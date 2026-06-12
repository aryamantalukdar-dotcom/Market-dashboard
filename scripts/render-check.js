// Executes public/app.js against a payload with a minimal DOM stub, so a
// runtime error in any render function (which would leave the real page stuck
// on "Loading…") fails CI/smoke instead of shipping.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function makeEl(id) {
  return {
    id, innerHTML: '', textContent: '', className: '', style: {},
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {},
    dataset: {}
  };
}

export function renderCheck(payload) {
  const elements = {};
  const g = globalThis;
  const saved = {};
  const stubs = {
    document: {
      getElementById: (id) => (elements[id] = elements[id] || makeEl(id)),
      querySelector: (sel) => makeEl(sel),
      querySelectorAll: () => [],
      createElement: () => ({
        set textContent(v) { this._t = String(v); },
        get innerHTML() { return (this._t || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
      })
    },
    location: { hash: '', pathname: '/' },
    history: { replaceState() {} },
    window: { scrollTo() {} },
    setInterval: () => 0
  };
  for (const [k, v] of Object.entries(stubs)) { saved[k] = g[k]; g[k] = v; }
  try {
    const src = readFileSync(join(ROOT, 'public', 'app.js'), 'utf8');
    const body = src.replace(/initTabs\(\);\s*setInterval[\s\S]*$/m, '');
    const fn = new Function(body + '\ninitTabs();\nrender(arguments[0]);\nreturn true;');
    fn(payload);
    return elements;
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete g[k];
      else g[k] = v;
    }
  }
}
