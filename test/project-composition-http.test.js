import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdir,mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {resolve,join,relative,isAbsolute} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {createExecutionService} from '../scripts/execution-service.js';
import {planningHandler} from '../scripts/planning-service.js';
import {seed} from '../apps/web/src/state.js';
import {composeProject,draftRoutingInput} from '../apps/web/src/project-composition.js';
import {routeDecision} from '../src/model-policy.js';

const brief={name:'Composed project',description:'Create a text file and independently review it'};
const plan=()=>({summary:'Write then verify',assumptions:[],risks:[],tasks:[
  {id:'write',title:'Write file',prompt:'Create result.txt',skills:['code'],dependsOn:[],acceptanceCriteria:['File exists']},
  {id:'review',title:'Review file',prompt:'Verify result.txt',skills:['review'],dependsOn:['write'],acceptanceCriteria:['File verified']}
]});
const makeRoute=(model,extra={})=>({id:`opencode:${model}`,backend:'opencode',model,name:model,
  availability:'ready',billing:'free_tier',freeConfirmed:true,billingBoundary:'included_only',runtimeSupported:true,
  checkedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+300000).toISOString(),
  capabilities:{jsonOutput:'prompt_validated',workspaceWrite:true},...extra});

async function fixture(t,{routingGate,routingResult,afterPlan}={}){
  const root=resolve('.orchestrator/tests');await mkdir(root,{recursive:true});const directory=await mkdtemp(join(root,'compose-'));
  const routes=[makeRoute('free-worker'),makeRoute('free-review',{capabilities:{jsonOutput:'prompt_validated',workspaceWrite:false}}),
    makeRoute('manager',{id:'codex:manager',backend:'codex',billing:'subscription_included',subscriptionConfirmed:true,includedAccessConfirmed:true,capabilities:{structuredOutput:true}})];
  const calls=[];
  const registry={snapshot:()=>({routes:routes.map(route=>({...route,decision:routeDecision(route)})),connections:[]}),scan:async()=>registry.snapshot(),requireRoute:async id=>{
    const route=routes.find(r=>r.id===id);assert.ok(route);return {...route,command:'fixture-only'};
  }};
  const service=createExecutionService({directory:join(directory,'state'),workspaces:join(directory,'workspaces'),registry,reviewRuns:false,provider:async(agent,ctx)=>{
    calls.push({model:agent.model,access:agent.access,prompt:ctx.prompt});
    if(ctx.prompt.includes('PlannerSelectionBrief:')){
      const brief=JSON.parse(ctx.prompt.split('PlannerSelectionBrief: ')[1]);
      return{text:JSON.stringify({routeId:brief.stage==='idea'?'opencode:free-review':routes[2].availability==='ready'?'codex:manager':'opencode:free-worker',reason:`Selected for this project's ${brief.stage} requirements`})};
    }
    if(ctx.prompt.includes('Операція: idea'))return{text:JSON.stringify({summary:'Accepted project concept',features:['File'],questions:[],risks:[]})};
    if(ctx.prompt.includes('Операція: plan'))return{text:JSON.stringify(plan())};
    if(ctx.prompt.includes('TaskBrief:')){
      await routingGate?.(ctx.signal);
      if(routingResult)return routingResult(agent,ctx);
      return{text:JSON.stringify({assignments:plan().tasks.map(task=>({taskId:task.id,
        routeIds:[task.id==='write'?'opencode:free-worker':'opencode:free-review'],reason:'Task capabilities match the verified free route'}))})};
    }
    if(agent.access==='workspace-write'){await writeFile(join(ctx.cwd,'result.txt'),'composed');return{text:'File created'};}
    assert.equal(await readFile(join(ctx.cwd,'result.txt'),'utf8'),'composed');return{text:'File independently verified'};
  },config:{command:'fixture-only',reasoningEffort:'high'}});
  const planning=planningHandler({resolve:options=>service.director.plannerConfig(options),managerCatalog:()=>registry.snapshot().routes,
    select:(request,signal)=>service.director.selectPlanner(request,signal)},service.director.invoke);
  const server=createServer((req,res)=>req.url.startsWith('/api/planning')?planning(req,res):service.handler(req,res));
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{service.close();for(const control of service.engine.controls.values()){await Promise.all(control.active.values());await control.recoveryWork;}
    server.closeAllConnections();server.close();const rel=relative(root,directory);assert.ok(rel&&!rel.startsWith('..')&&!isAbsolute(rel));await rm(directory,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${server.address().port}`;
  const execution=await(await fetch(base+'/api/execution/status')).json(),planner=await(await fetch(base+'/api/planning/status')).json();
  const call=async(path,method='GET',body,{signal}={})=>{const res=await fetch(base+path,{method,signal,headers:{'Content-Type':'application/json',
    'X-Execution-Token':execution.token,'X-Planning-Token':planner.token},...(body?{body:JSON.stringify(body)}:{})});return{status:res.status,value:await res.json()};};
  const workspace=seed();assert.equal((await call('/api/workspace','PUT',{revision:0,workspace})).status,200);
  async function prepared({idea=false,automatic=false,workerRouteIds}={}){
    const draft={...brief,mode:idea?'idea':'ready',priority:'economy',managerRouteId:automatic?'':'codex:manager',freeWorkers:true,maxAgentsPerTask:1,requirements:{review:'text'},workerRouteIds};
    const pin=draft.managerRouteId?{managerRouteId:draft.managerRouteId}:{};
    if(idea){const res=await call('/api/planning','POST',{kind:'idea',input:brief,...pin});assert.equal(res.status,200);draft.idea=res.value.value;draft.ideaSource=res.value.provenance;}
    const planned=await call('/api/planning','POST',{kind:'plan',input:{...brief,idea:draft.idea},...pin});assert.equal(planned.status,200);draft.plan=planned.value.value;draft.planSource=planned.value.provenance;
    afterPlan?.(routes);
    const picked=await call('/api/routing/draft','POST',draftRoutingInput(draft));assert.equal(picked.status,200,JSON.stringify(picked.value));draft.proposal=picked.value;draft.teamSource=picked.value.provenance;
    const composed=composeProject(draft,workspace.agents),next=structuredClone(workspace);next.projects.push(composed.project);next.agents.push(...composed.profiles);next.activeId=composed.project.id;
    return{draft,composed,input:{revision:1,workspace:next,routingDraftId:draft.proposal.id,routingProjectId:composed.project.id}};
  }
  return{service,registry,routes,calls,call,workspace,prepared};
}

test('one composition flow pins the manager from idea through exact free workers and starts without routing again',async t=>{
  const workerRouteIds=['opencode:free-worker','opencode:free-review'];
  const f=await fixture(t),p=await f.prepared({idea:true,workerRouteIds});
  assert.equal((await f.call('/api/workspace')).value.workspace.projects.length,f.workspace.projects.length);
  const stored=await f.call('/api/workspace','PUT',p.input);assert.equal(stored.status,200);
  const id=p.composed.project.id,routing=(await f.call(`/api/routing?projectId=${id}`)).value;
  assert.equal(routing.stale,false);assert.equal(routing.proposal.id,p.draft.proposal.id);assert.equal(routing.proposal.managerRouteId,'codex:manager');
  assert.equal((await f.call('/api/execution/preview','POST',{projectId:id})).value.proposal.id,p.draft.proposal.id);
  const started=await f.call('/api/execution/runs','POST',{projectId:id,revision:1,proposalId:p.draft.proposal.id});assert.equal(started.status,202);
  const run=f.service.engine.run(started.value.id);for(let n=0;n<1000&&['running','paused'].includes(run.status);n++)await delay(10);
  assert.equal(run.status,'completed');assert.equal(run.calls,2);assert.equal(run.project.recovery.managerRouteId,'codex:manager');
  assert.deepEqual(run.project.routingRequirements.write.allowedRouteIds,workerRouteIds);
  assert.deepEqual(f.calls.map(c=>c.model),['manager','manager','manager','free-worker','free-review']);
  assert.equal(f.calls.at(-1).access,'read-only');assert.equal(await readFile(join(run.project.workspace,'result.txt'),'utf8'),'composed');
  const replay=await f.call('/api/workspace','PUT',{...p.input,revision:2});assert.equal(replay.status,400);
});

test('automatic project-specific idea and plan models flow into exact team selection and execution',async t=>{
  const f=await fixture(t),p=await f.prepared({idea:true,automatic:true});
  assert.equal(p.draft.ideaSource.routeId,'opencode:free-review');assert.equal(p.draft.planSource.routeId,'codex:manager');
  assert.equal(p.draft.ideaSource.selection.stage,'idea');assert.equal(p.draft.planSource.selection.stage,'plan');
  assert.equal(p.draft.proposal.managerRouteId,'codex:manager');assert.equal(p.composed.project.planning.managerRouteId,'codex:manager');
  assert.equal((await f.call('/api/workspace','PUT',p.input)).status,200);
  const started=await f.call('/api/execution/runs','POST',{projectId:p.composed.project.id,revision:1,proposalId:p.draft.proposal.id});assert.equal(started.status,202);
  const run=f.service.engine.run(started.value.id);for(let n=0;n<1000&&['running','paused'].includes(run.status);n++)await delay(10);
  assert.equal(run.status,'completed');assert.equal(run.project.recovery.managerRouteId,'codex:manager');
  assert.deepEqual(f.calls.map(c=>c.model),['free-worker','free-review','free-worker','manager','manager','free-worker','free-review']);
});

test('ready description skips idea generation and a changed accepted plan cannot adopt its previous team',async t=>{
  const f=await fixture(t),p=await f.prepared();assert.equal(f.calls.length,2);
  p.input.workspace.projects.at(-1).tasks[0].prompt='Different instruction';
  const denied=await f.call('/api/workspace','PUT',p.input);assert.equal(denied.status,400);assert.match(denied.value.error,/План змінився/);
  assert.equal((await f.call('/api/workspace')).value.revision,1);assert.equal(Object.keys(f.service.store.data.routing??{}).length,0);
});

for(const change of ['unavailable','subscription'])test(`composition rechecks ${change} workers before saving and leaves no partial project`,async t=>{
  const f=await fixture(t),p=await f.prepared();
  if(change==='unavailable')f.routes[0].availability='unavailable';else Object.assign(f.routes[0],{billing:'subscription_included',subscriptionConfirmed:true,includedAccessConfirmed:true});
  const denied=await f.call('/api/workspace','PUT',p.input);assert.equal(denied.status,400);
  const current=(await f.call('/api/workspace')).value;assert.equal(current.revision,1);assert.equal(current.workspace.projects.length,f.workspace.projects.length);
  assert.equal(Object.keys(f.service.store.data.routing??{}).length,0);assert.equal(f.calls.length,2);
});

test('composition checks workspace revision again after discovery and preserves a concurrent edit',async t=>{
  const f=await fixture(t),p=await f.prepared();let entered=false,release;const gate=new Promise(r=>{release=r;});
  f.registry.scan=async()=>{entered=true;await gate;return f.registry.snapshot();};
  const saving=f.call('/api/workspace','PUT',p.input);
  try{
    for(let n=0;n<200&&!entered;n++)await delay(10);assert.equal(entered,true);
    const edited=structuredClone(f.workspace);edited.projects[0].name='Concurrent edit';assert.equal((await f.call('/api/workspace','PUT',{revision:1,workspace:edited})).status,200);
    release();const denied=await saving;assert.equal(denied.status,400);assert.match(denied.value.error,/Конфлікт/);
    const current=(await f.call('/api/workspace')).value;assert.equal(current.revision,2);assert.equal(current.workspace.projects[0].name,'Concurrent edit');
    assert.equal(current.workspace.projects.length,f.workspace.projects.length);assert.equal(Object.keys(f.service.store.data.routing??{}).length,0);
  }finally{release();await saving;}
});

test('an unavailable explicit idea manager never falls back to an automatic model',async t=>{
  const f=await fixture(t);f.routes[2].availability='unavailable';
  const status=(await f.call('/api/planning/status?managerRouteId=codex%3Amanager')).value;assert.equal(status.configured,false);
  assert.ok(status.managerRoutes.some(r=>r.id==='opencode:free-worker'));assert.ok(!status.managerRoutes.some(r=>r.id==='codex:manager'));
  const denied=await f.call('/api/planning','POST',{kind:'idea',input:brief,managerRouteId:'codex:manager'});
  assert.equal(denied.status,400);assert.match(denied.value.error,/Обраний маршрут керівника недоступний/);assert.equal(f.calls.length,0);
  for(const managerRouteId of [null,{},'',42])assert.equal((await f.call('/api/planning','POST',{kind:'idea',input:brief,managerRouteId})).status,400);
  assert.equal(f.calls.length,0);
});

test('unlimited draft team selection is cancelled on disconnect and a retry starts cleanly',async t=>{
  let entered=false,aborted=false,requests=0;
  const f=await fixture(t,{routingGate:async signal=>{
    if(++requests===1){entered=true;await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(signal.reason);},{once:true}));}
  }});
  const input={...brief,plan:plan(),managerRouteId:'codex:manager',requirements:{write:{workspaceWrite:true},review:{workspaceWrite:false}}};
  const controller=new AbortController();t.after(()=>controller.abort());
  const pending=f.call('/api/routing/draft','POST',input,{signal:controller.signal}),rejected=assert.rejects(pending,error=>error.name==='AbortError');
  for(let i=0;i<200&&!entered;i++)await delay(5);assert.equal(entered,true);controller.abort();await rejected;
  for(let i=0;i<200&&!aborted;i++)await delay(5);assert.equal(aborted,true);
  const retry=await f.call('/api/routing/draft','POST',input);assert.equal(retry.status,200);assert.equal(requests,2);
  assert.equal((await f.call('/api/workspace')).value.workspace.projects.length,f.workspace.projects.length);
});

test('the creation API automatically repairs an unknown route before saving a usable team',async t=>{
  let attempts=0;
  const f=await fixture(t,{routingResult:async(agent,ctx)=>{
    attempts++;if(attempts===2)assert.match(ctx.prompt,/RoutingRepairDiagnostics/);
    return{text:JSON.stringify({assignments:plan().tasks.map(task=>({taskId:task.id,routeIds:[attempts===1?'Codex CLI':task.id==='write'?'opencode:free-worker':'opencode:free-review'],reason:'Exact verified route'}))})};
  }});
  const p=await f.prepared();assert.equal(attempts,2);assert.equal(p.draft.proposal.provenance.repairCount,1);
  assert.equal(p.draft.proposal.provenance.attempts.length,2);assert.equal((await f.call('/api/workspace','PUT',p.input)).status,200);
  const preview=await f.call('/api/execution/preview','POST',{projectId:p.composed.project.id});assert.equal(preview.value.proposal.id,p.draft.proposal.id);
});

test('an accepted plan survives director quota exhaustion and the replacement directs the saved run',async t=>{
  const f=await fixture(t,{afterPlan:routes=>{routes[2].availability='quota_exhausted';}}),p=await f.prepared({automatic:true});
  assert.equal(p.draft.planSource.routeId,'codex:manager');assert.equal(p.draft.proposal.managerRouteId,'opencode:free-worker');
  assert.equal(p.composed.project.planning.managerRouteId,'opencode:free-worker');assert.ok(f.calls.slice(2).every(c=>c.model!=='manager'));
  assert.equal((await f.call('/api/workspace','PUT',p.input)).status,200);
  const started=await f.call('/api/execution/runs','POST',{projectId:p.composed.project.id,revision:1,proposalId:p.draft.proposal.id});assert.equal(started.status,202);
  const run=f.service.engine.run(started.value.id);for(let n=0;n<1000&&['running','paused'].includes(run.status);n++)await delay(10);
  assert.equal(run.status,'completed');assert.equal(run.project.recovery.managerRouteId,'opencode:free-worker');
  assert.deepEqual(run.project.tasks.map(t=>t.id),p.draft.plan.tasks.map(t=>t.id));
});
