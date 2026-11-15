import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, relative, isAbsolute, extname } from 'node:path';
import { planningHandler } from './planning-service.js';
import { createExecutionService } from './execution-service.js';

// Node preserves variables already set in the launching environment.
try { process.loadEnvFile(fileURLToPath(new URL('../.env.local', import.meta.url))); }
catch (error) { if (error.code !== 'ENOENT') throw error; }

const root = fileURLToPath(new URL('../apps/web/', import.meta.url));
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };
const execution = createExecutionService();
// A pinned director is optional. Automatic selection uses only verified, allowed routes.
const planning = planningHandler({resolve:options=>execution.director.plannerConfig(options)},execution.director.invoke);
const server = createServer(async (req, res) => {
  try {
    if (req.url?.startsWith('/api/')) { await (req.url.startsWith('/api/planning') ? planning : execution.handler)(req,res); return; }
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); res.end(); return; }
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const target = resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
    const rel = relative(root, target);
    if (rel.startsWith('..') || isAbsolute(rel)) { res.writeHead(403); res.end(); return; }
    const content = await readFile(target);
    res.writeHead(200, { 'Content-Type': types[extname(target)] ?? 'application/octet-stream', 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'" });
    res.end(req.method === 'HEAD' ? undefined : content);
  } catch { res.writeHead(404); res.end('Not found'); }
});
server.on('error', error => { console.error(error.message); process.exitCode = 1; });
server.listen(Number(process.env.UI_PORT ?? 4311), '127.0.0.1', () => console.log(
  `Orcestrator UI: http://127.0.0.1:${server.address().port}\nPlanner: ${process.env.ORCHESTRATOR_DIRECTOR_ROUTE?'pinned verified route':'automatic verified route'}\nExecution: verified AI routes in isolated worktrees; models are shown before each run.`));
const shutdown = () => { execution.close(); server.close(); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
