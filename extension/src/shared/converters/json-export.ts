/**
 * 分析用 bundle.json 构建
 */

import type {
  ExtractedContent,
  ContentItem,
  ZhihuComment,
  BundleCommentNode,
  ExportBundle,
  ZhihuAuthorRef,
  CommentCollectionMeta,
} from '@/types/zhihu';
import { commentHtmlToText } from '@/shared/converters/html-to-markdown';
import pkg from '../../../package.json';

const COLLECTOR_NAME = 'zhihu-analysis-collector';
const SCHEMA_VERSION = '1.0';

function toIso(ts: number | null | undefined): string | null {
  if (ts == null || !ts) return null;
  const ms = ts < 1e12 ? ts * 1000 : ts;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function htmlToPlain(html: string | null | undefined): string {
  if (!html) return '';
  const div = document.createElement('div');
  div.innerHTML = html;
  return (div.textContent || '').trim();
}

function getIpLocation(comment: ZhihuComment): string | null {
  const tag = (comment.comment_tag || []).find((t) => t.type === 'ip_info');
  return tag?.text || null;
}

function isContentAuthor(comment: ZhihuComment): boolean {
  return (comment.author_tag || []).some((t) => t.type === 'content_author');
}

function countNodes(comments: ZhihuComment[]): number {
  return comments.reduce(
    (sum, c) => sum + 1 + countNodes(c.child_comments || []),
    0,
  );
}

function maxDepthOf(comments: ZhihuComment[], depth = 0): number {
  if (!comments.length) return depth;
  let max = depth;
  for (const c of comments) {
    max = Math.max(max, maxDepthOf(c.child_comments || [], depth + 1));
  }
  return max;
}

function toNode(
  comment: ZhihuComment,
  parentId: string | null,
  rootId: string,
  depth: number,
): BundleCommentNode {
  const author: ZhihuAuthorRef & { is_content_author: boolean } = {
    name: comment.author?.name || '匿名用户',
    id: comment.author?.id,
    url_token: comment.author?.url_token,
    avatar_url: comment.author?.avatar_url,
    is_content_author: isContentAuthor(comment),
  };

  const children = (comment.child_comments || []).map((child) =>
    toNode(child, comment.id, rootId, depth + 1),
  );

  return {
    id: comment.id,
    parent_id: parentId,
    root_id: rootId,
    depth,
    reply_to_comment_id: comment.reply_comment_id || null,
    reply_to_author: comment.reply_to_author
      ? {
          name: comment.reply_to_author.name,
          id: comment.reply_to_author.id,
          url_token: comment.reply_to_author.url_token,
          avatar_url: comment.reply_to_author.avatar_url,
        }
      : null,
    author,
    content_html: comment.content || null,
    content_text: commentHtmlToText(comment.content || ''),
    created_at: toIso(comment.created_time),
    like_count: comment.like_count ?? 0,
    dislike_count: comment.dislike_count ?? 0,
    ip_location: getIpLocation(comment),
    child_comment_count: comment.child_comment_count ?? children.length,
    children,
  };
}

export interface BuildBundleOptions {
  content: ExtractedContent | ContentItem;
  comments: ZhihuComment[];
  /** 已知的总评论数；只有字段来源明确时才传入。 */
  expectedCommentCount?: number | null;
  /** 本次 API 采集过程统计。 */
  collectionMeta?: CommentCollectionMeta;
  warnings?: string[];
}

function collectChildWarnings(
  comments: ZhihuComment[],
  warnings: string[],
): void {
  for (const comment of comments) {
    const children = comment.child_comments || [];
    if (comment.child_comment_count > children.length) {
      warnings.push(
        `评论 ${comment.id} 声明子评 ${comment.child_comment_count}，实际抓到 ${children.length}`,
      );
    }
    collectChildWarnings(children, warnings);
  }
}

/**
 * 构建分析用 ExportBundle
 */
export function buildExportBundle(options: BuildBundleOptions): ExportBundle {
  const { content, comments } = options;
  const warnings = [...(options.warnings || [])];
  const captured = countNodes(comments);
  const expected =
    options.expectedCommentCount ??
    (content as ExtractedContent).commentCount ??
    (content as ContentItem).commentCount ??
    null;

  // 递归检查所有节点，避免只检查一级评论导致缺口被隐藏。
  collectChildWarnings(comments, warnings);

  let captureRatio: number | null = null;
  if (typeof expected === 'number' && expected > 0) {
    captureRatio = Math.min(1, captured / expected);
    if (captureRatio < 0.9) {
      warnings.push(
        `评论抓取比例 ${(captureRatio * 100).toFixed(1)}%（${captured}/${expected}）低于 90%`,
      );
    }
  }

  const extracted = content as ExtractedContent;
  const questionId =
    extracted.questionId ||
    content.url.match(/question\/(\d+)/)?.[1] ||
    null;

  const meta = options.collectionMeta;
  if (meta) {
    if (meta.apiDeclaredCount != null) {
      warnings.push(`知乎 API totals=${meta.apiDeclaredCount}，未将其直接作为抓全基准`);
    }
    if (!meta.rootPaginationComplete) {
      warnings.push('一级评论分页未完整结束');
    }
    if (meta.childFailedIds.length > 0) {
      warnings.push(`有 ${meta.childFailedIds.length} 个楼中楼请求失败`);
    }
    if (meta.childSkippedIds.length > 0) {
      warnings.push(`有 ${meta.childSkippedIds.length} 个楼中楼请求因限流未执行`);
    }
    if (meta.childPaginationIncompleteIds.length > 0) {
      warnings.push(`有 ${meta.childPaginationIncompleteIds.length} 个楼中楼分页未完整结束`);
    }
    if (meta.rateLimited) {
      warnings.push('采集过程中触发知乎限流');
    }
    if (meta.rootErrorStatus) {
      warnings.push(`一级评论请求中断（HTTP ${meta.rootErrorStatus}）`);
    }
  }
  // 仅真实采集缺口（分页中断 / 楼中楼失败跳过 / 限流 / 根请求中断）标 partial。
  // child_comment_count 声明差、抓取比例等软诊断只进 warnings，不硬停后续分析。
  const hasCollectionGap = Boolean(
    meta && (
      !meta.rootPaginationComplete ||
      meta.childFailedIds.length > 0 ||
      meta.childSkippedIds.length > 0 ||
      meta.childPaginationIncompleteIds.length > 0 ||
      meta.rateLimited ||
      Boolean(meta.rootErrorStatus)
    ),
  );
  const status: ExportBundle['completeness']['status'] = hasCollectionGap
    ? 'partial'
    : meta || expected != null
      ? 'complete'
      : 'unknown';

  return {
    schema_version: SCHEMA_VERSION,
    source: {
      platform: 'zhihu',
      url: content.url,
      content_type: content.type,
      content_id: content.id,
      question_id: questionId,
      exported_at: new Date().toISOString(),
      collector: COLLECTOR_NAME,
      collector_version: pkg.version,
    },
    completeness: {
      status,
      expected_comment_count: expected,
      captured_comment_count: captured,
      capture_ratio: captureRatio,
      expected_root_count: null,
      captured_root_count: comments.length,
      api_declared_count: meta?.apiDeclaredCount ?? null,
      api_total_scope: 'unknown',
      child_requests: meta?.childRequests ?? 0,
      child_completed: meta?.childCompleted ?? 0,
      child_failed_ids: meta?.childFailedIds ?? [],
      child_skipped_ids: meta?.childSkippedIds ?? [],
      child_pagination_incomplete_ids: meta?.childPaginationIncompleteIds ?? [],
      root_pages: meta?.rootPages ?? 0,
      root_pagination_complete: meta?.rootPaginationComplete ?? false,
      rate_limited: meta?.rateLimited ?? false,
      missing_reason: status === 'complete' ? null : warnings.length ? warnings.join('; ') : null,
      warnings,
    },
    answer: {
      id: content.id,
      question_title: content.title,
      author: {
        name: content.author || '知乎用户',
        id: extracted.authorId || undefined,
        url_token: extracted.authorUrlToken || undefined,
        is_author: true,
      },
      content_html: content.html || null,
      content_text: htmlToPlain(content.html),
      created_at: toIso(
        extracted.createdTime ?? (content as ContentItem).created_time ?? null,
      ),
      updated_at: toIso(
        extracted.updatedTime ?? (content as ContentItem).updated_time ?? null,
      ),
      voteup_count: extracted.voteupCount ?? null,
      comment_count: extracted.commentCount ?? expected,
    },
    comments: comments.map((c) => toNode(c, null, c.id, 0)),
    stats: {
      root_count: comments.length,
      total_nodes: captured,
      max_depth: maxDepthOf(comments),
    },
  };
}

export function stringifyBundle(bundle: ExportBundle): string {
  return `${JSON.stringify(bundle, null, 2)}\n`;
}
