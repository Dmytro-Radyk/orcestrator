import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { bindLocalBrowser, connectBrowser, localChromiumBrowser, visibleElement } from '../../browser-cdp.js';

const models = '[data-product-model]';

export function storefrontBrowser(env = process.env) {
  return localChromiumBrowser(env, 'ORCHESTRATOR_STOREFRONT_BROWSER');
}

export async function auditStorefront(url, { browser = storefrontBrowser(), minimum = 12, output, signal: parentSignal } = {}) {
  if (!browser) return { status: 'unavailable', issues: ['Не знайдено Chrome або Edge для незалежної перевірки.'] };
  const target = URL.parse(url);
  if (!target || target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || !target.port) {
    return { status: 'unavailable', issues: ['Незалежна перевірка працює лише з локальним переглядом оркестратора.'] };
  }
  const origin = target.origin;
  const deadline = AbortSignal.timeout(38000);
  const signal = parentSignal ? AbortSignal.any([parentSignal, deadline]) : deadline;
  const profile = await mkdtemp(join(tmpdir(), 'orcestrator-storefront-'));
  let connection;
  try {
    connection = await connectBrowser(browser, profile, origin, signal);
    const { call } = connection;
    bindLocalBrowser(connection, origin);
    const evaluate = async (fn, ...args) => {
      const result = await call('Runtime.evaluate', {
        expression: `((visible)=>(${fn})(${args.map(arg => JSON.stringify(arg)).join(',')}))(${visibleElement})`,
        returnByValue: true,
        awaitPromise: true
      });
      return result.exceptionDetails ? undefined : result.result?.value;
    };
    async function waitFor(fn, ...args) {
      for (let index = 0; index < 20; index++) {
        const value = await evaluate(fn, ...args).catch(error => {
          signal.throwIfAborted();
          if (error.message === 'Chromium: Runtime.evaluate') return null;
          throw error;
        });
        if (value) return value;
        await delay(90, undefined, { signal });
      }
    }
    const shown = selector => waitFor(selector => Boolean(visible(document.querySelector(selector))), selector);
    const click = async selector => {
      const point = await waitFor(selector => {
        const control = document.querySelector(selector);
        if (!visible(control) || control.disabled || control.getAttribute('aria-disabled') === 'true') return;
        control.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
        const rect = control.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      }, selector);
      if (!point) return false;
      for (const type of ['mousePressed', 'mouseReleased']) {
        await call('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 });
      }
      return true;
    };
    await call('Page.enable');
    await call('Network.enable');
    await call('Network.setCacheDisabled', { cacheDisabled: true });
    await call('Network.setBypassServiceWorker', { bypass: true });
    await call('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
    const hasOverflow = width => evaluate(width => document.documentElement.scrollWidth > width + 2, width);
    const issues = [], surfaces = [];
    for (const width of [1280, 390]) {
      await call('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: width === 390 });
      const navigation = await call('Page.navigate', { url });
      await waitFor(url => location.href === url && document.readyState !== 'loading', url);
      if (navigation.errorText) { issues.push(`${width}px: каталог не відкрився.`); continue; }
      await shown(models);
      const cards = await evaluate(async selector => {
        return Promise.all([...document.querySelectorAll(selector)].filter(visible).slice(0, 200).map(async card => {
          const img = card.querySelector('img');
          if (img?.loading === 'lazy') img.loading = 'eager';
          if (img) await Promise.race([img.decode().catch(() => {}), new Promise(done => setTimeout(done, 1200))]);
          return { id: card.getAttribute('data-product-model'), image: img?.currentSrc, width: img?.naturalWidth ?? 0 };
        }));
      }, models) ?? [];
      const ids = [...new Set(cards.map(card => card.id).filter(id => /^[A-Za-z0-9_.-]{1,80}$/.test(id ?? '')))];
      const hashes = new Map();
      for (const image of new Set(cards.filter(card => card.width > 0).map(card => card.image))) {
        const target = URL.parse(image ?? '');
        if (target?.origin !== origin) continue;
        try {
          const response = await fetch(target, { signal, redirect: 'error' });
          if (!response.ok || !response.headers.get('content-type')?.startsWith('image/')) { await response.body?.cancel(); continue; }
          const hash = createHash('sha256');
          for await (const chunk of response.body) hash.update(chunk);
          hashes.set(image, hash.digest('hex'));
        } catch { signal.throwIfAborted(); }
      }
      const primaryImages = new Map();
      for (const card of cards) {
        if (!primaryImages.has(card.id) && hashes.has(card.image)) primaryImages.set(card.id, hashes.get(card.image));
      }
      const uniqueImages = new Set(ids.map(id => primaryImages.get(id)).filter(Boolean));
      const broken = cards.filter(card => !card.width || !hashes.get(card.image)).length;
      if (ids.length < minimum) issues.push(`${width}px: ${ids.length} різних моделей, потрібно ${minimum}.`);
      if (uniqueImages.size < ids.length || broken) issues.push(`${width}px: ${uniqueImages.size} унікальних фото, ${broken} відсутніх або пошкоджених.`);
      if (await hasOverflow(width)) issues.push(`${width}px: каталог виходить за ширину екрана.`);
      if (output) {
        const { data } = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
        await mkdir(output, { recursive: true });
        await writeFile(join(output, `${width}.png`), Buffer.from(data, 'base64'));
      }
      if (ids.length >= 2) {
        const selector = id => `[data-product-model=${JSON.stringify(id)}]`;
        if (!await click(selector(ids[0]) + ' [data-storefront-compare]') ||
            !await click(selector(ids[1]) + ' [data-storefront-compare]') || !await click('[data-storefront-compare-open]') ||
            !await waitFor(ids => ids.every(id => [...document.querySelectorAll('[data-compared-model]')].some(el => visible(el) && el.getAttribute('data-compared-model') === id)), ids.slice(0, 2)) ||
            !await click('[data-storefront-differences]') ||
            !await waitFor(ids => {
              if (document.querySelector('[data-storefront-differences]')?.getAttribute('aria-pressed') !== 'true' ||
                  [...document.querySelectorAll('[data-comparison-same]')].some(visible)) return false;
              const first = document.querySelector(`[data-compared-model=${JSON.stringify(ids[0])}]`);
              const table = first?.closest('table, [role="table"], [role="grid"]');
              const rows = table?.querySelector(`[data-compared-model=${JSON.stringify(ids[1])}]`)
                ? table.querySelectorAll('tr, [role="row"]') : document.querySelectorAll('[data-comparison-different]');
              return [...rows].some(row => {
                if (!visible(row) || row.querySelector('[data-compared-model]')) return false;
                const cells = [...row.querySelectorAll('td, [role="cell"], [role="gridcell"]')].filter(visible).map(cell => cell.textContent.trim());
                return cells.length >= 2 && cells.every(Boolean) && new Set(cells).size >= 2;
              });
            }, ids.slice(0, 2))) {
          issues.push(`${width}px: не вдалося порівняти дві різні моделі та увімкнути режим відмінностей.`);
        } else if (await hasOverflow(width)) issues.push(`${width}px: сторінка порівняння виходить за ширину екрана.`);
        await call('Page.navigate', { url });
        if (!await click(selector(ids[0]) + ' [data-storefront-add]') || !await click('[data-storefront-cart]') ||
            !await shown(`[data-cart-model=${JSON.stringify(ids[0])}]`) || !await click('[data-storefront-checkout]') ||
            !await shown('[data-checkout-form] input:not([type="hidden"]):not(:disabled), [data-checkout-form] select:not(:disabled)')) {
          issues.push(`${width}px: не вдалося пройти від картки через кошик до форми оформлення.`);
        } else if (await hasOverflow(width)) issues.push(`${width}px: оформлення виходить за ширину екрана.`);
      }
      surfaces.push({ width, models: ids.length, uniqueImages: uniqueImages.size, brokenImages: broken });
    }
    const result = { status: issues.length ? 'failed' : 'passed', issues, surfaces };
    if (output) await writeFile(join(output, 'audit.json'), JSON.stringify(result, null, 2));
    return result;
  } catch (error) {
    parentSignal?.throwIfAborted();
    return { status: 'unavailable', issues: [deadline.aborted ? 'Незалежна браузерна перевірка не завершилась за 38 секунд.' : error.message] };
  } finally {
    await connection?.stop();
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 }).catch(() => {});
  }
}

export function createStorefrontVerifier({ projectPreview, outputRoot }) {
  return async function verifyStorefrontCandidate(run, cwd, signal) {
    const session = await projectPreview.open(run.project.uiProjectId, cwd, 'http://127.0.0.1', { candidate: true });
    if (!session.url) {
      return {
        status: session.reason ? 'unavailable' : 'failed',
        issues: [session.reason ?? 'Копія не містить зібраної вітрини з index.html, яку можна відкрити в оркестраторі.']
      };
    }
    try {
      return await auditStorefront(session.url, { signal, output: outputRoot ? join(outputRoot, run.id) : undefined });
    } finally {
      session.close();
    }
  };
}
