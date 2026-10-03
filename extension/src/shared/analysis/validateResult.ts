type AnyRecord = Record<string, any>;

const ALLOWED_STANCES = new Set(['author', 'support', 'oppose', 'neutral', 'mixed']);

export interface AnalysisValidation {
  errors: string[];
  warnings: string[];
}

export class AnalysisResultValidationError extends Error {
  readonly validation: AnalysisValidation;

  constructor(validation: AnalysisValidation) {
    super(`模型结果校验失败：${validation.errors.join('；')}`);
    this.name = 'AnalysisResultValidationError';
    this.validation = validation;
  }
}

function isRecord(value: unknown): value is AnyRecord {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function walkTree(
  value: unknown,
  depth: number,
  commentIds: Set<string> | undefined,
  validation: AnalysisValidation,
  counts: { nodes: number; maxDepth: number },
  isRoot = false,
): void {
  if (!isRecord(value)) {
    validation.errors.push('topic_tree 包含非对象节点');
    return;
  }

  counts.nodes += 1;
  counts.maxDepth = Math.max(counts.maxDepth, depth);
  if (typeof value.title !== 'string' || !value.title.trim()) {
    validation.errors.push(`议题树第 ${depth + 1} 层缺少 title`);
  }
  if (typeof value.summary !== 'string') {
    validation.errors.push(`议题树节点“${String(value.title || '未命名')}”缺少 summary`);
  }
  if (typeof value.stance !== 'string' || !ALLOWED_STANCES.has(value.stance)) {
    validation.errors.push(`议题树节点“${String(value.title || '未命名')}”的 stance 无效`);
  } else if (isRoot && value.stance !== 'author') {
    validation.warnings.push('议题树根节点的 stance 不是 author');
  }

  if (!Array.isArray(value.quote_ids)) {
    validation.errors.push(`议题树节点“${String(value.title || '未命名')}”的 quote_ids 不是数组`);
  } else if (commentIds) {
    for (const quoteId of value.quote_ids) {
      if (typeof quoteId !== 'string') {
        validation.warnings.push(`议题树节点“${String(value.title || '未命名')}”包含非字符串 quote_id`);
      } else if (!commentIds.has(quoteId)) {
        validation.warnings.push(`议题树引用了不存在的评论：${quoteId}`);
      }
    }
  }

  if (!Array.isArray(value.children)) {
    validation.errors.push(`议题树节点“${String(value.title || '未命名')}”的 children 不是数组`);
    return;
  }
  for (const child of value.children) {
    walkTree(child, depth + 1, commentIds, validation, counts);
  }
}

export function validateAnalysisResult(
  result: unknown,
  commentIds?: Set<string>,
): AnalysisValidation {
  const validation: AnalysisValidation = { errors: [], warnings: [] };
  if (!isRecord(result)) {
    return { errors: ['模型结果不是 JSON 对象'], warnings: [] };
  }

  if (typeof result.answer_summary !== 'string' || !result.answer_summary.trim()) {
    validation.errors.push('缺少 answer_summary');
  }

  const stance = result.stance;
  if (!isRecord(stance)) {
    validation.errors.push('缺少 stance 对象');
  } else {
    const values = ['support', 'oppose', 'neutral'].map((key) => stance[key]);
    for (const [index, value] of values.entries()) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
        validation.errors.push(`stance.${['support', 'oppose', 'neutral'][index]} 不是 0 到 100 的数字`);
      }
    }
    if (values.every((value) => typeof value === 'number' && Number.isFinite(value))) {
      const total = values.reduce((sum, value) => sum + Number(value), 0);
      if (Math.abs(total - 100) > 5) {
        validation.warnings.push(`态度比例之和为 ${total}，与 100 偏差超过 5`);
      }
    }
    if (typeof stance.note !== 'string') {
      validation.warnings.push('stance.note 缺失，报告将无法显示置信度说明');
    }
  }

  if (!Array.isArray(result.controversies)) {
    validation.errors.push('controversies 不是数组');
  }

  const counts = { nodes: 0, maxDepth: 0 };
  walkTree(result.topic_tree, 0, commentIds, validation, counts, true);
  if (counts.nodes > 40) validation.warnings.push(`议题树节点数为 ${counts.nodes}，阅读负担较大`);
  if (counts.maxDepth > 6) validation.warnings.push(`议题树最大深度为 ${counts.maxDepth + 1}，层级较深`);

  if (!Array.isArray(result.highlights)) {
    validation.errors.push('highlights 不是数组');
  } else {
    for (const highlight of result.highlights) {
      if (!isRecord(highlight)) {
        validation.errors.push('highlights 包含非对象条目');
        continue;
      }
      if (typeof highlight.comment_id !== 'string') {
        validation.errors.push('highlight 缺少 comment_id');
      } else if (commentIds && highlight.comment_id && !commentIds.has(highlight.comment_id)) {
        validation.warnings.push(`典型原话引用了不存在的评论：${highlight.comment_id}`);
      }
      if (typeof highlight.text !== 'string' || !highlight.text.trim()) {
        validation.errors.push('highlight 缺少 text');
      }
    }
  }

  if (typeof result.report_markdown !== 'string' || !result.report_markdown.trim()) {
    validation.errors.push('缺少 report_markdown');
  }

  return validation;
}

export function assertValidAnalysisResult(
  result: unknown,
  commentIds?: Set<string>,
): AnalysisValidation {
  const validation = validateAnalysisResult(result, commentIds);
  if (validation.errors.length > 0) {
    throw new AnalysisResultValidationError(validation);
  }
  return validation;
}

