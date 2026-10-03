/**
 * 数据层：知乎页面检测 + 内容提取 + 收藏夹信息
 * 依赖 shared/api/zhihu-api（API 调用层）
 * 所有函数以 named export 供其他模块调用
 */

import { detectPage, fetchCollectionPage, fetchColumnPage, fetchProfilePage, fetchAllComments } from '@/shared/api/zhihu-api';
import type { PageInfo, ExtractedContent, CollectionInfo } from '@/types/zhihu';

// Re-export API functions for convenience
export { detectPage, fetchCollectionPage, fetchColumnPage, fetchProfilePage, fetchAllComments };

// ============================
// 单篇内容提取
// ============================

export function extractContent(): ExtractedContent | null {
  const url = window.location.href;
  const pageInfo = detectPage(url);
  if (!pageInfo || pageInfo.type === 'collection') {
    return null;
  }

  const initialData = extractInitialData();
  const fromData = initialData ? extractFromInitialData(initialData, pageInfo, url) : null;
  const fromDOM = extractFromDOM(pageInfo, url);

  // 两个来源都有时，用 html 更长的那个（initialData 可能截断长文章）
  let result: ExtractedContent | null = null;
  if (fromData && fromDOM) {
    const dataLen = (fromData.html || '').length;
    const domLen = (fromDOM.html || '').length;
    if (domLen > dataLen) {
      fromDOM._source = `DOM(${domLen}) > initialData(${dataLen})`;
      // DOM 内容更长，但时间信息从 initialData 补充
      fromDOM.createdTime = fromDOM.createdTime || fromData.createdTime;
      fromDOM.updatedTime = fromDOM.updatedTime || fromData.updatedTime;
      result = fromDOM;
    } else {
      fromData._source = `initialData(${dataLen}) >= DOM(${domLen})`;
      result = fromData;
    }
  } else if (fromData) {
    fromData._source = 'initialData';
    result = fromData;
  } else if (fromDOM) {
    fromDOM._source = 'DOM';
    result = fromDOM;
  }

  if (result) {
    result.id = pageInfo.id;
  }
  return result;
}

function parseZop(el: Element): { itemId?: string; authorName?: string; type?: string } {
  const raw = el.getAttribute('data-zop');
  if (!raw) return {};
  try {
    const data = JSON.parse(raw) as { itemId?: string | number; authorName?: string; type?: string };
    return {
      itemId: data.itemId != null ? String(data.itemId) : undefined,
      authorName: data.authorName,
      type: data.type,
    };
  } catch {
    return {};
  }
}

function answerIdFromHref(href: string | null, questionId: string): string | null {
  if (!href) return null;
  const match = href.match(new RegExp(`question/${questionId}/answer/(\\d+)`));
  return match?.[1] || null;
}

function upsertAnswer(map: Map<string, ExtractedContent>, item: ExtractedContent): void {
  const existing = map.get(item.id);
  if (!existing) {
    map.set(item.id, item);
    return;
  }
  const nextHtml = (item.html || '').length > (existing.html || '').length ? item.html : existing.html;
  map.set(item.id, {
    ...existing,
    ...item,
    html: nextHtml || existing.html,
    author: item.author && item.author !== '知乎用户' ? item.author : existing.author,
    voteupCount: item.voteupCount ?? existing.voteupCount,
    commentCount: item.commentCount ?? existing.commentCount,
  });
}

/**
 * 问题页上已加载的回答列表（首屏 JSON + 当前 DOM）。
 * 滚动加载更多后需再调一次才会出现新卡片。
 */
