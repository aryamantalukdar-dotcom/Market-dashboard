// Central-bank implied policy path from 30-day fed funds futures (CME, via
// Yahoo). Implied rate = 100 - futures price; the strip of monthly contracts
// out ~12 months is the market's expected path for the Fed funds rate.

const MONTH_CODES = ['F', 'G', 'H', 'J', 'K', 'M', 'N', 'Q', 'U', 'V', 'X', 'Z'];

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
