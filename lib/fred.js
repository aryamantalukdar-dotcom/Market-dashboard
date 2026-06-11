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

// ECB Data Portal (free CSV, no key) — policy rate, inflation-linked swaps,
// AAA-curve forwards. Dataset defaults to FM (financial markets); YC carries
// the yield-curve series.
// Example: https://data-api.ecb.europa.eu/service/data/FM/M.U2.EUR.4F.BB.U2_5Y.YLD?format=csvdata
async function fetchEcbSeries(cfg, timeoutMs = 30000) {
  const url = `https://data-api.ecb.europa.eu/service/data/${cfg.ecbDataset || 'FM'}/${cfg.ecbKey}?format=csvdata&startPeriod=${startDate().slice(0, 7)}`;
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { headers: HEADERS, signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      const lines = text.trim().split('\n');
      const header = lines[0].split(',');
      const ti = header.indexOf('TIME_PERIOD');
      const vi = header.indexOf('OBS_VALUE');
      if (ti < 0 || vi < 0) throw new Error('unexpected ECB CSV shape');
      const rows = [];
      for (const line of lines.slice(1)) {
        const cols = line.split(',');
        const period = cols[ti];
        const value = Number(cols[vi]);
        if (!period || !Number.isFinite(value)) continue;
        rows.push({ date: period.length === 7 ? `${period}-01` : period, value });
      }
      if (!rows.length) throw new Error('no observations in ECB response');
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

// Bank of England IADB (free CSV, no key) — gilt-implied inflation forwards.
const BOE_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function boeDate(d) {
  return `${String(d.getUTCDate()).padStart(2, '0')}/${BOE_MONTHS[d.getUTCMonth()]}/${d.getUTCFullYear()}`;
}

// cfg.boeCodes lists candidate series codes (the IADB catalog can't be
// browsed programmatically, so daily/monthly variants are tried in order).
// Returns { rows, freq } since the matching candidate decides the frequency.
async function fetchBoeSeries(cfg, timeoutMs = 30000) {
  const from = new Date();
  from.setFullYear(from.getFullYear() - 4);
  let lastErr;
  for (const cand of cfg.boeCodes) {
    const url = 'https://www.bankofengland.co.uk/boeapps/database/_iadb-fromshowcolumns.asp'
      + `?csv.x=yes&Datefrom=${boeDate(from)}&Dateto=${boeDate(new Date())}`
      + `&SeriesCodes=${cand.code}&CSVF=TN&UsingCodes=Y&VPD=Y&VFD=N`;
    for (let attempt = 0; attempt < 2; attempt++) {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetch(url, { headers: HEADERS, signal: ctrl.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        if (/<html/i.test(text)) {
          lastErr = new Error(`IADB error page for ${cand.code}`);
          break; // bad code — no point retrying, move to next candidate
        }
        const rows = [];
        for (const line of text.trim().split('\n')) {
          const [rawDate, rawValue] = line.split(',');
          const time = Date.parse(rawDate);
          const value = Number(rawValue);
          if (!Number.isFinite(time) || !Number.isFinite(value)) continue;
          rows.push({ date: new Date(time).toISOString().slice(0, 10), value });
        }
        if (!rows.length) throw new Error(`no observations for ${cand.code}`);
        return { rows, freq: cand.freq };
      } catch (err) {
        lastErr = err;
        await sleep(1000 * (attempt + 1));
      } finally {
        clearTimeout(t);
      }
    }
  }
  throw lastErr;
}

// Japan MoF JGB yield curve CSV (free, no key; current calendar year).
// Header: Date,1Y,2Y,...,40Y; rows like 2026/1/6,0.71,...
async function fetchMofSeries(cfg, timeoutMs = 30000) {
  const url = 'https://www.mof.go.jp/english/policy/jgbs/reference/interest_rate/data/jgbcme.csv';
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { headers: HEADERS, signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const lines = (await res.text()).trim().split('\n');
      const hi = lines.findIndex((l) => /(^|,)Date(,|$)/i.test(l));
      if (hi < 0) throw new Error('no header row in MoF CSV');
      const header = lines[hi].split(',').map((s) => s.trim());
      const ci = header.indexOf(cfg.mofTenor);
      if (ci < 0) throw new Error(`tenor ${cfg.mofTenor} not in MoF CSV`);
      const rows = [];
      for (const line of lines.slice(hi + 1)) {
        const cols = line.split(',');
        const time = Date.parse(cols[0]);
        const value = Number(cols[ci]);
        if (!Number.isFinite(time) || !Number.isFinite(value)) continue;
        rows.push({ date: new Date(time).toISOString().slice(0, 10), value });
      }
      if (!rows.length) throw new Error('no observations in MoF CSV');
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
      let rows;
      let effCfg = cfg;
      if (cfg.source === 'ons') rows = await fetchOnsSeries(cfg);
      else if (cfg.source === 'ecb') rows = await fetchEcbSeries(cfg);
      else if (cfg.source === 'mof') rows = await fetchMofSeries(cfg);
      else if (cfg.source === 'boe') {
        const boe = await fetchBoeSeries(cfg);
        rows = boe.rows;
        effCfg = { ...cfg, freq: boe.freq };
      } else rows = parseCsv(await fetchCsv(cfg.id));
      let series = rows;
      if (cfg.transform === 'yoy') series = yoy(rows);
      else if (cfg.transform === 'mom_k') series = momThousands(rows);
      else if (cfg.transform === 'level_k') series = rows.map((r) => ({ date: r.date, value: r.value / 1000 }));
      out.set(cfg.id, summarize(effCfg, series));
    } catch (err) {
      errors.set(cfg.id, String(err.message || err));
    }
  }));
  // Promise.all completion order is nondeterministic; emit in config order so
  // grouped rendering downstream is stable.
  const ordered = new Map();
  for (const cfg of seriesConfigs) if (out.has(cfg.id)) ordered.set(cfg.id, out.get(cfg.id));
  return { macro: ordered, errors };
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
  // Most recent discrete step >= 5bp — surfaces policy moves (a 6m average
  // hides a hike that happened last week). Meaningless for noisy series;
  // only the stance card consumes it, with its own 10bp threshold.
  let lastMove = null;
  for (let i = recent.length - 1; i > 0; i--) {
    const delta = recent[i].value - recent[i - 1].value;
    if (Math.abs(delta) >= 0.05) {
      lastMove = { date: recent[i].date, delta: +delta.toFixed(2) };
      break;
    }
  }
  return {
    id: cfg.id,
    name: cfg.name,
    unit: cfg.unit,
    topic: cfg.topic || 'Other',
    latest: latest?.value ?? null,
    latestDate: latest?.date ?? null,
    prior: prior?.value ?? null,
    change3m: latest && back3 ? latest.value - back3.value : null,
    change6m: latest && back6 ? latest.value - back6.value : null,
    lastMove,
    spark,
    updatedAt: Date.now()
  };
}
