import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';

async function body(req) {
  let data = '';
  for await (const chunk of req) {
    data += chunk;
    if (data.length > 1024 * 1024) throw new Error('Request too large');
  }
  return data ? JSON.parse(data) : {};
}
export function createApi(engine, token = randomBytes(32).toString('hex')) {
  const server = createServer(async (req, res) => {
    const send = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
    try {
      const supplied = Buffer.from(req.headers.authorization ?? ''), expected = Buffer.from(`Bearer ${token}`);
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return send(401, { error: 'Bearer token required' });
      if (req.headers.origin) return send(403, { error: 'Browser origins are not enabled for this local API' });
      const parts = new URL(req.url, 'http://localhost').pathname.split('/').filter(Boolean);
      const [resource, key, action, taskId] = parts;
      if (req.method === 'GET' && resource === 'health') return send(200, { status: 'ok', version: '0.1.0' });
      if (resource === 'projects') {
        if (req.method === 'GET') return send(200, key ? engine.project(key) : Object.values(engine.store.data.projects));
        if (req.method === 'POST' && !key) return send(201, engine.createProject(await body(req)));
        if (req.method === 'PUT' && key) return send(200, engine.updateProject(key, await body(req)));
        if (req.method === 'POST' && action === 'runs') return send(202, engine.start(key));
      }
      if (resource === 'runs') {
        if (req.method === 'GET') {
          if (!key) return send(200, Object.values(engine.store.data.runs).map(({ id, projectId, revision, status, calls, createdAt }) => ({ id, projectId, revision, status, calls, createdAt })));
          const run = engine.run(key);
          return send(200, action === 'events' ? run.events : run);
        }
        if (req.method === 'POST' && ['pause', 'resume', 'cancel'].includes(action)) return send(200, engine[action](key));
        if (req.method === 'POST' && action === 'approve') return send(200, engine.approve(key, taskId));
        if (req.method === 'POST' && action === 'cancel-task') return send(200, engine.cancelTask(key, taskId));
      }
      send(404, { error: 'Route not found' });
    } catch (error) { send(400, { error: error.message }); }
  });
  server.requestTimeout = 15000;
  return { server, token };
}
