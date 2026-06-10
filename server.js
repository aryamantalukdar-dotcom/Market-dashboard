// Market dashboard server: polls free data sources on a schedule, runs the
// recommendation engine, and serves the dashboard + JSON API.
//
//   npm start        live data (Yahoo Finance, FRED, RSS — no API keys)
//   npm run demo     MOCK=1, fully offline deterministic data
//
// Zero npm dependencies; requires Node >= 18.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

import { REFRESH, FRED_SERIES, NEWS_FEEDS, allInstruments } from './lib/config.js';
import { fetchAll } from './lib/yahoo.js';
import { fetchMacroSeries } from './lib/fred.js';
import { fetchNews, aggregateSentiment } from './lib/news.js';
import { buildRecommendations } from './lib/engine.js';
import { buildPolicyPath } from './lib/policy.js';
import { runBacktest } from './lib/backtest.js';
import { enrichNews, blendSentiment } from './lib/llm.js';
import { assemblePayload } from './lib/payload.js';
import { TiltStore } from './lib/store.js';
import { mockIndicators, mockMacro, mockNews } from './lib/mock.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const FORCE_MOCK = process.env.MOCK === '1';

const store = new TiltStore(join(ROOT, 'data', 'tilt-history.json'));

const state = {
  mode: FORCE_MOCK ? 'mock' : 'live',
  indicators: new Map(),
  macro: new Map(),
  news: [],
  newsAgg: { byTag: {}, overall: 0 },
  newsLLM: null,
  policy: null,
  backtest: null,
  recommendations: null,
  status: {
    quotes: { lastSuccess: null, lastError: null },
    macro: { lastSuccess: null, lastError: null },
    news: { lastSuccess: null, lastError: null }
  },
  startedAt: Date.now()
};

const SYMBOLS = allInstruments().map((i) => i.symbol);

// ---------------------------------------------------------------------------
// Data refresh jobs
// ---------------------------------------------------------------------------

async function refreshQuotes(range) {
  if (state.mode === 'mock') {
    state.indicators = mockIndicators();
    state.status.quotes.lastSuccess = Date.now();
    return;
  }
  const { indicators, errors } = await fetchAll(SYMBOLS, { range });
  if (indicators.size) {
    // Merge so a partial failure keeps prior data for missing symbols
    for (const [sym, ind] of indicators) state.indicators.set(sym, ind);
    state.status.quotes.lastSuccess = Date.now();
    state.status.quotes.lastError = null;
  }
  if (errors.size) {
    state.status.quotes.lastError = `${errors.size} symbols failed (e.g. ${[...errors.entries()][0].join(': ')})`;
  }
}

async function refreshMacro() {
  if (state.mode === 'mock') {
    state.macro = mockMacro();
    state.status.macro.lastSuccess = Date.now();
    return;
  }
  const { macro, errors } = await fetchMacroSeries(FRED_SERIES);
  if (macro.size) {
    for (const [id, s] of macro) state.macro.set(id, s);
    state.status.macro.lastSuccess = Date.now();
    state.status.macro.lastError = null;
  }
  if (errors.size) {
    state.status.macro.lastError = `${errors.size} series failed (e.g. ${[...errors.entries()][0].join(': ')})`;
  }
}

// LLM enrichment is throttled independently of the 5-min RSS cycle to keep
// API spend bounded for long-running local servers.
const LLM_MIN_INTERVAL_MS = 15 * 60 * 1000;
let lastLLMAt = 0;

async function refreshNews() {
  if (state.mode === 'mock') {
    state.news = mockNews();
    state.newsAgg = aggregateSentiment(state.news);
    state.status.news.lastSuccess = Date.now();
    return;
  }
  const { items, errors } = await fetchNews(NEWS_FEEDS);
  if (items.length) {
    state.news = items;
    state.newsAgg = aggregateSentiment(items);
    state.status.news.lastSuccess = Date.now();
    state.status.news.lastError = null;
    if (Date.now() - lastLLMAt > LLM_MIN_INTERVAL_MS) {
      const llm = await enrichNews(items);
      if (llm) {
        state.newsLLM = llm;
        lastLLMAt = Date.now();
      }
    }
    if (state.newsLLM) state.newsAgg = blendSentiment(state.newsAgg, state.newsLLM);
  }
  if (errors.size) {
    state.status.news.lastError = `${errors.size} feeds failed (e.g. ${[...errors.entries()][0].join(': ')})`;
  }
}

