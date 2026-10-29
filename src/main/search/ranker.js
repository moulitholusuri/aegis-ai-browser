'use strict';
// Relevance ranker for Aegis Search.
// Pure-local, O(n) scoring so ranking never becomes the bottleneck:
//   1. BM25-style term scoring over title+snippet (query-likelihood)
//   2. Intent boost: match what the user is *trying* to do
//      (definition, how-to, comparison, research, code, news, buy)
//   3. Authority priors per source (wiki for facts, SO/GitHub for code, arXiv for research…)
//   4. Freshness decay (news/tech age matters; evergreen knowledge less so)
//   5. Quality signals (points/stars/comments) with log damping
//   6. Diversity: limit near-duplicate hosts so one domain can't dominate page 1
// When a cloud LLM is available, engine.js adds an AI re-rank pass on top.

const { LRUCache } = require('./cache');

const STOP = new Set(('a an and are as at be but by for from has have if in into is it its of on or that the ' +
  'this to was were will with you your we our not no so than then there these they what when where which who ' +
  'whom why how all any can could did do does doing down few more most other some such over only own same very ' +
  'just about after before between during he she his her them i im its its').split(' '));

function tokenize(text) {
  return String(text || '').toLowerCase().match(/[a-z0-9']{2,}/g) || [];
}

function queryTerms(query) {
  return [...new Set(tokenize(query).filter((t) => !STOP.has(t)))];
}

// ---- Intent detection (local, instant) ----
function detectIntent(query) {
  const q = query.toLowerCase();
  if (/^(what is|who is|define|definition of|meaning of|explain)\b/.test(q)) return 'definition';
  if (/^(how to|how do i|how can i|guide|tutorial|learn)\b/.test(q)) return 'howto';
  if (/\bvs\.?\b|\bversus\b|\bcompare\b|\bor\b.*\bbetter\b/.test(q)) return 'comparison';
  if (/\b(latest|news|today|202[4-9]|release|announc|update)\b/.test(q)) return 'news';
  if (/\b(error|exception|stack ?overflow|debug|api|sdk|function|code|python|javascript|rust|golang|java\b)/.test(q)) return 'code';
  if (/\b(buy|price|best|review|deal|cheap|top \d+)\b/.test(q)) return 'commercial';
  if (/\b(paper|study|research|arxiv|dataset|survey|thesis)\b/.test(q)) return 'research';
  return 'general';
}

// Which sources deserve a prior boost for each intent.
const INTENT_SOURCE_BOOST = {
  definition: { wikipedia: 2.2, 'duckduckgo-ia': 2.0, arxiv: 1.1 },
  howto: { stackoverflow: 1.8, github: 1.2, hackernews: 1.1, wikipedia: 1.1 },
  comparison: { hackernews: 1.7, 'duckduckgo': 1.1 },
  news: { hackernews: 1.8, 'duckduckgo': 1.4 },
  code: { stackoverflow: 2.4, github: 2.2, hackernews: 1.2 },
  commercial: { 'duckduckgo': 1.6 },
  research: { arxiv: 3.0, wikipedia: 1.3, hackernews: 1.1 },
  general: { wikipedia: 1.3, 'duckduckgo': 1.2 },
};

// Freshness half-life in hours per intent (longer = evergreen matters less).
const FRESHNESS_HALFLIFE_H = {
  news: 36, code: 24 * 90, general: 24 * 365, definition: 24 * 365 * 3,
  research: 24 * 365 * 2, howto: 24 * 365, comparison: 24 * 180, commercial: 24 * 90,
};

const idfCache = new LRUCache(500, 30 * 60 * 1000);

// BM25 over the mini-corpus formed by this result set (k1=1.2, b=0.75).
function bm25Score(docTerms, queryTermsSet, df, avgDl) {
  const k1 = 1.2, b = 0.75;
  const tf = new Map();
  for (const t of docTerms) tf.set(t, (tf.get(t) || 0) + 1);
  const dl = docTerms.length || 1;
  let score = 0;
  const N = Math.max(df.size, 1);
  for (const qt of queryTermsSet) {
    const f = tf.get(qt) || 0;
    if (!f) continue;
    const idf = Math.log(1 + (N - (df.get(qt) || 0) + 0.5) / ((df.get(qt) || 0) + 0.5));
    score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + b * (dl / avgDl))));
  }
  return score;
}

// Rank a flat list of normalized results. Returns new array, best first.
function rankResults(results, query, opts = {}) {
  const intent = detectIntent(query);
  const qTerms = queryTerms(query);
  const qSet = new Set(qTerms);
  if (!results.length) return { intent, items: [] };

  // Document frequency across this result set (mini-corpus idf).
  const df = new Map();
  const docs = results.map((r) => {
    const titleTerms = tokenize(r.title);
    const snipTerms = tokenize(r.snippet);
    const all = [...titleTerms, ...snipTerms, ...titleTerms]; // title terms weighted x2 by repetition
    for (const t of new Set(all)) df.set(t, (df.get(t) || 0) + 1);
    return { r, titleTerms, snipTerms, len: all.length };
  });
  const avgDl = docs.reduce((a, d) => a + d.len, 0) / docs.length || 1;

  const now = Date.now();
  const halfLife = FRESHNESS_HALFLIFE_H[intent] || 24 * 365;
  const boosts = INTENT_SOURCE_BOOST[intent] || {};

  const scored = docs.map(({ r, titleTerms, snipTerms, len }) => {
    // 1. BM25 over title+snippet (title duplicated -> double weight)
    const rel = bm25Score([...titleTerms, ...titleTerms, ...snipTerms], qSet, df, avgDl);

    // 2. Phrase / coverage bonuses
    const titleLc = (r.title || '').toLowerCase();
    const snipLc = (r.snippet || '').toLowerCase();
    let bonus = 0;
    const qLc = query.toLowerCase().trim();
    if (titleLc.includes(qLc)) bonus += 2.5;                                  // exact phrase in title
    else if (qTerms.every((t) => titleLc.includes(t))) bonus += 1.4;          // all terms in title
    const covered = qTerms.filter((t) => titleLc.includes(t) || snipLc.includes(t)).length;
    bonus += (covered / Math.max(qTerms.length, 1)) * 1.8;                    // query coverage

    // 3. Source authority prior for the detected intent
    const authority = boosts[r.source] || 1.0;

    // 4. Freshness decay
    let freshness = 1.0;
    if (r.date) {
      const ageH = Math.max(0, (now - r.date) / 3600000);
      freshness = Math.pow(0.5, ageH / halfLife) * 0.6 + 0.4; // floor 0.4: never zero out old evergreen
    }

    // 5. Social quality signal (points/stars), log-damped
    const quality = r.points ? Math.min(2.0, 1 + Math.log10(1 + r.points) * 0.25) : 1.0;

    const finalScore = (rel + bonus) * authority * freshness * quality;
    return { ...r, intent, score: Math.round(finalScore * 1000) / 1000 };
  });

  scored.sort((a, b) => b.score - a.score);

  // 6. Host diversity: max 3 results per registrable host on the first page
  const counts = new Map();
  const diversified = [];
  const deferred = [];
  for (const item of scored) {
    let host = '';
    try { host = new URL(item.url).hostname.replace(/^www\./, ''); } catch { /* skip */ }
    const n = counts.get(host) || 0;
    if (n < 3) { counts.set(host, n + 1); diversified.push(item); }
    else deferred.push(item);
  }
  return { intent, items: [...diversified, ...deferred] };
}

module.exports = { rankResults, detectIntent, tokenize, queryTerms };
