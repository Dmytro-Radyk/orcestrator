import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, unlinkSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const retryable=new Set(['EPERM','EACCES','EBUSY']);
const pause=ms=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms);
export function replaceWithRetry(source,target,{rename=renameSync,wait=pause}={}) {
  for(let attempt=0;;attempt++){
    try{return rename(source,target);}catch(error){
      if(!retryable.has(error.code)||attempt>=7)throw error;
      wait(Math.min(10*2**attempt,100));
    }
  }
}

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
    clearTimeout(this.pendingSave);
    this.pendingSave=undefined;
    const temp=`${this.path}.${process.pid}.${randomUUID().slice(0,8)}.tmp`;
    try {
      writeFileSync(temp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
      replaceWithRetry(temp, this.path);
    } catch (error) {
      try { unlinkSync(temp); } catch {}
      throw error;
    }
  }
  saveProgress() {
    if (this.pendingSave) return;
    this.pendingSave=setTimeout(()=>{
      this.pendingSave=undefined;
      try { this.save(); } catch (error) { console.error('Store progress save failed:', error.message); }
    },250);
    this.pendingSave.unref?.();
  }
  flush() {
    if (this.pendingSave) this.save();
  }
}
