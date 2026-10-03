# 知乎分析采集器

基于 [chouheiwa/download-zhihu](https://github.com/chouheiwa/download-zhihu)（知乎文章下载器）改造，面向「回答 + 评论树 → 分析」场景。

## 相对原版的改动

- 扩展显示名：**知乎分析采集器**（`zhihu-analysis-collector`）
- **生成报告（工作台）**：知乎页一点 → 新开工作台页看进度 → 同页出议题树 HTML
- 首次使用：配置 API Key + 选择临时文件目录（存 `bundle.json` / `report.html`）
- 导出 **`*.bundle.json`**：正文元数据 + 评论树（id / 父子 / 点赞 / 时间 / IP / 作者标识等）
- 评论 API 响应做富字段归一化
- 默认勾选「导出评论区」与「导出分析用 JSON」

原 Markdown / Word 导出能力保留。请保留对原作者的致谢。

### 工作台怎么用

1. 重新加载扩展（`E:\zhihu-analysis-collector-dist`）
2. 打开知乎**回答直链**，点浮动按钮 → **生成报告（工作台）**
3. 首次：填 DeepSeek API Key，并选择临时目录
4. 自动采集 → 分析 → 页内预览报告（过程日志可见）
5. 提示词在工作台「设置 / 提示词」中可改，一般定稿后不用动

### 已有数据的恢复与重跑

- 采集被限流或部分请求失败时，工作台会先保存 `bundle.json`，并标记为「部分采集」，不会继续生成看似完整的报告。
- 工作台顶部「选择已有 bundle」可以跳过知乎采集，直接重新分析本地 bundle。
- 已有报告对应的 `.llm_raw.json` 时，可以使用「仅重新渲染 HTML」，不重新请求模型。
- 每次分析还会写出 `.analysis_meta.json`，记录模型、输入节点数、完整性状态和结果校验提醒。

## 构建与加载（Edge）

```bash
cd extension
npm ci
npm run build
```

1. 打开 `edge://extensions/` 或 `chrome://extensions/`
2. 开启「开发人员模式」
3. **建议先关闭商店版「知乎文章下载器」**，避免两个浮动按钮冲突
4. 「加载解压缩的扩展」→ 选择构建产物目录（见下）
5. 打开知乎**回答直链**，用面板导出（勾选评论 + JSON）

### 路径注意（Windows）

项目路径里若有中文（如 `个人项目`、`知乎…`），Chrome/Edge **加载解压缩扩展常会点了没反应**。  
请改用纯英文路径副本（构建后可再复制一次）：

```text
E:\zhihu-analysis-collector-dist
```

在资源管理器中：进入上一级 `E:\`，**选中**文件夹 `zhihu-analysis-collector-dist`，再点「选择文件夹」（不要只停在空列表里却未选中目录）。

开发热更新可用 `npm run dev`（按 Vite/CRX 提示加载）。

## 输出说明

单篇回答典型产物：

| 文件 | 说明 |
|------|------|
| `{标题}-作者的回答.md` | 正文 |
| `{标题}-作者的回答-评论.md` | 评论 Markdown（可选） |
| `{标题}-作者的回答.bundle.json` | **分析主输入** |

`bundle.json` 含 `schema_version`、`completeness`、`answer`、树状 `comments[]`、`stats`。

## 版本

当前 `0.2.0`，源自 upstream `3.1.0` 能力基线。
