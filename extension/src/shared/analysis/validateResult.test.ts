import { describe, expect, it } from 'vitest';
import { assertValidAnalysisResult, validateAnalysisResult } from './validateResult';

function validResult() {
  return {
    answer_summary: '答主认为问题需要从长期成本和现实约束一起看。',
    stance: { support: 50, oppose: 30, neutral: 20, note: '基于有效表态评论估算。' },
    controversies: ['成本和收益如何权衡'],
    topic_tree: {
      id: 'root',
      title: '答主主旨',
      summary: '回答的核心观点。',
      stance: 'author',
      quote_ids: ['c1'],
      children: [],
    },
    highlights: [{ comment_id: 'c1', author: '用户', likes: 3, text: '代表性评论', why: '提供反方视角' }],
    report_markdown: '# 报告\n\n正文',
  };
}

describe('validateAnalysisResult', () => {
  it('接受符合契约的模型结果', () => {
    expect(assertValidAnalysisResult(validResult(), new Set(['c1']))).toEqual({ errors: [], warnings: [] });
  });

  it('拒绝缺少关键结构的结果', () => {
    const result = validateAnalysisResult({ stance: { support: 100, oppose: 0, neutral: 0 } });
    expect(result.errors).toContain('缺少 answer_summary');
    expect(result.errors).toContain('controversies 不是数组');
    expect(result.errors).toContain('缺少 report_markdown');
  });

  it('把不存在的引用标为提醒而不是静默输出', () => {
    const result = validateAnalysisResult(validResult(), new Set(['other']));
    expect(result.warnings.some((warning) => warning.includes('不存在的评论'))).toBe(true);
  });
});
