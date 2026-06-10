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
import { buildPolicyPath } from '../lib/policy.js';
import { runBacktest } from '../lib/backtest.js';
import { enrichNews, blendSentiment } from '../lib/llm.js';
import { assemblePayload } from '../lib/payload.js';
import { mockIndicators, mockMacro, mockNews } from '../lib/mock.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MOCK = process.env.MOCK === '1';

let history = {};
let log = [];
const prevUrls = [];
if (process.env.PREVIOUS_DATA_URL) prevUrls.push(process.env.PREVIOUS_DATA_URL);
if (process.env.GITHUB_REPOSITORY) {
  const [owner, repo] = process.env.GITHUB_REPOSITORY.split('/');
  // raw.githubusercontent works as soon as the gh-pages branch exists,
  // even before GitHub Pages serving is enabled in repo settings.
  prevUrls.push(`https://raw.githubusercontent.com/${owner}/${repo}/gh-pages/data.json`);
  prevUrls.push(`https://${owner}.github.io/${repo}/data.json`);
}
if (!MOCK) {
  for (const prevUrl of prevUrls) {
    try {
      const res = await fetch(prevUrl, { headers: { 'Cache-Control': 'no-cache' } });
      if (!res.ok) {
        console.log(`[static] no previous snapshot at ${prevUrl} (HTTP ${res.status})`);
        continue;
      }
      const prev = await res.json();
      history = prev.tiltState?.history || {};
      log = prev.tiltState?.log || [];
      console.log(`[static] loaded previous tilt state (${Object.keys(history).length} keys, ${log.length} log entries)`);
      break;
    } catch (err) {
      console.log(`[static] previous snapshot unreachable at ${prevUrl} (${err.message})`);
    }
  }
  if (!Object.keys(history).length) console.log('[static] starting with fresh tilt state');
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

let newsAgg = aggregateSentiment(newsItems);
// Optional LLM news layer (requires ANTHROPIC_API_KEY; silently skipped otherwise)
const newsLLM = MOCK ? null : await enrichNews(newsItems);
if (newsLLM) {
  newsAgg = blendSentiment(newsAgg, newsLLM);
  console.log(`[static] LLM news layer active (${newsLLM.model}): ${newsLLM.marketImpact}, ${newsLLM.events.length} events`);
}

const policy = buildPolicyPath(indicators, macro);
const backtest = runBacktest(indicators);
if (policy) console.log(`[static] policy path: ${policy.path.length} contracts, 12m change ${policy.change12mBp}bp`);
if (backtest) console.log(`[static] backtest: ${backtest.weeks} weeks, active return ${backtest.activeReturnPct}%`);

const result = buildRecommendations({ indicators, macro, newsAgg, history, policy, now });

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
  newsLLM,
  policy,
  backtest,
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
