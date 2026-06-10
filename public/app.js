/* Dashboard frontend: polls /api/dashboard and renders everything.
   No frameworks, no build step. */

const POLL_MS = 30 * 1000;
let lastPayload = null;
let nextPollAt = Date.now();

const $ = (id) => document.getElementById(id);

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
    <ul class="regime-signals">${sig(r.signals.risk)}${sig(r.signals.growth)}${sig(r.signals.inflation)}</ul>`;

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

function renderMacro(p) {
  const entries = Object.values(p.macro || {});
  if (!entries.length) {
    $('macro-grid').innerHTML = '<div class="muted">Macro data unavailable.</div>';
    return;
  }
  $('macro-grid').innerHTML = entries.map((m) => `
    <div class="macro-card">
      <div class="macro-name">${esc(m.name)}</div>
      <div class="macro-val">${fmt(m.latest)} <span class="muted small">${esc(m.unit)}</span></div>
      <div class="macro-meta">3m &Delta; <span class="${cls(m.change3m)}">${m.change3m != null ? (m.change3m >= 0 ? '+' : '') + m.change3m.toFixed(2) : '–'}</span> &middot; as of ${esc(m.latestDate || '–')}</div>
      ${sparkline(m.spark, { height: 28 })}
    </div>`).join('');
}

function renderNews(p) {
  const overall = p.newsSentiment?.overall ?? 0;
  $('news-sentiment').textContent = `aggregate sentiment: ${overall > 0.05 ? 'positive' : overall < -0.05 ? 'negative' : 'neutral'} (${overall.toFixed(2)})`;
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
  badge.textContent = p.mode === 'live' ? 'LIVE DATA' : 'DEMO DATA';
  badge.className = `badge ${p.mode === 'live' ? 'live' : 'mock'}`;
  const errs = Object.entries(p.status || {})
    .filter(([, s]) => s.lastError)
    .map(([k, s]) => `${k}: ${s.lastError}`);
  const secs = Math.max(0, Math.round((nextPollAt - Date.now()) / 1000));
  $('refresh-info').textContent =
    `updated ${new Date(p.generatedAt).toLocaleTimeString()} · next refresh in ${secs}s` +
    (errs.length ? ` · ⚠ ${errs.join(' | ')}` : '');
}

function render(p) {
  lastPayload = p;
  $('loading').classList.add('hidden');
  for (const id of ['regime-section', 'reco-section', 'markets-section', 'macro-section', 'news-section', 'log-section']) {
    $(id).classList.remove('hidden');
  }
  renderStatus(p);
  renderRegime(p);
  renderRecos(p);
  renderMarkets(p);
  renderMacro(p);
  renderNews(p);
  renderLog(p);
}

async function poll() {
  try {
    const res = await fetch('/api/dashboard');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const payload = await res.json();
    nextPollAt = Date.now() + POLL_MS;
    render(payload);
  } catch (err) {
    $('loading').textContent = `Failed to load: ${err.message} — retrying…`;
    $('loading').classList.remove('hidden');
  }
}

setInterval(() => { if (lastPayload) renderStatus(lastPayload); }, 1000);
setInterval(poll, POLL_MS);
poll();
