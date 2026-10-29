'use strict';
// Renders the Aegis Search results page (served over the privileged aegis://
// scheme). All data arrives via the /api/search streaming endpoint, so this
// template stays static and results paint progressively as sources respond.

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const CSS = `
:root{--bg:#0b0f14;--bg2:#111823;--bg3:#182231;--line:#223047;--fg:#dbe7f5;--muted:#7d92ab;--accent:#4da3ff;--accent2:#7c5cff;--ok:#3ddc97}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--fg);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;padding-top:54px}
header{position:fixed;top:0;left:0;right:0;height:54px;background:rgba(11,15,20,.92);backdrop-filter:blur(10px);border-bottom:1px solid var(--line);display:flex;align-items:center;gap:14px;padding:0 18px;z-index:10}
.logo{font-weight:700;color:var(--fg);text-decoration:none;font-size:16px;white-space:nowrap}
form{flex:1;display:flex;max-width:680px}
input{flex:1;padding:9px 16px;background:var(--bg2);border:1px solid var(--line);border-radius:999px 0 0 999px;color:var(--fg);outline:none;font-size:14px}
input:focus{border-color:var(--accent)}
button{padding:9px 18px;background:linear-gradient(135deg,var(--accent),var(--accent2));border:none;color:#fff;border-radius:0 999px 999px 0;cursor:pointer;font-size:14px}
main{max-width:760px;margin:0 auto;padding:20px 18px 80px}
#answer{background:linear-gradient(180deg,rgba(77,163,255,.08),rgba(124,92,255,.05));border:1px solid var(--line);border-left:3px solid var(--accent);border-radius:12px;padding:16px 18px;margin-bottom:22px}
#answer .tag{font-size:11px;color:var(--accent);font-weight:700;letter-spacing:.5px;margin-bottom:6px}
#answer p{font-size:14.5px;line-height:1.65}
#answer .cites{margin-top:10px;font-size:12px;color:var(--muted)}
#answer .cites a{color:var(--accent);text-decoration:none;margin-right:10px}
#answer .cites a:hover{text-decoration:underline}
#meta{font-size:12px;color:var(--muted);margin-bottom:14px;display:flex;gap:14px;flex-wrap:wrap}
.pills{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:18px}
.pill{padding:5px 12px;border-radius:999px;border:1px solid var(--line);background:var(--bg2);color:var(--muted);cursor:pointer;font-size:12px}
.pill.on{background:linear-gradient(135deg,var(--accent),var(--accent2));color:#fff;border-color:transparent}
.result{margin-bottom:20px}
.result .src{font-size:12px;color:var(--muted);display:flex;gap:8px;align-items:center}
.result .src .dot{width:6px;height:6px;border-radius:50%;background:var(--accent2)}
.result a.title{display:block;font-size:17px;color:var(--accent);text-decoration:none;margin:3px 0;line-height:1.35}
.result a.title:hover{text-decoration:underline}
.result .url{font-size:12.5px;color:var(--ok);word-break:break-all}
.result .snippet{font-size:13.5px;color:#b7c7da;line-height:1.55;margin-top:4px}
.result .badge{font-size:10px;padding:2px 7px;border-radius:999px;background:var(--bg3);border:1px solid var(--line);color:var(--muted)}
#empty{color:var(--muted);padding:30px 0;text-align:center}
footer{max-width:760px;margin:0 auto;padding:20px 18px;font-size:11.5px;color:var(--muted);border-top:1px solid var(--line)}
.skeleton{height:14px;background:linear-gradient(90deg,var(--bg2),var(--bg3),var(--bg2));background-size:200% 100%;animation:sh 1.2s infinite;border-radius:6px;margin:8px 0}
@keyframes sh{0%{background-position:200% 0}100%{background-position:-200% 0}}
`;

