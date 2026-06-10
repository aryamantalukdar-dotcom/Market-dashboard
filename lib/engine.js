// Recommendation engine.
//
// Pipeline: macro regime classification -> per-bucket composite score
// (relative momentum + trend + macro fit + news nudge) -> tilt with
// hysteresis -> compliance filter (30-day opposite-trade lock).
//
// All output is at region/sector/style/asset-class granularity via broad ETF
// proxies. Tilts are framed against an MSCI ACWI baseline for a passive,
// low-turnover investor.

import { REGIONS, SECTORS, STYLES, BONDS, COMMODITIES, ENGINE } from './config.js';

const TILT_RANK = { UNDERWEIGHT: -1, NEUTRAL: 0, OVERWEIGHT: 1 };

function clamp(x, lo = -1, hi = 1) {
  return Math.max(lo, Math.min(hi, x));
}

function get(indicators, symbol) {
  return indicators.get(symbol) || null;
}

// ---------------------------------------------------------------------------
// Regime classification
// ---------------------------------------------------------------------------

export function classifyRegime(indicators, macro, policy = null) {
  const vix = get(indicators, '^VIX');
  const acwi = get(indicators, 'ACWI');
  const dxy = get(indicators, 'DX-Y.NYB');
  const ust10 = get(indicators, '^TNX');
  const curve = macro.get('T10Y2Y');
  const hyOas = macro.get('BAMLH0A0HYM2');
  const cpi = macro.get('CPIAUCSL');
  const coreCpi = macro.get('CPILFESL');
  const unrate = macro.get('UNRATE');
  const payrolls = macro.get('PAYEMS');
  const claims = macro.get('ICSA');
  const indpro = macro.get('INDPRO');
  const be10 = macro.get('T10YIE');
  const fwd5y5y = macro.get('T5YIFR');

  // --- Risk stress score: positive = calm/risk-on, negative = stressed ---
  let risk = 0;
  const signals = { risk: [], growth: [], inflation: [] };
  if (vix?.price != null) {
    if (vix.price < 15) { risk += 0.5; signals.risk.push(`VIX low at ${vix.price.toFixed(1)}`); }
    else if (vix.price > 35) { risk -= 1.0; signals.risk.push(`VIX in crisis territory at ${vix.price.toFixed(1)}`); }
    else if (vix.price > 25) { risk -= 0.5; signals.risk.push(`VIX elevated at ${vix.price.toFixed(1)}`); }
    else signals.risk.push(`VIX moderate at ${vix.price.toFixed(1)}`);
  }
  if (acwi?.aboveMa200 != null) {
    risk += acwi.aboveMa200 ? 0.35 : -0.35;
    signals.risk.push(`ACWI ${acwi.aboveMa200 ? 'above' : 'below'} its 200-day average`);
  }
  if (hyOas?.latest != null && hyOas?.change3m != null) {
    if (hyOas.change3m > 0.75) { risk -= 0.5; signals.risk.push(`HY spreads widening (+${hyOas.change3m.toFixed(2)}pp / 3m)`); }
    else if (hyOas.change3m < -0.25) { risk += 0.25; signals.risk.push('HY spreads tightening'); }
    if (hyOas.latest > 5.5) { risk -= 0.35; signals.risk.push(`HY spreads wide at ${hyOas.latest.toFixed(1)}pp`); }
  }
  risk = clamp(risk);

  // --- Growth score ---
  let growth = 0;
  if (payrolls?.latest != null) {
    if (payrolls.latest > 150) { growth += 0.4; signals.growth.push(`Payrolls solid (+${Math.round(payrolls.latest)}k)`); }
    else if (payrolls.latest < 0) { growth -= 0.6; signals.growth.push(`Payrolls contracting (${Math.round(payrolls.latest)}k)`); }
    else { growth += 0.1; signals.growth.push(`Payrolls soft (+${Math.round(payrolls.latest)}k)`); }
  }
  if (unrate?.change6m != null) {
    if (unrate.change6m > 0.4) { growth -= 0.5; signals.growth.push(`Unemployment rising (+${unrate.change6m.toFixed(1)}pp / 6m)`); }
    else if (unrate.change6m < 0) { growth += 0.2; signals.growth.push('Unemployment falling'); }
  }
  if (curve?.latest != null) {
    if (curve.latest < 0) { growth -= 0.3; signals.growth.push(`Yield curve inverted (${curve.latest.toFixed(2)}pp)`); }
    else if (curve.change3m != null && curve.change3m > 0.2) { growth += 0.15; signals.growth.push('Yield curve steepening'); }
  }
  if (claims?.change3m != null) {
    if (claims.change3m > 25) { growth -= 0.25; signals.growth.push(`Jobless claims trending up (+${Math.round(claims.change3m)}k / 3m)`); }
    else if (claims.change3m < -10) { growth += 0.1; signals.growth.push('Jobless claims falling'); }
  }
  if (indpro?.latest != null) {
    if (indpro.latest < 0) { growth -= 0.2; signals.growth.push(`Industrial production contracting (${indpro.latest.toFixed(1)}% y/y)`); }
    else if (indpro.latest > 2) { growth += 0.15; signals.growth.push('Industrial production expanding'); }
  }
  growth = clamp(growth);

  // --- Inflation score: positive = inflation pressure ---
  let inflation = 0;
  const cpiNow = coreCpi?.latest ?? cpi?.latest;
  if (cpiNow != null) {
    if (cpiNow > 3.5) { inflation += 0.6; signals.inflation.push(`Core inflation hot at ${cpiNow.toFixed(1)}%`); }
    else if (cpiNow > 2.5) { inflation += 0.3; signals.inflation.push(`Inflation above target (${cpiNow.toFixed(1)}%)`); }
    else { inflation -= 0.2; signals.inflation.push(`Inflation near/below target (${cpiNow.toFixed(1)}%)`); }
  }
  const cpiTrend = coreCpi?.change6m ?? cpi?.change6m;
  if (cpiTrend != null) {
    if (cpiTrend > 0.3) { inflation += 0.3; signals.inflation.push('Inflation re-accelerating'); }
    else if (cpiTrend < -0.3) { inflation -= 0.3; signals.inflation.push('Inflation decelerating'); }
  }
  // Market-implied expectations: 5y5y forward is the anchoring gauge,
  // breakeven momentum is the repricing gauge.
  if (fwd5y5y?.latest != null) {
    if (fwd5y5y.latest > 2.6) { inflation += 0.25; signals.inflation.push(`Long-run inflation expectations elevated (5y5y ${fwd5y5y.latest.toFixed(2)}%)`); }
    else if (fwd5y5y.latest < 2.2) { inflation -= 0.15; signals.inflation.push(`Long-run expectations anchored (5y5y ${fwd5y5y.latest.toFixed(2)}%)`); }
  }
  if (be10?.change3m != null) {
    if (be10.change3m > 0.2) { inflation += 0.2; signals.inflation.push(`Breakevens repricing higher (+${be10.change3m.toFixed(2)}pp / 3m)`); }
    else if (be10.change3m < -0.2) { inflation -= 0.15; signals.inflation.push('Breakevens easing'); }
  }
  inflation = clamp(inflation);

  // --- Market-implied policy path (display + signals; small macro tilt) ---
  signals.policy = [];
  if (policy) {
    const c = policy.change12mBp;
    const dir = c <= -10 ? `${Math.abs(c)}bp of cuts` : c >= 10 ? `${c}bp of hikes` : 'roughly no change';
    signals.policy.push(`Fed funds futures price ${dir} over the next 12m (policy rate now ${policy.currentRate.toFixed(2)}%)`);
  }

  // --- Label ---
  let label;
  let summary;
  if (risk < -0.5) {
    label = 'Risk-Off Stress';
    summary = 'Markets are under stress. Favor quality, defensives and duration; avoid adding cyclical risk.';
  } else if (growth >= 0 && inflation < 0) {
    label = 'Goldilocks (Disinflationary Expansion)';
    summary = 'Growth holding up while inflation cools — historically the friendliest backdrop for equities and credit.';
  } else if (growth >= 0 && inflation >= 0) {
    label = 'Reflation';
    summary = 'Growth and inflation both firm. Real assets, value and cyclicals tend to lead; long duration lags.';
  } else if (growth < 0 && inflation >= 0) {
    label = 'Stagflation Risk';
    summary = 'Slowing growth with sticky inflation. Favor TIPS, commodities and defensive equity; toughest regime for balanced portfolios.';
  } else {
    label = 'Slowdown / Disinflation';
    summary = 'Growth and inflation both rolling over. Duration and quality usually outperform; expect rate cuts to be debated.';
  }

  return {
    label,
    summary,
    scores: { risk: +risk.toFixed(2), growth: +growth.toFixed(2), inflation: +inflation.toFixed(2) },
    signals,
    aux: {
      vix: vix?.price ?? null,
      dxy3m: dxy?.r3m ?? null,
      ust10_3mChangeBp: ust10?.r3m != null && ust10?.price != null
        ? +(ust10.price - ust10.price / (1 + ust10.r3m / 100)).toFixed(2) * 10
        : null,
      oil3m: get(indicators, 'CL=F')?.r3m ?? null
    }
  };
}

