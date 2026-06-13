/* Dashboard frontend: polls /api/dashboard and renders everything.
   No frameworks, no build step. */

const POLL_MS = 30 * 1000;
let lastPayload = null;
let nextPollAt = Date.now();
let dataSource = null; // '/api/dashboard' (local server) or 'data.json' (static hosting)

async function fetchPayload() {
  if (dataSource !== 'data.json') {
    try {
      const res = await fetch('/api/dashboard');
      if (res.ok) {
        dataSource = '/api/dashboard';
        return res.json();
      }
    } catch { /* fall through to static snapshot */ }
    if (dataSource === '/api/dashboard') throw new Error('API unreachable');
  }
  const res = await fetch(`data.json?t=${Date.now()}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  dataSource = 'data.json';
  return res.json();
}

const $ = (id) => document.getElementById(id);

/* ------------------------------ tabs --------------------------------- */

const TABS = [
  ['overview', 'Overview'],
  ['tilts', 'Tilts'],
  ['markets', 'Markets'],
  ['macro', 'Macro'],
  ['news', 'News']
];
const SECTION_TABS = {
  'regime-section': 'overview',
  'policy-section': 'overview',
  'reco-section': 'tilts',
  'backtest-section': 'tilts',
  'log-section': 'tilts',
  'markets-section': 'markets',
  'macro-section': 'macro',
  'news-section': 'news'
};
let activeTab = TABS.some(([k]) => k === location.hash.slice(1)) ? location.hash.slice(1) : 'overview';

function applyTab() {
  for (const [id, tab] of Object.entries(SECTION_TABS)) {
    $(id).style.display = tab === activeTab ? '' : 'none';
  }
  document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === activeTab));
}

function initTabs() {
  $('tabs').innerHTML = TABS.map(([k, label]) =>
    `<button class="tab-btn" data-tab="${k}" type="button">${label}</button>`).join('');
  $('tabs').addEventListener('click', (e) => {
    const b = e.target.closest('.tab-btn');
    if (!b) return;
    activeTab = b.dataset.tab;
    history.replaceState(null, '', `#${activeTab}`);
    applyTab();
    window.scrollTo({ top: 0 });
  });
  applyTab();
}

// The /public/ deployment ships a payload with variant: 'public' and no
// tilt data; adapt the chrome once on first render.
let variantApplied = false;
function applyVariant(p) {
  if (variantApplied) return;
  variantApplied = true;
  if (p.variant !== 'public') return;
  const idx = TABS.findIndex(([k]) => k === 'tilts');
  if (idx >= 0) TABS.splice(idx, 1);
  if (activeTab === 'tilts') {
    activeTab = 'overview';
    history.replaceState(null, '', '#overview');
  }
  initTabs();
  const banner = document.querySelector('.compliance-banner');
  if (banner) {
    banner.innerHTML = '<strong>Disclaimer:</strong> Informational/educational only — not investment advice. '
      + 'This view shows market, macro and news monitors with a rules-based regime read; '
      + 'no allocation recommendations are published here.';
  }
}

function fmt(n, digits = 2) {
  if (n == null || !Number.isFinite(n)) return '–';
  return n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function pct(n, digits = 1) {
  if (n == null || !Number.isFinite(n)) return '–';
  return `${n >= 0 ? '+' : ''}${n.toFixed(digits)}%`;
}

function cls(n) {
  return n == null ? '' : n >= 0 ? 'pos' : 'neg';
}

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s ?? '';
  return d.innerHTML;
}

