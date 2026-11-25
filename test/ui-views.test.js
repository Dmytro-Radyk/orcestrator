import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { seed } from '../apps/web/src/state.js';
import { badge, button, h, icon } from '../apps/web/src/ui/primitives.js';
import { renderHeader, renderOverview, renderSearchResultsHtml, renderSidebar } from '../apps/web/src/ui/shell-and-overview.js';
import { renderConfigForm, renderPlanSection, renderProjectPage } from '../apps/web/src/ui/project-views.js';

const webRoot = fileURLToPath(new URL('../apps/web/', import.meta.url));

test('index.html stylesheets, scripts and CSS @import manifests resolve to non-empty files', async () => {
  const html = await readFile(join(webRoot, 'index.html'), 'utf8');
  const refs = [...html.matchAll(/(?:href|src)="(\/[^"]+)"/g)].map(m => m[1]);
  assert.ok(refs.length >= 10);
  for (const ref of refs) {
    const info = await stat(join(webRoot, ref));
    assert.ok(info.isFile() && info.size > 0, `Expected non-empty asset for ${ref}`);
  }
  for (const manifest of ['src/styles.css', 'src/cosmic.css', 'src/solar-system.css']) {
    const manifestPath = join(webRoot, manifest);
    const css = await readFile(manifestPath, 'utf8');
    const imports = [...css.matchAll(/@import\s+"([^"]+)"/g)].map(m => m[1]);
    assert.ok(imports.length >= 2, `Expected @import entries in ${manifest}`);
    for (const rel of imports) {
      const target = join(dirname(manifestPath), rel);
      const info = await stat(target);
      assert.ok(info.isFile() && info.size > 50, `Expected non-empty split stylesheet ${rel}`);
    }
  }
});

test('extracted UI view modules render shell, project views and escape untrusted labels', () => {
  assert.equal(h('<img src=x onerror=1>'), '&lt;img src=x onerror=1&gt;');
  assert.match(icon('split'), /<svg /);
  assert.match(icon('__proto__'), /<svg /);
  assert.match(button('save', 'Зберегти', 'check'), /data-action="save"/);
  assert.match(badge('running'), /badge running/);

  const state = seed();
  state.projects[0].name = 'Alpha <script>alert(1)</script>';
  const active = state.projects[0];
  const resolveAgent = id => state.agents.find(a => a.id === id);

  const sidebarHtml = renderSidebar({ state, route: 'project', navOpen: true, executionReady: true });
  assert.doesNotMatch(sidebarHtml, /<script>/);
  assert.match(sidebarHtml, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);

  const headerHtml = renderHeader({ route: 'project', projectName: active.name, navOpen: false, executionReady: true });
  assert.doesNotMatch(headerHtml, /<script>/);

  const overviewHtml = renderOverview({ state, activeProject: active, resolveAgent });
  assert.match(overviewHtml, /MISSION CONTROL/);

  const planHtml = renderPlanSection(active, {
    view: 'graph',
    selected: active.tasks[0].id,
    stateAgents: state.agents,
    execution: { routingState: () => null },
    resolveAgent,
    isLocked: false
  });
  assert.match(planHtml, /data-live-key="task-drawer"/);

  const configHtml = renderConfigForm(active, true);
  assert.match(configHtml, /maxlength="12000"/);
  assert.match(configHtml, /disabled/);

  const projectHtml = renderProjectPage(active, {
    tab: 'plan',
    view: 'list',
    selected: null,
    stateAgents: state.agents,
    execution: { ready: true, routingState: () => null, streamState: () => null },
    projectChat: { panel: () => '' },
    verifyingHost: new Set(),
    resumingCancelled: new Set(),
    resolveAgent,
    isLocked: false
  });
  assert.match(projectHtml, /role="tablist"/);
  assert.match(renderSearchResultsHtml(state, 'alpha'), /search-result/);
});
