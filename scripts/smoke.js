// End-to-end smoke test: boots the server in mock mode on a random port,
// hits the API, and sanity-checks the engine output (including the 30-day
// compliance lock logic, which is exercised directly).

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import assert from 'node:assert';
import { applyCompliance } from '../lib/engine.js';

const DAY = 24 * 60 * 60 * 1000;

function testComplianceLock() {
  const now = Date.now();
  // Established OVERWEIGHT 10 days ago via a buy (+1): flipping to UNDERWEIGHT
  // implies selling — opposite trade inside 30d — must be locked.
  let history = { 'us': { tilt: 'OVERWEIGHT', changedAt: now - 10 * DAY, lastTradeDir: 1 } };
  let r = applyCompliance('us', 'UNDERWEIGHT', history, now);
  assert.equal(r.locked, true, 'reversal within 30d must be locked');
  assert.equal(r.tilt, 'OVERWEIGHT', 'locked tilt holds previous value');
  assert.equal(r.pendingTilt, 'UNDERWEIGHT');

  // Same reversal after 35 days: allowed.
  history = { 'us': { tilt: 'OVERWEIGHT', changedAt: now - 35 * DAY, lastTradeDir: 1 } };
  r = applyCompliance('us', 'UNDERWEIGHT', history, now);
  assert.equal(r.locked, false, 'reversal after 30d is allowed');
  assert.equal(r.tilt, 'UNDERWEIGHT');

  // Moving further in the SAME direction inside 30d is not an opposite trade.
  history = { 'em': { tilt: 'NEUTRAL', changedAt: now - 5 * DAY, lastTradeDir: 1 } };
  r = applyCompliance('em', 'OVERWEIGHT', history, now);
  assert.equal(r.locked, false, 'same-direction move is allowed');

  // Reducing toward NEUTRAL within 30d of a buy is still an opposite trade.
  history = { 'tech': { tilt: 'OVERWEIGHT', changedAt: now - 5 * DAY, lastTradeDir: 1 } };
  r = applyCompliance('tech', 'NEUTRAL', history, now);
  assert.equal(r.locked, true, 'trimming within 30d of a buy is locked');

  console.log('✓ compliance lock unit checks passed');
}

async function testServer() {
  const port = 3456;
  const child = spawn(process.execPath, ['server.js'], {
    env: { ...process.env, MOCK: '1', PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', (d) => process.stdout.write(`  [server] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`  [server] ${d}`));

  try {
    let payload = null;
    for (let i = 0; i < 30; i++) {
      await sleep(500);
      try {
        const res = await fetch(`http://localhost:${port}/api/dashboard`);
        if (res.ok) {
          payload = await res.json();
          if (payload.recommendations) break;
        }
      } catch { /* server still starting */ }
    }
    assert.ok(payload, 'API did not respond');
    assert.equal(payload.mode, 'mock');
    assert.ok(Object.keys(payload.instruments).length > 40, 'expected >40 instruments');
    assert.ok(payload.recommendations.regime.label, 'regime label missing');
    for (const group of ['assetClasses', 'regions', 'sectors', 'styles', 'bonds', 'commodities']) {
      const items = payload.recommendations.buckets[group];
      assert.ok(items?.length, `bucket ${group} empty`);
      for (const it of items) assert.ok(['OVERWEIGHT', 'NEUTRAL', 'UNDERWEIGHT'].includes(it.tilt), `bad tilt in ${group}`);
    }
    assert.ok(payload.news.length > 0, 'no news items');
    assert.ok(Object.keys(payload.macro).length >= 18, 'macro series missing');
    assert.ok(payload.macro.T5YIFR && payload.macro.T10YIE, 'inflation expectation series missing');
    assert.ok(payload.macro.ECBDFR && payload.macro.IUDSOIA && payload.macro.IRSTCI01JPM156N, 'central bank stance series missing');
    assert.ok(payload.macro.CP0000EZ19M086NEST && payload.macro.UKCPI_D7G7, 'regional CPI series missing');
    assert.ok(payload.policy && payload.policy.path.length >= 4, 'policy path missing');
    assert.ok(Number.isFinite(payload.policy.change12mBp), 'policy 12m change missing');
    assert.ok(payload.backtest && payload.backtest.weeks > 0, 'backtest missing');
    assert.ok(Array.isArray(payload.backtest.curve) && payload.backtest.curve.length > 5, 'backtest curve missing');
    assert.ok(payload.recommendations.regime.signals.policy?.length, 'regime policy signal missing');
    const anyInst = Object.values(payload.instruments)[0];
    assert.ok(!('closes' in anyInst), 'full closes array leaked into payload');

    const html = await (await fetch(`http://localhost:${port}/`)).text();
    assert.ok(html.includes('Global Market'), 'index.html not served');

    const health = await (await fetch(`http://localhost:${port}/api/health`)).json();
    assert.equal(health.ok, true);

    console.log(`✓ server smoke test passed (${Object.keys(payload.instruments).length} instruments, regime: ${payload.recommendations.regime.label})`);
  } finally {
    child.kill();
  }
}

testComplianceLock();
await testServer();
console.log('All smoke tests passed.');
process.exit(0);
