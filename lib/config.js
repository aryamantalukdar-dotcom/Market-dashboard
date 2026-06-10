// Central configuration: instrument universe, data sources, refresh cadence,
// and engine weights. Everything the engine recommends is an ETF/index proxy
// for a region, sector, style or asset class — never a single stock.

import { policyContracts } from './policy.js';

export const REFRESH = {
  quotesMs: 60 * 1000,        // fast price refresh
  historyMs: 10 * 60 * 1000,  // full 1y daily history refresh
  newsMs: 5 * 60 * 1000,      // RSS feeds
  macroMs: 6 * 60 * 60 * 1000 // FRED daily/monthly series
};

// ACWI weights are approximate and only used to contextualize tilts for a
// passive MSCI ACWI investor.
export const REGIONS = [
  { key: 'us',     name: 'United States',  symbol: 'SPY',  acwiWeight: 64 },
  { key: 'europe', name: 'Europe ex-UK',   symbol: 'VGK',  acwiWeight: 11 },
  { key: 'uk',     name: 'United Kingdom', symbol: 'EWU',  acwiWeight: 3.3 },
  { key: 'japan',  name: 'Japan',          symbol: 'EWJ',  acwiWeight: 4.7 },
  { key: 'china',  name: 'China',          symbol: 'MCHI', acwiWeight: 2.8 },
  { key: 'india',  name: 'India',          symbol: 'INDA', acwiWeight: 2.0 },
  { key: 'em',     name: 'EM (broad)',     symbol: 'EEM',  acwiWeight: 10 },
  { key: 'latam',  name: 'Latin America',  symbol: 'ILF',  acwiWeight: 0.8 },
  { key: 'canada', name: 'Canada',         symbol: 'EWC',  acwiWeight: 2.9 },
  { key: 'austr',  name: 'Australia',      symbol: 'EWA',  acwiWeight: 1.7 }
];

export const SECTORS = [
  { key: 'tech',        name: 'Technology',       symbol: 'XLK' },
  { key: 'financials',  name: 'Financials',       symbol: 'XLF' },
  { key: 'health',      name: 'Health Care',      symbol: 'XLV' },
  { key: 'energy',      name: 'Energy',           symbol: 'XLE' },
  { key: 'industrials', name: 'Industrials',      symbol: 'XLI' },
  { key: 'discretionary', name: 'Cons. Discretionary', symbol: 'XLY' },
  { key: 'staples',     name: 'Cons. Staples',    symbol: 'XLP' },
  { key: 'utilities',   name: 'Utilities',        symbol: 'XLU' },
  { key: 'materials',   name: 'Materials',        symbol: 'XLB' },
  { key: 'realestate',  name: 'Real Estate',      symbol: 'XLRE' },
  { key: 'comms',       name: 'Comm. Services',   symbol: 'XLC' }
];

export const STYLES = [
  { key: 'value',    name: 'Value',        symbol: 'VTV' },
  { key: 'growth',   name: 'Growth',       symbol: 'VUG' },
  { key: 'quality',  name: 'Quality',      symbol: 'QUAL' },
  { key: 'momentum', name: 'Momentum',     symbol: 'MTUM' },
  { key: 'minvol',   name: 'Min Volatility', symbol: 'USMV' },
  { key: 'smallcap', name: 'US Small Cap', symbol: 'IWM' }
];

export const BONDS = [
  { key: 'ust_long',  name: 'Long UST (20y+)',   symbol: 'TLT' },
  { key: 'ust_mid',   name: 'UST 7-10y',         symbol: 'IEF' },
  { key: 'ig_credit', name: 'IG Credit',         symbol: 'LQD' },
  { key: 'hy_credit', name: 'High Yield',        symbol: 'HYG' },
  { key: 'tips',      name: 'TIPS',              symbol: 'TIP' },
  { key: 'em_debt',   name: 'EM Debt (USD)',     symbol: 'EMB' },
  { key: 'global_agg', name: 'Global Agg ex-US', symbol: 'BNDX' }
];

export const COMMODITIES = [
  { key: 'gold',   name: 'Gold',        symbol: 'GC=F' },
  { key: 'oil',    name: 'WTI Crude',   symbol: 'CL=F' },
  { key: 'copper', name: 'Copper',      symbol: 'HG=F' },
  { key: 'silver', name: 'Silver',      symbol: 'SI=F' },
  { key: 'natgas', name: 'Natural Gas', symbol: 'NG=F' }
];

export const FX = [
  { key: 'dxy',    name: 'Dollar Index', symbol: 'DX-Y.NYB' },
  { key: 'eurusd', name: 'EUR/USD',      symbol: 'EURUSD=X' },
  { key: 'usdjpy', name: 'USD/JPY',      symbol: 'USDJPY=X' },
  { key: 'gbpusd', name: 'GBP/USD',      symbol: 'GBPUSD=X' },
  { key: 'usdcny', name: 'USD/CNY',      symbol: 'CNY=X' }
];