// ---------------------------------------------------------------------------
// Macro fit adjustments per bucket
// ---------------------------------------------------------------------------

function macroAdjustments(regime, policy = null) {
  const adj = {};
  const why = {};
  const add = (key, v, reason) => {
    adj[key] = (adj[key] || 0) + v;
    (why[key] = why[key] || []).push(reason);
  };
  const { risk, growth, inflation } = regime.scores;
  const dxy3m = regime.aux.dxy3m;
  const oil3m = regime.aux.oil3m;

  // Market-implied Fed path: deep easing priced in supports duration,
  // hikes priced in pressure it.
  if (policy) {
    if (policy.change12mBp < -75) {
      add('ust_long', 0.1, 'deep Fed easing priced into futures supports duration');
      add('ust_mid', 0.08, 'deep Fed easing priced into futures supports duration');
    } else if (policy.change12mBp > 50) {
      add('ust_long', -0.1, 'Fed hikes priced into futures pressure duration');
      add('ust_mid', -0.06, 'Fed hikes priced into futures pressure duration');
    }
  }

  // Dollar trend hits EM hardest
  if (dxy3m != null && dxy3m > 3) {
    for (const k of ['em', 'china', 'india', 'latam', 'em_debt']) add(k, -0.15, 'strong USD is a headwind');
  } else if (dxy3m != null && dxy3m < -3) {
    for (const k of ['em', 'china', 'india', 'latam', 'em_debt']) add(k, 0.15, 'weakening USD is a tailwind');
  }

  if (oil3m != null && oil3m > 10) add('energy', 0.15, 'oil up sharply over 3 months');
  if (oil3m != null && oil3m < -10) add('energy', -0.1, 'oil down sharply over 3 months');

  if (risk < -0.4) {
    for (const k of ['staples', 'utilities', 'health', 'minvol', 'quality', 'gold', 'ust_long', 'ust_mid'])
      add(k, 0.15, 'risk-off regime favors defensives/safe havens');
    for (const k of ['discretionary', 'industrials', 'financials', 'smallcap', 'hy_credit', 'em'])
      add(k, -0.12, 'risk-off regime penalizes cyclical/levered exposure');
  } else if (risk > 0.4) {
    for (const k of ['discretionary', 'industrials', 'smallcap', 'hy_credit'])
      add(k, 0.08, 'calm, risk-on tape supports cyclicals');
  }

  if (inflation > 0.3) {
    for (const k of ['tips', 'gold', 'energy', 'materials', 'value']) add(k, 0.12, 'inflation pressure favors real assets/value');
    for (const k of ['ust_long', 'growth', 'realestate', 'utilities']) add(k, -0.12, 'inflation pressure hurts duration-sensitive assets');
  } else if (inflation < -0.3) {
    for (const k of ['ust_long', 'ust_mid', 'growth', 'tech', 'realestate']) add(k, 0.1, 'disinflation supports duration and growth');
  }

  if (growth < -0.3) {
    for (const k of ['quality', 'minvol', 'staples', 'health', 'ust_mid']) add(k, 0.1, 'slowing growth favors quality/defensives');
    for (const k of ['smallcap', 'industrials', 'materials', 'financials']) add(k, -0.1, 'slowing growth weighs on cyclicals');
  } else if (growth > 0.3) {
    for (const k of ['smallcap', 'industrials', 'financials', 'value']) add(k, 0.1, 'firm growth supports cyclicals');
  }

  return { adj, why };
}