function recompute() {
  if (!state.indicators.size) return;
  // Policy path and backtest only refresh when the inputs support them
  // (e.g. a 5d quote refresh has too little history for the backtest).
  const policy = buildPolicyPath(state.indicators, state.macro);
  if (policy) state.policy = policy;
  const backtest = runBacktest(state.indicators);
  if (backtest) state.backtest = backtest;

  const result = buildRecommendations({
    indicators: state.indicators,
    macro: state.macro,
    newsAgg: state.newsAgg,
    history: store.history,
    policy: state.policy
  });
  store.applyChanges(result.changes);
  state.recommendations = result;
}

async function safe(name, fn) {
  try {
    await fn();
  } catch (err) {
    console.error(`[${name}]`, err.message);
    if (state.status[name]) state.status[name].lastError = String(err.message || err);
  }
}

async function boot() {
  console.log(`[boot] mode=${state.mode}, fetching initial data...`);
  await Promise.all([
    safe('quotes', () => refreshQuotes('1y')),
    safe('macro', refreshMacro),
    safe('news', refreshNews)
  ]);

  // If live mode got nothing at all, fall back to mock so the dashboard is
  // still usable (clearly badged as DEMO DATA in the UI).
  if (state.mode === 'live' && !state.indicators.size) {
    console.warn('[boot] no live data reachable — falling back to mock/demo mode');
    state.mode = 'mock';
    await Promise.all([refreshQuotes(), refreshMacro(), refreshNews()]);
  }

  recompute();
  console.log(`[boot] ready: ${state.indicators.size} instruments, ${state.macro.size} macro series, ${state.news.length} headlines`);

  setInterval(() => safe('quotes', () => refreshQuotes('5d').then(recompute)), REFRESH.quotesMs);
  setInterval(() => safe('quotes', () => refreshQuotes('1y').then(recompute)), REFRESH.historyMs);
  setInterval(() => safe('news', () => refreshNews().then(recompute)), REFRESH.newsMs);
  setInterval(() => safe('macro', () => refreshMacro().then(recompute)), REFRESH.macroMs);
}

// ---------------------------------------------------------------------------
// HTTP API + static frontend
// ---------------------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

function dashboardPayload() {
  return assemblePayload({
    mode: state.mode,
    indicators: state.indicators,
    macro: state.macro,
    news: state.news,
    newsAgg: state.newsAgg,
    newsLLM: state.newsLLM,
    policy: state.policy,
    backtest: state.backtest,
    recommendations: state.recommendations,
    status: state.status,
    tiltLog: store.log.slice(-30).reverse()
  });
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(body);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/api/dashboard') return sendJson(res, 200, dashboardPayload());
    if (url.pathname === '/api/health') {
      return sendJson(res, 200, {
        ok: true,
        mode: state.mode,
        uptimeSec: Math.round((Date.now() - state.startedAt) / 1000),
        instruments: state.indicators.size,
        status: state.status
      });
    }

    // Static files
    let file = url.pathname === '/' ? '/index.html' : url.pathname;
    file = normalize(file).replace(/^(\.\.[/\\])+/, '');
    const path = join(ROOT, 'public', file);
    if (!path.startsWith(join(ROOT, 'public'))) {
      res.writeHead(403);
      return res.end('forbidden');
    }
    const data = await readFile(path);
    res.writeHead(200, { 'Content-Type': MIME[extname(path)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  } catch (err) {
    if (err.code === 'ENOENT') {
      res.writeHead(404);
      res.end('not found');
    } else {
      console.error('[http]', err.message);
      res.writeHead(500);
      res.end('internal error');
    }
  }
});

server.listen(PORT, () => {
  console.log(`Market dashboard running at http://localhost:${PORT}`);
  boot().catch((err) => console.error('[boot] fatal:', err));
});
