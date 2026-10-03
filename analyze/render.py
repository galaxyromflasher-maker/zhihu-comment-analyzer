from __future__ import annotations

import json
import re
from typing import Any


def _safe_id(node_id: str) -> str:
    s = re.sub(r"[^\w\u4e00-\u9fff]+", "_", str(node_id))
    if not s:
        s = "n"
    if s[0].isdigit():
        s = "n_" + s
    return s[:40]


def topic_tree_to_mermaid(tree: dict[str, Any]) -> str:
    lines = ["```mermaid", "flowchart TD"]
    edges: list[str] = []

    def walk(node: dict[str, Any], parent: str | None = None) -> None:
        nid = _safe_id(node.get("id") or node.get("title") or "node")
        title = str(node.get("title") or nid).replace('"', "'")
        stance = node.get("stance") or ""
        label = f"{title}"
        if stance:
            label += f"（{stance}）"
        lines.append(f'  {nid}["{label}"]')
        if parent:
            edges.append(f"  {parent} --> {nid}")
        for child in node.get("children") or []:
            if isinstance(child, dict):
                walk(child, nid)

    if tree:
        walk(tree)
    lines.extend(edges)
    lines.append("```")
    return "\n".join(lines)


def topic_tree_to_markdown(tree: dict[str, Any], level: int = 1) -> str:
    if not tree:
        return "_（无议题树）_\n"
    prefix = "#" * min(level + 1, 6)
    title = tree.get("title") or "未命名"
    summary = tree.get("summary") or ""
    stance = tree.get("stance") or ""
    quotes = tree.get("quote_ids") or []
    lines = [f"{prefix} {title}"]
    meta = []
    if stance:
        meta.append(f"立场标记: `{stance}`")
    if quotes:
        meta.append("引用评论: " + ", ".join(f"`{q}`" for q in quotes[:8]))
    if meta:
        lines.append("  \n".join(meta))
    if summary:
        lines.append("")
        lines.append(summary)
    lines.append("")
    for child in tree.get("children") or []:
        if isinstance(child, dict):
            lines.append(topic_tree_to_markdown(child, level + 1))
    return "\n".join(lines).rstrip() + "\n"


def build_topic_tree_doc(bundle: dict[str, Any], result: dict[str, Any]) -> str:
    answer = bundle.get("answer") or {}
    source = bundle.get("source") or {}
    tree = result.get("topic_tree") or {}
    parts = [
        f"# 议题树：{answer.get('question_title') or '未命名'}",
        "",
        f"- 答主：{(answer.get('author') or {}).get('name', '')}",
        f"- 来源：{source.get('url', '')}",
        f"- 说明：以答主回答为根；主干为回答要点与评论主线，分支为评论引申议题。",
        "",
        "## 图谱（Mermaid）",
        "",
        topic_tree_to_mermaid(tree),
        "",
        "## 文字树",
        "",
        topic_tree_to_markdown(tree, level=1),
    ]
    return "\n".join(parts).rstrip() + "\n"


def build_analysis_doc(bundle: dict[str, Any], result: dict[str, Any], validation: dict[str, Any]) -> str:
    answer = bundle.get("answer") or {}
    source = bundle.get("source") or {}
    stance = result.get("stance") or {}
    report = (result.get("report_markdown") or "").strip()
    header = [
        f"# 分析报告：{answer.get('question_title') or '未命名'}",
        "",
        f"- 答主：{(answer.get('author') or {}).get('name', '')}",
        f"- 来源：{source.get('url', '')}",
        f"- 评论节点：{validation.get('captured_comment_count')}",
        f"- 态度估算（支持/反对/中立）：{stance.get('support')}% / {stance.get('oppose')}% / {stance.get('neutral')}%",
        f"- 态度说明：{stance.get('note', '')}",
        "",
        "---",
        "",
    ]
    if report:
        body = report
    else:
        body = _fallback_report(result)
    return "\n".join(header) + body.rstrip() + "\n"


def _fallback_report(result: dict[str, Any]) -> str:
    lines = [
        "## 一、答主摘要",
        "",
        str(result.get("answer_summary") or ""),
        "",
        "## 二、争议点",
        "",
    ]
    for c in result.get("controversies") or []:
        lines.append(f"- {c}")
    lines += ["", "## 三、代表性原话", ""]
    for h in result.get("highlights") or []:
        lines.append(
            f"- （👍{h.get('likes', 0)} · {h.get('author', '')}）{h.get('text', '')} — {h.get('why', '')}"
        )
    return "\n".join(lines)


def dump_raw_result(result: dict[str, Any]) -> str:
    return json.dumps(result, ensure_ascii=False, indent=2) + "\n"