export const RISK = [
  { key: 'acwi', name: 'MSCI ACWI (benchmark)', symbol: 'ACWI' },
  { key: 'vix',  name: 'VIX',                   symbol: '^VIX' },
  { key: 'ust10', name: 'US 10Y Yield',         symbol: '^TNX' },
  { key: 'ust30', name: 'US 30Y Yield',         symbol: '^TYX' },
  { key: 'tbill', name: 'US 3M T-Bill',         symbol: '^IRX' },
  { key: 'btc',  name: 'Bitcoin (risk appetite)', symbol: 'BTC-USD' }
];

// 30-day fed funds futures strip (next 12 monthly contracts), used by the
// implied policy path monitor. Not shown in the markets grid.
export const POLICY = policyContracts().map((c) => ({
  key: c.key,
  name: `Fed Funds ${c.name}`,
  symbol: c.symbol
}));

export const GROUPS = { REGIONS, SECTORS, STYLES, BONDS, COMMODITIES, FX, RISK, POLICY };

export function allInstruments() {
  return Object.entries(GROUPS).flatMap(([group, items]) => items.map((i) => ({ ...i, group })));
}

// FRED series fetched via the public fredgraph.csv endpoint (no API key).
// freq drives how many observations back "3m/6m change" looks (d/w/m).
export const FRED_SERIES = [
  { id: 'CPIAUCSL',     name: 'CPI (headline)',        transform: 'yoy', unit: '% y/y', freq: 'm' },
  { id: 'CPILFESL',     name: 'CPI (core)',            transform: 'yoy', unit: '% y/y', freq: 'm' },
  { id: 'UNRATE',       name: 'Unemployment Rate',     transform: 'level', unit: '%', freq: 'm' },
  { id: 'PAYEMS',       name: 'Nonfarm Payrolls',      transform: 'mom_k', unit: 'k m/m', freq: 'm' },
  { id: 'FEDFUNDS',     name: 'Fed Funds Rate',        transform: 'level', unit: '%', freq: 'm' },
  { id: 'T10Y2Y',       name: '10Y-2Y Curve',          transform: 'level', unit: 'pp', freq: 'd' },
  { id: 'BAMLH0A0HYM2', name: 'HY Credit Spread (OAS)', transform: 'level', unit: 'pp', freq: 'd' },
  { id: 'UMCSENT',      name: 'Consumer Sentiment',    transform: 'level', unit: 'idx', freq: 'm' },
  // Richer macro: production, claims
  { id: 'INDPRO',       name: 'Industrial Production', transform: 'yoy', unit: '% y/y', freq: 'm' },
  { id: 'ICSA',         name: 'Initial Jobless Claims', transform: 'level_k', unit: 'k/wk', freq: 'w' },
  // Central-bank policy stance (Fed = FEDFUNDS above). SONIA and the BoJ
  // call rate track their policy rates within a few bp.
  { id: 'ECBDFR',       name: 'ECB Deposit Rate',      transform: 'level', unit: '%', freq: 'd' },
  { id: 'IUDSOIA',      name: 'BoE SONIA Rate',        transform: 'level', unit: '%', freq: 'd' },
  { id: 'IRSTCI01JPM156N', name: 'BoJ Overnight Call Rate', transform: 'level', unit: '%', freq: 'm' },
  // Realized inflation by region (Japan has no live free monthly CPI on FRED)
  { id: 'CP0000EZ19M086NEST', name: 'Euro Area HICP',  transform: 'yoy', unit: '% y/y', freq: 'm' },
  { id: 'GBRCPIALLMINMEI',    name: 'UK CPI',          transform: 'yoy', unit: '% y/y', freq: 'm' },
  // Market-implied inflation expectations (TIPS breakevens + 5y5y forward)
  { id: 'T5YIE',        name: '5y Inflation Breakeven', transform: 'level', unit: '%', freq: 'd' },
  { id: 'T10YIE',       name: '10y Inflation Breakeven', transform: 'level', unit: '%', freq: 'd' },
  { id: 'T5YIFR',       name: '5y5y Forward Inflation', transform: 'level', unit: '%', freq: 'd' }
];

// Free RSS feeds, no key required.
export const NEWS_FEEDS = [
  { name: 'BBC World',   url: 'https://feeds.bbci.co.uk/news/world/rss.xml' },
  { name: 'CNBC Top News', url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html' },
  { name: 'MarketWatch', url: 'https://feeds.content.dowjones.io/public/rss/mw_topstories' },
  { name: 'Yahoo Finance', url: 'https://finance.yahoo.com/news/rssindex' },
  { name: 'Guardian Business', url: 'https://www.theguardian.com/uk/business/rss' }
];

export const ENGINE = {
  // Composite score weights (sum to 1)
  weights: { momentum: 0.45, trend: 0.20, macro: 0.25, news: 0.10 },
  // Tilt thresholds with hysteresis so signals don't churn
  enterThreshold: 0.25, // |score| needed to move OFF Neutral
  exitThreshold: 0.15,  // |score| below which an existing tilt reverts to Neutral
  // PIMCO-style compliance: an implied trade opposite to the previous one is
  // blocked within this window.
  oppositeTradeLockDays: 30,
  // Suggested minimum days between any acted-on changes (frequency guard)
  minHoldDays: 30
};
