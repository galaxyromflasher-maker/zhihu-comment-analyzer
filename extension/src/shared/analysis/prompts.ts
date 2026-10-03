export const DEFAULT_SYSTEM = `你是中文舆情与议题分析助手。输入是一条知乎回答及其评论语料。
你必须只输出一个 JSON 对象（不要 Markdown 围栏），字段见用户要求。
态度占比是基于评论内容的估算，须给出置信度说明，不可假装精确统计。
如果数据校验摘要显示 completeness_status=partial 或存在 warnings，必须在摘要、态度说明和报告结论中明确指出数据不完整，不得把样本估算写成全量结论。
议题树以答主回答为根：主干是答主核心论点与评论主线，分支是评论引申出的子议题/立场簇。`;

export const DEFAULT_USER_TEMPLATE = `请基于以下语料完成分析。

【数据校验摘要】
{validation}

【语料】
{corpus}

请输出 JSON，严格包含以下键：
{
  "answer_summary": "答主核心观点，200字内",
  "stance": {
    "support": 0,
    "oppose": 0,
    "neutral": 0,
    "note": "占比估算说明与置信度；分母是有效表态评论的大致比例，百分比整数且三者之和约100"
  },
  "controversies": ["争议点1", "争议点2"],
  "topic_tree": {
    "id": "root",
    "title": "短标题（答主主旨）",
    "summary": "节点说明",
    "stance": "support|oppose|neutral|mixed|author",
    "quote_ids": [],
    "children": [
      {
        "id": "t1",
        "title": "一级议题/立场分支",
        "summary": "该分支在说什么",
        "stance": "support|oppose|neutral|mixed",
        "quote_ids": ["评论id"],
        "children": []
      }
    ]
  },
  "highlights": [
    {"comment_id": "", "author": "", "likes": 0, "text": "代表性原话", "why": "为何收录"}
  ],
  "report_markdown": "完整中文分析报告 Markdown（含：一、答主摘要 二、议题树文字版 三、态度估算 四、争议点 五、高赞/典型原话 六、小结）。报告里用标题层级，不要再包代码围栏包住全文。"
}

议题树要求：
1. 根节点必须是答主回答主旨（stance=author）。
2. 一级 children 3~8 个，覆盖主要引申与立场；二级按需，总节点不宜超过 25。
3. quote_ids 必须是数组；无引用时写 []。
4. children 必须是数组；叶节点必须写 "children": []，不得省略或写成 null/对象。
5. 分支要体现「引申出来的信息」，不是简单复制评论列表。
`;

export function renderUserPrompt(
  template: string,
  corpus: string,
  validation: unknown,
): string {
  const val = typeof validation === 'string' ? validation : JSON.stringify(validation);
  return template.replaceAll('{validation}', val).replaceAll('{corpus}', corpus);
}
