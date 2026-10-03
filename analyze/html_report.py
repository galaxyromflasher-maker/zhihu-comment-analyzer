from __future__ import annotations

import html
import json
import re
from pathlib import Path
from typing import Any

STANCE_LABEL = {
    "author": "答主",
    "support": "支持",
    "oppose": "反对",
    "neutral": "中立",
    "mixed": "混合",
}


def _esc(text: Any) -> str:
    return html.escape("" if text is None else str(text), quote=True)


def _stance_badge(stance: str) -> str:
    key = (stance or "").strip().lower()
    label = STANCE_LABEL.get(key, stance or "未标")
    return f'<span class="badge badge-{_esc(key or "unknown")}">{_esc(label)}</span>'


def _render_tree_node(node: dict[str, Any], depth: int = 0) -> str:
    if not isinstance(node, dict):
        return ""
    title = _esc(node.get("title") or "未命名")
    summary = _esc(node.get("summary") or "")
    stance = str(node.get("stance") or "")
    quotes = node.get("quote_ids") or []
    children = [c for c in (node.get("children") or []) if isinstance(c, dict)]
    quote_html = ""
    if quotes:
        chips = " ".join(f'<code class="chip">{_esc(q)}</code>' for q in quotes[:10])
        quote_html = f'<div class="quotes">引用评论 {chips}</div>'

    kids = "".join(_render_tree_node(c, depth + 1) for c in children)
    open_attr = "open" if depth < 2 else ""
    body = f"""
    <div class="node-body">
      <div class="node-title-row">
        <strong class="node-title">{title}</strong>
        {_stance_badge(stance)}
      </div>
      <p class="node-summary">{summary}</p>
      {quote_html}
    </div>
    """
    if kids:
        return f"""
        <li class="tree-item depth-{depth}">
          <details class="tree-node" {open_attr}>
            <summary>{body}</summary>
            <ul class="tree-children">{kids}</ul>
          </details>
        </li>
        """
    return f'<li class="tree-item depth-{depth}"><div class="tree-node leaf">{body}</div></li>'


def _simple_md_to_html(md: str) -> str:
    """极简 Markdown → HTML，够用看报告正文。"""
    if not md.strip():
        return "<p class='muted'>（无报告正文）</p>"
    lines = md.replace("\r\n", "\n").split("\n")
    out: list[str] = []
    in_ul = False

    def close_ul() -> None:
        nonlocal in_ul
        if in_ul:
            out.append("</ul>")
            in_ul = False

    for raw in lines:
        line = raw.rstrip()
        if not line.strip():
            close_ul()
            continue
        if line.startswith("### "):
            close_ul()
            out.append(f"<h4>{_esc(line[4:])}</h4>")
        elif line.startswith("## "):
            close_ul()
            out.append(f"<h3>{_esc(line[3:])}</h3>")
        elif line.startswith("# "):
            close_ul()
            out.append(f"<h2>{_esc(line[2:])}</h2>")
        elif re.match(r"^[-*]\s+", line):
            if not in_ul:
                out.append("<ul>")
                in_ul = True
            raw_item = re.sub(r"^[-*]\s+", "", line)
            parts = re.split(r"(\*\*.+?\*\*)", raw_item)
            buf: list[str] = []
            for p in parts:
                if p.startswith("**") and p.endswith("**") and len(p) >= 4:
                    buf.append(f"<strong>{_esc(p[2:-2])}</strong>")
                else:
                    buf.append(_esc(p))
            out.append(f"<li>{''.join(buf)}</li>")
        else:
            close_ul()
            parts = re.split(r"(\*\*.+?\*\*)", line)
            buf = []
            for p in parts:
                if p.startswith("**") and p.endswith("**") and len(p) >= 4:
                    buf.append(f"<strong>{_esc(p[2:-2])}</strong>")
                else:
                    buf.append(_esc(p))
            out.append(f"<p>{''.join(buf)}</p>")
    close_ul()
    return "\n".join(out)


