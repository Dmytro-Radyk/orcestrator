import test from 'node:test';
import assert from 'node:assert/strict';
import { createDirector,routingCandidates,validateRouteAssignments,planFingerprint } from '../scripts/director-service.js';
import { routeDecision } from '../src/model-policy.js';
import {readFile} from 'node:fs/promises';
import {balanceWorkerCandidates} from '../scripts/worker-routing.js';

test('balanced routing splits compatible work across Codex and Gemini and preserves tool requirements',()=>{
  const tasks=[
    {id:'a',title:'Write Markdown docs',dependsOn:[]},
    {id:'b',title:'Prepare frontend component',dependsOn:[]},
    {id:'c',title:'Run database integration tests',dependsOn:['a']},
    {id:'d',title:'Додати політики, SEO та аналітику воронки',skills:['frontend'],dependsOn:['b']}
  ];
  const codex={id:'codex:fixture',backend:'codex',capabilities:{tools:true}},gemini={id:'antigravity:gemini-fixture',backend:'antigravity',model:'gemini-fixture'};
  const choices=new Map(tasks.map(({id})=>[id,[codex,gemini]]));
  const result=balanceWorkerCandidates(tasks,choices,{c:{tools:true}},{priority:'balanced',maxAgentsPerTask:1});
  assert.deepEqual(result.get('a'),[gemini]);
  assert.deepEqual(result.get('b'),[codex]);
  assert.deepEqual(result.get('c'),[codex]);
  assert.deepEqual(result.get('d'),[codex]);
  assert.equal(balanceWorkerCandidates(tasks,choices,{}, {priority:'quality',maxAgentsPerTask:1}),choices);
});

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

test('UI routing repairs a wrong model ID once using the current task candidates and records both calls',async()=>{
  let calls=0,reserved=0;const results=[];
  const f=fixture(async(agent,ctx)=>{
    calls++;
    if(calls===1){const bad=selection();bad.assignments[0].routeIds=['Codex CLI'];return{text:JSON.stringify(bad),usage:{input_tokens:10}};}
    assert.match(ctx.prompt,/RoutingRepairDiagnostics/);assert.match(ctx.prompt,/Codex CLI/);
    return{text:JSON.stringify(selection()),usage:{input_tokens:7}};
  });
  const result=await f.director.propose({plan:plan(),maxAgentsPerTask:2,repairInvalid:true},AbortSignal.timeout(3000),{onInvoke:()=>{reserved++;},onResult:r=>results.push(r)});
  assert.equal(calls,2);assert.equal(reserved,2);assert.equal(results.length,2);assert.equal(result.provenance.repairCount,1);
  assert.deepEqual(result.provenance.attempts.map(a=>a.usage.input_tokens),[10,7]);assert.equal(result.assignments[0].routeIds[0],'opencode:opencode/a');
});

test('UI routing reselects after a tariff change without weakening the original free-only requirement',async()=>{
  let calls=0;
  const f=fixture(async(agent,ctx)=>{
    calls++;
    if(calls===1){Object.assign(f.routes[0],{billing:'subscription_included',subscriptionConfirmed:true,includedAccessConfirmed:true});return{text:JSON.stringify(selection())};}
    const brief=JSON.parse(ctx.prompt.split('TaskBrief: ')[1]);assert.ok(brief.tasks.every(t=>t.candidateRouteIds.length===1&&t.candidateRouteIds[0]==='opencode:opencode/b'));
    return{text:JSON.stringify({assignments:brief.tasks.map(t=>({taskId:t.id,routeIds:['opencode:opencode/b'],reason:'A permitted free replacement'}))})};
  });
  const result=await f.director.propose({plan:plan(),maxAgentsPerTask:2,repairInvalid:true,requirements:{a:{billing:'free_tier'},b:{billing:'free_tier'}}});
  assert.equal(calls,2);assert.ok(result.routes.every(r=>r.billing==='free_tier'));assert.equal(result.provenance.repairCount,1);
});

test('UI routing repair is bounded and never accepts repeated invented IDs',async()=>{
  let calls=0;const f=fixture(async()=>{calls++;const value=selection();value.assignments[0].routeIds=['paid:excluded'];return{text:JSON.stringify(value)};});
  await assert.rejects(f.director.propose({plan:plan(),maxAgentsPerTask:2,repairInvalid:true}),error=>error.code==='ROUTING_INVALID_RESPONSE'&&error.details.taskId==='a');
  assert.equal(calls,2);
});

test('Codex routing uses a strict schema containing exact permitted route IDs and task IDs',async()=>{
  const f=fixture(async agent=>{
    const schema=JSON.parse(await readFile(agent.outputSchema,'utf8')),item=schema.properties.assignments.items;
    assert.deepEqual(item.properties.taskId.enum,['a','b']);assert.ok(item.properties.routeIds.items.enum.includes('opencode:opencode/a'));
    assert.ok(!item.properties.routeIds.items.enum.includes('paid:excluded'));assert.equal(item.properties.routeIds.maxItems,2);
    return{text:JSON.stringify(selection())};
  });
  f.routes.unshift(route('codex:manager',{backend:'codex',model:'manager',capabilities:{structuredOutput:true}}));
  await f.director.propose({plan:plan(),maxAgentsPerTask:2,managerRouteId:'codex:manager'});
});

test('an automatic director can be reselected when its quota is exhausted; a manual pin stays blocked',async()=>{
  let calls=0,reserved=0;
  const f=fixture(async(agent,ctx)=>{
    calls++;assert.notEqual(agent.model,'exhausted');
    if(ctx.prompt.includes('PlannerSelectionBrief:'))return{text:JSON.stringify({routeId:'opencode:opencode/b',reason:'Available project planner after quota exhaustion'}),usage:{input_tokens:3}};
    assert.equal(agent.model,'opencode/b');return{text:JSON.stringify(selection()),usage:{input_tokens:4}};
  });
  f.routes.unshift(route('codex:exhausted',{backend:'codex',model:'exhausted',availability:'quota_exhausted'}));
  const input={plan:plan(),managerRouteId:'codex:exhausted',maxAgentsPerTask:2};
  await assert.rejects(f.director.propose(input),/Обраний маршрут/);assert.equal(calls,0);
  const result=await f.director.propose({...input,allowManagerFallback:true},undefined,{onInvoke:()=>{reserved++;}});
  assert.equal(calls,2);assert.equal(reserved,2);assert.equal(result.managerRouteId,'opencode:opencode/b');
  assert.equal(result.provenance.selection.replacedRouteId,'codex:exhausted');assert.equal(result.provenance.attempts.length,2);
});
