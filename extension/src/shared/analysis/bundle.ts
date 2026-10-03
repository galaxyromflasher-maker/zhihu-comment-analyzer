import type { ExportBundle } from '@/types/zhihu';

type AnyRecord = Record<string, any>;

function asRecord(value: unknown): AnyRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as AnyRecord
    : {};
}

/**
 * 读取并兼容历史 bundle。历史文件没有新增的完整性字段，统一在入口补默认值。
 */
export function parseExportBundle(text: string): ExportBundle {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`bundle JSON 解析失败：${error instanceof Error ? error.message : String(error)}`);
  }

  const data = asRecord(raw);
  const source = asRecord(data.source);
  const answer = asRecord(data.answer);
  const stats = asRecord(data.stats);
  const comments = Array.isArray(data.comments) ? data.comments : null;

  if (!data.schema_version || !source.url || !answer.author || !comments) {
    throw new Error('bundle 格式不完整：需要 schema_version、source、answer 和 comments');
  }

  const oldCompleteness = asRecord(data.completeness);
  const warnings = Array.isArray(oldCompleteness.warnings)
    ? oldCompleteness.warnings.filter((item: unknown): item is string => typeof item === 'string')
    : [];
  const captured = Number(oldCompleteness.captured_comment_count ?? stats.total_nodes ?? 0);
  const rootCount = Number(oldCompleteness.captured_root_count ?? stats.root_count ?? comments.length);

  return {
    ...data,
    completeness: {
      status: oldCompleteness.status === 'complete' || oldCompleteness.status === 'partial'
        ? oldCompleteness.status
        : warnings.length > 0 ? 'partial' : 'unknown',
      expected_comment_count: typeof oldCompleteness.expected_comment_count === 'number'
        ? oldCompleteness.expected_comment_count
        : null,
      captured_comment_count: captured,
      capture_ratio: typeof oldCompleteness.capture_ratio === 'number'
        ? oldCompleteness.capture_ratio
        : null,
      expected_root_count: typeof oldCompleteness.expected_root_count === 'number'
        ? oldCompleteness.expected_root_count
        : null,
      captured_root_count: rootCount,
      api_declared_count: typeof oldCompleteness.api_declared_count === 'number'
        ? oldCompleteness.api_declared_count
        : null,
      api_total_scope: oldCompleteness.api_total_scope === 'total_nodes' || oldCompleteness.api_total_scope === 'root_nodes'
        ? oldCompleteness.api_total_scope
        : 'unknown',
      child_requests: Number(oldCompleteness.child_requests ?? 0),
      child_completed: Number(oldCompleteness.child_completed ?? 0),
      child_failed_ids: Array.isArray(oldCompleteness.child_failed_ids) ? oldCompleteness.child_failed_ids : [],
      child_skipped_ids: Array.isArray(oldCompleteness.child_skipped_ids) ? oldCompleteness.child_skipped_ids : [],
      child_pagination_incomplete_ids: Array.isArray(oldCompleteness.child_pagination_incomplete_ids)
        ? oldCompleteness.child_pagination_incomplete_ids
        : [],
      root_pages: Number(oldCompleteness.root_pages ?? 0),
      root_pagination_complete: oldCompleteness.root_pagination_complete !== false,
      rate_limited: oldCompleteness.rate_limited === true,
      missing_reason: typeof oldCompleteness.missing_reason === 'string'
        ? oldCompleteness.missing_reason
        : warnings.length ? warnings.join('; ') : null,
      warnings,
    },
    stats: {
      root_count: Number(stats.root_count ?? rootCount),
      total_nodes: Number(stats.total_nodes ?? captured),
      max_depth: Number(stats.max_depth ?? 0),
    },
  } as ExportBundle;
}

