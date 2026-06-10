# Global Market & Macro Dashboard

A self-contained, auto-refreshing dashboard that watches global markets, the macro
landscape, and top worldwide news — and turns them into **broad allocation tilts**
(region / sector / style / asset class) framed against an **MSCI ACWI** baseline.

It is deliberately built for a **passive, compliance-constrained investor**:

- Recommendations are **never single stocks** — only broad ETF/index proxies.
- A persistent **30-day opposite-trade lock**: if the signal flips against a tilt
  you (notionally) just put on, the dashboard holds the old tilt, shows the pending
  signal with a 🔒 badge, and only releases it after 30 days — mirroring typical
  asset-manager personal-trading windows (e.g. PIMCO-style rules).
- **Hysteresis** on tilt thresholds so signals don't churn — designed for
  monthly-at-most rebalancing, not trading.
- Every tilt change is written to an **audit log** (`data/tilt-history.json`).

> ⚠️ Educational tool, not investment advice. Always preclear personal trades
> with your compliance team.

## Hosted version (always on)

The dashboard is deployed to **GitHub Pages** and rebuilt with fresh live data
**every 10 minutes** by a scheduled GitHub Actions workflow:

> https://aryamantalukdar-dotcom.github.io/Market-dashboard/

The hosted build is a static snapshot: each run fetches all sources, runs the
engine, and publishes the result (badged `LIVE · 10-MIN SNAPSHOTS`). The 30-day
compliance lock state is carried forward from the previous snapshot, so it
persists across rebuilds. For second-by-second countdowns and 60-second quote
refresh, run it locally instead.

## Quick start (local — fastest refresh)

Requires Node ≥ 18. **Zero npm dependencies, zero API keys.**

```bash
npm start        # live data, quotes refresh every 60s
npm run demo     # offline demo with deterministic mock data
npm run smoke    # end-to-end smoke test (mock mode)
```

Open http://localhost:3000.

## What it watches

| Source | Data | Refresh |
|---|---|---|
| Yahoo Finance (free chart API) | ~50 instruments: ACWI benchmark, 10 regions, 11 sectors, 6 styles, 7 bond classes, 5 commodities, 5 FX pairs, VIX/rates/BTC | quotes **60s**, full 1y history 10min |
| FRED (public CSV, no key) | CPI & core CPI (y/y), unemployment, payrolls, fed funds, 10y–2y curve, HY credit spreads, consumer sentiment | 6h (data is daily/monthly) |
| RSS (BBC World, CNBC, MarketWatch, Yahoo Finance, Guardian Business) | Top worldwide headlines with keyword sentiment + region/sector tagging | 5min |

The frontend polls the server every 30s with a live countdown. If a source is
unreachable the dashboard keeps the last good data and surfaces the error in the
header; if nothing is reachable at boot it falls back to clearly-badged demo data.

## How recommendations are built

1. **Macro regime classification** — three scores in [-1, 1]:
   - *Risk appetite*: VIX level, ACWI vs 200-day average, HY spread level & 3m change
   - *Growth*: payrolls, unemployment trend, yield-curve shape
   - *Inflation pressure*: core CPI level vs target and 6m trend

   These map to a regime: **Goldilocks**, **Reflation**, **Stagflation Risk**,
   **Slowdown/Disinflation**, or **Risk-Off Stress** (overrides the grid when
   stress is extreme).

2. **Per-bucket composite score** (weights in `lib/config.js`):
   - **45% relative momentum** — 1m/3m/6m returns *relative to ACWI* for equity
     buckets (absolute for bonds/commodities), tanh-squashed
   - **20% trend** — price vs 50/200-day moving averages
   - **25% macro-regime fit** — transparent rules (e.g. strong USD penalizes EM,
     rising inflation favors TIPS/value/real assets, risk-off favors defensives,
     quality and duration)
   - **10% news sentiment** — wordlist sentiment aggregated per region/sector tag
     (a nudge, never a driver)

3. **Tilt assignment with hysteresis** — |score| > 0.25 to enter
   Overweight/Underweight, must fall below 0.15 to exit.

4. **Compliance filter** — each tilt change records the implied trade direction.
   A candidate change implying the *opposite* trade within 30 days is blocked,
   held at the previous tilt, and badged 🔒 with its release date. History
   persists across restarts.

Every recommendation row shows its score decomposition inputs and plain-English
reasons, so you can always see *why* a tilt is what it is.

## Architecture

```
server.js            zero-dep Node HTTP server + refresh scheduler
lib/config.js        instrument universe, feeds, cadences, engine weights
lib/yahoo.js         Yahoo chart fetcher → indicator pack (returns, MAs, vol, sparklines)
lib/fred.js          FRED fredgraph.csv fetcher (+ y/y, m/m transforms)
lib/news.js          RSS parsing, keyword sentiment, bucket tagging
lib/engine.js        regime classification, scoring, tilts, 30-day lock
lib/store.js         persistent tilt history + audit log
lib/mock.js          deterministic offline demo data
public/              no-build vanilla JS frontend
scripts/smoke.js     end-to-end smoke test
```

## Ideas for future improvement

- **LLM news layer**: replace wordlist sentiment with Claude API summarization +
  structured event extraction (central-bank surprises, geopolitical escalation).
- **Richer macro**: global PMIs, ECB/BOJ policy rates, earnings-revision breadth;
  FRED API key for higher-frequency pulls.
- **Backtesting**: replay the engine over history to size tilt magnitudes honestly.
- **Drift/rebalance helper**: enter your actual ACWI-based holdings and get
  tracking-error-aware tilt sizing (e.g. ±2% bands) plus a compliance-friendly
  quarterly rebalance calendar.
- **Alerts**: email/push when the regime label changes or a lock releases —
  regime *changes* matter more than levels for a monthly rebalancer.
- **Real benchmark weights**: pull current MSCI ACWI country/sector weights
  instead of static approximations.