function sparkline(values, { width = 200, height = 34 } = {}) {
  if (!values || values.length < 2) return '';
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => {
    const x = (i / (values.length - 1)) * width;
    const y = height - 3 - ((v - min) / span) * (height - 6);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const up = values[values.length - 1] >= values[0];
  const color = up ? 'var(--green)' : 'var(--red)';
  return `<svg class="sparkline" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">
    <polyline points="${pts.join(' ')}" fill="none" stroke="${color}" stroke-width="1.5"/>
  </svg>`;
}

function scoreBar(score) {
  if (score == null) return '<span class="muted">–</span>';
  const halfPct = Math.min(Math.abs(score), 1) * 50;
  const color = score >= 0 ? 'var(--green)' : 'var(--red)';
  const style = score >= 0
    ? `left:50%;width:${halfPct}%;background:${color}`
    : `right:50%;width:${halfPct}%;background:${color}`;
  return `<div class="score-bar-wrap">
    <div class="score-bar"><div class="mid"></div><div class="fill" style="${style}"></div></div>
    <span class="score-num ${cls(score)}">${score >= 0 ? '+' : ''}${score.toFixed(2)}</span>
  </div>`;
}

function tiltBadge(item) {
  let html = `<span class="tilt ${item.tilt}">${item.tilt}</span>`;
  if (item.locked && item.pendingTilt) {
    const until = item.lockedUntil ? new Date(item.lockedUntil).toLocaleDateString() : 'soon';
    html += `<span class="lock-chip" title="Signal wants ${item.pendingTilt}, but that would be an opposite-way trade inside the 30-day compliance window. Held until ${until}.">&#128274; ${item.pendingTilt} pending</span>`;
  }
  return html;
}

/* ----------------------------- sections ------------------------------ */

function renderRegime(p) {
  const r = p.recommendations?.regime;
  if (!r) return;
  const sig = (arr) => arr.map((s) => `<li>${esc(s)}</li>`).join('');
  $('regime-card').innerHTML = `
    <div class="regime-label">${esc(r.label)}</div>
    <div class="regime-summary">${esc(r.summary)}</div>
    <div class="regime-scores">
      <div class="score-pill">Risk appetite <b class="${cls(r.scores.risk)}">${r.scores.risk}</b></div>
      <div class="score-pill">Growth <b class="${cls(r.scores.growth)}">${r.scores.growth}</b></div>
      <div class="score-pill">Inflation pressure <b class="${cls(-r.scores.inflation)}">${r.scores.inflation}</b></div>
    </div>
    <ul class="regime-signals">${sig(r.signals.risk)}${sig(r.signals.growth)}${sig(r.signals.inflation)}${sig(r.signals.policy || [])}</ul>`;

  const gauges = ['ACWI', '^VIX', '^TNX', 'DX-Y.NYB', 'GC=F', 'CL=F', 'BTC-USD', 'EURUSD=X'];
  $('gauges-card').innerHTML = `<div class="gauges">${gauges.map((sym) => {
    const q = p.instruments[sym];
    if (!q) return '';
    return `<div class="gauge">
      <div class="g-name">${esc(q.name)}</div>
      <div class="g-val">${fmt(q.price, q.price > 500 ? 0 : 2)}</div>
      <div class="g-chg ${cls(q.dayChangePct)}">${pct(q.dayChangePct)} today &middot; ${pct(q.r3m)} 3m</div>
    </div>`;
  }).join('')}</div>`;
}

const CENTRAL_BANKS = [
  { id: 'FEDFUNDS', bank: 'Fed', region: 'United States', note: 'effective fed funds' },
  { id: 'ECBDFR', bank: 'ECB', region: 'Euro area', note: 'deposit facility' },
  { id: 'IUDSOIA', bank: 'BoE', region: 'United Kingdom', note: 'SONIA overnight' },
  { id: 'IRSTCI01JPM156N', bank: 'BoJ', region: 'Japan', note: 'overnight call rate' }
];

const isStale = (m, days = 400) =>
  m?.latestDate && Date.now() - Date.parse(m.latestDate) > days * 86400 * 1000;

function renderPolicy(p) {
  const sec = $('policy-section');
  const pol = p.policy;
  const inflIds = [['T5YIE', '5y breakeven'], ['T10YIE', '10y breakeven'], ['T5YIFR', '5y5y forward']];
  const haveInfl = inflIds.some(([id]) => p.macro?.[id]);
  const haveStance = CENTRAL_BANKS.some((b) => p.macro?.[b.id]);
  if (!pol?.path?.length && !haveInfl && !haveStance) { sec.classList.add('hidden'); return; }
  sec.classList.remove('hidden');

  const outlookByBank = {};
  for (const o of pol?.outlook || []) outlookByBank[o.bank] = o;

  const announcedByBank = {};
  for (const a of p.policyAnnouncements || []) announcedByBank[a.bank] = a;
  const announceChip = (bank) => {
    const a = announcedByBank[bank];
    if (!a) return '';
    const when = new Date(a.decidedDate).toLocaleDateString([], { day: 'numeric', month: 'short' });
    return `<span class="announce-chip" title="${esc(bank)} announced a ${a.deltaBp >= 0 ? '+' : ''}${a.deltaBp}bp move on ${when} — new rate ${a.newRate}% not yet reflected in the official series">&#128226; ${a.deltaBp >= 0 ? '+' : ''}${a.deltaBp}bp announced ${when}</span>`;
  };

  $('stance-card').innerHTML = `
    <div class="panel-title">Policy stance — major central banks</div>
    <div class="stance-rows">${CENTRAL_BANKS.map((b) => {
      const m = p.macro?.[b.id];
      if (!m || m.latest == null) {
        return `<div class="stance-row muted"><span class="st-bank">${b.bank}</span><span class="st-note">${b.note} — unavailable</span>${announceChip(b.bank)}</div>`;
      }
      const stale = isStale(m);
      // Most recent discrete move >= 10bp beats a 6m average for visibility
      // of fresh hikes/cuts; fall back to the 6m change.
      const mv = m.lastMove && Math.abs(m.lastMove.delta) >= 0.1 ? m.lastMove : null;
      const mvRecent = mv && Date.now() - Date.parse(mv.date) <= 200 * 86400 * 1000 ? mv : null;
      let dir = 'on hold';
      let dirCls = 'muted';
      if (mvRecent) {
        const bp = Math.round(mvRecent.delta * 100);
        const when = new Date(mvRecent.date).toLocaleDateString([], { day: 'numeric', month: 'short' });
        dir = `${bp > 0 ? 'hiked' : 'cut'} ${Math.abs(bp)}bp on ${when}`;
        dirCls = bp > 0 ? 'neg' : 'pos';
      } else if (m.change6m != null && Math.abs(Math.round(m.change6m * 100)) >= 10) {
        const chg = Math.round(m.change6m * 100);
        dir = chg < 0 ? `cut ${Math.abs(chg)}bp / 6m` : `hiked ${chg}bp / 6m`;
        dirCls = chg < 0 ? 'pos' : 'neg';
      }
      const o = outlookByBank[b.bank];
      const impl = o?.impliedBp != null
        ? `<span class="${o.impliedBp <= -10 ? 'pos' : o.impliedBp >= 10 ? 'neg' : 'muted'}" title="${esc(o.basis)}">12m: ${o.impliedBp >= 0 ? '+' : ''}${o.impliedBp}bp</span>`
        : `<span class="muted" title="${esc(o?.basis || '')}">12m: n/a</span>`;
      return `<div class="stance-row${stale ? ' stale' : ''}">
        <span class="st-bank">${b.bank}<span class="st-region">${esc(b.region)}</span></span>
        <span class="st-rate">${fmt(m.latest)}%</span>
        <span class="st-dir ${dirCls}">${dir}${stale ? ' · stale data' : ''}${announceChip(b.bank)}</span>
        <span class="st-impl">${impl}</span>
        <span class="st-spark">${sparkline(m.spark, { height: 22 })}</span>
      </div>`;
    }).join('')}</div>
    <div class="muted small infl-note">"12m" is each market's implied policy direction over the next year — hover for the instrument behind it.</div>`;

  if (pol?.path?.length) {
    const c = pol.change12mBp;
    const dir = c <= -10 ? `${Math.abs(c)} bp of cuts` : c >= 10 ? `${c} bp of hikes` : 'roughly no change';
    const vals = pol.path.map((x) => x.implied).concat(pol.currentRate);
    const minR = Math.min(...vals);
    const span = (Math.max(...vals) - minR) || 1;
    $('policy-card').innerHTML = `
      <div class="panel-title">Fed implied policy path <span class="muted small">(${esc(pol.source)})</span></div>
      <div class="policy-summary">Policy rate ${fmt(pol.currentRate)}% today &middot; futures price
        <b class="${c <= -10 ? 'pos' : c >= 10 ? 'neg' : ''}">${dir}</b> over the next 12 months
        <span class="muted">(6m: ${pol.change6mBp >= 0 ? '+' : ''}${pol.change6mBp} bp)</span></div>
      <div class="policy-bars">${pol.path.map((pt) => {
        const w = 8 + ((pt.implied - minR) / span) * 90;
        return `<div class="policy-bar-row">
          <span class="pb-label">${esc(pt.label)}</span>
          <div class="pb-track"><div class="pb-fill" style="width:${w.toFixed(1)}%"></div></div>
          <span class="pb-val">${pt.implied.toFixed(2)}%</span>
        </div>`;
      }).join('')}</div>`;
  } else {
    $('policy-card').innerHTML = '<div class="panel-title">Fed implied policy path</div><div class="muted small">Fed funds futures unavailable.</div>';
  }

  // 5y5y forwards derived from spot rates: f ≈ 2×10y − 5y
  const derive5y5y = (b5, b10, name) => (b5?.latest != null && b10?.latest != null ? {
    name,
    latest: 2 * b10.latest - b5.latest,
    latestDate: b10.latestDate,
    change3m: b5.change3m != null && b10.change3m != null ? 2 * b10.change3m - b5.change3m : null,
    spark: b5.spark?.length === b10.spark?.length ? b10.spark.map((v, i) => 2 * v - b5.spark[i]) : null
  } : null);
  const ez5y5y = derive5y5y(p.macro?.EZBE5, p.macro?.EZBE10, 'Euro 5y5y forward');
  const uk5y5y = derive5y5y(p.macro?.UKBE5, p.macro?.UKBE10, 'UK 5y5y forward');

  const inflGauge = (m, label, target2 = true) => {
    if (!m || m.latest == null) return '';
    const stale = isStale(m);
    const dev = m.latest - 2;
    return `<div class="gauge${stale ? ' stale' : ''}">
      <div class="g-name">${label}${stale ? ' <span class="muted">(stale)</span>' : ''}</div>
      <div class="g-val">${fmt(m.latest)}%</div>
      <div class="g-chg ${m.change3m != null ? cls(-m.change3m) : ''}">3m ${m.change3m != null ? (m.change3m >= 0 ? '+' : '') + m.change3m.toFixed(2) + 'pp' : '–'}${target2 ? ` · ${dev >= 0 ? '+' : ''}${dev.toFixed(2)} vs 2%` : ''}</div>
      ${m.spark ? sparkline(m.spark, { height: 26 }) : ''}
    </div>`;
  };
  const region = (label, html, note = '') => html
    ? `<div class="infl-sub muted small">${label}${note ? ` <span class="muted">${note}</span>` : ''}</div><div class="infl-grid">${html}</div>`
    : '';

  $('inflation-card').innerHTML = `
    <div class="panel-title">Market-implied inflation expectations</div>
    ${region('United States — TIPS breakevens (FRED)',
      inflIds.map(([id, label]) => inflGauge(p.macro?.[id], label)).join(''))}
    ${region('Euro area — inflation-linked swaps (ECB)',
      [inflGauge(p.macro?.EZBE5, '5y swap'), inflGauge(p.macro?.EZBE10, '10y swap'), inflGauge(ez5y5y, '5y5y forward (derived)')].join(''))}
    ${region('United Kingdom — gilt-implied, RPI basis (BoE)',
      [inflGauge(p.macro?.UKBE5, '5y implied', false), inflGauge(p.macro?.UKBE10, '10y implied', false), inflGauge(uk5y5y, '5y5y forward (derived)', false)].join(''),
      '(RPI runs ~1pp above CPI)')}
    <div class="muted small infl-note">5y5y forwards are the gauge of whether long-run expectations stay anchored near target. Japan is omitted: JGBi breakevens have no free data feed, and the market is thin enough that the BoJ itself treats them as unreliable. Realized CPI by region lives in the Macro tab.</div>`;
}

function renderBacktest(p) {
  const sec = $('backtest-section');
  const bt = p.backtest;
  if (!bt) { sec.classList.add('hidden'); return; }
  sec.classList.remove('hidden');
  $('backtest-card').innerHTML = `
    <div class="bt-stats">
      <div class="gauge"><div class="g-name">Active return (window)</div><div class="g-val ${cls(bt.activeReturnPct)}">${pct(bt.activeReturnPct, 2)}</div></div>
      <div class="gauge"><div class="g-name">Annualized</div><div class="g-val ${cls(bt.annualizedPct)}">${pct(bt.annualizedPct, 2)}</div></div>
      <div class="gauge"><div class="g-name">Weekly hit rate</div><div class="g-val">${bt.hitRatePct}%</div></div>
      <div class="gauge"><div class="g-name">Max drawdown</div><div class="g-val neg">-${bt.maxDrawdownPct}%</div></div>
      <div class="gauge"><div class="g-name">Avg tilts on</div><div class="g-val">${bt.avgPositions} / ${bt.universe}</div></div>
      <div class="gauge"><div class="g-name">Weeks tested</div><div class="g-val">${bt.weeks}</div></div>
    </div>
    <div class="bt-curve">${sparkline(bt.curve, { height: 46 })}</div>
    <ul class="bt-caveats">${bt.caveats.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>`;
}

const RECO_GROUPS = [
  ['assetClasses', 'Asset Allocation'],
  ['regions', 'Regions'],
  ['sectors', 'Sectors (global proxies)'],
  ['styles', 'Styles & Factors'],
  ['bonds', 'Fixed Income'],
  ['commodities', 'Commodities']
];

function renderRecos(p) {
  const b = p.recommendations?.buckets;
  if (!b) return;
  $('reco-groups').innerHTML = RECO_GROUPS.map(([key, title]) => {
    const items = (b[key] || []).slice().sort((x, y) => (y.score ?? -9) - (x.score ?? -9));
    if (!items.length) return '';
    return `<div class="reco-group">
      <h3>${title}</h3>
      <table class="reco-table">
        <thead><tr><th>Exposure</th><th>Tilt</th><th>Score</th><th>3m</th><th>Why</th></tr></thead>
        <tbody>${items.map((it) => `<tr>
          <td class="reco-name">${esc(it.name)}<span class="reco-sym">${esc(it.symbol)}</span></td>
          <td>${tiltBadge(it)}</td>
          <td>${scoreBar(it.score)}</td>
          <td class="${cls(it.market?.r3m)}">${pct(it.market?.r3m)}</td>
          <td class="reasons">${esc((it.reasons || []).join(' · '))}</td>
        </tr>`).join('')}</tbody>
      </table>
    </div>`;
  }).join('');
}

const MKT_GROUPS = [
  ['RISK', 'Benchmark & Risk'],
  ['REGIONS', 'Regions'],
  ['SECTORS', 'Sectors'],
  ['BONDS', 'Rates & Credit'],
  ['COMMODITIES', 'Commodities'],
  ['FX', 'Currencies']
];

function renderMarkets(p) {
  const byGroup = {};
  for (const q of Object.values(p.instruments)) {
    (byGroup[q.group] = byGroup[q.group] || []).push(q);
  }
  $('markets-groups').innerHTML = MKT_GROUPS.map(([g, title]) => {
    const items = byGroup[g] || [];
    if (!items.length) return '';
    return `<div class="mkt-group"><h3>${title}</h3><div class="mkt-grid">${items.map((q) => `
      <div class="mkt-card">
        <div class="mkt-head"><span class="mkt-name">${esc(q.name)}</span><span class="mkt-sym">${esc(q.symbol)}</span></div>
        <div class="mkt-price">${fmt(q.price, q.price > 500 ? 0 : 2)} <span class="${cls(q.dayChangePct)}" style="font-size:12px">${pct(q.dayChangePct)}</span></div>
        <div class="mkt-chips">
          <span class="chip ${cls(q.r1m)}">1m ${pct(q.r1m)}</span>
          <span class="chip ${cls(q.r3m)}">3m ${pct(q.r3m)}</span>
          <span class="chip ${cls(q.r6m)}">6m ${pct(q.r6m)}</span>
        </div>
        ${sparkline(q.spark)}
      </div>`).join('')}</div></div>`;
  }).join('');
}

const MACRO_TOPICS = ['Inflation', 'Inflation expectations', 'Growth & labor', 'Policy rates', 'Rates & credit', 'Other'];

function renderMacro(p) {
  const entries = Object.values(p.macro || {});
  if (!entries.length) {
    $('macro-grid').innerHTML = '<div class="muted">Macro data unavailable.</div>';
    return;
  }
  const byTopic = {};
  for (const m of entries) (byTopic[m.topic || 'Other'] = byTopic[m.topic || 'Other'] || []).push(m);
  const card = (m) => `
    <div class="macro-card">
      <div class="macro-name">${esc(m.name)}</div>
      <div class="macro-val">${fmt(m.latest)} <span class="muted small">${esc(m.unit)}</span></div>
      <div class="macro-meta">3m &Delta; <span class="${cls(m.change3m)}">${m.change3m != null ? (m.change3m >= 0 ? '+' : '') + m.change3m.toFixed(2) : '–'}</span> &middot; as of ${esc(m.latestDate || '–')}</div>
      ${sparkline(m.spark, { height: 28 })}
    </div>`;
  $('macro-grid').innerHTML = MACRO_TOPICS
    .filter((t) => byTopic[t]?.length)
    .map((t) => `<div class="macro-group"><h3>${t}</h3><div class="macro-grid-inner">${byTopic[t].map(card).join('')}</div></div>`)
    .join('');
}

function renderNews(p) {
  const overall = p.newsSentiment?.overall ?? 0;
  $('news-sentiment').textContent = `aggregate sentiment: ${overall > 0.05 ? 'positive' : overall < -0.05 ? 'negative' : 'neutral'} (${overall.toFixed(2)})`;

  const ai = $('news-ai');
  if (p.newsLLM?.summary) {
    ai.classList.remove('hidden');
    const impactCls = { risk_on: 'pos', risk_off: 'neg' }[p.newsLLM.marketImpact] || '';
    const events = (p.newsLLM.events || []).slice(0, 6).map((e) =>
      `<span class="ai-event ${e.direction > 0 ? 'pos' : 'neg'}" title="${esc((e.buckets || []).join(', '))} · severity ${e.severity}">${esc(String(e.type || '').replace('_', ' '))}: ${esc(String(e.headline || '').slice(0, 90))}</span>`
    ).join('');
    ai.innerHTML = `
      <div class="ai-head">
        <span class="ai-badge">AI ANALYSIS</span>
        <span class="ai-impact ${impactCls}">${esc(String(p.newsLLM.marketImpact || '').replace('_', '-'))}</span>
        <span class="muted small">${esc(p.newsLLM.model || '')}</span>
      </div>
      <div class="ai-summary">${esc(p.newsLLM.summary)}</div>
      ${events ? `<div class="ai-events">${events}</div>` : ''}`;
  } else {
    ai.classList.add('hidden');
  }
  $('news-list').innerHTML = (p.news || []).slice(0, 30).map((n) => {
    const dot = n.sentiment > 0 ? 'sent-pos' : n.sentiment < 0 ? 'sent-neg' : 'sent-neu';
    const when = n.publishedAt ? new Date(n.publishedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
    const tags = (n.tags || []).map((t) => `<span class="news-tag">${esc(t)}</span>`).join('');
    return `<li>
      <span class="sent-dot ${dot}" title="sentiment ${n.sentiment}"></span>
      <span class="news-title"><a href="${esc(n.link)}" target="_blank" rel="noopener">${esc(n.title)}</a></span>
      <span class="news-tags">${tags}</span>
      <span class="news-meta">${esc(n.source)} &middot; ${when}</span>
    </li>`;
  }).join('');
}

function renderLog(p) {
  const log = p.tiltLog || [];
  $('tilt-log').innerHTML = log.length
    ? log.map((c) => `<li>${new Date(c.changedAt).toLocaleString()} — <b>${esc(c.key)}</b> &rarr; ${esc(c.tilt)}</li>`).join('')
    : '<li>No tilt changes recorded yet.</li>';
}

function renderStatus(p) {
  const badge = $('mode-badge');
  badge.textContent = p.mode !== 'live' ? 'DEMO DATA' : p.hosted ? 'LIVE · 10-MIN SNAPSHOTS' : 'LIVE DATA';
  badge.className = `badge ${p.mode === 'live' ? 'live' : 'mock'}`;
  const errs = Object.entries(p.status || {})
    .filter(([, s]) => s.lastError)
    .map(([k, s]) => `${k}: ${s.lastError}`);
  const secs = Math.max(0, Math.round((nextPollAt - Date.now()) / 1000));
  $('refresh-info').textContent =
    `data as of ${new Date(p.generatedAt).toLocaleTimeString()} · next check in ${secs}s` +
    (errs.length ? ` · ⚠ ${errs.join(' | ')}` : '');
}

function render(p) {
  lastPayload = p;
  applyVariant(p);
  $('loading').classList.add('hidden');
  for (const id of ['regime-section', 'reco-section', 'markets-section', 'macro-section', 'news-section', 'log-section']) {
    $(id).classList.remove('hidden');
  }
  renderStatus(p);
  renderRegime(p);
  renderPolicy(p);
  renderRecos(p);
  renderBacktest(p);
  renderMarkets(p);
  renderMacro(p);
  renderNews(p);
  renderLog(p);
}

async function poll() {
  try {
    const payload = await fetchPayload();
    nextPollAt = Date.now() + POLL_MS;
    render(payload);
  } catch (err) {
    $('loading').textContent = `Failed to load: ${err.message} — retrying…`;
    $('loading').classList.remove('hidden');
  }
}

initTabs();
setInterval(() => { if (lastPayload) renderStatus(lastPayload); }, 1000);
setInterval(poll, POLL_MS);
poll();
