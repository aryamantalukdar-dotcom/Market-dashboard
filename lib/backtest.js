// Walk-forward backtest of the engine's market signals over the fetched
// price history. Honest about its limits: only the momentum + trend
// components can be replayed point-in-time (macro-regime fit and news
// sentiment have no free point-in-time history), the window is ~1 year of
// daily closes, and no transaction costs are modeled. Its job is to sanity-
// check that the tilt rules aren't obviously value-destroying, not to prove
// alpha.

import { REGIONS, SECTORS, STYLES, ENGINE } from './config.js';

const STEP = 5;          // weekly rebalance (trading days)
const ACTIVE_W = 0.02;   // +/-2% active weight per tilted bucket vs ACWI
const START = 130;       // need 126 days of history for 6m momentum

function mean(arr) {
  let s = 0;
  for (const x of arr) s += x;
  return s / arr.length;
}

function retOver(closes, i, days) {
  if (i - days < 0) return null;
  const prior = closes[i - days];
  return prior ? closes[i] / prior - 1 : null;
}

// Same momentum + trend math as the live engine, renormalized to exclude the
// macro/news weights that can't be replayed.
function momTrendScore(closes, bench, i) {
  const horizons = [[21, 0.2], [63, 0.4], [126, 0.4]];
  let total = 0;
  let wsum = 0;
  for (const [d, w] of horizons) {
    const r = retOver(closes, i, d);
    const rb = retOver(bench, i, d);
    if (r == null || rb == null) continue;
    total += w * (r - rb) * 100;
    wsum += w;
  }
  if (!wsum) return null;
  const mom = Math.tanh(total / wsum / 6);

  let trend = 0;
  if (i >= 199) trend += closes[i] > mean(closes.slice(i - 199, i + 1)) ? 0.6 : -0.6;
  if (i >= 49) trend += closes[i] > mean(closes.slice(i - 49, i + 1)) ? 0.4 : -0.4;

  const w = ENGINE.weights;
  const score = (w.momentum * mom + w.trend * trend) / (w.momentum + w.trend);
  return Math.max(-1, Math.min(1, score));
}

export function runBacktest(indicators) {
  const bench = indicators.get('ACWI');
  if (!bench?.closes || bench.closes.length < START + STEP + 10) return null;
  const b = bench.closes;
  const N = b.length;

  // Equity buckets only (where the engine scores relative to ACWI). Series
  // are aligned from the end; instruments with shorter history are skipped.
  const items = [...REGIONS, ...SECTORS, ...STYLES]
    .map((it) => {
      const ind = indicators.get(it.symbol);
      if (!ind?.closes || ind.closes.length < N) return null;
      return { key: it.key, closes: ind.closes.slice(-N) };
    })
    .filter(Boolean);
  if (items.length < 8) return null;

  const { enterThreshold, exitThreshold } = ENGINE;
  const tilt = {};
  let cum = 0;
  let weeks = 0;
  let wins = 0;
  let posSum = 0;
  let peak = 0;
  let maxDD = 0;
  const curve = [0];

  for (let i = START; i + STEP < N; i += STEP) {
    const rb = b[i + STEP] / b[i] - 1;
    let weekly = 0;
    let active = 0;
    for (const it of items) {
      const s = momTrendScore(it.closes, b, i);
      const cur = tilt[it.key] || 0;
      let t;
      if (s == null) t = 0;
      else if (cur === 1) t = s > exitThreshold ? 1 : s < -enterThreshold ? -1 : 0;
      else if (cur === -1) t = s < -exitThreshold ? -1 : s > enterThreshold ? 1 : 0;
      else t = s > enterThreshold ? 1 : s < -enterThreshold ? -1 : 0;
      tilt[it.key] = t;
      if (t !== 0) {
        active++;
        weekly += t * ACTIVE_W * ((it.closes[i + STEP] / it.closes[i] - 1) - rb);
      }
    }
    cum += weekly;
    weeks++;
    posSum += active;
    if (weekly > 0) wins++;
    curve.push(+(cum * 100).toFixed(3));
    peak = Math.max(peak, cum);
    maxDD = Math.max(maxDD, peak - cum);
  }
  if (!weeks) return null;

  return {
    weeks,
    universe: items.length,
    activeWeightPct: ACTIVE_W * 100,
    activeReturnPct: +(cum * 100).toFixed(2),
    annualizedPct: +((cum / weeks) * 52 * 100).toFixed(2),
    hitRatePct: Math.round((wins / weeks) * 100),
    maxDrawdownPct: +(maxDD * 100).toFixed(2),
    avgPositions: +(posSum / weeks).toFixed(1),
    curve,
    caveats: [
      'Replays momentum + trend only — macro-regime fit and news sentiment have no free point-in-time history',
      `±${ACTIVE_W * 100}% active weight per tilted bucket vs ACWI, weekly rebalance, no transaction costs or compliance lock`,
      'One year of daily history is far too short to be statistically meaningful — treat as a sanity check, not proof of alpha'
    ],
    updatedAt: Date.now()
  };
}
