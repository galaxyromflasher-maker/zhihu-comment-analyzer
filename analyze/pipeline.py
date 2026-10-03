from __future__ import annotations

from pathlib import Path
from typing import Any

from analyze.bundle import build_llm_corpus, load_bundle, validate_bundle
from analyze.llm import chat_json
from analyze.prompts import build_user_prompt, get_system_prompt
from analyze.render import build_analysis_doc, build_topic_tree_doc, dump_raw_result
from analyze.html_report import write_html_report
from analyze.validation import assert_valid_analysis_result


def analyze_bundle(bundle_path: str | Path, output_dir: str | Path | None = None) -> dict[str, Any]:
    bundle_path = Path(bundle_path)
    bundle = load_bundle(bundle_path)
    validation = validate_bundle(bundle)
    corpus = build_llm_corpus(bundle)

    result = chat_json(get_system_prompt(), build_user_prompt(corpus, validation))
    comment_ids = {str(c.get("id", "")) for c in _flatten_comments(bundle.get("comments") or [])}
    analysis_warnings = assert_valid_analysis_result(result, comment_ids)

    out_dir = Path(output_dir) if output_dir else bundle_path.parent / "analysis"
    out_dir.mkdir(parents=True, exist_ok=True)

    topic_path = out_dir / "topic_tree.md"
    report_path = out_dir / "analysis.md"
    raw_path = out_dir / "llm_raw.json"
    html_path = out_dir / "report.html"

    topic_path.write_text(build_topic_tree_doc(bundle, result), encoding="utf-8")
    report_path.write_text(build_analysis_doc(bundle, result, validation), encoding="utf-8")
    raw_path.write_text(dump_raw_result(result), encoding="utf-8")
    write_html_report(html_path, bundle, result, validation)

    return {
        "bundle": str(bundle_path),
        "output_dir": str(out_dir),
        "html": str(html_path),
        "topic_tree": str(topic_path),
        "analysis": str(report_path),
        "raw": str(raw_path),
        "validation": validation,
        "analysis_warnings": analysis_warnings,
    }


def _flatten_comments(comments: list[dict[str, Any]]) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for comment in comments:
        result.append(comment)
        result.extend(_flatten_comments(comment.get("children") or []))
    return result
