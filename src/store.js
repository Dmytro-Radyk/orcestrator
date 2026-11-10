import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

// One server process owns this store. Atomic replacement prevents partial JSON writes.
export class Store {
  constructor(directory = '.orchestrator') {
    this.directory = resolve(directory);
    mkdirSync(this.directory, { recursive: true });
    this.path = join(this.directory, 'state.json');
    this.data = existsSync(this.path) ? JSON.parse(readFileSync(this.path, 'utf8')) : { projects: {}, runs: {} };
    for (const run of Object.values(this.data.runs)) {
      if (['running', 'paused'].includes(run.status)) {
        run.status = 'interrupted';
        for (const task of run.tasks) if (task.status === 'running') task.status = 'interrupted';
        run.events.push({ at: new Date().toISOString(), type: 'run.interrupted', message: 'Server restarted; create a new run to retry safely.' });
      }
    }
    this.save();
  }
  save() {
    writeFileSync(`${this.path}.tmp`, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    renameSync(`${this.path}.tmp`, this.path);
  }
}
