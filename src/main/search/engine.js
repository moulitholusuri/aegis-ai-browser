'use strict';
// SearchEngine: orchestrates the metasearch pipeline.
//   query -> parallel source fan-out (each isolated + timed out)
//         -> dedupe -> local BM25+intent ranking -> optional AI re-rank
//         -> AI answer synthesis (cloud LLM or instant local)
// Performance guards: per-source AbortSignal timeouts, 10-min result cache,
// log-damped scoring, and streaming partial results to the UI as they land.

const { LRUCache } = require('./cache');
const { SOURCES } = require('./sources');
const { rankResults } = require('./ranker');

function normalizeUrl(u) {
  try {
    const url = new URL(u);
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|ref$|ref_|mc_eid|mc_cid|igshid|yclid|_ga|si$|feature$)/i.test(key)) {
        url.searchParams.delete(key);
      }
    }
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');
    return url.toString().replace(/\/$/, '');
  } catch {
    return String(u);
  }
}

function dedupe(items) {
  const byUrl = new Map();
  const byTitle = new Map();
  const out = [];
  for (const item of items) {
    const nu = normalizeUrl(item.url);
    if (!nu || byUrl.has(nu)) continue;
    const nt = String(item.title || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (nt && byTitle.has(nt)) continue; // same headline from another source
    byUrl.set(nu, true);
    if (nt) byTitle.set(nt, true);
    out.push({ ...item, url: item.url });
  }
  return out;
}

class SearchEngine {
  constructor({ getSettings, ai }) {
    this.getSettings = getSettings;
    this.ai = ai; // AiEngine instance (may have no cloud key -> local mode)
    this.cache = new LRUCache(200, 10 * 60 * 1000); // hot queries answer instantly
  }

  activeSources() {
    const enabled = (this.getSettings() && this.getSettings().searchSources) || {};
    return SOURCES.filter((s) => enabled[s.group] !== false);
  }

  hasCloud() {
    return !!(this.ai && this.ai.llmConfig && this.ai.llmConfig());
  }

  // onProgress(event) is called as each source settles (streaming to the UI).
  async search(query, onProgress) {
    const q = String(query || '').trim().slice(0, 300);
    const key = q.toLowerCase();
    if (!q) return { query: q, results: [], answer: null, intent: 'general', tookMs: 0 };

    const cached = this.cache.get(key);
    if (cached) {
      onProgress && onProgress({ type: 'cached', ...cached });
      return cached;
    }

    const started = Date.now();
    const sources = this.activeSources();
    const collected = [];
    let meta = null;

    // Parallel fan-out; every adapter is individually bounded by its timeout.
    const perSource = sources.map(async (s) => {
      const t0 = Date.now();
      try {
        const out = await s.fetch(q, AbortSignal.timeout(s.timeout || 2500));
        if (s.meta) {
          meta = (out && out.meta) || null;
          return { source: s.id, label: s.label, group: s.group, items: (out && out.items) || [], ms: Date.now() - t0 };
        }
        return { source: s.id, label: s.group ? s.label : s.label, group: s.group, items: out || [], ms: Date.now() - t0 };
      } catch (err) {
        return { source: s.id, label: s.label, group: s.group, items: [], ms: Date.now() - t0, error: String(err.message || err) };
      }
    });

    const settled = await Promise.all(
      perSource.map((p) =>
        p.then((r) => {
          collected.push(...r.items);
          onProgress && onProgress({ type: 'source', ...r });
          return r;
        }),
      ),
    );

    // Local ranking — O(results), microseconds, never the bottleneck.
    const { intent, items } = rankResults(dedupe(collected), q);

    // AI re-rank (cloud only): reorder the head of the list, tail keeps order.
    let finalItems = items;
    let reranked = false;
    if (this.hasCloud() && items.length > 4) {
      finalItems = await this.aiReRank(q, items).catch(() => items);
      reranked = finalItems !== items;
    }

    const result = {
      query: q,
      intent,
      results: finalItems.slice(0, 30),
      sources: settled.map(({ source, label, group, ms, error, items }) => ({
        source, label, group, ms, error, count: items.length,
      })),
      reranked,
      tookMs: Date.now() - started,
    };

    result.answer = await this.synthesizeAnswer(result);
    onProgress && onProgress({ type: 'answer', answer: result.answer });
    onProgress && onProgress({
      type: 'done',
      tookMs: result.tookMs,
      count: result.results.length,
      intent,
      cached: false,
    });

    this.cache.set(key, result);
    return result;
  }

  // Cloud LLM re-ranks the top results; validates the model's output strictly.
  async aiReRank(q, items) {
    const top = items.slice(0, 15);
    const list = top.map((r, i) => `${i + 1}. [${r.source}] ${r.title} — ${r.url}`).join('\n');
    const raw = await this.ai.chat(
      'You are a search ranking model. Reorder results by true relevance to the query. ' +
      'Reply ONLY with a JSON array of the numbers in best-first order, each exactly once, e.g. [3,1,2].',
      `Query: ${q}\n\nResults:\n${list}`,
      { maxTokens: 300, timeoutMs: 6000 },
    );
    if (!raw) return items;
    const m = raw.match(/\[[\d,\s]+\]/);
    if (!m) return items;
    let order;
    try { order = JSON.parse(m[0]); } catch { return items; }
    const seen = new Set();
    const out = [];
    for (const n of order) {
      const idx = Number(n) - 1;
      if (Number.isInteger(idx) && idx >= 0 && idx < top.length && !seen.has(idx)) {
        seen.add(idx);
        out.push(top[idx]);
      }
    }
    if (out.length < 2) return items; // model output garbage -> keep local order
    for (let i = 0; i < top.length; i++) if (!seen.has(i)) out.push(top[i]);
    return [...out, ...items.slice(15)];
  }

  // Answer box: cloud LLM with citations, else instant local synthesis.
  async synthesizeAnswer(result) {
    const { query, results, meta } = result;
    if (this.hasCloud()) {
      try {
        const top = results.slice(0, 8);
        const ctx = top.map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.snippet}`).join('\n\n');
        const text = await this.ai.chat(
          'You are the answer engine of a search engine. Using ONLY the sources below, write a direct ' +
          '2-4 sentence answer to the query. Cite supporting sources inline as [n]. If sources are ' +
          'insufficient, say exactly what is missing. No preamble.',
          `Query: ${query}\n\nSources:\n${ctx}`,
          { maxTokens: 350, timeoutMs: 12000 },
        );
        if (text) {
          return { text, mode: 'cloud', cited: top.slice(0, 5).map((r, i) => ({ n: i + 1, title: r.title, url: r.url })) };
        }
      } catch { /* fall through to local */ }
    }
    // Local synthesis: instant-answer abstract > stitched top snippets.
    if (meta && meta.abstract) {
      return {
        text: meta.abstract,
        mode: 'local',
        cited: meta.abstractUrl ? [{ n: 1, title: meta.heading || 'Instant answer', url: meta.abstractUrl }] : [],
      };
    }
    if (meta && meta.answer) {
      const clean = String(meta.answer).replace(/<[^>]+>/g, '').trim();
      if (clean) return { text: clean, mode: 'local', cited: [] };
    }
    const top = results.filter((r) => r.snippet && r.snippet.length > 40).slice(0, 3);
    if (!top.length) return null;
    return {
      text: top.map((r) => r.snippet).join(' '),
      mode: 'local',
      cited: top.map((r, i) => ({ n: i + 1, title: r.title, url: r.url })),
    };
  }
}

module.exports = { SearchEngine, normalizeUrl, dedupe };
