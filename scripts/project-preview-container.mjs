import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [mode, targetFile] = process.argv.slice(2);
const writeFrame = payload => { process.stdout.write(`${JSON.stringify(payload)}\n`); };
const env = {
  PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
  HOME: '/tmp',
  TMPDIR: '/tmp',
  PORT: '3000',
  HOST: '127.0.0.1'
};

let child, fixtureInstance, targetUrl, shuttingDown = false;

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  try { await fixtureInstance?.close?.(); } catch {}
  try { child?.kill('SIGKILL'); } catch {}
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
process.stdin.on('end', () => void shutdown());

function parseLoopbackUrl(value) {
  const parsed = typeof value === 'string' ? URL.parse(value) : null;
  if (!parsed || parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || !parsed.port || parsed.username || parsed.password) {
    throw new Error('Сервер перегляду має слухати лише 127.0.0.1 у контейнері');
  }
  return parsed;
}

async function startUpstream() {
  const scriptPath = resolve('/project', targetFile);
  if (mode === 'fixture') {
    const mod = await import(pathToFileURL(scriptPath).href);
    fixtureInstance = await mod.startFixture();
    return parseLoopbackUrl(fixtureInstance?.origin);
  }
  child = spawn(process.execPath, [scriptPath], {
    cwd: '/project',
    env,
    stdio: ['ignore', 'pipe', 'ignore']
  });
  const lines = createInterface({ input: child.stdout });
  try {
    return await new Promise((done, reject) => {
      const timer = setTimeout(() => reject(new Error('Локальний перегляд не запустився в контейнері')), 12000);
      const finish = (fn, value) => { clearTimeout(timer); fn(value); };
      child.once('error', err => finish(reject, err));
      child.once('exit', () => finish(reject, new Error('Сервер перегляду завершився')));
      lines.on('line', line => {
        try {
          const data = JSON.parse(line);
          if (data.mode === 'TEST_ONLY' && data.externalCalls === false) {
            finish(done, parseLoopbackUrl(data.url));
          }
        } catch {}
      });
    });
  } finally {
    lines.close();
    child.stdout.resume();
  }
}

function forwardHttp({ id, method = 'GET', path = '/', headers = {}, body = '' }) {
  return new Promise(done => {
    const url = URL.parse(path, targetUrl.origin);
    if (!url || url.origin !== targetUrl.origin) {
      done({ id, statusCode: 400, headers: {}, body: '' });
      return;
    }
    const reqHeaders = { ...headers, host: targetUrl.host, connection: 'close' };
    delete reqHeaders['accept-encoding'];
    const payload = body ? Buffer.from(body, 'base64') : null;
    if (payload) reqHeaders['content-length'] = String(payload.length);
    else delete reqHeaders['content-length'];
    const upstream = httpRequest(url, { method, headers: reqHeaders, timeout: 15000 }, res => {
      const chunks = [];
      let bytes = 0;
      res.on('data', chunk => {
        bytes += chunk.length;
        if (bytes <= 8 * 1024 * 1024) chunks.push(chunk);
        else upstream.destroy(new Error('Response limit exceeded'));
      });
      res.on('end', () => {
        done({
          id,
          statusCode: res.statusCode ?? 502,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('base64')
        });
      });
      res.on('error', () => done({ id, statusCode: 502, headers: {}, body: '' }));
    });
    upstream.on('timeout', () => upstream.destroy(new Error('Upstream timeout')));
    upstream.on('error', () => done({ id, statusCode: 502, headers: {}, body: '' }));
    if (payload?.length) upstream.write(payload);
    upstream.end();
  });
}

try {
  targetUrl = await startUpstream();
  child?.once('exit', () => void shutdown());
  writeFrame({ type: 'ready', pathname: targetUrl.pathname, demo: mode === 'fixture' });
  const input = createInterface({ input: process.stdin });
  input.on('line', line => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message?.type === 'close') { void shutdown(); return; }
    if (!message || message.id === undefined) return;
    void forwardHttp(message).then(writeFrame);
  });
} catch (error) {
  writeFrame({ type: 'error', message: error.message || 'Не вдалося запустити перегляд у контейнері' });
  await shutdown();
}