export function listQuestionAnswers(questionId: string, questionTitle: string): ExtractedContent[] {
  const map = new Map<string, ExtractedContent>();
  const title = questionTitle || `知乎问题${questionId}`;

  const initialData = extractInitialData() as any;
  const answers = initialData?.initialState?.entities?.answers || {};
  for (const key of Object.keys(answers)) {
    const data = answers[key];
    const id = String(data?.id || key);
    if (!id) continue;
    if (data?.question?.id != null && String(data.question.id) !== questionId) continue;
    upsertAnswer(map, {
      id,
      type: 'answer',
      url: `https://www.zhihu.com/question/${questionId}/answer/${id}`,
      title,
      author: data?.author?.name || '知乎用户',
      html: data?.content || '',
      createdTime: data?.created_time || null,
      updatedTime: data?.updated_time || null,
      questionId,
      authorId: data?.author?.id != null ? String(data.author.id) : null,
      authorUrlToken: data?.author?.url_token || null,
      voteupCount: typeof data?.voteup_count === 'number' ? data.voteup_count : null,
      commentCount: typeof data?.comment_count === 'number' ? data.comment_count : null,
      _source: 'initialData',
    });
  }

  const cards = document.querySelectorAll('.AnswerItem, .ContentItem.AnswerItem');
  cards.forEach((card) => {
    const zop = parseZop(card);
    const link = card.querySelector<HTMLAnchorElement>(`a[href*="/question/${questionId}/answer/"]`);
    const id = zop.itemId || answerIdFromHref(link?.getAttribute('href') || '', questionId);
    if (!id) return;
    const authorEl = card.querySelector('.AuthorInfo-name .UserLink-link, .AuthorInfo-name');
    const contentEl = card.querySelector('.RichContent-inner, .RichText');
    const voteEl = card.querySelector('[itemprop="upvoteCount"]');
    const voteText = voteEl?.getAttribute('content') || voteEl?.textContent || '';
    const voteupCount = voteText ? Number.parseInt(voteText.replace(/[^\d]/g, ''), 10) : NaN;
    upsertAnswer(map, {
      id,
      type: 'answer',
      url: `https://www.zhihu.com/question/${questionId}/answer/${id}`,
      title,
      author: (authorEl?.textContent || zop.authorName || '').trim() || '知乎用户',
      html: (contentEl as HTMLElement | null)?.innerHTML || '',
      questionId,
      voteupCount: Number.isFinite(voteupCount) ? voteupCount : null,
      _source: 'DOM',
    });
  });

  return Array.from(map.values());
}

