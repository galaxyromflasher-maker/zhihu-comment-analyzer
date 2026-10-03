import type { ExportBundle, ZhihuComment } from '@/types/zhihu';

function trim(text: string | null | undefined, limit: number): string {
  const t = (text || '').replace(/\n/g, ' ').trim();
  return t.length <= limit ? t : `${t.slice(0, limit - 1)}…`;
}

function flatten(comments: ZhihuComment[], acc: ZhihuComment[] = []): ZhihuComment[] {
  for (const c of comments) {
    acc.push(c);
    if (c.child_comments?.length) flatten(c.child_comments, acc);
  }
  return acc;
}

/** 从 ExportBundle 压成 LLM 语料 */
export function buildCorpusFromBundle(bundle: ExportBundle): {
  corpus: string;
  validation: Record<string, unknown>;
} {
  const flat: Array<{
    id: string;
    depth: number;
    like_count: number;
    author: string;
    ip_location: string;
    content_text: string;
  }> = [];

  const walk = (nodes: ExportBundle['comments'], depth = 0) => {
    for (const n of nodes) {
      flat.push({
        id: n.id,
        depth,
        like_count: n.like_count || 0,
        author: n.author?.name || '',
        ip_location: n.ip_location || '',
        content_text: n.content_text || '',
      });
      if (n.children?.length) walk(n.children, depth + 1);
    }
  };
  walk(bundle.comments || []);

  const ranked = [...flat].sort((a, b) => b.like_count - a.like_count);
  const lines = [
    `URL: ${bundle.source.url}`,
    `问题: ${bundle.answer.question_title}`,
    `答主: ${bundle.answer.author.name}`,
    `评论节点数: ${flat.length}`,
    '',
    '【答主回答】',
    trim(bundle.answer.content_text, 3500),
    '',
    '【评论列表】格式: id | depth | likes | author | ip | 正文',
  ];
  for (const c of ranked) {
    lines.push(
      [c.id, c.depth, c.like_count, c.author, c.ip_location, trim(c.content_text, 180)].join(' | '),
    );
  }

  const validation = {
    completeness_status: bundle.completeness.status,
    root_count: bundle.stats.root_count,
    captured_comment_count: flat.length,
    declared_total_nodes: bundle.stats.total_nodes,
    expected_comment_count: bundle.completeness.expected_comment_count,
    expected_root_count: bundle.completeness.expected_root_count,
    captured_root_count: bundle.completeness.captured_root_count,
    api_declared_count: bundle.completeness.api_declared_count,
    child_requests: bundle.completeness.child_requests,
    child_completed: bundle.completeness.child_completed,
    child_failed_ids: bundle.completeness.child_failed_ids,
    child_skipped_ids: bundle.completeness.child_skipped_ids,
    root_pagination_complete: bundle.completeness.root_pagination_complete,
    rate_limited: bundle.completeness.rate_limited,
    warnings: bundle.completeness.warnings,
    nodes_match_declared: bundle.stats.total_nodes === flat.length,
  };

  return { corpus: lines.join('\n'), validation };
}

export function countCommentNodes(comments: ZhihuComment[]): number {
  return flatten(comments).length;
}
