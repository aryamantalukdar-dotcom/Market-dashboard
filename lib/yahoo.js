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

// Public relay proxies, tried per-symbol as a last resort for whatever the
// direct endpoints could not reach: they fetch from their own egress IPs, so
// they can work where a runner IP is blocked. Only price data flows through
// them. In practice all four are usually down (401/522), so callers must put
// a circuit breaker in front rather than attempting them for every symbol.
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

// Yahoo's spark endpoint returns chart data for many symbols in ONE request —
// the whole universe in 7 calls instead of 62, when the IP is allowed to use it.
// A single pass over the universe. Batches are spaced, but a run of failures
// means the endpoint is refusing this IP rather than throttling a burst, so the
// pass gives up instead of walking the remaining batches into the same wall.
async function sparkPass(symbols, range, out) {
  let consecFails = 0;
  for (let i = 0; i < symbols.length; i += 10) {
    const batch = symbols.slice(i, i + 10);
    const url = `${HOSTS[0]}/v8/finance/spark?symbols=${batch.map(encodeURIComponent).join(',')}&range=${range}&interval=1d`;
    try {
      const json = await fetchJson(url, 25000);
      // The spark payload shape has varied over time; accept all known forms.
      const results = json?.spark?.result || json?.result || (Array.isArray(json) ? json : []);
      for (const r of results) {
        try {
          const chart = parseChartResult(r.symbol, r?.response?.[0]);
          if (chart.closes.length) out.set(r.symbol, computeIndicators(chart));
        } catch { /* symbol missing from batch; the chart rounds retry it */ }
      }
      consecFails = 0;
    } catch (err) {
      console.warn(`[yahoo] spark batch (${batch.length} syms) failed: ${err.message}`);
      if (++consecFails >= 3) {
        console.warn('[yahoo] spark endpoint unavailable — falling through to per-symbol chart');
        return;
      }
    }
    await sleep(800);
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
    closes, // full series kept for the backtest; stripped from the payload
    marketTime: chart.marketTime,
    updatedAt: Date.now()
  };
}

// Runs fn over items with a bounded worker pool, pausing between requests so a
// pass paces itself rather than arriving as one burst.
async function pooled(items, concurrency, gapMs, fn) {
  let idx = 0;
  const worker = async () => {
    while (idx < items.length) {
      const item = items[idx++];
      await fn(item);
      if (gapMs) await sleep(gapMs + Math.random() * gapMs);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
}

// Fetch many symbols.
//
// Endpoint choice is driven by what actually survives from CI: Yahoo's /spark
// endpoint 429s every batch from GitHub Actions runner IPs no matter how the
// requests are spaced, while per-symbol /chart on the same host keeps serving.
// So spark gets one cheap attempt (it is 7 requests for the whole universe and
// does work off-CI), and /chart is the real workhorse, retried in rounds.
//
// Stooq and the public relays are tried last and only for whatever is still
// missing — both block or throttle datacenter IPs and rarely contribute.
export async function fetchAll(symbols, { range = '1y', concurrency = 4 } = {}) {
  const out = new Map();
  const errors = new Map();

  // 1. One spark pass. Cheap when it works, abandoned immediately when it does not.
  await sparkPass(symbols, range, out);
  if (out.size) console.log(`[yahoo] spark direct covered ${out.size}/${symbols.length} symbols`);

  // 2. Per-symbol /chart in rounds. A round that makes progress is followed by
  //    another for whatever it missed; a round that yields nothing at all means
  //    the host is refusing us outright, so stop rather than grind.
  for (let round = 0; round < 3; round++) {
    const missing = symbols.filter((s) => !out.has(s));
    if (!missing.length) break;
    if (round > 0) {
      console.warn(`[yahoo] ${missing.length} symbols missing — cooling down before chart round ${round + 1}`);
      await sleep(30000);
    }
    const before = out.size;
    await pooled(missing, concurrency, 250, async (sym) => {
      try {
        out.set(sym, computeIndicators(await fetchChart(sym, range)));
        errors.delete(sym);
      } catch (err) {
        errors.set(sym, `yahoo: ${err.message}`);
      }
    });
    const gained = out.size - before;
    console.log(`[yahoo] chart round ${round + 1}: +${gained} symbols (${out.size}/${symbols.length})`);
    if (!gained) break;
  }

  // 3. Stooq, then the relays, for anything still missing. Both give up quickly
  //    once they prove unreachable — they are long shots, not a budget sink.
  const stragglers = symbols.filter((s) => !out.has(s));
  let stooqConsecFails = 0;
  let proxyConsecFails = 0;
  const BREAK_AFTER = 6;
  await pooled(stragglers, concurrency, 0, async (sym) => {
    const attemptsLog = [errors.get(sym)].filter(Boolean);
    let chart = null;

    if (stooqConsecFails < BREAK_AFTER) {
      try {
        chart = await fetchStooqChart(sym);
        stooqConsecFails = 0;
      } catch (err) {
        stooqConsecFails++;
        attemptsLog.push(`stooq: ${err.message}`);
      }
    }
    if (!chart && proxyConsecFails < BREAK_AFTER) {
      try {
        chart = await fetchChartViaProxies(sym, range, '1d');
        proxyConsecFails = 0;
      } catch (err) {
        proxyConsecFails++;
        attemptsLog.push(`proxy: ${err.message}`);
      }
    }

    if (chart?.closes?.length) {
      out.set(sym, computeIndicators(chart));
      errors.delete(sym);
    } else {
      errors.set(sym, attemptsLog.join('; ') || 'no data');
    }
  });
  return { indicators: out, errors };
}
