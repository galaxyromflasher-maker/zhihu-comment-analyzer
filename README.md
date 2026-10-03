# 知乎分析系统

个人用：知乎回答与评论区采集 → 结构化数据 → AI 分析报告。

**交给其他 AI / 协作者时：请先读 [`交接文档.md`](交接文档.md)。**

## 当前进度

1. 需求与调研见 `杂项/`
2. **采集扩展 v0.2**：`extension/` — 工具栏或知乎页「打开工作台」预填后 **手动启动**；问题页先选回答
3. 实操备忘：`杂项/操作经验记录.md`（加载用 `E:\zhihu-analysis-collector-dist`）
4. **备选分析**：`run.py` / `webapp.py`（Python 侧仍可用）

## 扩展怎么用

见 [`extension/README.md`](extension/README.md)。构建后同步到 `E:\zhihu-analysis-collector-dist` 再「重新加载」。

## 分析怎么用

```powershell
cd E:\01个人项目\cursor项目\F_知乎分析系统
pip install -r requirements.txt
# 需已设置环境变量 DEEPSEEK_API_KEY（或项目根 .env）
python run.py "杂项\首次改造扩展导出\如何看待现在县城的中学逐渐衰弱？-默默的莫莫的回答\如何看待现在县城的中学逐渐衰弱？-默默的莫莫的回答.bundle.json"
```

输出在 bundle 同级 `analysis/`：

- **`report.html`**（主看这个：议题树可展开、态度条、争议、原话、全文）
- `topic_tree.md` / `analysis.md`（备份）
- `llm_raw.json`

已有分析结果时，只重生成 HTML（不耗 API）：

```powershell
python run.py "路径\xxx.bundle.json" --html-only
```

## 提示词工作台（网页）

```powershell
python webapp.py
```

浏览器打开 http://127.0.0.1:8765 ：预览 / 修改提示词，保存到 `configs/prompts.json`；也可在页内对 bundle 跑分析。

## 致谢

采集扩展基于 [chouheiwa/download-zhihu](https://github.com/chouheiwa/download-zhihu) 改造。
