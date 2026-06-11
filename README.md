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

A scheduled GitHub Actions workflow rebuilds a live snapshot **every 10
minutes** and force-pushes it to the `gh-pages` branch. Two ways to view it:

> **Primary:** https://aryamantalukdar-dotcom.github.io/Market-dashboard/
>
> **External-facing (no tilts):** https://aryamantalukdar-dotcom.github.io/Market-dashboard/public/ —
> same markets/macro/policy/news monitors, but the allocation tilts, backtest,
> tilt log and compliance-lock state are stripped from the published payload
> itself, so the shareable link exposes no recommendations.
>
> **No-setup mirror:** https://raw.githack.com/aryamantalukdar-dotcom/Market-dashboard/gh-pages/index.html

If the primary URL 404s, GitHub Pages needs one one-time switch flipped:
**Settings → Pages → Source: “Deploy from a branch” → `gh-pages` / root** —
the Actions workflow token isn't allowed to create the Pages site itself.

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
| Yahoo Finance (free chart API) | ~62 instruments: ACWI benchmark, 10 regions, 11 sectors, 6 styles, 7 bond classes, 5 commodities, 5 FX pairs, VIX/rates/BTC, plus the next 12 monthly **fed funds futures** contracts | quotes **60s**, full 1y history 10min |
| FRED (public CSV, no key) | CPI & core CPI (y/y), unemployment, payrolls, **jobless claims**, **industrial production**, **policy stance for Fed / ECB / BoE / BoJ**, 10y–2y curve, HY credit spreads, consumer sentiment, **5y/10y inflation breakevens + 5y5y forward**, **euro-area HICP & UK CPI (y/y)** | 6h (data is daily/weekly/monthly) |
| RSS (BBC World, CNBC, MarketWatch, Yahoo Finance, Guardian Business) | Top worldwide headlines with keyword sentiment + region/sector tagging | 5min |
| Claude API (optional, needs `ANTHROPIC_API_KEY`) | LLM news layer: structured event extraction, market-impact call, per-bucket sentiment | with news (throttled to 15min locally) |

The frontend polls the server every 30s with a live countdown. If a source is
unreachable the dashboard keeps the last good data and surfaces the error in the
header; if nothing is reachable at boot it falls back to clearly-badged demo data.

### Central banks & inflation monitors

- **Fed implied policy path** — implied rate (100 − price) from the strip of
  30-day fed funds futures (ZQ, CME) out 12 months, vs the current effective
  rate. The bp of cuts/hikes priced in shows up as a regime signal and feeds a
  small duration tilt (deep easing priced → duration tailwind, hikes priced →
  headwind).
- **Policy stance — Fed / ECB / BoE / BoJ** — current policy rate and delivered
  moves over the last 6 months (FEDFUNDS, ECB deposit rate, daily SONIA, BoJ
  overnight call rate). Easing/tightening cycles feed small region tilts
  (ECB cutting → Europe tailwind, BoJ hiking → Japan headwind). Market-implied
  *paths* need €STR/SONIA/TONA futures, which have no free feed — the
  futures-implied path is Fed-only; stale series are greyed out and excluded
  from the engine.
- **Inflation — market-implied & realized** — 5y and 10y TIPS breakevens plus
  the **5y5y forward** (the Fed's preferred gauge of long-run anchoring) feed
  the regime's inflation score; realized CPI y/y is shown for the US, euro
  area (HICP) and UK. Inflation swaps outside the US and a live free Japan
  monthly CPI feed don't exist, so coverage is honest about its limits.

### LLM news layer (optional)

Add an `ANTHROPIC_API_KEY` secret (repo Settings → Secrets and variables →
Actions) and the hosted build enriches headlines via the Claude API: a 2-3
sentence synthesis, a risk-on/risk-off call, extracted events with severity
(central-bank surprises, geopolitical escalation, ...), and per-bucket
sentiment that is averaged 50/50 with the transparent wordlist scores — still
capped at the engine's 10% news weight, so it nudges rather than drives.
Default model is `claude-opus-4-8`; set an `LLM_MODEL` repo variable (e.g.
`claude-haiku-4-5`) to trade some quality for ~5x lower cost. Without a key
everything silently falls back to wordlist sentiment.

### Backtest panel

Every snapshot replays the engine's **market signals** (momentum + trend with
the same weights, thresholds and hysteresis) walk-forward over the fetched
year of daily history: weekly rebalance, ±2% active weight per tilted bucket
vs ACWI. The panel shows active return, hit rate, max drawdown and an equity
curve — with explicit caveats: macro-regime fit and news sentiment cannot be
replayed point-in-time from free sources, and one year of history is a sanity
check, not proof of alpha.

## How recommendations are built

1. **Macro regime classification** — three scores in [-1, 1]:
   - *Risk appetite*: VIX level, ACWI vs 200-day average, HY spread level & 3m change
   - *Growth*: payrolls, unemployment trend, jobless-claims trend, industrial
     production, yield-curve shape
   - *Inflation pressure*: core CPI level vs target and 6m trend, plus
     market-implied expectations (5y5y forward anchoring, breakeven repricing)

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
lib/fred.js          FRED fredgraph.csv fetcher (freq-aware 3m/6m trends, y/y & m/m transforms)
lib/news.js          RSS parsing, keyword sentiment, bucket tagging
lib/llm.js           optional Claude API news layer (events, impact, bucket sentiment)
lib/policy.js        fed funds futures strip → implied policy path
lib/backtest.js      walk-forward replay of the market signals
lib/engine.js        regime classification, scoring, tilts, 30-day lock
lib/store.js         persistent tilt history + audit log
lib/mock.js          deterministic offline demo data
public/              no-build vanilla JS frontend
scripts/smoke.js     end-to-end smoke test
```

## Ideas for future improvement

- **Drift/rebalance helper**: enter your actual ACWI-based holdings and get
  tracking-error-aware tilt sizing (e.g. ±2% bands) plus a compliance-friendly
  quarterly rebalance calendar.
- **Alerts**: email/push when the regime label changes or a lock releases —
  regime *changes* matter more than levels for a monthly rebalancer.
- **Real benchmark weights**: pull current MSCI ACWI country/sector weights
  instead of static approximations.
- **ECB/BOJ implied paths**: €STR and TONA futures aren't on Yahoo's free API;
  a paid or scraped source could extend the policy monitor beyond the Fed.
- **Longer backtest**: fetch 5-10y of history (slower, heavier) to make the
  walk-forward replay statistically meaningful and to size tilt magnitudes.
