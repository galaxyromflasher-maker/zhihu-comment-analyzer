from __future__ import annotations

import json
from pathlib import Path
from typing import Any


def load_bundle(path: str | Path) -> dict[str, Any]:
    p = Path(path)
    if not p.exists():
        raise FileNotFoundError(f"找不到 bundle: {p}")
    data = json.loads(p.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError("bundle 根节点必须是 JSON 对象")
    if "answer" not in data or "comments" not in data:
        raise ValueError("bundle 缺少 answer 或 comments 字段")
    return data


def flatten_comments(comments: list[dict[str, Any]], acc: list[dict[str, Any]] | None = None) -> list[dict[str, Any]]:
    acc = acc if acc is not None else []
    for c in comments:
        acc.append(c)
        children = c.get("children") or []
        if children:
            flatten_comments(children, acc)
    return acc


def validate_bundle(bundle: dict[str, Any]) -> dict[str, Any]:
    comments = bundle.get("comments") or []
    flat = flatten_comments(comments)
    stats = bundle.get("stats") or {}
    declared = stats.get("total_nodes")
    captured = len(flat)
    expected = (bundle.get("completeness") or {}).get("expected_comment_count")
    ratio = None
    if isinstance(expected, (int, float)) and expected > 0:
        ratio = min(1.0, captured / float(expected))
    return {
        "root_count": len(comments),
        "captured_comment_count": captured,
        "declared_total_nodes": declared,
        "expected_comment_count": expected,
        "capture_ratio": ratio,
        "nodes_match_declared": declared is None or declared == captured,
    }


def _trim(text: str | None, limit: int) -> str:
    t = (text or "").replace("\n", " ").strip()
    if len(t) <= limit:
        return t
    return t[: limit - 1] + "…"


def build_llm_corpus(bundle: dict[str, Any], *, answer_limit: int = 3500, comment_limit: int = 180) -> str:
    """压缩为适合喂给模型的语料。"""
    answer = bundle.get("answer") or {}
    source = bundle.get("source") or {}
    flat = flatten_comments(bundle.get("comments") or [])
    # 按点赞排序，保证高赞优先完整保留；全部仍纳入，仅截断正文
    ranked = sorted(flat, key=lambda c: int(c.get("like_count") or 0), reverse=True)

    lines: list[str] = []
    lines.append(f"URL: {source.get('url', '')}")
    lines.append(f"问题: {answer.get('question_title', '')}")
    lines.append(f"答主: {(answer.get('author') or {}).get('name', '')}")
    lines.append(f"评论节点数: {len(flat)}")
    lines.append("")
    lines.append("【答主回答】")
    lines.append(_trim(answer.get("content_text"), answer_limit))
    lines.append("")
    lines.append("【评论列表】格式: id | depth | likes | author | ip | 正文")
    for c in ranked:
        author = (c.get("author") or {}).get("name", "")
        lines.append(
            " | ".join(
                [
                    str(c.get("id", "")),
                    str(c.get("depth", 0)),
                    str(c.get("like_count") or 0),
                    author,
                    str(c.get("ip_location") or ""),
                    _trim(c.get("content_text"), comment_limit),
                ]
            )
        )
    return "\n".join(lines)
