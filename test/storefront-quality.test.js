import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProjectPreview } from '../scripts/project-preview.js';
import { auditStorefront, storefrontBrowser } from '../scripts/storefront-browser.js';
import { generatePlanning } from '../scripts/planning-service.js';
import { storefrontAcceptanceId } from '../src/profiles/storefront/quality.js';

test('storefront domain profile is optional and can be omitted cleanly in planning', async () => {
  const rawPlan = {
    summary: 'Компактний каталог товарів',
    assumptions: ['Локальні дані'],
    risks: ['Немає бекенду'],
    tasks: [{
      id: 'catalog-ui',
      title: 'Каталог товарів',
      prompt: 'Створи інтерфейс каталогу',
      skills: ['frontend'],
      dependsOn: [],
      acceptanceCriteria: ['Картки відображаються']
    }]
  };
  const cfg = { configured: true, label: 'mock', provider: 'responses', agent: { provider: 'responses', model: 'mock' } };
  const brief = { name: 'Онлайн магазин смартфонів', description: 'Інтернет-магазин телефонів' };

  const withoutProfiles = await generatePlanning('plan', brief, cfg, async (_agent, { prompt }) => {
    assert.doesNotMatch(prompt, /СТАНДАРТ ВІТРИНИ/);
    return { text: JSON.stringify(rawPlan) };
  }, undefined, { domainProfiles: [] });
  assert.deepEqual(withoutProfiles.value.tasks.map(t => t.id), ['catalog-ui']);

  const withDefaultProfile = await generatePlanning('plan', brief, cfg, async (_agent, { prompt }) => {
    assert.match(prompt, /СТАНДАРТ ВІТРИНИ/);
    return { text: JSON.stringify(rawPlan) };
  });
  assert.deepEqual(withDefaultProfile.value.tasks.map(t => t.id), ['catalog-ui', storefrontAcceptanceId]);
});

test('a configured server preview is never launched from a candidate worktree', async t=>{
  const directory=await mkdtemp(join(tmpdir(),'storefront-preview-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  await writeFile(join(directory,'preview-commands.json'),JSON.stringify({projects:{fixture:{script:'missing.mjs'}}}));
  const preview=createProjectPreview(directory);
  t.after(()=>preview.close());
  const candidate=await preview.open('fixture',directory,'http://127.0.0.1',{candidate:true});
  assert.equal(candidate.url,null);
  assert.match(candidate.reason,/ізольоване середовище/);
});

test('independent Chromium checks real product media, comparison and checkout', {skip:!storefrontBrowser(),timeout:60000}, async t=>{
  const directory=await mkdtemp(join(tmpdir(),'storefront-browser-'));
  const preview=createProjectPreview(directory);
  t.after(async()=>{preview.close();await rm(directory,{recursive:true,force:true});});
  const ids=Array.from({length:12},(_,index)=>`model-${index}`);
  const catalog=(count,broken=false,hideAll=false)=>`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head>
    <nav><button data-storefront-compare-open>Compare</button><button data-storefront-cart>Cart</button></nav>
    <main>${ids.slice(0,count).map((id,index)=>`<article data-product-model="${id}"><img width="28" height="28" src="/${broken?'missing':id}.svg">
    <button data-storefront-compare>Compare</button><button data-storefront-add>Add</button></article>`).join('')}</main>
    <script>
      const main=document.querySelector('main'),comparison=new Set();
      let cart;
      document.addEventListener('click', event=>{
        const button=event.target;
        if(button.matches('[data-storefront-compare]')) comparison.add(button.closest('[data-product-model]').dataset.productModel);
        if(button.matches('[data-storefront-compare-open]'))main.innerHTML=[...comparison].map(id=>'<p data-compared-model="'+id+'">'+id+'</p>').join('')+
          '<table><tr data-comparison-same><td>Same</td><td>Same</td></tr><tr data-comparison-different><td>128 GB</td><td>256 GB</td></tr></table><button aria-pressed="false" data-storefront-differences>Differences</button>';
        if(button.matches('[data-storefront-differences]')){
          button.setAttribute('aria-pressed','true');main.querySelector('[data-comparison-same]').hidden=true;
          if(${hideAll})main.querySelector('[data-comparison-different]').hidden=true;
        }
        if(button.matches('[data-storefront-add]'))cart=button.closest('[data-product-model]').dataset.productModel;
        if(button.matches('[data-storefront-cart]'))main.innerHTML='<p data-cart-model="'+cart+'">'+cart+'</p><button data-storefront-checkout>Checkout</button>';
        if(button.matches('[data-storefront-checkout]'))main.innerHTML='<form data-checkout-form><label>Name<input required></label></form>';
      });
    </script></html>`;
  for(const [index,id] of ids.entries()){
    await writeFile(join(directory,id+'.svg'),`<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28"><rect width="28" height="28" fill="rgb(${index},40,210)"/></svg>`);
  }
  const index=join(directory,'index.html'),output=join(directory,'audit');
  await writeFile(index,catalog(12));
  const session=await preview.open('fixture',directory,'http://127.0.0.1',{candidate:true});
  const good=await auditStorefront(session.url,{output});
  assert.deepEqual(good.issues,[]);
  assert.equal(good.status,'passed');
  assert.deepEqual(good.surfaces.map(({width,uniqueImages})=>[width,uniqueImages]),[[1280,12],[390,12]]);
  assert.equal(JSON.parse(await readFile(join(output,'audit.json'))).status,'passed');
  await writeFile(index,catalog(12,false,true));
  const hidden=await auditStorefront(session.url);
  assert.equal(hidden.status,'failed');
  assert.match(hidden.issues.join(' '),/режим відмінностей/);
  await writeFile(index,catalog(1,true));
  const poor=await auditStorefront(session.url);
  assert.equal(poor.status,'failed');
  assert.match(poor.issues.join(' '),/1 різних моделей, потрібно 12/);
  assert.match(poor.issues.join(' '),/1 відсутніх або пошкоджених/);
});
