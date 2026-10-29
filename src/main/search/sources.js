'use strict';
// Source adapters for the Aegis metasearch engine.
// Every adapter: async fetch(query, signal) -> normalized results[]
// Results: { title, url, snippet, source, date?, points? }
// All sources are free/public APIs or lightweight HTML endpoints; each one is
// isolated (try/catch + timeout) so a slow or dead source can never hurt the
// overall query latency — the engine yields whatever arrives.

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 AegisBrowser/1.0';

function stripTags(html) {
  return String(html || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;|&#x27;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/\s+/g, ' ')
    .trim();
}

function clip(s, n = 260) {
  const t = String(s || '').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

async function getJson(url, signal, headers = {}) {
  const res = await fetch(url, {
    signal,
    headers: { 'user-agent': UA, accept: 'application/json', ...headers },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function getText(url, signal, init = {}) {
  const res = await fetch(url, {
    signal,
    headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml', ...(init.headers || {}) },
    ...init,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// ---- DuckDuckGo Lite: general web results (HTML, parseable) ----
async function duckduckgo(query, signal) {
  const body = new URLSearchParams({ q: query, kl: 'wt-wt' }).toString();
  const html = await getText('https://lite.duckduckgo.com/lite/', signal, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html' },
    body,
  });
  const out = [];
  // DDG lite marks results with class='result-link' (single quotes) and puts
  // href before class — parse anchors generically instead of one rigid regex.
  const anchorRe = /<a\s+([^>]*)>([\s\S]*?)<\/a>/gi;
  const snippetRe = /<td[^>]*class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/gi;
  const snippets = [...html.matchAll(snippetRe)].map((m) => stripTags(m[1]));
  let snipIdx = 0;
  for (const m of html.matchAll(anchorRe)) {
    const attrs = m[1];
    if (!/class=['"][^'"]*result-link/.test(attrs)) continue;
    const hrefMatch = attrs.match(/href=['"]([^'"]+)['"]/i);
    if (!hrefMatch) continue;
    let url = hrefMatch[1];
    // DDG wraps outbound links: //duckduckgo.com/l/?uddg=<encoded>
    try {
      const u = new URL(url, 'https://duckduckgo.com');
      const uddg = u.searchParams.get('uddg');
      if (uddg && /^https?:/i.test(uddg)) url = uddg;
    } catch { /* keep raw */ }
    const title = stripTags(m[2]);
    if (!/^https?:/i.test(url) || !title) continue;
    out.push({ title: clip(title, 120), url, snippet: clip(snippets[snipIdx++] || ''), source: 'duckduckgo' });
    if (out.length >= 8) break;
  }
  return out;
}

// ---- Mojeek: removed — currently serves a CAPTCHA wall to non-browser clients ----

// ---- DuckDuckGo Instant Answer: knowledge seed + answer material ----
async function ddgInstant(query, signal) {
  const data = await getJson(
    `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1&t=aegis`,
    signal,
  );
  const items = [];
  if (data.AbstractText && data.AbstractURL) {
    items.push({
      title: clip(data.Heading || query, 120),
      url: data.AbstractURL,
      snippet: clip(data.AbstractText),
      source: 'duckduckgo-ia',
    });
  }
  for (const t of (data.RelatedTopics || []).slice(0, 4)) {
    if (t.FirstURL && t.Text) {
      items.push({ title: clip(t.Text.split(' - ')[0], 120), url: t.FirstURL, snippet: clip(t.Text), source: 'duckduckgo-ia' });
    }
  }
  return {
    items: items.slice(0, 5),
    meta: {
      abstract: data.AbstractText || null,
      abstractUrl: data.AbstractURL || null,
      heading: data.Heading || null,
      answer: data.Answer || null,
    },
  };
}

// ---- Wikipedia: knowledge panel ----
async function wikipedia(query, signal) {
  const data = await getJson(
    `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}` +
    '&srlimit=6&format=json&utf8=1&srprop=snippet|timestamp',
    signal,
  );
  return (data.query?.search || []).map((r) => ({
    title: clip(r.title, 120),
    url: `https://en.wikipedia.org/wiki/${encodeURIComponent(r.title.replace(/ /g, '_'))}`,
    snippet: clip(stripTags(r.snippet)),
    source: 'wikipedia',
    date: r.timestamp ? Date.parse(r.timestamp) : undefined,
  }));
}

// ---- Hacker News (Algolia): discussions & tech ----
async function hackernews(query, signal) {
  const data = await getJson(
    `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&hitsPerPage=6&tags=story`,
    signal,
  );
  return (data.hits || []).map((h) => ({
    title: clip(h.title, 120),
    url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
    snippet: clip(`${h.points || 0} points · ${h.num_comments || 0} comments · on Hacker News`),
    source: 'hackernews',
    points: h.points || 0,
    date: h.created_at ? Date.parse(h.created_at) : undefined,
  }));
}

// ---- Stack Overflow (StackExchange): code answers ----
async function stackoverflow(query, signal) {
  const data = await getJson(
    `https://api.stackexchange.com/2.3/search/excerpts?order=desc&sort=relevance` +
    `&q=${encodeURIComponent(query)}&site=stackoverflow&pagesize=6&filter=default`,
    signal,
  );
  return (data.items || [])
    .filter((i) => i.item_type === 'question' && i.question_id)
    .map((i) => ({
      title: clip(stripTags(i.title), 120),
      url: i.link || `https://stackoverflow.com/q/${i.question_id}`,
      snippet: clip(stripTags(i.excerpt)),
      source: 'stackoverflow',
      points: i.score || 0,
      date: i.creation_date ? i.creation_date * 1000 : undefined,
    }));
}

// ---- arXiv: research papers ----
async function arxiv(query, signal) {
  const xml = await getText(
    `http://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&max_results=5&sortBy=relevance`,
    signal,
  );
  const out = [];
  for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const entry = m[1];
    const title = (entry.match(/<title>([\s\S]*?)<\/title>/) || [])[1];
    const summary = (entry.match(/<summary>([\s\S]*?)<\/summary>/) || [])[1];
    const id = (entry.match(/<id>([\s\S]*?)<\/id>/) || [])[1];
    const published = (entry.match(/<published>([\s\S]*?)<\/published>/) || [])[1];
    if (!title || !id) continue;
    out.push({
      title: clip(stripTags(title), 140),
      url: id.trim(),
      snippet: clip(stripTags(summary)),
      source: 'arxiv',
      date: published ? Date.parse(published) : undefined,
    });
  }
  return out;
}

// ---- GitHub repositories ----
async function github(query, signal) {
  const data = await getJson(
    `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=5`,
    signal,
    { 'user-agent': UA, accept: 'application/vnd.github+json' },
  );
  return (data.items || []).map((r) => ({
    title: clip(r.full_name, 120),
    url: r.html_url,
    snippet: clip(r.description || 'GitHub repository'),
    source: 'github',
    points: r.stargazers_count || 0,
    date: r.updated_at ? Date.parse(r.updated_at) : undefined,
  }));
}

// ---- Reddit: removed — blocks unauthenticated JSON access (HTTP 403) ----

// Registry: id, human label, settings group, fetcher, timeout.
const SOURCES = [
  { id: 'duckduckgo', label: 'Web', group: 'web', fetch: duckduckgo, timeout: 2800 },
  { id: 'duckduckgo-ia', label: 'Facts', group: 'knowledge', fetch: ddgInstant, timeout: 2000, meta: true },
  { id: 'wikipedia', label: 'Wiki', group: 'knowledge', fetch: wikipedia, timeout: 2500 },
  { id: 'stackoverflow', label: 'SO', group: 'code', fetch: stackoverflow, timeout: 2500 },
  { id: 'github', label: 'GitHub', group: 'code', fetch: github, timeout: 2500 },
  { id: 'arxiv', label: 'Papers', group: 'papers', fetch: arxiv, timeout: 3000 },
  { id: 'hackernews', label: 'HN', group: 'discussions', fetch: hackernews, timeout: 2000 },
];

module.exports = { SOURCES, stripTags, clip };
