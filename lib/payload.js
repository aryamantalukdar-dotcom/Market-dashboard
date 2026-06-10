// Shared dashboard payload assembly, used by both the live server and the
// static (GitHub Pages) snapshot builder so the frontend sees one shape.

import { REFRESH, allInstruments } from './config.js';

export function assemblePayload({
  mode, hosted = false, indicators, macro, news, newsAgg, recommendations,
  status, tiltLog, policy = null, backtest = null, newsLLM = null
}) {
  const instruments = {};
  for (const inst of allInstruments()) {
    const ind = indicators.get(inst.symbol);
    if (!ind) continue;
    // closes is the full price history kept for the backtest — too heavy to ship
    const { closes, ...pub } = ind;
    instruments[inst.symbol] = { ...inst, ...pub };
  }
  return {
    mode,
    hosted,
    generatedAt: Date.now(),
    refreshMs: { quotes: REFRESH.quotesMs, news: REFRESH.newsMs, macro: REFRESH.macroMs },
    status,
    instruments,
    macro: Object.fromEntries(macro),
    news,
    newsSentiment: newsAgg,
    newsLLM,
    policy,
    backtest,
    recommendations,
    tiltLog
  };
}
