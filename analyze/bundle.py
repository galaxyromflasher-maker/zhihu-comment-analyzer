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
    completeness = bundle.get("completeness") or {}
    declared = stats.get("total_nodes")
    captured = len(flat)
    expected = completeness.get("expected_comment_count")
    ratio = None
    if isinstance(expected, (int, float)) and expected > 0:
        ratio = min(1.0, captured / float(expected))
    return {
        "completeness_status": completeness.get("status", "unknown"),
        "root_count": len(comments),
        "captured_root_count": completeness.get("captured_root_count", len(comments)),
        "captured_comment_count": captured,
        "declared_total_nodes": declared,
        "expected_comment_count": expected,
        "expected_root_count": completeness.get("expected_root_count"),
        "api_declared_count": completeness.get("api_declared_count"),
        "child_requests": completeness.get("child_requests", 0),
        "child_completed": completeness.get("child_completed", 0),
        "child_failed_ids": completeness.get("child_failed_ids", []),
        "child_skipped_ids": completeness.get("child_skipped_ids", []),
        "root_pagination_complete": completeness.get("root_pagination_complete", True),
        "rate_limited": completeness.get("rate_limited", False),
        "warnings": completeness.get("warnings", []),
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
    lines.append(f"数据状态: {(bundle.get('completeness') or {}).get('status', 'unknown')}")
    bundle_warnings = (bundle.get("completeness") or {}).get("warnings") or []
    if bundle_warnings:
        lines.append(f"完整性提醒: {'; '.join(str(item) for item in bundle_warnings[:8])}")
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
