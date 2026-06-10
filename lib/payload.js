// Shared dashboard payload assembly, used by both the live server and the
// static (GitHub Pages) snapshot builder so the frontend sees one shape.

import { REFRESH, allInstruments } from './config.js';

export function assemblePayload({ mode, hosted = false, indicators, macro, news, newsAgg, recommendations, status, tiltLog }) {
  const instruments = {};
  for (const inst of allInstruments()) {
    const ind = indicators.get(inst.symbol);
    if (ind) instruments[inst.symbol] = { ...inst, ...ind };
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
    recommendations,
    tiltLog
  };
}
