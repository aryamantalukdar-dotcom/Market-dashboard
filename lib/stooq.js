// Stooq fallback data source (free CSV, no key, tolerant of datacenter IPs).
// Used when Yahoo rate-limits us — e.g. from GitHub Actions runners.
// CSV: Date,Open,High,Low,Close,Volume with full daily history.

const HEADERS = { 'User-Agent': 'Mozilla/5.0 (market-dashboard)' };

// Symbols that don't follow the plain "<ticker>.us" ETF convention.
const MAP = {
  'GC=F': 'gc.f',
  'CL=F': 'cl.f',
  'HG=F': 'hg.f',
  'SI=F': 'si.f',
  'NG=F': 'ng.f',
  'EURUSD=X': 'eurusd',
  'USDJPY=X': 'usdjpy',
  'GBPUSD=X': 'gbpusd',
  'CNY=X': 'usdcny',
  'DX-Y.NYB': 'dx.f',
  '^VIX': '^vix',
  '^TNX': '10yusy.b',
  '^TYX': '30yusy.b',
  '^IRX': '3musy.b',
  'BTC-USD': 'btcusd'
};

export function stooqSymbol(symbol) {
  if (MAP[symbol]) return MAP[symbol];
  if (/^[A-Z]{2,5}$/.test(symbol)) return `${symbol.toLowerCase()}.us`;
  return null;
}

export async function fetchStooqChart(symbol, timeoutMs = 15000) {
  const mapped = stooqSymbol(symbol);
  if (!mapped) throw new Error(`no stooq mapping for ${symbol}`);
  const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(mapped)}&i=d`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: HEADERS, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const lines = text.trim().split('\n');
    if (lines.length < 30 || !lines[0].startsWith('Date')) throw new Error('no data');
    const closes = [];
    const times = [];
    for (const line of lines.slice(1).slice(-260)) {
      const cols = line.split(',');
      const close = Number(cols[4]);
      if (!Number.isFinite(close)) continue;
      closes.push(close);
      times.push(Math.floor(Date.parse(cols[0]) / 1000));
    }
    if (closes.length < 30) throw new Error('too few rows');
    return {
      symbol,
      price: closes[closes.length - 1],
      previousClose: closes[closes.length - 2],
      marketTime: times[times.length - 1],
      closes,
      times
    };
  } finally {
    clearTimeout(t);
  }
}
