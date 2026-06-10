// Persistent tilt history backing the 30-day compliance lock. Survives
// restarts so the lock cannot be reset by bouncing the server.

import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';

export class TiltStore {
  constructor(path) {
    this.path = path;
    this.history = {}; // key -> { tilt, changedAt, lastTradeDir }
    this.log = [];     // append-only change log for auditability
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8'));
      this.history = raw.history || {};
      this.log = raw.log || [];
    } catch {
      // first run: empty history
    }
  }

  applyChanges(changes) {
    if (!changes.length) return;
    for (const c of changes) {
      this.history[c.key] = { tilt: c.tilt, changedAt: c.changedAt, lastTradeDir: c.lastTradeDir };
      this.log.push({ ...c, at: new Date(c.changedAt).toISOString() });
    }
    if (this.log.length > 2000) this.log = this.log.slice(-2000);
    this.save();
  }

  save() {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, JSON.stringify({ history: this.history, log: this.log }, null, 2));
      renameSync(tmp, this.path);
    } catch (err) {
      console.error('[store] failed to persist tilt history:', err.message);
    }
  }
}
