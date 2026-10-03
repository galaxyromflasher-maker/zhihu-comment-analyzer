/* 自包含 HTML 报告（议题树可展开） */

type AnyRec = Record<string, unknown>;

function esc(text: unknown): string {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const STANCE_LABEL: Record<string, string> = {
  author: '答主',
  support: '支持',
  oppose: '反对',
  neutral: '中立',
  mixed: '混合',
};

function badge(stance: string): string {
  const key = (stance || 'unknown').toLowerCase();
  const label = STANCE_LABEL[key] || stance || '未标';
  return `<span class="badge badge-${esc(key)}">${esc(label)}</span>`;
}

function renderNode(node: AnyRec, depth = 0): string {
  const title = esc(node.title || '未命名');
  const summary = esc(node.summary || '');
  const stance = String(node.stance || '');
  const quotes = (node.quote_ids as string[]) || [];
  const children = ((node.children as AnyRec[]) || []).filter(Boolean);
  const quoteHtml = quotes.length
    ? `<div class="quotes">引用 ${quotes.slice(0, 10).map((q) => `<code class="chip">${esc(q)}</code>`).join(' ')}</div>`
    : '';
  const body = `<div class="node-body"><div class="node-title-row"><strong>${title}</strong>${badge(stance)}</div><p class="node-summary">${summary}</p>${quoteHtml}</div>`;
  const kids = children.map((c) => renderNode(c, depth + 1)).join('');
  if (kids) {
    const open = depth < 2 ? 'open' : '';
    return `<li class="tree-item"><details class="tree-node" ${open}><summary>${body}</summary><ul class="tree-children">${kids}</ul></details></li>`;
  }
  return `<li class="tree-item"><div class="tree-node leaf">${body}</div></li>`;
}

function mdLite(md: string): string {
  if (!md.trim()) return '<p class="muted">（无）</p>';
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let ul = false;
  const close = () => {
    if (ul) {
      out.push('</ul>');
      ul = false;
    }
  };
  const inline = (s: string) =>
    s
      .split(/(\*\*.+?\*\*)/g)
      .map((p) =>
        p.startsWith('**') && p.endsWith('**') && p.length >= 4
          ? `<strong>${esc(p.slice(2, -2))}</strong>`
          : esc(p),
      )
      .join('');
  for (const line of lines) {
    if (!line.trim()) {
      close();
      continue;
    }
    if (line.startsWith('### ')) {
      close();
      out.push(`<h4>${esc(line.slice(4))}</h4>`);
    } else if (line.startsWith('## ')) {
      close();
      out.push(`<h3>${esc(line.slice(3))}</h3>`);
    } else if (line.startsWith('# ')) {
      close();
      out.push(`<h2>${esc(line.slice(2))}</h2>`);
    } else if (/^[-*]\s+/.test(line)) {
      if (!ul) {
        out.push('<ul>');
        ul = true;
      }
      out.push(`<li>${inline(line.replace(/^[-*]\s+/, ''))}</li>`);
    } else {
      close();
      out.push(`<p>${inline(line)}</p>`);
    }
  }
  close();
  return out.join('\n');
}

export function buildHtmlReport(opts: {
  title: string;
  author: string;
  url: string;
  commentCount: number;
  result: AnyRec;
}): string {
  const stance = (opts.result.stance as AnyRec) || {};
  const support = Number(stance.support || 0);
  const oppose = Number(stance.oppose || 0);
  const neutral = Number(stance.neutral || 0);
  const tree = (opts.result.topic_tree as AnyRec) || null;
  const controversies = (opts.result.controversies as string[]) || [];
  const highlights = (opts.result.highlights as AnyRec[]) || [];
  const summary = String(opts.result.answer_summary || '');
  const note = String(stance.note || '');
  const reportMd = String(opts.result.report_markdown || '');

  const treeHtml = tree
    ? `<ul class="tree-root">${renderNode(tree)}</ul>`
    : '<p class="muted">（无议题树）</p>';
  const controversyHtml = controversies.length
    ? `<ol>${controversies.map((c) => `<li>${esc(c)}</li>`).join('')}</ol>`
    : '<p class="muted">（无）</p>';
  const highlightHtml =
    highlights
      .map(
        (h) => `<article class="quote-card"><header><span>👍 ${esc(h.likes)}</span><span>${esc(h.author)}</span></header><p>${esc(h.text)}</p><p class="muted">${esc(h.why)}</p></article>`,
      )
      .join('') || '<p class="muted">（无）</p>';

  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>${esc(opts.title)}</title>
<style>
:root{--bg:#f4f2ec;--panel:#fffcf7;--ink:#171614;--muted:#5f5a52;--line:#d9d1c4;--accent:#0f5c52;--support:#2f6b3a;--oppose:#9a3b2f;--neutral:#6a6570;--mixed:#9a6b16}
*{box-sizing:border-box}body{margin:0;font-family:"Segoe UI","Noto Sans SC",sans-serif;color:var(--ink);background:radial-gradient(900px 420px at 0% -10%,#dfeae5,transparent 55%),var(--bg);line-height:1.6}
.wrap{max-width:960px;margin:0 auto;padding:1.25rem}
.card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:1rem 1.1rem;margin:0 0 1rem;box-shadow:0 8px 24px rgba(40,30,10,.05)}
h1{margin:0 0 .4rem;font-size:1.35rem}.muted{color:var(--muted)}.badge{display:inline-block;color:#fff;border-radius:999px;padding:.1rem .45rem;font-size:.72rem;margin-left:.35rem}
.badge-author,.badge-support{background:var(--support)}.badge-oppose{background:var(--oppose)}.badge-neutral{background:var(--neutral)}.badge-mixed{background:var(--mixed)}.badge-unknown{background:#7a746a}
.bar{display:grid;grid-template-columns:3rem 1fr 2.4rem;gap:.45rem;align-items:center;margin:.35rem 0}
.track{height:.65rem;background:#ebe4d8;border-radius:999px;overflow:hidden}.fill{height:100%}
.fill.s{background:var(--support);width:${support}%}.fill.o{background:var(--oppose);width:${oppose}%}.fill.n{background:var(--neutral);width:${neutral}%}
.tree-root,.tree-children{list-style:none;margin:0;padding:0}
.tree-children{margin:.5rem 0 0 .8rem;padding-left:.8rem;border-left:2px solid #cfc5b5}
.tree-node{background:#fff;border:1px solid var(--line);border-radius:12px;padding:.65rem .8rem;margin-bottom:.4rem}
details.tree-node>summary{list-style:none;cursor:pointer}details.tree-node>summary::-webkit-details-marker{display:none}
.node-summary{margin:.35rem 0 0;color:var(--muted);font-size:.9rem}.chip{font-family:ui-monospace,monospace;font-size:.72rem;background:#efe9df;padding:.05rem .3rem;border-radius:4px}
.quote-card{border:1px solid var(--line);border-radius:12px;padding:.7rem;margin:.5rem 0;background:#fff}
a{color:var(--accent)}
</style></head><body><div class="wrap">
<section class="card"><h1>${esc(opts.title)}</h1><div class="muted">答主：${esc(opts.author)} · 评论 ${esc(opts.commentCount)}${opts.url ? ` · <a href="${esc(opts.url)}" target="_blank">原回答</a>` : ''}</div></section>
<section class="card"><h2>答主摘要</h2><p>${esc(summary)}</p></section>
<section class="card"><h2>态度估算</h2>
<div class="bar"><span>支持</span><div class="track"><div class="fill s"></div></div><span>${support}%</span></div>
<div class="bar"><span>反对</span><div class="track"><div class="fill o"></div></div><span>${oppose}%</span></div>
<div class="bar"><span>中立</span><div class="track"><div class="fill n"></div></div><span>${neutral}%</span></div>
<p class="muted">${esc(note)}</p></section>
<section class="card"><h2>议题树</h2><p class="muted">点击节点展开/收起</p>${treeHtml}</section>
<section class="card"><h2>争议点</h2>${controversyHtml}</section>
<section class="card"><h2>典型原话</h2>${highlightHtml}</section>
<section class="card"><h2>完整报告</h2>${mdLite(reportMd)}</section>
</div></body></html>`;
}
