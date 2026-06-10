// Deterministic mock data so the dashboard runs end-to-end with no network
// (demos, tests, restricted environments). Enabled with MOCK=1 or used as a
// fallback when live sources are completely unreachable at boot.

import { allInstruments, FRED_SERIES } from './config.js';
import { computeIndicators } from './yahoo.js';
import { summarize } from './fred.js';
import { scoreSentiment, tagItem } from './news.js';

// Small seeded PRNG (mulberry32) for reproducible series.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashCode(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return Math.abs(h) || 1;
}

const PROFILES = [
  [/^\^VIX$/, { start: 18, drift: 0, vol: 0.05, floor: 10 }],
  [/^\^(TNX|TYX|IRX|FVX)$/, { start: 4.2, drift: 0, vol: 0.012, floor: 0.5 }],
  [/=F$/, { start: 80, drift: 0.0004, vol: 0.016, floor: 1 }],
  [/(=X|-Y\.NYB)$/, { start: 100, drift: 0, vol: 0.005, floor: 1 }],
  [/^BTC/, { start: 60000, drift: 0.001, vol: 0.035, floor: 1000 }],
  [/^(TLT|IEF|LQD|HYG|TIP|EMB|BNDX)$/, { start: 95, drift: 0.0001, vol: 0.005, floor: 10 }],
  [/.*/, { start: 100, drift: 0.0005, vol: 0.011, floor: 5 }]
];

function profileFor(symbol) {
  return PROFILES.find(([re]) => re.test(symbol))[1];
}

export function mockIndicators() {
  const indicators = new Map();
  const now = Math.floor(Date.now() / 1000);
  for (const inst of allInstruments()) {
    const p = profileFor(inst.symbol);
    const rand = rng(hashCode(inst.symbol));
    const closes = [];
    const times = [];
    let price = p.start * (0.5 + rand());
    for (let i = 252; i > 0; i--) {
      const shock = (rand() - 0.5) * 2 * p.vol;
      price = Math.max(p.floor, price * (1 + p.drift + shock));
      closes.push(+price.toFixed(2));
      times.push(now - i * 86400);
    }
    indicators.set(inst.symbol, computeIndicators({
      symbol: inst.symbol,
      price: closes[closes.length - 1],
      previousClose: closes[closes.length - 2],
      marketTime: now,
      closes,
      times
    }));
  }
  return indicators;
}

const MOCK_MACRO_BASE = {
  CPIAUCSL: { start: 3.4, step: -0.05 },
  CPILFESL: { start: 3.1, step: -0.04 },
  UNRATE: { start: 4.0, step: 0.02 },
  PAYEMS: { start: 180, step: -4 },
  FEDFUNDS: { start: 4.5, step: -0.04 },
  T10Y2Y: { start: 0.3, step: 0.01 },
  BAMLH0A0HYM2: { start: 3.4, step: 0.01 },
  UMCSENT: { start: 68, step: 0.2 }
};

export function mockMacro() {
  const macro = new Map();
  for (const cfg of FRED_SERIES) {
    const base = MOCK_MACRO_BASE[cfg.id] || { start: 1, step: 0 };
    const rand = rng(hashCode(cfg.id));
    const series = [];
    const today = new Date();
    for (let i = 36; i >= 0; i--) {
      const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
      series.push({
        date: d.toISOString().slice(0, 10),
        value: +(base.start + base.step * (36 - i) + (rand() - 0.5) * Math.abs(base.start) * 0.05).toFixed(2)
      });
    }
    macro.set(cfg.id, summarize(cfg, series));
  }
  return macro;
}

const MOCK_HEADLINES = [
  ['Fed officials signal patience on rate cuts as inflation cools', 'Mock Wire'],
  ['Global stocks rally as growth data tops estimates', 'Mock Wire'],
  ['China unveils fresh stimulus to support property sector', 'Mock Wire'],
  ['Oil slips as OPEC output rises and demand outlook softens', 'Mock Wire'],
  ['European banks beat earnings expectations, lift FTSE and DAX', 'Mock Wire'],
  ['Treasury yields edge lower ahead of CPI report', 'Mock Wire'],
  ['AI chip demand drives tech sector to record high', 'Mock Wire'],
  ['Japan wage growth strengthens case for BOJ normalization', 'Mock Wire'],
  ['EM currencies gain as dollar weakens for third week', 'Mock Wire'],
  ['Geopolitical tensions escalate in Middle East, gold jumps', 'Mock Wire']
];

export function mockNews() {
  const now = Date.now();
  return MOCK_HEADLINES.map(([title, source], i) => ({
    title,
    link: '#',
    description: '(mock headline for demo mode)',
    source,
    publishedAt: now - i * 45 * 60 * 1000,
    sentiment: scoreSentiment(title),
    tags: tagItem(title)
  }));
}
