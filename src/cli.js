import { readFileSync } from 'node:fs';
import { Store } from './store.js';
import { Engine } from './engine.js';
import { createApi } from './server.js';
import { setTimeout as delay } from 'node:timers/promises';

const [command = 'help', file] = process.argv.slice(2);
try {
  if (command === 'serve') {
    const engine = new Engine(new Store(process.env.ORCHESTRATOR_DATA));
    const { server, token } = createApi(engine, process.env.ORCHESTRATOR_TOKEN);
    const port = Number(process.env.PORT ?? 4310);
    server.on('error', error => { console.error(error.message); process.exitCode = 1; });
    server.listen(port, '127.0.0.1', () => {
      console.log(`Orcestrator API: http://127.0.0.1:${server.address().port}\nBearer token: ${token}\nKeep this token private. Data: ${engine.store.directory}`);
    });
    const shutdown = () => {
      for (const run of Object.values(engine.store.data.runs)) if (['running', 'paused'].includes(run.status)) engine.cancel(run.id);
      server.close();
    };
    process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
  } else if (command === 'demo' || command === 'run') {
    const path = command === 'demo' ? new URL('../examples/demo.json', import.meta.url) : file;
    if (!path) throw new Error('Usage: node src/cli.js run project.json');
    const engine = new Engine(new Store(process.env.ORCHESTRATOR_DATA));
    const project = engine.createProject(JSON.parse(readFileSync(path, 'utf8')));
    const run = engine.start(project.id);
    process.on('SIGINT', () => { if (['running', 'paused'].includes(run.status)) engine.cancel(run.id); });
    let cursor = 0;
    while (['running', 'paused'].includes(run.status)) {
      for (const event of run.events.slice(cursor)) console.log(`${event.type} ${event.taskId ?? ''} ${event.agentId ?? ''}`);
      cursor = run.events.length;
      if (run.tasks.some(t => t.status === 'awaiting_approval')) {
        engine.cancel(run.id); throw new Error('Interactive approvals require server mode');
      }
      await delay(50);
    }
    console.log(JSON.stringify({ id: run.id, status: run.status, calls: run.calls, tasks: run.tasks.map(t => ({ id: t.id, status: t.status, result: t.result, error: t.error })) }, null, 2));
    if (run.status !== 'completed') process.exitCode = 1;
  } else console.log('Commands:\n  npm start — local management API\n  npm run demo — offline team example\n  node src/cli.js run project.json — execute a project\n  npm test — automated tests');
} catch (error) { console.error(error.message); process.exitCode = 1; }
