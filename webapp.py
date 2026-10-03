#!/usr/bin/env python3
"""本地网页：提示词预览/编辑 + 可选跑分析。

  python webapp.py
  浏览器打开 http://127.0.0.1:8765
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, Field
import uvicorn

ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from analyze.bundle import build_llm_corpus, load_bundle, validate_bundle
from analyze.pipeline import analyze_bundle
from analyze.prompts import (
    PROMPTS_PATH,
    default_prompts,
    load_prompts,
    render_user_prompt,
    save_prompts,
)

app = FastAPI(title="知乎分析系统 · 提示词工作台")


class PromptSaveBody(BaseModel):
    system: str
    user_template: str


class PreviewBody(BaseModel):
    system: str | None = None
    user_template: str | None = None
    bundle_path: str = Field(..., description="bundle.json 路径")


class AnalyzeBody(BaseModel):
    bundle_path: str
    output_dir: str | None = None


def _resolve_bundle(path_str: str) -> Path:
    p = Path(path_str)
    if not p.is_absolute():
        p = (ROOT / p).resolve()
    else:
        p = p.resolve()
    if not p.exists():
        raise HTTPException(404, f"找不到文件: {p}")
    return p


@app.get("/", response_class=HTMLResponse)
def index() -> str:
    return (ROOT / "web" / "index.html").read_text(encoding="utf-8")


@app.get("/api/prompts")
def api_get_prompts():
    data = load_prompts()
    return {
        "path": str(PROMPTS_PATH),
        "system": data["system"],
        "user_template": data["user_template"],
        "version": data.get("version", 1),
    }


@app.post("/api/prompts")
def api_save_prompts(body: PromptSaveBody):
    path = save_prompts(
        {
            "version": 1,
            "system": body.system,
            "user_template": body.user_template,
        }
    )
    return {"ok": True, "path": str(path)}


@app.post("/api/prompts/reset")
def api_reset_prompts():
    path = save_prompts(default_prompts())
    data = load_prompts()
    return {
        "ok": True,
        "path": str(path),
        "system": data["system"],
        "user_template": data["user_template"],
    }


@app.post("/api/preview")
def api_preview(body: PreviewBody):
    stored = load_prompts()
    system = body.system if body.system is not None else stored["system"]
    template = body.user_template if body.user_template is not None else stored["user_template"]
    bundle_path = _resolve_bundle(body.bundle_path)
    bundle = load_bundle(bundle_path)
    validation = validate_bundle(bundle)
    corpus = build_llm_corpus(bundle)
    user = render_user_prompt(template, corpus, validation)
    return {
        "bundle": str(bundle_path),
        "validation": validation,
        "corpus_chars": len(corpus),
        "system": system,
        "user": user,
        "system_chars": len(system),
        "user_chars": len(user),
    }


@app.post("/api/analyze")
def api_analyze(body: AnalyzeBody):
    bundle_path = _resolve_bundle(body.bundle_path)
    try:
        info = analyze_bundle(bundle_path, body.output_dir)
    except Exception as e:
        raise HTTPException(500, str(e)) from e
    return info


@app.get("/api/sample-bundle")
def api_sample_bundle():
    samples = sorted(ROOT.joinpath("杂项").rglob("*.bundle.json"))
    return {
        "samples": [str(p.relative_to(ROOT)).replace("\\", "/") for p in samples]
    }


def main() -> None:
    print("提示词工作台: http://127.0.0.1:8765")
    print(f"提示词文件: {PROMPTS_PATH}")
    uvicorn.run(app, host="127.0.0.1", port=8765, log_level="info")


if __name__ == "__main__":
    main()
