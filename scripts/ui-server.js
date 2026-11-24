import { createServer } from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, relative, isAbsolute, extname, sep } from 'node:path';
import { planningHandler } from './planning-service.js';
import { createExecutionService } from './execution-service.js';

// Node preserves variables already set in the launching environment.
try { process.loadEnvFile(fileURLToPath(new URL('../.env.local', import.meta.url))); }
catch (error) { if (error.code !== 'ENOENT') throw error; }

const root = await realpath(fileURLToPath(new URL('../apps/web/', import.meta.url)));
const inside = (base, target) => { const rel = relative(base, target); return Boolean(rel) && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); };
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };
const port = process.env.UI_PORT === undefined || process.env.UI_PORT === '' ? 4311 : Number(process.env.UI_PORT);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('UI_PORT must be an integer 1..65535');
const execution = createExecutionService({origin:`http://127.0.0.1:${port}`});
// A pinned director is optional. Automatic selection uses only verified, allowed routes.
const planning = planningHandler({resolve:options=>execution.director.plannerConfig(options),managerCatalog:()=>execution.registry.snapshot().routes,
  select:(request,signal)=>execution.director.selectPlanner(request,signal)},execution.director.invoke);
const server = createServer(async (req, res) => {
  try {
    const boundPort = server.address()?.port ?? port;
    const host = req.headers.host;
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { res.writeHead(400); res.end('Bad request'); return; }
    if (host === `localhost:${boundPort}` && !url.pathname.startsWith('/api/') && ['GET', 'HEAD'].includes(req.method)) {
      res.writeHead(307, { Location: `http://127.0.0.1:${boundPort}${url.pathname}${url.search}` });
      res.end();
      return;
    }
    if (host !== `127.0.0.1:${boundPort}`) { res.writeHead(403); res.end('Forbidden host'); return; }
    if (url.pathname.startsWith('/api/')) { await (url.pathname.startsWith('/api/planning') ? planning : execution.handler)(req,res); return; }
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); res.end(); return; }
    const pathname = decodeURIComponent(url.pathname);
    const candidate = resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
    const target = await realpath(candidate);
    if (!inside(root, target)) { res.writeHead(403); res.end(); return; }
    const content = await readFile(target);
    const isTexture = pathname.startsWith('/textures/');
    res.writeHead(200, { 'Content-Type': types[extname(target)] ?? 'application/octet-stream',
      'Cache-Control': isTexture ? 'public, max-age=86400' : 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src http://127.0.0.1:*; object-src 'none'; base-uri 'none'; frame-ancestors 'none'" });
    res.end(req.method === 'HEAD' ? undefined : content);
  } catch { if (!res.headersSent && !res.destroyed) { res.writeHead(404); res.end('Not found'); } }
});
server.on('error', error => { console.error(error.message); process.exitCode = 1; });
server.listen(port, '127.0.0.1', () => console.log(
  `Orcestrator UI: http://127.0.0.1:${server.address().port}\nPlanner: ${process.env.ORCHESTRATOR_DIRECTOR_ROUTE?'pinned verified route':'automatic verified route'}\nExecution: verified AI routes in isolated worktrees; models are shown before each run.`));
const shutdown = () => { execution.close(); server.closeAllConnections(); server.close(); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