// ---------------------------------------------------------------------------
// Per-bucket composite scores
// ---------------------------------------------------------------------------

function momentumScore(ind, bench) {
  if (!ind) return null;
  const parts = [];
  const w = [0.2, 0.4, 0.4];
  const horizons = ['r1m', 'r3m', 'r6m'];
  let total = 0;
  let wsum = 0;
  for (let i = 0; i < horizons.length; i++) {
    const h = horizons[i];
    if (ind[h] == null) continue;
    const rel = bench && bench[h] != null ? ind[h] - bench[h] : ind[h];
    total += w[i] * rel;
    wsum += w[i];
    parts.push(rel);
  }
  if (!wsum) return null;
  // tanh squashes the weighted relative return (in %) into [-1, 1];
  // ~6% relative outperformance maps to ~0.76.
  return Math.tanh(total / wsum / 6);
}

function trendScore(ind) {
  if (!ind) return null;
  let s = 0;
  if (ind.aboveMa200 != null) s += ind.aboveMa200 ? 0.6 : -0.6;
  if (ind.aboveMa50 != null) s += ind.aboveMa50 ? 0.4 : -0.4;
  return s;
}

function scoreBucket(items, indicators, bench, macroAdj, newsByTag, { relative }) {
  return items.map((item) => {
    const ind = get(indicators, item.symbol);
    const mom = momentumScore(ind, relative ? bench : null);
    const trend = trendScore(ind);
    const macroFit = macroAdj.adj[item.key] || 0;
    const news = clamp((newsByTag[item.key] || 0), -1, 1);

    const w = ENGINE.weights;
    let score = null;
    if (mom != null && trend != null) {
      score = clamp(w.momentum * mom + w.trend * trend + w.macro * clamp(macroFit / 0.3) + w.news * news);
    }

    const reasons = [];
    if (ind?.r3m != null && bench?.r3m != null && relative) {
      const rel3m = ind.r3m - bench.r3m;
      reasons.push(`${rel3m >= 0 ? '+' : ''}${rel3m.toFixed(1)}% vs ACWI over 3m`);
    } else if (ind?.r3m != null) {
      reasons.push(`${ind.r3m >= 0 ? '+' : ''}${ind.r3m.toFixed(1)}% over 3m`);
    }
    if (ind?.aboveMa200 != null) reasons.push(ind.aboveMa200 ? 'in uptrend (>200dma)' : 'in downtrend (<200dma)');
    if (macroAdj.why[item.key]) reasons.push(...macroAdj.why[item.key]);
    if (Math.abs(news) > 0.15) reasons.push(`news flow ${news > 0 ? 'supportive' : 'negative'}`);

    return {
      ...item,
      score: score != null ? +score.toFixed(3) : null,
      components: {
        momentum: mom != null ? +mom.toFixed(2) : null,
        trend: trend != null ? +trend.toFixed(2) : null,
        macro: +clamp(macroFit / 0.3).toFixed(2),
        news: +news.toFixed(2)
      },
      reasons,
      market: ind ? {
        price: ind.price,
        dayChangePct: ind.dayChangePct,
        r1m: ind.r1m,
        r3m: ind.r3m,
        r6m: ind.r6m
      } : null
    };
  });
}

