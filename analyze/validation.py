from __future__ import annotations

from typing import Any


class AnalysisValidationError(ValueError):
    def __init__(self, errors: list[str], warnings: list[str] | None = None) -> None:
        self.errors = errors
        self.warnings = warnings or []
        super().__init__("模型结果校验失败：" + "；".join(errors))


_STANCES = {"author", "support", "oppose", "neutral", "mixed"}


def validate_analysis_result(
    result: Any,
    comment_ids: set[str] | None = None,
) -> dict[str, list[str]]:
    errors: list[str] = []
    warnings: list[str] = []

    if not isinstance(result, dict):
        return {"errors": ["模型结果不是 JSON 对象"], "warnings": []}

    if not isinstance(result.get("answer_summary"), str) or not result["answer_summary"].strip():
        errors.append("缺少 answer_summary")

    stance = result.get("stance")
    if not isinstance(stance, dict):
        errors.append("缺少 stance 对象")
    else:
        values = [stance.get(key) for key in ("support", "oppose", "neutral")]
        for key, value in zip(("support", "oppose", "neutral"), values):
            if not isinstance(value, (int, float)) or isinstance(value, bool) or not 0 <= value <= 100:
                errors.append(f"stance.{key} 不是 0 到 100 的数字")
        if all(isinstance(value, (int, float)) and not isinstance(value, bool) for value in values):
            total = sum(values)
            if abs(total - 100) > 5:
                warnings.append(f"态度比例之和为 {total}，与 100 偏差超过 5")
        if not isinstance(stance.get("note"), str):
            warnings.append("stance.note 缺失")

    if not isinstance(result.get("controversies"), list):
        errors.append("controversies 不是数组")

    counts = {"nodes": 0, "max_depth": 0}

    def walk(node: Any, depth: int, root: bool = False) -> None:
        if not isinstance(node, dict):
            errors.append("topic_tree 包含非对象节点")
            return
        counts["nodes"] += 1
        counts["max_depth"] = max(counts["max_depth"], depth)
        title = str(node.get("title") or "未命名")
        if not isinstance(node.get("title"), str) or not node["title"].strip():
            errors.append(f"议题树第 {depth + 1} 层缺少 title")
        if not isinstance(node.get("summary"), str):
            errors.append(f"议题树节点“{title}”缺少 summary")
        if node.get("stance") not in _STANCES:
            errors.append(f"议题树节点“{title}”的 stance 无效")
        elif root and node["stance"] != "author":
            warnings.append("议题树根节点的 stance 不是 author")
        quote_ids = node.get("quote_ids")
        if not isinstance(quote_ids, list):
            errors.append(f"议题树节点“{title}”的 quote_ids 不是数组")
        elif comment_ids is not None:
            for quote_id in quote_ids:
                if not isinstance(quote_id, str) or quote_id not in comment_ids:
                    warnings.append(f"议题树节点“{title}”引用了不存在的评论：{quote_id}")
        children = node.get("children")
        if not isinstance(children, list):
            errors.append(f"议题树节点“{title}”的 children 不是数组")
        else:
            for child in children:
                walk(child, depth + 1)

    walk(result.get("topic_tree"), 0, True)
    if counts["nodes"] > 40:
        warnings.append(f"议题树节点数为 {counts['nodes']}，阅读负担较大")

    highlights = result.get("highlights")
    if not isinstance(highlights, list):
        errors.append("highlights 不是数组")
    else:
        for item in highlights:
            if not isinstance(item, dict):
                errors.append("highlights 包含非对象条目")
                continue
            comment_id = item.get("comment_id")
            if not isinstance(comment_id, str):
                errors.append("highlight 缺少 comment_id")
            elif comment_ids is not None and comment_id and comment_id not in comment_ids:
                warnings.append(f"典型原话引用了不存在的评论：{comment_id}")
            if not isinstance(item.get("text"), str) or not item["text"].strip():
                errors.append("highlight 缺少 text")

    if not isinstance(result.get("report_markdown"), str) or not result["report_markdown"].strip():
        errors.append("缺少 report_markdown")

    return {"errors": errors, "warnings": warnings}


def assert_valid_analysis_result(
    result: Any,
    comment_ids: set[str] | None = None,
) -> list[str]:
    validation = validate_analysis_result(result, comment_ids)
    if validation["errors"]:
        raise AnalysisValidationError(validation["errors"], validation["warnings"])
    return validation["warnings"]

