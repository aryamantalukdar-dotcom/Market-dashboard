// Yahoo Finance chart API fetcher (no API key). One request per symbol.
// Computes the per-instrument indicator pack the engine consumes.

import { fetchStooqChart } from './stooq.js';

const HOSTS = ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com'];
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Accept': 'application/json'
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(url, timeoutMs = 12000, extraHeaders = null) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { ...HEADERS, ...extraHeaders }, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

// Public relay proxies used as a last resort: GitHub Actions runner IPs are
// rate-limited by Yahoo (429) and blocked by Stooq, but these relays fetch
// from their own egress IPs. Only price data flows through them. They are
// themselves rate-limited, so callers must keep relay traffic to a handful
// of (batched) requests with spacing between them.
const RELAYS = [
  // corsproxy first: most reliable in practice (requires the browser-style
  // Origin headers below on its free tier)
  { name: 'corsproxy', wrap: (u) => `https://corsproxy.io/?url=${encodeURIComponent(u)}` },
  { name: 'allorigins-raw', wrap: (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}` },
  {
    name: 'allorigins-get',
    wrap: (u) => `https://api.allorigins.win/get?url=${encodeURIComponent(u)}`,
    unwrap: (j) => JSON.parse(j.contents)
  },
  { name: 'codetabs', wrap: (u) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(u)}` }
];

const RELAY_HEADERS = {
  'Origin': 'https://localhost',
  'X-Requested-With': 'XMLHttpRequest'
};

async function relayFetchJson(relay, url, timeoutMs = 20000) {
  const json = await fetchJson(relay.wrap(url), timeoutMs, RELAY_HEADERS);
  return relay.unwrap ? relay.unwrap(json) : json;
}

function chartUrl(host, symbol, range, interval) {
  return `${host}/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}&includePrePost=false`;
}

function parseChartResult(symbol, result) {
  if (!result) throw new Error('empty chart result');
  const closesRaw = result.indicators?.quote?.[0]?.close || [];
  const timesRaw = result.timestamp || [];
  const closes = [];
  const times = [];
  for (let i = 0; i < closesRaw.length; i++) {
    if (closesRaw[i] != null && Number.isFinite(closesRaw[i])) {
      closes.push(closesRaw[i]);
      times.push(timesRaw[i]);
    }
  }
  return {
    symbol,
    price: result.meta?.regularMarketPrice ?? closes[closes.length - 1] ?? null,
    previousClose: result.meta?.chartPreviousClose ?? result.meta?.previousClose ?? null,
    marketTime: result.meta?.regularMarketTime ?? null,
    closes,
    times
  };
}

export async function fetchChart(symbol, range = '1y', interval = '1d', attempts = 2) {
  // Yahoo rate-limits datacenter IPs aggressively; rotate hosts and back off.
  let lastErr;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const url = chartUrl(HOSTS[attempt % HOSTS.length], symbol, range, interval);
    try {
      const json = await fetchJson(url);
      return parseChartResult(symbol, json?.chart?.result?.[0]);
    } catch (err) {
      lastErr = err;
      await sleep(600 * (attempt + 1) + Math.random() * 400);
    }
  }
  throw lastErr;
}

async function fetchChartViaProxies(symbol, range, interval) {
  let lastErr;
  for (const relay of RELAYS) {
    try {
      const json = await relayFetchJson(relay, chartUrl(HOSTS[0], symbol, range, interval), 15000);
      return parseChartResult(symbol, json?.chart?.result?.[0]);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

// Yahoo's spark endpoint returns chart data for many symbols in ONE request,
// which matters when going through relay proxies (they rate-limit too).
async function sparkPass(symbols, range, out, relay) {
  const via = relay ? relay.name : 'direct';
  for (let i = 0; i < symbols.length; i += 10) {
    const batch = symbols.slice(i, i + 10);
    const url = `${HOSTS[0]}/v8/finance/spark?symbols=${batch.map(encodeURIComponent).join(',')}&range=${range}&interval=1d`;
    const attempts = relay ? 2 : 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const json = relay ? await relayFetchJson(relay, url) : await fetchJson(url, 25000);
        // The spark payload shape has varied over time; accept all known forms.
        const results = json?.spark?.result || json?.result || (Array.isArray(json) ? json : []);
        for (const r of results) {
          try {
            const chart = parseChartResult(r.symbol, r?.response?.[0]);
            if (chart.closes.length) out.set(r.symbol, computeIndicators(chart));
          } catch { /* symbol missing from batch; later passes retry it */ }
        }
        break;
      } catch (err) {
        console.warn(`[yahoo] spark batch (${batch.length} syms) via ${via} failed: ${err.message}`);
        if (attempt + 1 < attempts) await sleep(2000);
      }
    }
    if (relay) await sleep(1200); // stay under relay rate limits
  }
}

function returnOver(closes, days) {
  if (closes.length < days + 1) return null;
  const last = closes[closes.length - 1];
  const prior = closes[closes.length - 1 - days];
  if (!prior) return null;
  return (last / prior - 1) * 100;
}

function mean(arr) {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

export function computeIndicators(chart) {
  const { closes } = chart;
  const last = chart.price ?? closes[closes.length - 1];
  const prevClose = closes.length >= 2 ? closes[closes.length - 2] : chart.previousClose;
  const ma50 = closes.length >= 50 ? mean(closes.slice(-50)) : null;
  const ma200 = closes.length >= 200 ? mean(closes.slice(-200)) : null;

  // 21-day annualized realized volatility
  let vol21 = null;
  if (closes.length >= 22) {
    const rets = [];
    for (let i = closes.length - 21; i < closes.length; i++) {
      rets.push(Math.log(closes[i] / closes[i - 1]));
    }
    const m = mean(rets);
    const variance = mean(rets.map((r) => (r - m) ** 2));
    vol21 = Math.sqrt(variance * 252) * 100;
  }

  const high52 = Math.max(...closes);
  const low52 = Math.min(...closes);

  // Downsample for sparkline (~60 points over ~6 months)
  const window = closes.slice(-126);
  const step = Math.max(1, Math.floor(window.length / 60));
  const spark = window.filter((_, i) => i % step === 0 || i === window.length - 1);

  return {
    symbol: chart.symbol,
    price: last,
    dayChangePct: prevClose ? (last / prevClose - 1) * 100 : null,
    r1w: returnOver(closes, 5),
    r1m: returnOver(closes, 21),
    r3m: returnOver(closes, 63),
    r6m: returnOver(closes, 126),
    r1y: returnOver(closes, 251),
    ma50,
    ma200,
    aboveMa50: ma50 != null ? last > ma50 : null,
    aboveMa200: ma200 != null ? last > ma200 : null,
    vol21,
    pctFromHigh: high52 ? (last / high52 - 1) * 100 : null,
    high52,
    low52,
    spark,
    marketTime: chart.marketTime,
    updatedAt: Date.now()
  };
}

// Fetch many symbols, cheapest strategy first:
//   1. spark batch direct (3 requests for the whole universe)
//   2. spark batch through each relay proxy (for IP-blocked environments)
//   3. per-symbol chain for stragglers: chart direct -> Stooq -> chart via proxy
export async function fetchAll(symbols, { range = '1y', concurrency = 4 } = {}) {
  const out = new Map();
  const errors = new Map();

  await sparkPass(symbols, range, out, null);
  for (const relay of RELAYS) {
    const missing = symbols.filter((s) => !out.has(s));
    if (!missing.length) break;
    await sparkPass(missing, range, out, relay);
  }

  const stragglers = symbols.filter((s) => !out.has(s));
  let yahooConsecFails = 0;
  let stooqConsecFails = 0;
  const BREAK_AFTER = 6;
  let idx = 0;
  async function worker() {
    while (idx < stragglers.length) {
      const sym = stragglers[idx++];
      const attemptsLog = [];
      let chart = null;

      if (yahooConsecFails < BREAK_AFTER) {
        try {
          chart = await fetchChart(sym, range);
          yahooConsecFails = 0;
        } catch (err) {
          yahooConsecFails++;
          attemptsLog.push(`yahoo: ${err.message}`);
        }
      }
      if (!chart && stooqConsecFails < BREAK_AFTER) {
        try {
          chart = await fetchStooqChart(sym);
          stooqConsecFails = 0;
        } catch (err) {
          stooqConsecFails++;
          attemptsLog.push(`stooq: ${err.message}`);
        }
      }
      if (!chart) {
        try {
          chart = await fetchChartViaProxies(sym, range, '1d');
        } catch (err) {
          attemptsLog.push(`proxy: ${err.message}`);
        }
      }

      if (chart?.closes?.length) out.set(sym, computeIndicators(chart));
      else errors.set(sym, attemptsLog.join('; ') || 'no data');
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, stragglers.length) }, worker));
  return { indicators: out, errors };
}
