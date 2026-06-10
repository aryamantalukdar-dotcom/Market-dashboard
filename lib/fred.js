// FRED macro series via the public fredgraph.csv endpoint — no API key needed.
// Example: https://fred.stlouisfed.org/graph/fredgraph.csv?id=CPIAUCSL

const BASE = 'https://fred.stlouisfed.org/graph/fredgraph.csv?id=';
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (market-dashboard)' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Only the last few years are needed; without cosd, daily series like T10Y2Y
// download 50 years of history and time out on slow connections.
function startDate() {
  const d = new Date();
  d.setFullYear(d.getFullYear() - 4);
  return d.toISOString().slice(0, 10);
}

async function fetchCsv(id, timeoutMs = 45000) {
  let lastErr;
  const url = `${BASE}${encodeURIComponent(id)}&cosd=${startDate()}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { headers: HEADERS, signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      lastErr = err;
      await sleep(1000 * (attempt + 1));
    } finally {
      clearTimeout(t);
    }
  }
  throw lastErr;
}

function parseCsv(text) {
  const rows = [];
  for (const line of text.split('\n').slice(1)) {
    const [date, raw] = line.trim().split(',');
    if (!date || raw === undefined || raw === '.' || raw === '') continue;
    const value = Number(raw);
    if (Number.isFinite(value)) rows.push({ date, value });
  }
  return rows;
}

function yoy(rows) {
  // Monthly series: y/y % change
  return rows.map((r, i) => (i >= 12 ? { date: r.date, value: (r.value / rows[i - 12].value - 1) * 100 } : null))
    .filter(Boolean);
}

function momThousands(rows) {
  return rows.map((r, i) => (i >= 1 ? { date: r.date, value: r.value - rows[i - 1].value } : null))
    .filter(Boolean);
}

// UK ONS time-series endpoint (free JSON, no key) — used where FRED has no
// live feed, e.g. UK CPI after the OECD series were discontinued. The JSON
// lives at the series page URL with /data appended (the old api.ons.gov.uk
// host is retired).
// Example: https://www.ons.gov.uk/economy/inflationandpriceindices/timeseries/d7g7/mm23/data
async function fetchOnsSeries(cfg, timeoutMs = 30000) {
  const url = `https://www.ons.gov.uk/${cfg.onsPath}/data`;
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { headers: HEADERS, signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const rows = (json.months || []).map((m) => {
        const t2 = Date.parse(`${m.month} 1, ${m.year}`);
        const value = Number(m.value);
        if (!Number.isFinite(t2) || !Number.isFinite(value)) return null;
        return { date: new Date(t2).toISOString().slice(0, 10), value };
      }).filter(Boolean);
      if (!rows.length) throw new Error('no monthly observations in ONS response');
      return rows;
    } catch (err) {
      lastErr = err;
      await sleep(1000 * (attempt + 1));
    } finally {
      clearTimeout(t);
    }
  }
  throw lastErr;
}

export async function fetchMacroSeries(seriesConfigs) {
  const out = new Map();
  const errors = new Map();
  await Promise.all(seriesConfigs.map(async (cfg) => {
    try {
      const rows = cfg.source === 'ons'
        ? await fetchOnsSeries(cfg)
        : parseCsv(await fetchCsv(cfg.id));
      let series = rows;
      if (cfg.transform === 'yoy') series = yoy(rows);
      else if (cfg.transform === 'mom_k') series = momThousands(rows);
      else if (cfg.transform === 'level_k') series = rows.map((r) => ({ date: r.date, value: r.value / 1000 }));
      out.set(cfg.id, summarize(cfg, series));
    } catch (err) {
      errors.set(cfg.id, String(err.message || err));
    }
  }));
  return { macro: out, errors };
}

// Observations per 3m/6m lookback and a ~1y spark window, by series frequency.
const OBS = {
  d: { m3: 63, m6: 126, spark: 252 },
  w: { m3: 13, m6: 26, spark: 104 },
  m: { m3: 3, m6: 6, spark: 36 },
  q: { m3: 1, m6: 2, spark: 12 }
};

export function summarize(cfg, series) {
  const o = OBS[cfg.freq] || OBS.m;
  const recent = series.slice(-Math.max(400, o.spark)); // keep payload small
  const latest = recent[recent.length - 1] || null;
  const prior = recent[recent.length - 2] || null;
  const back3 = recent[recent.length - 1 - o.m3] || null;
  const back6 = recent[recent.length - 1 - o.m6] || null;
  // Spark: ~1y window downsampled to <= ~37 points
  const win = recent.slice(-o.spark);
  const step = Math.max(1, Math.floor(win.length / 36));
  const spark = win.filter((_, i) => i % step === 0 || i === win.length - 1).map((r) => r.value);
  return {
    id: cfg.id,
    name: cfg.name,
    unit: cfg.unit,
    latest: latest?.value ?? null,
    latestDate: latest?.date ?? null,
    prior: prior?.value ?? null,
    change3m: latest && back3 ? latest.value - back3.value : null,
    change6m: latest && back6 ? latest.value - back6.value : null,
    spark,
    updatedAt: Date.now()
  };
}
