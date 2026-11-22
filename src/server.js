import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { streamRun } from './run-stream.js';
import { readJsonBody } from './http-body.js';

const body=readJsonBody;
export function createApi(engine, token) {
  const effectiveToken = token === undefined ? randomBytes(32).toString('hex') : String(token);
  if (effectiveToken.length < 16) throw new Error('ORCHESTRATOR_TOKEN must be at least 16 characters');
  const streams = new Set();
  const server = createServer(async (req, res) => {
    const send = (status, data) => {
      if (res.headersSent || res.destroyed || res.writableEnded) return;
      const payload = JSON.stringify(data);
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Cross-Origin-Resource-Policy': 'same-origin'
      });
      res.end(payload);
    };
    try {
      const supplied = Buffer.from(req.headers.authorization ?? ''), expected = Buffer.from(`Bearer ${effectiveToken}`);
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return send(401, { error: 'Bearer token required' });
      if (req.headers.origin) return send(403, { error: 'Browser origins are not enabled for this local API' });
      const parts = new URL(req.url, 'http://localhost').pathname.split('/').filter(Boolean).map(decodeURIComponent);
      const [resource, key, action, taskId, extra] = parts;
      if (extra !== undefined) return send(404, { error: 'Route not found' });
      if (req.method === 'GET' && resource === 'health' && !key) return send(200, { status: 'ok', version: '0.1.0' });
      if (resource === 'projects') {
        if (req.method === 'GET' && !action) return send(200, key ? engine.project(key) : Object.values(engine.store.data.projects));
        if (req.method === 'POST' && !key) return send(201, engine.createProject(await body(req)));
        if (req.method === 'PUT' && key && !action) return send(200, engine.updateProject(key, await body(req)));
        if (req.method === 'POST' && key && action === 'runs' && !taskId) return send(202, engine.start(key));
      }
      if (resource === 'runs') {
        if (req.method === 'GET' && !taskId) {
          if (!key) return send(200, Object.values(engine.store.data.runs).map(({ id, projectId, revision, status, calls, createdAt }) => ({ id, projectId, revision, status, calls, createdAt })));
          const run = engine.run(key);
          if(action==='events'&&req.headers.accept?.includes('text/event-stream')){
            let close; close=streamRun(engine,run,req,res,{onClose:()=>streams.delete(close)});
            if(!res.writableEnded)streams.add(close);
            return;
          }
          if (!action) return send(200, run);
          if (action === 'events') return send(200, run.events);
        }
        if (req.method === 'POST' && key && !taskId && ['pause', 'resume', 'cancel'].includes(action)) return send(200, engine[action](key));
        if (req.method === 'POST' && key && !taskId && action === 'recover') return send(202, engine.requestRecovery(key));
        if (req.method === 'POST' && key && taskId && action === 'approve') return send(200, engine.approve(key, taskId));
        if (req.method === 'POST' && key && taskId && action === 'cancel-task') return send(200, engine.cancelTask(key, taskId));
      }
      send(404, { error: 'Route not found' });
    } catch (error) {
      if (res.headersSent || res.destroyed || res.writableEnded) { res.end(); return; }
      send(error.statusCode ?? 400, { error: error.message });
    }
  });
  server.requestTimeout = 15000;
  return { server, token: effectiveToken, closeStreams() { for (const close of streams) close(); } };
}
