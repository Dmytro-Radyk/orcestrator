import test from 'node:test';
import assert from 'node:assert/strict';
import { createDirector,routingCandidates,validateRouteAssignments,planFingerprint } from '../scripts/director-service.js';
import { routeDecision } from '../src/model-policy.js';

const plan=()=>({summary:'Test project',assumptions:[],risks:[],tasks:[{id:'a',title:'Concept',prompt:'Describe the concept',skills:['planning'],dependsOn:[],acceptanceCriteria:['Clear scope']},
  {id:'b',title:'Review',prompt:'Review the concept',skills:['review'],dependsOn:['a'],acceptanceCriteria:['Risks checked']}]});
const route=(id,change={})=>({id,backend:'opencode',connectionId:'opencode',model:id.replace(/^opencode:/,''),name:id,
  checkedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+300000).toISOString(),billing:'free_tier',freeConfirmed:true,
  billingBoundary:'included_only',availability:'ready',runtimeSupported:true,capabilities:{jsonOutput:'prompt_validated',workspaceWrite:false,tools:false},limit:{context:32000},...change});
function fixture(provider) {
  const routes=[route('opencode:opencode/a'),route('opencode:opencode/b'),route('paid:excluded',{billing:'metered'})];let scans=0;
  const registry={snapshot:()=>({routes:routes.map(r=>({...r,decision:routeDecision(r)}))}),scan:async()=>{scans++;return registry.snapshot();},
    requireRoute:async id=>{await registry.scan();const r=routes.find(r=>r.id===id);if(!routeDecision(r).allowed)throw Error('Route denied');return {...r,command:'trusted'};}};
  return {routes,registry,director:createDirector({registry,provider,preferredId:null}),scans:()=>scans};
}
const selection=()=>({assignments:[{taskId:'a',routeIds:['opencode:opencode/a'],reason:'Concept model; quality has not been measured'},
  {taskId:'b',routeIds:['opencode:opencode/a','opencode:opencode/b'],reason:'Two independent text reviewers'}]});

test('director receives only permitted task candidates and returns exact route IDs, reasons and provenance',async()=>{
  const f=fixture(async(agent,ctx)=>{assert.equal(agent.command,'trusted');assert.ok(!ctx.prompt.includes('paid:excluded'));
    assert.match(ctx.prompt,/TaskBrief/);return {text:JSON.stringify({...selection(),command:'UNTRUSTED'}),usage:{cost:0}};});
  const proposal=await f.director.propose({plan:plan(),maxAgentsPerTask:2});
  assert.equal(proposal.assignments[1].routeIds.length,2);assert.equal(proposal.provenance.routeId,'opencode:opencode/a');
  assert.equal(proposal.planFingerprint,planFingerprint(plan()));assert.equal(proposal.provenance.usage.cost,0);
  assert.equal(proposal.managerRouteId,undefined);
  assert.ok(!JSON.stringify(proposal).includes('UNTRUSTED'));assert.ok(!JSON.stringify(proposal).includes('trusted'));
  assert.ok(f.scans()>=3);
});

test('director rejects unavailable capabilities before inference and honors a pinned manager without fallback',async()=>{
  let calls=0;const f=fixture(async()=>{calls++;throw Error('must not run');});
  await assert.rejects(f.director.propose({plan:plan(),requirements:{a:{workspaceWrite:true}}}),/Немає дозволеної/);
  await assert.rejects(f.director.propose({plan:plan(),requirements:{a:{contextTokens:999999}}}),/Немає дозволеної/);
  const config=await f.director.plannerConfig({preferred:'paid:excluded'});assert.equal(config.configured,false);
  await assert.rejects(f.director.propose({plan:plan(),managerRouteId:'paid:excluded'}),/Обраний маршрут керівника недоступний/);
  assert.equal(calls,0);
});

test('director validation rejects fabricated routes, duplicates, missing tasks, empty reasons and wrong capabilities',()=>{
  const f=fixture(),p=plan(),candidates=routingCandidates(p,f.routes);
  for(const change of [v=>v.assignments.pop(),v=>v.assignments[0].routeIds=['paid:excluded'],v=>v.assignments[0].routeIds=['made-up'],
    v=>v.assignments[1].taskId='a',v=>v.assignments[0].routeIds=['opencode:opencode/a','opencode:opencode/a'],v=>v.assignments[0].reason='']) {
    const value=selection();change(value);assert.throws(()=>validateRouteAssignments(value,p,candidates));
  }
  assert.throws(()=>routingCandidates(p,f.routes,{unknown:{tools:true}}));
  assert.throws(()=>routingCandidates(p,f.routes,{a:{tools:'yes'}}));
});

test('director rechecks pricing after the model response and rejects a route whose tariff changed',async()=>{
  const f=fixture(async()=>{f.routes[0].billing='metered';return{text:JSON.stringify(selection())};});
  await assert.rejects(f.director.propose({plan:plan(),maxAgentsPerTask:2}),/поза дозволеним каталогом/);
});

test('director bounds worker fan-out instead of assigning several models to every simple task by default',async()=>{
  const f=fixture(async()=>({text:JSON.stringify(selection())}));
  await assert.rejects(f.director.propose({plan:plan()}),/ліміт кількості виконавців/);
  for(const value of [0,7,1.5,'2'])await assert.rejects(f.director.propose({plan:plan(),maxAgentsPerTask:value}),/від 1 до 6/);
});

test('worker billing requirements keep subscription directors separate from exclusively free workers',async()=>{
  const f=fixture(async(agent,ctx)=>{
    assert.equal(agent.provider,'codex');assert.ok(!ctx.prompt.includes('codex:manager'));
    return{text:JSON.stringify({assignments:selection().assignments.map(a=>({...a,routeIds:['opencode:opencode/a']}))})};
  });
  f.routes.unshift(route('codex:manager',{backend:'codex',model:'manager',billing:'subscription_included',subscriptionConfirmed:true,includedAccessConfirmed:true,capabilities:{structuredOutput:true}}));
  const proposal=await f.director.propose({plan:plan(),managerRouteId:'codex:manager',requirements:{a:{billing:'free_tier'},b:{billing:'free_tier'}}});
  assert.equal(proposal.provenance.provider,'codex');assert.ok(proposal.routes.every(r=>r.billing==='free_tier'));
  assert.equal(proposal.managerRouteId,'codex:manager');
  assert.throws(()=>routingCandidates(plan(),f.routes,{a:{billing:'metered'}}),/Некоректні/);
  const onlyFree=f.routes.filter(r=>r.backend==='opencode');assert.throws(()=>routingCandidates(plan(),onlyFree,{a:{billing:'subscription_included'}}),/Немає дозволеної/);
  const filtered=routingCandidates(plan(),f.routes,{a:{billing:'free_tier',excludeRouteIds:['opencode:opencode/a']}});
  assert.deepEqual(filtered.get('a').map(r=>r.id),['opencode:opencode/b']);
  for(const excludeRouteIds of ['bad',[null],['duplicate','duplicate']])assert.throws(()=>routingCandidates(plan(),f.routes,{a:{excludeRouteIds}}),/Некоректні/);
});