def build_html_report(
    bundle: dict[str, Any],
    result: dict[str, Any],
    validation: dict[str, Any],
) -> str:
    answer = bundle.get("answer") or {}
    source = bundle.get("source") or {}
    stance = result.get("stance") or {}
    tree = result.get("topic_tree") or {}
    title = answer.get("question_title") or "未命名分析"
    author = (answer.get("author") or {}).get("name", "")
    url = source.get("url") or ""
    summary = result.get("answer_summary") or ""
    support = int(stance.get("support") or 0)
    oppose = int(stance.get("oppose") or 0)
    neutral = int(stance.get("neutral") or 0)
    note = stance.get("note") or ""
    controversies = result.get("controversies") or []
    highlights = result.get("highlights") or []
    report_md = (result.get("report_markdown") or "").strip()
    completeness = bundle.get("completeness") or {}
    completeness_status = completeness.get("status", validation.get("completeness_status", "unknown"))
    status_label = {
        "complete": "采集完整",
        "partial": "部分采集",
        "unknown": "完整性未知",
    }.get(completeness_status, "完整性未知")
    completeness_warnings = completeness.get("warnings") or validation.get("warnings") or []

    tree_html = (
        f'<ul class="tree-root">{_render_tree_node(tree)}</ul>'
        if tree
        else '<p class="muted">（无议题树）</p>'
    )

    controversy_html = (
        "<ol class='list'>"
        + "".join(f"<li>{_esc(c)}</li>" for c in controversies)
        + "</ol>"
        if controversies
        else "<p class='muted'>（无）</p>"
    )

    highlight_items = []
    for h in highlights:
        highlight_items.append(
            f"""
            <article class="quote-card">
              <header>
                <span class="likes">👍 {_esc(h.get('likes', 0))}</span>
                <span class="who">{_esc(h.get('author', ''))}</span>
                <code class="chip">{_esc(h.get('comment_id', ''))}</code>
              </header>
              <p class="quote-text">{_esc(h.get('text', ''))}</p>
              <p class="quote-why">{_esc(h.get('why', ''))}</p>
            </article>
            """
        )
    highlights_html = "".join(highlight_items) or "<p class='muted'>（无）</p>"

    return f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>议题树报告 · {_esc(title)}</title>
  <style>
    :root {{
      --bg: #f2efe8;
      --panel: #fffcf6;
      --ink: #1a1917;
      --muted: #5f5a52;
      --line: #d8d0c3;
      --root: #0f5c52;
      --support: #2f6b3a;
      --oppose: #9a3b2f;
      --neutral: #6a6570;
      --mixed: #9a6b16;
      --author: #0f5c52;
      --unknown: #7a746a;
      --shadow: 0 10px 30px rgba(40, 30, 10, 0.06);
      --sans: "Source Han Sans SC", "Noto Sans SC", "Segoe UI", sans-serif;
      --mono: "Cascadia Mono", Consolas, monospace;
    }}
    * {{ box-sizing: border-box; }}
    body {{
      margin: 0;
      font-family: var(--sans);
      color: var(--ink);
      background:
        radial-gradient(900px 480px at 0% -10%, #dde8e3 0%, transparent 55%),
        radial-gradient(700px 420px at 100% 0%, #efe3d2 0%, transparent 50%),
        var(--bg);
      line-height: 1.6;
    }}
    .wrap {{ max-width: 980px; margin: 0 auto; padding: 1.5rem 1.2rem 3rem; }}
    header.hero {{
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 16px;
      padding: 1.25rem 1.35rem;
      box-shadow: var(--shadow);
      margin-bottom: 1rem;
    }}
    header.hero h1 {{ margin: 0 0 0.4rem; font-size: 1.45rem; }}
    header.hero .meta {{ color: var(--muted); font-size: 0.92rem; }}
    header.hero a {{ color: var(--root); }}
    nav.toc {{
      display: flex; flex-wrap: wrap; gap: 0.45rem;
      margin: 1rem 0 1.25rem;
    }}
    nav.toc a {{
      text-decoration: none;
      color: var(--ink);
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 0.28rem 0.75rem;
      font-size: 0.85rem;
    }}
    section.card {{
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 16px;
      padding: 1.1rem 1.2rem 1.25rem;
      margin-bottom: 1rem;
      box-shadow: var(--shadow);
    }}
    section.card h2 {{
      margin: 0 0 0.75rem;
      font-size: 1.1rem;
      padding-bottom: 0.45rem;
      border-bottom: 1px solid var(--line);
    }}
    .muted {{ color: var(--muted); }}
    .bars {{
      display: grid;
      gap: 0.55rem;
      margin: 0.75rem 0;
    }}
    .bar-row {{ display: grid; grid-template-columns: 3.5rem 1fr 2.5rem; gap: 0.5rem; align-items: center; }}
    .bar-track {{ background: #ebe4d8; border-radius: 999px; overflow: hidden; height: 0.7rem; }}
    .bar-fill {{ height: 100%; border-radius: 999px; }}
    .bar-fill.support {{ background: var(--support); width: {support}%; }}
    .bar-fill.oppose {{ background: var(--oppose); width: {oppose}%; }}
    .bar-fill.neutral {{ background: var(--neutral); width: {neutral}%; }}
    .badge {{
      display: inline-block;
      font-size: 0.75rem;
      padding: 0.12rem 0.45rem;
      border-radius: 999px;
      color: #fff;
      vertical-align: middle;
    }}
    .badge-author {{ background: var(--author); }}
    .badge-support {{ background: var(--support); }}
    .badge-oppose {{ background: var(--oppose); }}
    .badge-neutral {{ background: var(--neutral); }}
    .badge-mixed {{ background: var(--mixed); }}
    .badge-unknown {{ background: var(--unknown); }}
    .tree-root, .tree-children {{
      list-style: none;
      margin: 0;
      padding: 0;
    }}
    .tree-children {{
      margin: 0.55rem 0 0.15rem 0.85rem;
      padding-left: 0.85rem;
      border-left: 2px solid #cfc5b5;
    }}
    .tree-node {{
      background: #fff;
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 0.7rem 0.85rem;
    }}
    .tree-node.leaf {{ margin-bottom: 0.45rem; }}
    details.tree-node > summary {{
      list-style: none;
      cursor: pointer;
    }}
    details.tree-node > summary::-webkit-details-marker {{ display: none; }}
    .node-title-row {{
      display: flex; flex-wrap: wrap; gap: 0.45rem; align-items: center;
    }}
    .node-title {{ font-size: 0.98rem; }}
    .node-summary {{
      margin: 0.4rem 0 0;
      color: var(--muted);
      font-size: 0.9rem;
    }}
    .quotes {{ margin-top: 0.4rem; font-size: 0.8rem; color: var(--muted); }}
    .chip {{
      font-family: var(--mono);
      font-size: 0.72rem;
      background: #f0ebe2;
      padding: 0.05rem 0.3rem;
      border-radius: 4px;
    }}
    .list {{ margin: 0.25rem 0 0 1.1rem; }}
    .quote-card {{
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 0.75rem 0.85rem;
      margin: 0.55rem 0;
      background: #fff;
    }}
    .quote-card header {{
      display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center;
      margin-bottom: 0.35rem; font-size: 0.85rem; color: var(--muted);
    }}
    .quote-text {{ margin: 0.2rem 0; }}
    .quote-why {{ margin: 0.35rem 0 0; color: var(--muted); font-size: 0.86rem; }}
    .report-body h2, .report-body h3, .report-body h4 {{ margin: 1rem 0 0.4rem; }}
    .report-body p {{ margin: 0.4rem 0; }}
    .report-body ul {{ margin: 0.3rem 0 0.6rem 1.2rem; }}
    .data-status {{ border-left: 4px solid var(--unknown); }}
    .data-status.complete {{ border-left-color: var(--support); }}
    .data-status.partial {{ border-left-color: var(--oppose); background: #fff8f5; }}
    .data-status strong {{ margin-right: 0.8rem; }}
    footer.note {{
      color: var(--muted);
      font-size: 0.8rem;
      text-align: center;
      margin-top: 1.5rem;
    }}
  </style>
</head>
<body>
  <div class="wrap">
    <header class="hero">
      <h1>{_esc(title)}</h1>
      <div class="meta">
        答主：{_esc(author)} · 评论节点：{_esc(validation.get('captured_comment_count'))} · 数据状态：{_esc(status_label)}
        {" · <a href='" + _esc(url) + "' target='_blank' rel='noopener'>原回答</a>" if url else ""}
      </div>
    </header>

    <section class="card data-status {_esc(completeness_status)}" id="data-status">
      <h2>数据状态</h2>
      <p><strong>{_esc(status_label)}</strong> 总节点 {_esc(validation.get('captured_comment_count'))} · 一级 {_esc(validation.get('captured_root_count', validation.get('root_count')))}</p>
      <p class="muted">楼中楼成功 {_esc(validation.get('child_completed', 0))} / {_esc(validation.get('child_requests', 0))}，一级分页{"已结束" if validation.get('root_pagination_complete', True) else "未完整结束"}。</p>
      {("<ul>" + "".join(f"<li>{_esc(item)}</li>" for item in completeness_warnings[:8]) + "</ul>") if completeness_warnings else ""}
    </section>

    <nav class="toc">
      <a href="#summary">答主摘要</a>
      <a href="#stance">态度估算</a>
      <a href="#tree">议题树</a>
      <a href="#controversies">争议点</a>
      <a href="#highlights">典型原话</a>
      <a href="#report">完整报告</a>
    </nav>

    <section class="card" id="summary">
      <h2>一、答主摘要</h2>
      <p>{_esc(summary)}</p>
    </section>

    <section class="card" id="stance">
      <h2>二、态度估算</h2>
      <div class="bars">
        <div class="bar-row"><span>支持</span><div class="bar-track"><div class="bar-fill support"></div></div><span>{support}%</span></div>
        <div class="bar-row"><span>反对</span><div class="bar-track"><div class="bar-fill oppose"></div></div><span>{oppose}%</span></div>
        <div class="bar-row"><span>中立</span><div class="bar-track"><div class="bar-fill neutral"></div></div><span>{neutral}%</span></div>
      </div>
      <p class="muted">{_esc(note)}</p>
    </section>

    <section class="card" id="tree">
      <h2>三、议题树</h2>
      <p class="muted">以答主回答为根；点击节点可展开/收起分支。颜色标记：答主 / 支持 / 反对 / 中立 / 混合。</p>
      {tree_html}
    </section>

    <section class="card" id="controversies">
      <h2>四、争议点</h2>
      {controversy_html}
    </section>

    <section class="card" id="highlights">
      <h2>五、高赞 / 典型原话</h2>
      {highlights_html}
    </section>

    <section class="card" id="report">
      <h2>六、完整报告</h2>
      <div class="report-body">
        {_simple_md_to_html(report_md)}
      </div>
    </section>

    <footer class="note">由知乎分析系统生成 · 议题树为 AI 归纳，态度为估算非精确统计</footer>
  </div>
</body>
</html>
"""


def write_html_report(
    path: str | Path,
    bundle: dict[str, Any],
    result: dict[str, Any],
    validation: dict[str, Any],
) -> Path:
    p = Path(path)
    p.write_text(build_html_report(bundle, result, validation), encoding="utf-8")
    return p


def rebuild_html_from_raw(
    bundle_path: str | Path,
    raw_path: str | Path | None = None,
    output_html: str | Path | None = None,
) -> Path:
    """不调用 LLM，用已有 llm_raw.json 重生成 HTML。"""
    from analyze.bundle import load_bundle, validate_bundle

    bundle_path = Path(bundle_path)
    bundle = load_bundle(bundle_path)
    validation = validate_bundle(bundle)
    raw_path = Path(raw_path) if raw_path else bundle_path.parent / "analysis" / "llm_raw.json"
    result = json.loads(raw_path.read_text(encoding="utf-8"))
    out = Path(output_html) if output_html else raw_path.parent / "report.html"
    return write_html_report(out, bundle, result, validation)
