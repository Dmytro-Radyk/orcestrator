import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { terminate } from '../src/providers.js';

export function localChromiumBrowser(env = process.env, envKey = 'ORCHESTRATOR_LOCAL_BROWSER') {
  return [
    env[envKey],
    env.ORCHESTRATOR_STOREFRONT_BROWSER,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  ].find(path => path && isAbsolute(path) && existsSync(path));
}

export const visibleElement = element => element && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden';

export async function connectBrowser(command, directory, origin, signal) {
  const child = spawn(command, [
    '--headless=new', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
    '--disable-background-networking', '--disable-extensions', '--no-first-run',
    '--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1',
    '--proxy-server=http://127.0.0.1:1', `--proxy-bypass-list=<-loopback>;${new URL(origin).host}`,
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    `--user-data-dir=${directory}`, 'about:blank'
  ], { stdio: 'ignore', windowsHide: true });
  let processError, socket, sequence = 0, stopped = false;
  const pending = new Map();
  child.once('error', error => { processError = error; });
  async function stop() {
    if (stopped) return;
    stopped = true;
    try { socket?.close(); } catch {}
    terminate(child);
    if (child.exitCode === null && child.signalCode === null) {
      await Promise.race([once(child, 'close'), delay(1500)]).catch(() => {});
    }
  }
  try {
    let port;
    for (let n = 0; n < 80 && !port; n++) {
      signal.throwIfAborted();
      if (processError || child.exitCode !== null) throw Error('Chromium завершився під час запуску');
      port = (await readFile(join(directory, 'DevToolsActivePort'), 'utf8').catch(() => '')).split(/\r?\n/)[0];
      if (!port) await delay(100, undefined, { signal });
    }
    if (!/^\d+$/.test(port ?? '')) throw Error('Chromium не відкрив DevTools');
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal })).json();
    const endpoint = URL.parse(targets.find(target => target.type === 'page')?.webSocketDebuggerUrl ?? '');
    if (!endpoint || endpoint.origin !== `ws://127.0.0.1:${port}` || !endpoint.pathname.startsWith('/devtools/page/')) {
      throw Error('Неочікувана адреса DevTools');
    }
    socket = new WebSocket(endpoint);
    await once(socket, 'open', { signal });
    function call(method, params = {}) {
      signal.throwIfAborted();
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        const finish = () => { clearTimeout(timer); pending.delete(id); signal.removeEventListener('abort', abort); };
        const abort = () => { finish(); reject(signal.reason); };
        const timer = setTimeout(() => { finish(); reject(Error(`Chromium не відповів на ${method}`)); }, 5000);
        pending.set(id, result => { finish(); if (result.error) reject(Error(`Chromium: ${method}`)); else resolve(result.result); });
        signal.addEventListener('abort', abort, { once: true });
        try { socket.send(JSON.stringify({ id, method, params })); } catch (error) { finish(); reject(error); }
      });
    }
    return { call, socket, stop, pending };
  } catch (error) {
    await stop();
    throw error;
  }
}

export function bindLocalBrowser(connection, origin) {
  const { call, socket } = connection;
  socket.addEventListener('message', ({ data }) => {
    const event = JSON.parse(data);
    if (event.id) return connection.pending.get(event.id)?.(event);
    if (event.method !== 'Fetch.requestPaused') return;
    const { requestId, request } = event.params;
    const target = URL.parse(request.url);
    const allowed = target?.origin === origin || ['data:', 'blob:'].includes(target?.protocol);
    void Promise.resolve().then(() => call(allowed ? 'Fetch.continueRequest' : 'Fetch.failRequest',
      allowed ? { requestId } : { requestId, errorReason: 'BlockedByClient' })).catch(() => {});
  });
}

export async function inspectLocalPreview(url, width, parentSignal) {
  const target = URL.parse(url), browser = localChromiumBrowser();
  if (!target || target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || !target.port || !browser) {
    throw Error('Локальний перегляд або Chromium недоступний.');
  }
  const signal = AbortSignal.any([parentSignal, AbortSignal.timeout(22000)]);
  const profile = await mkdtemp(join(tmpdir(), 'orcestrator-preview-'));
  let connection;
  try {
    connection = await connectBrowser(browser, profile, target.origin, signal);
    bindLocalBrowser(connection, target.origin);
    const { call } = connection;
    await call('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
    await call('Emulation.setDeviceMetricsOverride', { width, height: 850, deviceScaleFactor: 1, mobile: false });
    const navigation = await call('Page.navigate', { url: target.href });
    if (navigation.errorText) throw Error('Chromium не відкрив сторінку проєкту.');
    for (let attempt = 0; attempt < 30; attempt++) {
      const { result } = await call('Runtime.evaluate', { returnByValue: true, expression:
        `location.origin===${JSON.stringify(target.origin)} && document.readyState==='complete' && ({
          path:location.pathname, title:document.title, heading:document.querySelector('h1')?.innerText??'',
          horizontalOverflow:document.documentElement.scrollWidth>document.documentElement.clientWidth,
          brokenImages:[...document.images].filter(img=>img.complete&&!img.naturalWidth).slice(0,12).map(img=>img.alt),
          visibleText:document.body.innerText.slice(0,1800)
        })` }).catch(error => { signal.throwIfAborted(); if (error.message === 'Chromium: Runtime.evaluate') return {}; throw error; });
      if (result?.value) {
        const image = await call('Page.captureScreenshot', { format: 'jpeg', quality: 55 });
        return { page: result.value, image: image.data };
      }
      await delay(180, undefined, { signal });
    }
    throw Error('Сторінка проєкту не завершила завантаження.');
  } finally {
    await connection?.stop();
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 }).catch(() => {});
  }
}