function extractInitialData(): unknown | null {
  const scriptTag = document.querySelector('script#js-initialData[type="text/json"]');
  if (!scriptTag || !scriptTag.textContent) return null;
  try {
    return JSON.parse(scriptTag.textContent);
  } catch {
    return null;
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function extractFromInitialData(jsonData: unknown, pageInfo: PageInfo, url: string): ExtractedContent | null {
  const { type, id } = pageInfo;
  const root = jsonData as any;

  switch (type) {
    case 'answer': {
      const questionMatch = url.match(/question\/(\d+)/);
      const questionId = questionMatch ? questionMatch[1] : '';
      const data = root?.initialState?.entities?.answers?.[id];
      return {
        id,
        type, url,
        title: data?.question?.title || `知乎问题${questionId}`,
        author: data?.author?.name || '知乎用户',
        html: data?.content || '',
        createdTime: data?.created_time || null,
        updatedTime: data?.updated_time || null,
        questionId: data?.question?.id != null ? String(data.question.id) : questionId || null,
        authorId: data?.author?.id != null ? String(data.author.id) : null,
        authorUrlToken: data?.author?.url_token || null,
        voteupCount: typeof data?.voteup_count === 'number' ? data.voteup_count : null,
        commentCount: typeof data?.comment_count === 'number' ? data.comment_count : null,
      };
    }
    case 'article': {
      const data = root?.initialState?.entities?.articles?.[id];
      return {
        id,
        type, url,
        title: data?.title || `知乎文章${id}`,
        author: data?.author?.name || '知乎用户',
        html: data?.content || '',
        createdTime: data?.created || null,
        updatedTime: data?.updated || null,
        questionId: null,
        authorId: data?.author?.id != null ? String(data.author.id) : null,
        authorUrlToken: data?.author?.url_token || null,
        voteupCount: typeof data?.voteup_count === 'number' ? data.voteup_count : null,
        commentCount: typeof data?.comment_count === 'number' ? data.comment_count : null,
      };
    }
    case 'question': {
      const data = root?.initialState?.entities?.questions?.[id];
      const detail = data?.detail || '';
      const title = data?.title || `知乎问题${id}`;
      const asker = data?.author?.name || '知乎用户';

      const answers = root?.initialState?.entities?.answers || {};
      let answersHtml = '';
      for (const key in answers) {
        const answer = answers[key];
        const aAuthor = answer?.author?.name || '知乎用户';
        const aUrl = `https://www.zhihu.com/question/${id}/answer/${answer?.id}`;
        answersHtml += `<h1><a href="${aUrl}">${aAuthor}的回答</a></h1>`;
        answersHtml += `<div>${answer?.content || ''}</div>`;
      }

      return { id, type, url, title, author: asker, html: detail + answersHtml };
    }
    case 'pin': {
      const pinData = root?.initialState?.entities?.pins?.[id];
      const users = root?.initialState?.entities?.users || {};

      let author = '知乎用户';
      for (const key in users) {
        if (users[key]?.name) { author = users[key].name; break; }
      }

      const contentHtml = typeof pinData?.contentHtml === 'string' ? pinData.contentHtml : '';
      const contentArr = Array.isArray(pinData?.content) ? pinData.content : [];
      const imgsHtml = contentArr
        .filter((e: any) => e?.type === 'image' && e?.originalUrl)
        .map((e: any) => {
          const w = e.width ? ` width="${e.width}"` : '';
          const h = e.height ? ` height="${e.height}"` : '';
          return `<img src="${e.originalUrl}" alt=""${w}${h} />`;
        })
        .join('\n');

      return {
        id,
        type, url,
        title: `想法${id}`,
        author,
        html: contentHtml + (imgsHtml ? `<div>${imgsHtml}</div>` : ''),
        createdTime: pinData?.created || null,
        updatedTime: pinData?.updated || null,
      };
    }
    default:
      return null;
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

function extractFromDOM(pageInfo: PageInfo, url: string): ExtractedContent | null {
  const { type, id } = pageInfo;
  switch (type) {
    case 'article': {
      const titleEl = document.querySelector('.Post-Title');
      const contentEl = document.querySelector('.Post-RichText');
      const authorEl = document.querySelector('.AuthorInfo-name .UserLink-link');
      return {
        id,
        type, url,
        title: titleEl?.textContent?.trim() || '知乎文章',
        author: authorEl?.textContent?.trim() || '知乎用户',
        html: contentEl?.innerHTML || '',
      };
    }
    case 'answer': {
      const titleEl = document.querySelector('.QuestionHeader-title');
      const contentEl = document.querySelector('.RichContent-inner');
      const answerContainer = contentEl?.closest('.ContentItem, .List-item, .AnswerItem');
      const authorEl = answerContainer?.querySelector('.AuthorInfo-name .UserLink-link, .AuthorInfo-name');
      return {
        id,
        type, url,
        title: titleEl?.textContent?.trim() || '知乎回答',
        author: authorEl?.textContent?.trim() || '知乎用户',
        html: contentEl?.innerHTML || '',
      };
    }
    case 'question': {
      const titleEl = document.querySelector('.QuestionHeader-title');
      const detailEl = document.querySelector('.QuestionRichText--collapsed, .QuestionRichText--expandable');
      return {
        id,
        type, url,
        title: titleEl?.textContent?.trim() || '知乎问题',
        author: '知乎用户',
        html: detailEl?.innerHTML || '',
      };
    }
    case 'pin': {
      const contentEl = document.querySelector('.PinItem-contentWrapper');
      return {
        id,
        type, url,
        title: '知乎想法',
        author: '知乎用户',
        html: contentEl?.innerHTML || '',
      };
    }
    default:
      return null;
  }
}

// ============================
// 收藏夹信息（需要 DOM）
// ============================

export function getCollectionInfo(): CollectionInfo | null {
  const url = window.location.href;
  const match = url.match(/zhihu\.com\/collection\/(\d+)/);
  if (!match) return null;

  const id = match[1];
  const titleEl =
    document.querySelector('.CollectionDetailPageHeader-title') ||
    document.querySelector('[class*="CollectionDetail"] h2') ||
    document.querySelector('h1');

  return {
    id,
    title: titleEl?.textContent?.trim() || `收藏夹${id}`,
    itemCount: 0,
    apiUrl: `https://www.zhihu.com/api/v4/collections/${id}/items?offset=0&limit=20`,
  };
}

// ============================
// 专栏信息（需要 DOM）
// ============================

export function getColumnInfo(): CollectionInfo | null {
  const url = window.location.href;
  const match = url.match(/zhihu\.com\/column\/([^/?#]+)/) ||
                url.match(/zhuanlan\.zhihu\.com\/([^/?#p][^/?#]*)/);
  if (!match) return null;

  const id = match[1];

  // 从页面标题提取，去掉 "(N 条消息)" 前缀和 " - 知乎" 后缀
  let title = '';
  const pageTitle = (document.title || '').replace(/^\(\d+\s*条消息\)\s*/, '');
  if (pageTitle) {
    title = pageTitle.split(' - ')[0].trim();
  }

  // 兜底：从初始数据或 meta 提取
  if (!title) {
    const metaDesc = document.querySelector('meta[name="description"]');
    title = metaDesc?.getAttribute('content')?.trim() || '';
  }

  if (!title) {
    title = document.querySelector('h1')?.textContent?.trim() || `专栏${id}`;
  }

  return {
    id,
    title,
    itemCount: 0,
    apiUrl: `https://www.zhihu.com/api/v4/columns/${id}/items`,
  };
}

// ============================
// 个人主页信息（需要 DOM）
// ============================

export function getProfileInfo(): CollectionInfo | null {
  const url = window.location.href;
  const match = url.match(/zhihu\.com\/people\/([^/?#]+)/);
  if (!match) return null;

  const urlToken = match[1];

  // 仅允许导出当前登录用户自己的主页，防止滥用
  if (!isCurrentUserProfile(urlToken)) return null;

  // 从页面提取用户名
  let title = '';
  const nameEl = document.querySelector('.ProfileHeader-name') ||
                 document.querySelector('[class*="ProfileHeader"] .Avatar + span') ||
                 document.querySelector('h1');
  if (nameEl) {
    title = nameEl.textContent?.trim() || '';
  }

  if (!title) {
    const pageTitle = (document.title || '').replace(/^\(\d+\s*条消息\)\s*/, '');
    title = pageTitle.split(' - ')[0].trim();
  }

  if (!title) {
    title = decodeURIComponent(urlToken);
  }

  return {
    id: urlToken,
    title,
    itemCount: 0,
    apiUrl: `https://www.zhihu.com/api/v3/moments/${urlToken}/activities?page_num=1`,
  };
}

/**
 * 判断当前页面的 profile 是否属于已登录用户本人
 * 优先从 initialData 读取，兜底检测 DOM 中的「编辑资料」按钮
 */
function isCurrentUserProfile(urlToken: string): boolean {
  // 方式 1：从 initialData 中比较当前登录用户的 urlToken
  const scriptTag = document.querySelector('script#js-initialData[type="text/json"]');
  if (scriptTag?.textContent) {
    try {
      const initialData = JSON.parse(scriptTag.textContent) as any;
      const currentUserToken =
        initialData?.initialState?.entities?.currentUser?.urlToken ||
        initialData?.initialState?.currentUser;
      if (currentUserToken && currentUserToken === urlToken) return true;
      // initialData 存在但 token 不匹配 → 不是本人
      if (currentUserToken) return false;
    } catch { /* 解析失败，走兜底逻辑 */ }
  }

  // 方式 2：DOM 中存在「编辑个人资料」按钮，说明是本人主页
  const editBtn = document.querySelector('.ProfileHeader-editButton, [class*="ProfileHeader"] button[class*="edit"], a[href="/settings/profile"]');
  return !!editBtn;
}

// ============================
// Fetch 代理：通过页面上下文发起请求
// 页面 JS 环境中的 fetch 会被知乎的请求拦截器自动加上 x-zse 签名头
// ============================

const pendingRequests = new Map<number, { resolve: (data: unknown) => void; reject: (err: Error) => void }>();
let requestIdCounter = 0;

export function pageFetch(url: string, responseType?: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = ++requestIdCounter;
    pendingRequests.set(id, { resolve, reject });
    window.dispatchEvent(new CustomEvent('__zhihu_dl_fetch_request', {
      detail: { id, url, responseType },
    }));
    // 超时 30 秒
    setTimeout(() => {
      if (pendingRequests.has(id)) {
        pendingRequests.delete(id);
        reject(new Error('页面代理请求超时'));
      }
    }, 30000);
  });
}

export function setupFetchBridge(): void {
  // 1. 注入桥接脚本到页面 JS 上下文（外部文件，不受 CSP 限制）
  const bridgeScript = document.createElement('script');
  bridgeScript.src = chrome.runtime.getURL('src/content/fetch-bridge.js');
  (document.head || document.documentElement).appendChild(bridgeScript);
  bridgeScript.onload = () => bridgeScript.remove();

  // 2. Content script 侧：监听桥接脚本的响应
  window.addEventListener('__zhihu_dl_fetch_response', ((e: CustomEvent) => {
    const { id, data, error, status } = e.detail;
    const pending = pendingRequests.get(id);
    if (pending) {
      pendingRequests.delete(id);
      if (error) {
        const err = new Error(error) as Error & { httpStatus?: number };
        err.httpStatus = status;
        pending.reject(err);
      } else {
        pending.resolve(data);
      }
    }
  }) as EventListener);

  // 3. 接收 service worker 转发的请求，通过页面上下文代理
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.action !== 'fetchProxy') return;

    pageFetch(message.url, message.responseType)
      .then((data: unknown) => sendResponse({ data }))
      .catch((err: Error & { httpStatus?: number }) => sendResponse({ error: err.message, status: err.httpStatus }));

    return true;
  });
}
