'use strict';
// JSON Viewer — detects raw JSON in the page (API responses render as <pre>),
// pretty-prints it and adds syntax colors via a constructable stylesheet
// (CSP-exempt, so it works on strict endpoints too).
(() => {
  const pre = document.querySelector('pre');
  if (!pre || document.body.children.length > 3) return;
  const raw = (pre.textContent || '').trim();
  if (!/^[[{]/.test(raw)) return;
  let data;
  try { data = JSON.parse(raw); } catch { return; }

  const pretty = JSON.stringify(data, null, 2);
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  let html = esc(pretty);
  // strings (keys first, then values)
  html = html.replace(/"([^"\n]*)"(\s*:)?/g, (m, body, colon) =>
    colon ? `<span class="jv-key">"${body}"</span>${colon}` : `<span class="jv-str">"${body}"</span>`);
  // numbers after colons
  html = html.replace(/(:\s*)(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g, '$1<span class="jv-num">$2</span>');
  // literals
  html = html.replace(/\b(true|false|null)\b/g, '<span class="jv-lit">$1</span>');

  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(
      'body{background:#0e1319!important;color:#cfe0f4!important}' +
      'pre{white-space:pre-wrap;word-break:break-word}' +
      '.jv-key{color:#7cc4ff}.jv-str{color:#8ee6b8}.jv-num{color:#ffca85}.jv-lit{color:#c792ea}',
    );
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  } catch { /* colors are optional */ }

  pre.innerHTML = html;
  document.title = 'JSON — pretty-printed by Aegis JSON Viewer';
})();
