// Builds a static snapshot of the dashboard into dist/ for GitHub Pages:
// the frontend plus a data.json produced by one full live fetch + engine run.
//
// The 30-day compliance lock needs memory across runs, so the previous tilt
// state is pulled from the currently deployed data.json (PREVIOUS_DATA_URL)
// and the updated state is embedded in the new snapshot.
//
// Run with MOCK=1 to build an offline demo snapshot (used for testing).

import { mkdirSync, writeFileSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { FRED_SERIES, NEWS_FEEDS, allInstruments } from '../lib/config.js';
import { fetchAll } from '../lib/yahoo.js';
import { fetchMacroSeries } from '../lib/fred.js';
import { fetchNews, aggregateSentiment } from '../lib/news.js';
import { buildRecommendations } from '../lib/engine.js';
import { assemblePayload } from '../lib/payload.js';
import { mockIndicators, mockMacro, mockNews } from '../lib/mock.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MOCK = process.env.MOCK === '1';

let history = {};
let log = [];
let prevUrl = process.env.PREVIOUS_DATA_URL;
if (!prevUrl && process.env.GITHUB_REPOSITORY) {
  const [owner, repo] = process.env.GITHUB_REPOSITORY.split('/');
  prevUrl = `https://${owner}.github.io/${repo}/data.json`;
}
if (prevUrl && !MOCK) {
  try {
    const res = await fetch(prevUrl, { headers: { 'Cache-Control': 'no-cache' } });
    if (res.ok) {
      const prev = await res.json();
      history = prev.tiltState?.history || {};
      log = prev.tiltState?.log || [];
      console.log(`[static] loaded previous tilt state (${Object.keys(history).length} keys, ${log.length} log entries)`);
    } else {
      console.log(`[static] no previous snapshot yet (HTTP ${res.status}) — starting fresh`);
    }
  } catch (err) {
    console.log(`[static] no previous snapshot reachable (${err.message}) — starting fresh`);
  }
}

const now = Date.now();
const status = {
  quotes: { lastSuccess: now, lastError: null },
  macro: { lastSuccess: now, lastError: null },
  news: { lastSuccess: now, lastError: null }
};

let indicators;
let macro;
let newsItems;
if (MOCK) {
  indicators = mockIndicators();
  macro = mockMacro();
  newsItems = mockNews();
} else {
  const symbols = allInstruments().map((i) => i.symbol);
  const quotesRes = await fetchAll(symbols);
  indicators = quotesRes.indicators;
  if (quotesRes.errors.size) {
    status.quotes.lastError = `${quotesRes.errors.size} symbols failed (e.g. ${[...quotesRes.errors.entries()][0].join(': ')})`;
    console.warn('[static]', status.quotes.lastError);
  }

  const macroRes = await fetchMacroSeries(FRED_SERIES);
  macro = macroRes.macro;
  if (macroRes.errors.size) {
    status.macro.lastError = `${macroRes.errors.size} series failed (e.g. ${[...macroRes.errors.entries()][0].join(': ')})`;
    console.warn('[static]', status.macro.lastError);
  }

  const newsRes = await fetchNews(NEWS_FEEDS);
  newsItems = newsRes.items;
  if (newsRes.errors.size) {
    status.news.lastError = `${newsRes.errors.size} feeds failed (e.g. ${[...newsRes.errors.entries()][0].join(': ')})`;
    console.warn('[static]', status.news.lastError);
  }
}

// Refuse to publish an empty/broken snapshot — failing keeps the previous
// deployment live.
if (indicators.size < 20) {
  console.error(`[static] only ${indicators.size} instruments fetched — aborting so the previous snapshot stays live`);
  process.exit(1);
}

const newsAgg = aggregateSentiment(newsItems);
const result = buildRecommendations({ indicators, macro, newsAgg, history, now });

for (const c of result.changes) {
  history[c.key] = { tilt: c.tilt, changedAt: c.changedAt, lastTradeDir: c.lastTradeDir };
  log.push({ ...c, at: new Date(c.changedAt).toISOString() });
}
if (log.length > 2000) log = log.slice(-2000);

const payload = assemblePayload({
  mode: MOCK ? 'mock' : 'live',
  hosted: true,
  indicators,
  macro,
  news: newsItems,
  newsAgg,
  recommendations: result,
  status,
  tiltLog: log.slice(-30).reverse()
});
payload.tiltState = { history, log };

const dist = join(ROOT, 'dist');
mkdirSync(dist, { recursive: true });
cpSync(join(ROOT, 'public'), dist, { recursive: true });
writeFileSync(join(dist, 'data.json'), JSON.stringify(payload));
console.log(`[static] wrote dist/ — ${indicators.size} instruments, ${macro.size} macro series, ${newsItems.length} headlines, regime: ${result.regime.label}`);
