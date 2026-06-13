// Central-bank implied policy path from 30-day fed funds futures (CME, via
// Yahoo). Implied rate = 100 - futures price; the strip of monthly contracts
// out ~12 months is the market's expected path for the Fed funds rate.

const MONTH_CODES = ['F', 'G', 'H', 'J', 'K', 'M', 'N', 'Q', 'U', 'V', 'X', 'Z'];

// Central-bank decisions that have been announced but won't show up in the
// official rate-level series for a week or two: most central banks (the ECB
// in particular) apply a new policy rate from the start of the next reserve
// maintenance period, not from the decision date, so FRED/ECB Data Portal
// lag the headline by several days. Manually updated after each meeting.
export const ANNOUNCED_POLICY_MOVES = [
  { bank: 'ECB', seriesId: 'ECBDFR', decidedDate: '2026-06-11', deltaBp: 25, newRate: 2.25 }
];

// Drop an entry once the live series catches up to the new rate, or after 30
// days regardless (so a stale/incorrect manual entry can't get stuck showing
// "announced, pending" forever).
export function pendingPolicyMoves(macro, announced = ANNOUNCED_POLICY_MOVES, now = Date.now()) {
  return announced.filter((a) => {
    if (now - Date.parse(a.decidedDate) > 30 * 86400 * 1000) return false;
    const m = macro.get(a.seriesId);
    return !m || m.latest == null || Math.round(m.latest * 100) !== Math.round(a.newRate * 100);
  });
}

// Next 12 monthly ZQ contracts (skipping the in-expiry front month).
export function policyContracts(now = new Date()) {
  const out = [];
  for (let i = 1; i <= 12; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + i, 1));
    const code = MONTH_CODES[d.getUTCMonth()];
    const yy = String(d.getUTCFullYear()).slice(2);
    out.push({
      key: `ff_${yy}${code.toLowerCase()}`,
      name: d.toLocaleDateString('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' }),
      symbol: `ZQ${code}${yy}.CBT`,
      monthsAhead: i
    });
  }
  return out;
}

// Per-bank market-implied 12m policy direction, each from the best free
// source available. Only the Fed has tradeable futures with a free feed;
// the others use yield-curve proxies (which embed small term premia), and
// sterling has no free 1y instrument at all (the BoE OIS curve is published
// only as spreadsheets).
const fresh = (m, maxDays = 45) =>
  m?.latest != null && m.latestDate && Date.now() - Date.parse(m.latestDate) <= maxDays * 86400 * 1000 ? m : null;

export function buildPolicyOutlook(policy, macro) {
  const ecbRate = fresh(macro.get('ECBDFR'));
  const ezFwd = fresh(macro.get('EZIF1Y'));
  const bojRate = fresh(macro.get('IRSTCI01JPM156N'), 120); // monthly with lag
  const jgb1y = fresh(macro.get('JGB1Y'));
  return [
    {
      bank: 'Fed',
      impliedBp: policy?.change12mBp ?? null,
      basis: '30-day fed funds futures strip, 12 months out'
    },
    {
      bank: 'ECB',
      impliedBp: ezFwd && ecbRate ? Math.round((ezFwd.latest - ecbRate.latest) * 100) : null,
      basis: '1y instantaneous forward on the AAA euro-area curve vs deposit rate (includes a small sovereign spread)'
    },
    {
      bank: 'BoE',
      impliedBp: null,
      basis: 'no free 1y sterling instrument — the BoE OIS curve is published only as spreadsheets'
    },
    {
      bank: 'BoJ',
      impliedBp: jgb1y && bojRate ? Math.round((jgb1y.latest - bojRate.latest) * 100) : null,
      basis: '1y JGB yield vs overnight call rate (includes a small term premium)'
    }
  ];
}

export function buildPolicyPath(indicators, macro) {
  const path = [];
  for (const c of policyContracts()) {
    const ind = indicators.get(c.symbol);
    if (!ind || ind.price == null) continue;
    const implied = 100 - ind.price;
    if (implied < -1 || implied > 15) continue; // bad quote guard
    path.push({ label: c.name, monthsAhead: c.monthsAhead, implied: +implied.toFixed(2) });
  }
  if (path.length < 4) return null;

  const current = macro.get('FEDFUNDS')?.latest ?? path[0].implied;
  const closestTo = (m) =>
    path.reduce((best, p) => (Math.abs(p.monthsAhead - m) < Math.abs(best.monthsAhead - m) ? p : best), path[0]);
  return {
    bank: 'Federal Reserve',
    source: '30-day fed funds futures, CME',
    currentRate: +current.toFixed(2),
    path,
    change6mBp: Math.round((closestTo(6).implied - current) * 100),
    change12mBp: Math.round((closestTo(12).implied - current) * 100),
    updatedAt: Date.now()
  };
}
