/** 页面类型 */
export type PageType = 'article' | 'answer' | 'question' | 'pin' | 'collection' | 'column' | 'profile';

/** 页面检测结果 */
export interface PageInfo {
  type: PageType;
  id: string;
}

/** 收藏夹/专栏的内容条目（API 返回归一化后） */
export interface ContentItem {
  id: string;
  type: PageType;
  url: string;
  title: string;
  author: string;
  html: string;
  isTruncated: boolean;
  isPaidContent: boolean;
  commentCount: number;
  created_time: number;
  updated_time: number;
  /** 收藏时间（仅收藏夹条目有此字段） */
  collected_time?: number;
}

/** 作者标识（富字段） */
export interface ZhihuAuthorRef {
  name: string;
  id?: string;
  url_token?: string;
  avatar_url?: string;
}

/** 从当前页面提取的文章/回答内容 */
export interface ExtractedContent {
  id: string;
  type: PageType;
  url: string;
  title: string;
  author: string;
  html: string;
  createdTime?: number | null;
  updatedTime?: number | null;
  _source?: string;
  /** 问题 ID（回答页） */
  questionId?: string | null;
  authorId?: string | null;
  authorUrlToken?: string | null;
  voteupCount?: number | null;
  commentCount?: number | null;
}

/** 收藏夹/专栏信息 */
export interface CollectionInfo {
  id: string;
  title: string;
  itemCount: number;
  apiUrl: string;
}

/** 分页 API 返回 */
export interface PaginatedResult {
  items: ContentItem[];
  nextUrl: string | null;
  totals: number;
}

/** 知乎评论（API 归一化后） */
export interface ZhihuComment {
  id: string;
  content: string;
  author: ZhihuAuthorRef;
  created_time: number;
  child_comment_count: number;
  child_comments?: ZhihuComment[];
  like_count?: number;
  dislike_count?: number;
  /** 直接回复的评论 ID（若有） */
  reply_comment_id?: string;
  reply_to_author?: ZhihuAuthorRef;
  author_tag?: Array<{ type: string; text?: string }>;
  comment_tag?: Array<{ type: string; text?: string }>;
}

/** 一次评论采集的过程统计，避免把一级评论数和总节点数混为一谈。 */
export interface CommentCollectionMeta {
  apiDeclaredCount: number | null;
  rootPages: number;
  rootPaginationComplete: boolean;
  childRequests: number;
  childCompleted: number;
  childFailedIds: string[];
  childSkippedIds: string[];
  childPaginationIncompleteIds: string[];
  rateLimited: boolean;
  rootErrorStatus?: number;
}

/** 评论接口的完整返回，供报告流水线和传统导出分别决定如何处理部分结果。 */
export interface CommentFetchResult {
  comments: ZhihuComment[];
  rootTotals: number;
  collectionMeta: CommentCollectionMeta;
}

/** 分析用导出包中的评论节点 */
export interface BundleCommentNode {
  id: string;
  parent_id: string | null;
  root_id: string;
  depth: number;
  reply_to_comment_id: string | null;
  reply_to_author: ZhihuAuthorRef | null;
  author: ZhihuAuthorRef & { is_content_author: boolean };
  content_html: string | null;
  content_text: string;
  created_at: string | null;
  like_count: number;
  dislike_count: number;
  ip_location: string | null;
  child_comment_count: number;
  children: BundleCommentNode[];
}

/** 分析用 bundle.json */
export interface ExportBundle {
  schema_version: string;
  source: {
    platform: 'zhihu';
    url: string;
    content_type: PageType;
    content_id: string;
    question_id: string | null;
    exported_at: string;
    collector: string;
    collector_version: string;
  };
  completeness: {
    status: 'complete' | 'partial' | 'unknown';
    expected_comment_count: number | null;
    captured_comment_count: number;
    capture_ratio: number | null;
    expected_root_count: number | null;
    captured_root_count: number;
    api_declared_count: number | null;
    api_total_scope: 'unknown' | 'total_nodes' | 'root_nodes';
    child_requests: number;
    child_completed: number;
    child_failed_ids: string[];
    child_skipped_ids: string[];
    child_pagination_incomplete_ids: string[];
    root_pages: number;
    root_pagination_complete: boolean;
    rate_limited: boolean;
    missing_reason: string | null;
    warnings: string[];
  };
  answer: {
    id: string;
    question_title: string;
    author: ZhihuAuthorRef & { is_author: true };
    content_html: string | null;
    content_text: string;
    created_at: string | null;
    updated_at: string | null;
    voteup_count: number | null;
    comment_count: number | null;
  };
  comments: BundleCommentNode[];
  stats: {
    root_count: number;
    total_nodes: number;
    max_depth: number;
  };
}

/** 导出进度 */
export interface ExportProgress {
  collectionId: string;
  collectionName: string;
  articles: {
    exportedIds: string[];
    totalExported: number;
    batchSize: number;
  };
  comments: {
    exportedArticles: string[];
    totalExported: number;
  };
}

/** 图片下载结果 */
export interface ImageDownloadResult {
  imageMapping: Record<string, string>;
  imageFiles: Array<{ path: string; buffer: ArrayBuffer }>;
}

/** 日志级别 */
export type LogLevel = 'info' | 'warn' | 'error' | 'success';

/** 日志条目 */
export interface LogEntry {
  time: string;
  message: string;
  level: LogLevel;
}

/** 导出格式 */
export type ExportFormat = 'md' | 'docx';

/** Docx 图片模式 */
export type DocxImageMode = 'embed' | 'link';