// ---------------------------------------------------------------------------
// Tilts with hysteresis + 30-day opposite-trade compliance lock
// ---------------------------------------------------------------------------

function rawTilt(score, currentTilt) {
  if (score == null) return 'NEUTRAL';
  const { enterThreshold, exitThreshold } = ENGINE;
  if (currentTilt === 'OVERWEIGHT') return score > exitThreshold ? 'OVERWEIGHT' : score < -enterThreshold ? 'UNDERWEIGHT' : 'NEUTRAL';
  if (currentTilt === 'UNDERWEIGHT') return score < -exitThreshold ? 'UNDERWEIGHT' : score > enterThreshold ? 'OVERWEIGHT' : 'NEUTRAL';
  return score > enterThreshold ? 'OVERWEIGHT' : score < -enterThreshold ? 'UNDERWEIGHT' : 'NEUTRAL';
}

export function applyCompliance(key, candidateTilt, history, now = Date.now()) {
  const rec = history[key];
  if (!rec) {
    return { tilt: candidateTilt, locked: false, changed: candidateTilt !== 'NEUTRAL' };
  }
  if (candidateTilt === rec.tilt) {
    return { tilt: rec.tilt, locked: false, changed: false };
  }

  const lockMs = ENGINE.oppositeTradeLockDays * 24 * 60 * 60 * 1000;
  const sinceChange = now - (rec.changedAt || 0);
  const candidateDir = Math.sign(TILT_RANK[candidateTilt] - TILT_RANK[rec.tilt]);
  // rec.lastTradeDir is the direction of the trade that established the
  // current tilt (+1 = bought exposure, -1 = sold exposure). Acting in the
  // opposite direction inside the window would be an opposite-way trade.
  const isOpposite = rec.lastTradeDir != null && candidateDir === -rec.lastTradeDir;

  if (isOpposite && sinceChange < lockMs) {
    return {
      tilt: rec.tilt,
      locked: true,
      changed: false,
      pendingTilt: candidateTilt,
      lockedUntil: (rec.changedAt || now) + lockMs
    };
  }
  return { tilt: candidateTilt, locked: false, changed: true, tradeDir: candidateDir };
}

