'use strict';
// AI engine.
// - If an OpenAI-compatible API key + base URL + model are configured (stored
//   encrypted in the vault), every request goes there.
// - Otherwise a built-in local engine runs: extractive summarizer, intent
//   router for the omnibox ("search X", "open Y", "compare Z"), and page Q&A
//   via keyword retrieval. No data leaves the machine in local mode.

const STOPWORDS = new Set(('a an and are as at be but by for from has have if in into is it its of on or ' +
  'that the this to was were will with you your we our i me my not no so than then there these they ' +
  'what when where which who whom why how all any can could did do does doing down few more most other ' +
  'some such over only own same s t too very just about after before between during each few he she his ' +
  'her them they\'re don\'t i\'m it\'s').split(' '));

function sentences(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'(])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 40 && s.length < 600);
}

function tokens(text) {
  return String(text || '').toLowerCase().match(/[a-z0-9']{3,}/g) || [];
}

// Extractive summary: score sentences by term frequency, keep original order.
function localSummarize(text, maxSentences = 5) {
  const sents = sentences(text);
  if (sents.length === 0) return String(text || '').slice(0, 400);
  const freq = new Map();
  for (const t of tokens(text)) {
    if (STOPWORDS.has(t)) continue;
    freq.set(t, (freq.get(t) || 0) + 1);
  }
  const scored = sents.map((s, i) => {
    const ts = tokens(s);
    if (!ts.length) return { s, i, score: 0 };
    const score = ts.reduce((acc, t) => acc + (freq.get(t) || 0), 0) / Math.sqrt(ts.length);
    // small bonus for early sentences and headings-like fragments
    return { s, i, score: score + Math.max(0, 8 - i) * 0.4 };
  });
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, maxSentences)
    .sort((a, b) => a.i - b.i)
    .map((x) => x.s)
    .join(' ');
}

// Keyword-based retrieval answer for "ask this page" in local mode.
function localAnswer(question, pageText) {
  const qTokens = tokens(question).filter((t) => !STOPWORDS.has(t));
  const sents = sentences(pageText);
  if (!qTokens.length || !sents.length) return null;
  const ranked = sents
    .map((s) => {
      const ts = new Set(tokens(s));
      let hits = 0;
      for (const q of qTokens) if (ts.has(q)) hits++;
      return { s, hits };
    })
    .filter((x) => x.hits > 0)
    .sort((a, b) => b.hits - a.hits)
    .slice(0, 3);
  if (!ranked.length) return null;
  return ranked.map((x) => x.s).join(' ');
}

// Omnibox intent router: decides navigate vs search vs AI question.
function routeIntent(input) {
  const text = String(input || '').trim();
  if (!text) return { type: 'none' };
  if (/^https?:\/\//i.test(text)) return { type: 'navigate', url: text };
  if (/^localhost(:\d+)?(\/|$)/i.test(text)) return { type: 'navigate', url: `http://${text}` };
  // domain-like: has a dot, no spaces, plausible TLD
  if (!/\s/.test(text) && /^[\w-]+(\.[\w-]+)+(\/.*)?$/i.test(text) && !/\.(com|net|org|io|dev|app|co|me|ai|edu|gov|uk|de|fr|in|ca|au|jp|ru|info|biz|xyz|sh|to|tv|fm|so|ai)$/i.test(text.split('/')[0]) === false) {
    return { type: 'navigate', url: `https://${text}` };
  }
  if (!/\s/.test(text) && /^[\w-]+(\.[\w-]+)+(\/.*)?$/i.test(text)) {
    return { type: 'navigate', url: `https://${text}` };
  }
  const searchMatch = text.match(/^(?:search(?: for| google for| the web for)?|google|look up|find|query)\s+(.+)$/i);
  if (searchMatch) return { type: 'search', query: searchMatch[1].trim() };
  const compareMatch = text.match(/^compare\s+(.+)$/i);
  if (compareMatch) return { type: 'compare', query: compareMatch[1].trim() };
  const summarizeMatch = text.match(/^(?:summar(?:y|ise|ize)(?: this page)?|tl;?dr)\b.*$/i);
  if (summarizeMatch) return { type: 'summarize' };
  // App-health questions route to the diagnostic model attached to the assistant
  // ("diagnose", "show me the errors", "how many errors", "app health").
  if (/\b(diagnose|diagnostics?|health check|app health|system health)\b/i.test(text) ||
      /^(?:show|list|check|report|get)(?: me)? (?:the |any |app )?(?:errors?|issues?|problems?|bugs)\b/i.test(text) ||
      /\b(?:how many|what|any|are there|latest|recent) errors?\b/i.test(text) ||
      /\berror (?:report|log|status|history)\b/i.test(text) ||
      /\bwhat(?:'| i)s wrong with (?:the|this) (?:app|browser|system)\b/i.test(text)) {
    return { type: 'diagnose' };
  }
  // A question mark or question word -> ask the AI
  if (text.includes('?') || /^(what|why|how|who|when|where|explain|define|tell me|give me)\b/i.test(text)) {
    return { type: 'ask', question: text };
  }
  return { type: 'search', query: text };
}

class AiEngine {
  constructor(getSettings, getSecrets) {
    this.getSettings = getSettings;
    this.getSecrets = getSecrets; // () => ({ aiApiKey, aiBaseUrl, aiModel })
  }

  llmConfig() {
    const secrets = this.getSecrets() || {};
    const key = secrets.aiApiKey;
    if (!key) return null;
    return {
      key,
      baseUrl: (secrets.aiBaseUrl || 'https://api.openai.com/v1').replace(/\/+$/, ''),
      model: secrets.aiModel || 'gpt-4o-mini',
    };
  }

  mode() { return this.llmConfig() ? 'cloud' : 'local'; }

  async chat(system, userText, opts = {}) {
    const cfg = this.llmConfig();
    if (!cfg) return null;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), opts.timeoutMs || 30000);
    try {
      const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.key}` },
        body: JSON.stringify({
          model: cfg.model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: userText },
          ],
          temperature: 0.2,
          max_tokens: opts.maxTokens ?? 600,
        }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`AI provider returned ${res.status}`);
      const data = await res.json();
      return data.choices?.[0]?.message?.content?.trim() || null;
    } finally {
      clearTimeout(timeout);
    }
  }

  async summarize(page) {
    // page: { title, url, text }
    const cloud = await this.chat(
      'You are a precise browser assistant. Summarize the page in at most 5 short bullets, then one takeaway sentence. No preamble.',
      `Title: ${page.title}\nURL: ${page.url}\n\nContent:\n${(page.text || '').slice(0, 12000)}`,
      { maxTokens: 400 },
    ).catch(() => null);
    if (cloud) return { mode: 'cloud', summary: cloud };
    return { mode: 'local', summary: localSummarize(page.text, 5) };
  }

  async ask(question, page) {
    const cloud = await this.chat(
      'You are a browser assistant. Answer the user question using the page content when relevant. Be concise and factual. If the page is irrelevant, say so briefly.',
      `Page: ${page.title} (${page.url})\n\nContent:\n${(page.text || '').slice(0, 12000)}\n\nQuestion: ${question}`,
    ).catch(() => null);
    if (cloud) return { mode: 'cloud', answer: cloud };
    const local = localAnswer(question, page.text);
    return {
      mode: 'local',
      answer: local || 'Local AI could not find an answer on this page. Configure an AI API key in Settings for full answers.',
    };
  }

  async planTask(task, page) {
    const system = 'You are an autonomous browser agent. Given the user task and current page, reply with ONLY a JSON array of at most 5 steps. Each step: {"action":"navigate","url":...} | {"action":"search","query":...} | {"action":"summarize"} | {"action":"ask","question":...} | {"action":"done","reason":...}. No prose.';
    const cloud = await this.chat(system,
      `Task: ${task}\nCurrent page: ${page ? `${page.title} (${page.url})` : 'new tab'}\nPage excerpt: ${page ? (page.text || '').slice(0, 3000) : 'none'}`,
      { maxTokens: 500 }).catch(() => null);
    if (cloud) {
      try {
        const jsonStart = cloud.indexOf('[');
        const jsonEnd = cloud.lastIndexOf(']');
        const steps = JSON.parse(cloud.slice(jsonStart, jsonEnd + 1));
        if (Array.isArray(steps) && steps.length) return { mode: 'cloud', steps: steps.slice(0, 5) };
      } catch { /* fall through */ }
    }
    // Local heuristic plan: decompose the task into a search + summarize run.
    const intent = routeIntent(task);
    const steps = [];
    if (intent.type === 'navigate') steps.push({ action: 'navigate', url: intent.url });
    else if (intent.type === 'search') steps.push({ action: 'search', query: intent.query });
    else if (intent.type === 'ask') steps.push({ action: 'ask', question: intent.question });
    else steps.push({ action: 'search', query: task });
    steps.push({ action: 'summarize' });
    return { mode: 'local', steps };
  }
}

module.exports = { AiEngine, routeIntent, localSummarize };
