#!/usr/bin/env python3
"""一键分析：读 bundle.json → 议题树 + 分析报告。

用法:
  python run.py path/to/xxx.bundle.json
  python run.py path/to/xxx.bundle.json -o path/to/outdir
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="知乎 bundle 分析（议题树 + 报告）")
    parser.add_argument("bundle", help="扩展导出的 *.bundle.json 路径")
    parser.add_argument(
        "-o",
        "--output",
        help="输出目录（默认：bundle 同级 analysis/）",
        default=None,
    )
    parser.add_argument(
        "--html-only",
        action="store_true",
        help="不调用 LLM，仅用已有 analysis/llm_raw.json 重生成 report.html",
    )
    args = parser.parse_args(argv)

    # 保证可从任意 cwd 以脚本方式运行
    root = Path(__file__).resolve().parent
    if str(root) not in sys.path:
        sys.path.insert(0, str(root))

    if args.html_only:
        from analyze.html_report import rebuild_html_from_raw

        try:
            html_path = rebuild_html_from_raw(args.bundle)
        except Exception as e:
            print(f"[失败] {e}", file=sys.stderr)
            return 1
        print(f"[完成] 已重生成 HTML: {html_path}")
        return 0

    from analyze.pipeline import analyze_bundle

    try:
        info = analyze_bundle(args.bundle, args.output)
    except Exception as e:
        print(f"[失败] {e}", file=sys.stderr)
        return 1

    print("[完成] 知乎分析")
    print(f"  bundle : {info['bundle']}")
    print(f"  校验   : {json.dumps(info['validation'], ensure_ascii=False)}")
    print(f"  HTML   : {info.get('html')}")
    print(f"  议题树 : {info['topic_tree']}")
    print(f"  报告MD : {info['analysis']}")
    print(f"  原始JSON: {info['raw']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
