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
  /** API paging.totals（一级评论总数，若有） */
  expectedCommentCount?: number | null;
  warnings?: string[];
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

  // 子评论缺口：API 声明 child_comment_count 但未拉全
  for (const root of comments) {
    const got = (root.child_comments || []).length;
    if (root.child_comment_count > got) {
      warnings.push(
        `评论 ${root.id} 声明子评 ${root.child_comment_count}，实际抓到 ${got}`,
      );
    }
  }

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
      expected_comment_count: expected,
      captured_comment_count: captured,
      capture_ratio: captureRatio,
      missing_reason: warnings.length ? warnings.join('; ') : null,
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