const JS = `
const params = new URLSearchParams(location.search);
const q = params.get('q') || '';
document.getElementById('q').value = q;
const state = { results: [], filter: 'all' };

const CATEGORY = {
  duckduckgo: 'web',
  'duckduckgo-ia': 'facts', wikipedia: 'facts',
  stackoverflow: 'code', github: 'code',
  arxiv: 'papers',
  hackernews: 'talk',
};
const CAT_LABEL = { all: 'All', web: 'Web', facts: 'Facts', code: 'Code', papers: 'Papers', talk: 'Discussions' };

function esc(s){return String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));}

function renderPills(){
  const cats = ['all', ...new Set(state.results.map(r => CATEGORY[r.source] || 'web'))];
  document.getElementById('pills').innerHTML = cats.map(c =>
    '<span class="pill' + (state.filter === c ? ' on' : '') + '" data-c="' + c + '">' + CAT_LABEL[c] + '</span>'
  ).join('');
  document.querySelectorAll('.pill').forEach(p => p.onclick = () => { state.filter = p.dataset.c; renderPills(); renderResults(); });
}

function renderResults(){
  const list = state.results.filter(r => state.filter === 'all' || (CATEGORY[r.source] || 'web') === state.filter);
  document.getElementById('results').innerHTML = list.map(r =>
    '<div class="result">' +
      '<div class="src"><span class="dot"></span>' + esc(r.source) +
        '<span class="badge">' + esc(CATEGORY[r.source] || 'web') + '</span></div>' +
      '<a class="title" href="' + esc(r.url) + '" target="_blank" rel="noreferrer">' + esc(r.title) + '</a>' +
      '<div class="url">' + esc(r.url) + '</div>' +
      (r.snippet ? '<div class="snippet">' + esc(r.snippet) + '</div>' : '') +
    '</div>'
  ).join('') || '<div id="empty">No results for this filter.</div>';
}

function renderAnswer(ans){
  const box = document.getElementById('answer');
  if (!ans) { box.style.display = 'none'; return; }
  box.style.display = 'block';
  box.innerHTML = '<div class="tag">✨ AI ANSWER · ' + (ans.mode === 'cloud' ? 'CLOUD' : 'LOCAL, ON-DEVICE') + '</div>' +
    '<p>' + esc(ans.text) + '</p>' +
    (ans.cited && ans.cited.length ? '<div class="cites">Sources: ' +
      ans.cited.map(c => '<a href="' + esc(c.url) + '" target="_blank" rel="noreferrer">[' + c.n + '] ' + esc((c.title||'').slice(0,40)) + '</a>').join('') +
      '</div>' : '');
}

async function run(){
  try {
    const resp = await fetch('aegis://search/api/search?q=' + encodeURIComponent(q));
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const sourcesDone = new Map();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\\n')) >= 0) {
        const line = buf.slice(0, idx); buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        let ev; try { ev = JSON.parse(line); } catch { continue; }
        if (ev.type === 'source') {
          sourcesDone.set(ev.source, ev);
          if (ev.items && ev.items.length) { state.results.push(...ev.items); renderPills(); renderResults(); }
          const m = document.getElementById('meta');
          const doneN = [...sourcesDone.values()];
          m.textContent = 'Searching… ' + doneN.filter(s=>!s.error).length + '/' + doneN.length + ' sources responded' +
            (doneN.some(s=>s.error) ? ' (' + doneN.filter(s=>s.error).length + ' skipped)' : '');
        } else if (ev.type === 'answer') {
          renderAnswer(ev.answer);
        } else if (ev.type === 'done') {
          document.getElementById('meta').textContent =
            ev.count + ' results · ' + ev.intent + ' intent · ' + ev.tookMs + 'ms' + (ev.reranked ? ' · AI re-ranked' : '');
          if (!state.results.length) document.getElementById('results').innerHTML = '<div id="empty">No results found.</div>';
        } else if (ev.type === 'cached') {
          state.results = ev.results || [];
          renderPills(); renderResults(); renderAnswer(ev.answer);
          document.getElementById('meta').textContent = state.results.length + ' results · instant (cached)';
        }
      }
    }
  } catch (e) {
    document.getElementById('meta').textContent = 'Search failed: ' + e.message;
  }
}
run();
`;

function searchPageHtml(query, opts = {}) {
  const rankNote = opts.cloud
    ? 'AI re-ranked with your LLM'
    : 'ranked locally by BM25 + intent signals';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src https: data:; connect-src aegis:; base-uri 'none'; form-action 'none'" />
<title>${esc(query)} — Aegis Search</title>
<style>${CSS}</style>
</head>
<body>
<header>
  <a class="logo" href="aegis://newtab">🛡️ Aegis</a>
  <form onsubmit="location.href='aegis://search?q='+encodeURIComponent(document.getElementById('q').value);return false;">
    <input id="q" name="q" autocomplete="off" spellcheck="false" />
    <button type="submit">Search</button>
  </form>
</header>
<main>
  <div id="answer" style="display:none"></div>
  <div id="meta">Starting search…</div>
  <div class="pills" id="pills"></div>
  <div id="results"><div class="skeleton" style="width:90%"></div><div class="skeleton" style="width:75%"></div><div class="skeleton" style="width:85%"></div></div>
</main>
<footer>🛡️ Aegis Search — metasearch across 8 independent sources, ${rankNote}. No ads. No tracking. Your query is never logged.</footer>
<script>${JS}</script>
</body>
</html>`;
}

module.exports = { searchPageHtml };