function finalizeBucket(scored, history, now) {
  const changes = [];
  const out = scored.map((item) => {
    const key = item.key;
    const current = history[key]?.tilt || 'NEUTRAL';
    const candidate = rawTilt(item.score, current);
    const result = applyCompliance(key, candidate, history, now);
    if (result.changed) {
      changes.push({
        key,
        tilt: result.tilt,
        changedAt: now,
        lastTradeDir: result.tradeDir ?? Math.sign(TILT_RANK[result.tilt])
      });
    }
    return {
      ...item,
      tilt: result.tilt,
      locked: result.locked || false,
      pendingTilt: result.pendingTilt || null,
      lockedUntil: result.lockedUntil || null,
      tiltSince: result.changed ? now : history[key]?.changedAt || null
    };
  });
  return { out, changes };
}

// ---------------------------------------------------------------------------
// Asset-class guidance from regime
// ---------------------------------------------------------------------------

function assetClassScores(regime, indicators, bench) {
  const { risk, growth, inflation } = regime.scores;
  const defs = [
    {
      key: 'ac_equities', name: 'Global Equities', symbol: 'ACWI',
      score: clamp(0.25 + 0.45 * risk + 0.3 * growth - 0.15 * Math.max(inflation, 0)),
      reasons: ['baseline overweight for a long-horizon passive investor, scaled by risk & growth regime']
    },
    {
      key: 'ac_duration', name: 'Govt Bonds / Duration', symbol: 'IEF',
      score: clamp(-0.3 * risk - 0.35 * growth - 0.5 * inflation),
      reasons: ['duration hedges growth shocks but suffers when inflation pressure builds']
    },
    {
      key: 'ac_credit', name: 'Corporate Credit', symbol: 'LQD',
      score: clamp(0.1 + 0.4 * risk + 0.2 * growth),
      reasons: ['credit carry works in calm regimes, vulnerable in risk-off']
    },
    {
      key: 'ac_real', name: 'Real Assets (Gold/Cmdty)', symbol: 'GC=F',
      score: clamp(0.45 * inflation - 0.25 * risk),
      reasons: ['real assets hedge inflation and stress regimes']
    },
    {
      key: 'ac_cash', name: 'Cash / T-Bills', symbol: '^IRX',
      score: clamp(-0.5 * risk - 0.2 * growth),
      reasons: ['cash earns its keep when stress rises or regimes turn hostile']
    }
  ];
  return defs.map((d) => {
    const ind = get(indicators, d.symbol);
    return {
      key: d.key, name: d.name, symbol: d.symbol,
      score: +d.score.toFixed(3),
      components: null,
      reasons: d.reasons,
      market: ind ? { price: ind.price, dayChangePct: ind.dayChangePct, r1m: ind.r1m, r3m: ind.r3m, r6m: ind.r6m } : null
    };
  });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function buildRecommendations({ indicators, macro, newsAgg, history, policy = null, now = Date.now() }) {
  const regime = classifyRegime(indicators, macro, policy);
  const bench = get(indicators, 'ACWI');
  const macroAdj = macroAdjustments(regime, policy);
  const newsByTag = newsAgg?.byTag || {};

  const buckets = {
    assetClasses: assetClassScores(regime, indicators, bench),
    regions: scoreBucket(REGIONS, indicators, bench, macroAdj, newsByTag, { relative: true }),
    sectors: scoreBucket(SECTORS, indicators, bench, macroAdj, newsByTag, { relative: true }),
    styles: scoreBucket(STYLES, indicators, bench, macroAdj, newsByTag, { relative: true }),
    bonds: scoreBucket(BONDS, indicators, bench, macroAdj, newsByTag, { relative: false }),
    commodities: scoreBucket(COMMODITIES, indicators, bench, macroAdj, newsByTag, { relative: false })
  };

  const allChanges = [];
  const final = {};
  for (const [name, scored] of Object.entries(buckets)) {
    const { out, changes } = finalizeBucket(scored, history, now);
    final[name] = out;
    allChanges.push(...changes);
  }

  return { regime, buckets: final, changes: allChanges };
}
