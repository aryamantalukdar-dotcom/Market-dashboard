// Yahoo Finance chart API fetcher (no API key). One request per symbol.
// Computes the per-instrument indicator pack the engine consumes.

const BASE = 'https://query1.finance.yahoo.com/v8/finance/chart/';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Accept': 'application/json'
};

async function fetchJson(url, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: HEADERS, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

export async function fetchChart(symbol, range = '1y', interval = '1d') {
  const url = `${BASE}${encodeURIComponent(symbol)}?range=${range}&interval=${interval}&includePrePost=false`;
  const json = await fetchJson(url);
  const result = json?.chart?.result?.[0];
  if (!result) throw new Error(json?.chart?.error?.description || 'empty chart result');
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

// Fetch many symbols with a small concurrency limit to stay polite.
export async function fetchAll(symbols, { range = '1y', concurrency = 6 } = {}) {
  const out = new Map();
  const errors = new Map();
  let idx = 0;
  async function worker() {
    while (idx < symbols.length) {
      const sym = symbols[idx++];
      try {
        const chart = await fetchChart(sym, range);
        if (chart.closes.length) out.set(sym, computeIndicators(chart));
      } catch (err) {
        errors.set(sym, String(err.message || err));
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, symbols.length) }, worker));
  return { indicators: out, errors };
}
