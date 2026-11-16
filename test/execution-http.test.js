import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve,join,relative,isAbsolute } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createExecutionService } from '../scripts/execution-service.js';
import { seed } from '../apps/web/src/state.js';
import { applyExecutionRun } from '../apps/web/src/execution.js';

async function fixture(t,provider) {
  const base=resolve('.orchestrator/tests');await mkdir(base,{recursive:true});const dir=await mkdtemp(join(base,'execution-'));
  const trusted={id:'codex:fake-model',backend:'codex',model:'fake-model',decision:{allowed:true,reason:'Test-only verified route'},
    checkedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+300000).toISOString(),availability:'ready',
    billing:'free_tier',freeConfirmed:true,billingBoundary:'included_only',runtimeSupported:true,reasoningEfforts:['low','high'],capabilities:{structuredOutput:true,tools:true,workspaceWrite:true}};
  const registry={snapshot:()=>({routes:[trusted],connections:[]}),scan:async()=>registry.snapshot(),requireRoute:async id=>{
    assert.equal(id,trusted.id);return {...trusted,command:'trusted-executable'};
  }};
  const service=createExecutionService({directory:join(dir,'data'),workspaces:join(dir,'workspaces'),config:{model:'fake-model',command:'trusted-executable',reasoningEffort:'high'},provider,registry});
  const server=createServer(service.handler);server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{service.close();server.closeAllConnections();server.close();const rel=relative(base,dir);assert.ok(rel&&!rel.startsWith('..')&&!isAbsolute(rel));await rm(dir,{recursive:true,force:true});});
  const url=`http://127.0.0.1:${server.address().port}`;
  const status=await (await fetch(url+'/api/execution/status')).json();
  const call=async(path,method='GET',body,headers={})=>{
    const res=await fetch(url+path,{method,headers:{'X-Execution-Token':status.token,'Content-Type':'application/json',...headers},...(body?{body:JSON.stringify(body)}:{})});return {status:res.status,value:await res.json()};
  };
  const workspace=seed(),p=workspace.projects[0];p.tasks=p.tasks.slice(0,2);p.tasks.forEach(t=>{t.agentIds=['backend'];t.acceptanceCriteria=['Файл перевірено'];});
  await call('/api/workspace','PUT',{revision:0,workspace});
  return {service,call,workspace,p,dir,trusted};
}
async function until(predicate){for(let i=0;i<1500;i++){if(await predicate())return;await delay(10);}throw Error('Timed out');}

test('saved Codex reasoning reaches the executor and unsupported levels stop before model invocation',async t=>{
  const observed=[];const f=await fixture(t,async agent=>{observed.push(agent.reasoningEffort);return {text:'Verified reasoning selection'};});
  f.workspace.agents.find(a=>a.id==='backend').reasoningEffort='low';
  assert.equal((await f.call('/api/workspace','PUT',{revision:1,workspace:f.workspace})).status,200);
  const started=await f.call('/api/execution/runs','POST',{projectId:f.p.id,revision:f.p.revision,bindings:{backend:'codex-read'}});
  assert.equal(started.status,202);const id=started.value.id;
  await until(async()=>['completed','failed'].includes((await f.call(`/api/execution/runs/${id}`)).value.status));
  assert.equal((await f.call(`/api/execution/runs/${id}`)).value.status,'completed');assert.deepEqual(observed,['low','low']);
  f.workspace.agents.find(a=>a.id==='backend').reasoningEffort='unsupported';
  await f.call('/api/workspace','PUT',{revision:2,workspace:f.workspace});
  const denied=await f.call('/api/execution/runs','POST',{projectId:f.p.id,revision:f.p.revision,bindings:{backend:'codex-read'}});
  assert.equal(denied.status,400);assert.match(denied.value.error,/рівень роздумів недоступний/);assert.equal(observed.length,2);
});

test('browser execution persists snapshots, uses trusted bindings and exposes real files, usage and progress',async t=>{
  let calls=0;
  const f=await fixture(t,async(agent,ctx)=>{
    assert.equal(agent.command,'trusted-executable');assert.equal(agent.model,'fake-model');assert.equal(agent.provider,'codex');
    assert.equal(agent.ignoreUserConfig,true);assert.ok(agent.outputSchema.endsWith('execution.json'));
    assert.match(ctx.prompt,/Файл перевірено/);assert.ok(ctx.cwd.startsWith(join(f.dir,'workspaces')));
    ctx.onEvent({kind:'command_execution',message:'node --test → passed'});
    await writeFile(join(ctx.cwd,'result.txt'),`call ${++calls}`);
    await writeFile(join(ctx.cwd,'.env'),'PRIVATE');return{text:'Перевірено файл',usage:{input_tokens:3,output_tokens:4}};
  });
  assert.equal((await f.call('/api/workspace','GET',undefined,{'X-Execution-Token':'wrong'})).status,403);
  assert.equal((await f.call('/api/execution/status','GET',undefined,{Origin:'https://example.com'})).status,403);
  assert.equal((await f.call('/api/workspace','PUT',{revision:0,workspace:f.workspace})).status,400);
  const launch=await f.call('/api/execution/runs','POST',{projectId:f.p.id,revision:1,bindings:{backend:'codex-write'},command:'untrusted'});
  assert.equal(launch.status,202);const id=launch.value.id;
  await until(()=>f.service.engine.run(id).status==='completed');
  const run=(await f.call(`/api/execution/runs/${id}`)).value;
  assert.equal(run.calls,2);assert.equal(run.tasks[0].outputs[0].usage.output_tokens,4);
  assert.ok(run.events.some(e=>e.type==='agent.progress'));assert.equal(run.files.length,1);assert.equal(run.files[0].path,'result.txt');
  assert.equal((await f.call(`/api/execution/runs/${id}/file?path=result.txt`)).value.text,'call 2');
  assert.equal((await f.call(`/api/execution/runs/${id}/file?path=.env`)).status,400);
  assert.equal((await f.call(`/api/execution/runs/${id}/file?path=../data/state.json`)).status,400);
  const view=structuredClone(f.p);applyExecutionRun(view,run);assert.equal(view.tasks[0].status,'done');assert.equal(view.execution.agents[0].model,'fake-model');
  assert.equal(view.team[0],'architect');assert.equal(f.workspace.agents[0].model,'GPT-6 Astra');
  f.p.name='New draft';f.p.revision=2;await f.call('/api/workspace','PUT',{revision:1,workspace:f.workspace});
  assert.notEqual(f.service.engine.run(id).project.name,'New draft');
  const restored=createExecutionService({directory:join(f.dir,'data'),workspaces:join(f.dir,'workspaces')});
  assert.equal(restored.store.data.ui.workspace.projects[0].revision,2);assert.equal(restored.engine.run(id).status,'completed');restored.close();
});

test('browser pause drains work, resume starts dependencies and cancellation aborts a real run',async t=>{
  let finish,started=0;
  const f=await fixture(t,async(a,{signal})=>{started++;await new Promise((res,rej)=>{finish=res;signal.addEventListener('abort',()=>rej(signal.reason),{once:true});});return{text:'done'};});
  const {value:run}=await f.call('/api/execution/runs','POST',{projectId:f.p.id,revision:1,bindings:{backend:'codex-write'}});
  await until(()=>started===1);
  assert.equal((await f.call(`/api/execution/runs/${run.id}/pause`,'POST',{})).value.status,'paused');
  finish();await until(()=>f.service.engine.run(run.id).tasks[0].status==='completed');await delay(25);assert.equal(started,1);
  await f.call(`/api/execution/runs/${run.id}/resume`,'POST',{});await until(()=>started===2);
  const cancelled=await f.call(`/api/execution/runs/${run.id}/cancel`,'POST',{});assert.equal(cancelled.value.status,'cancelled');
  await until(()=>f.service.engine.controls.get(run.id).active.size===0);
  assert.equal(f.service.engine.run(run.id).tasks[1].status,'cancelled');
});

test('launch rejects missing bindings, stale plans and concurrent duplicate starts',async t=>{
  const f=await fixture(t,async()=>{await delay(30);return{text:'done'};});
  const body={projectId:f.p.id,revision:1,bindings:{backend:'codex-write'}};
  assert.equal((await f.call('/api/execution/runs','POST',{...body,bindings:{}})).status,400);
  assert.equal((await f.call('/api/execution/runs','POST',{...body,revision:0})).status,400);
  const results=await Promise.all([f.call('/api/execution/runs','POST',body),f.call('/api/execution/runs','POST',body)]);
  assert.deepEqual(results.map(r=>r.status).sort(),[202,400]);
  await until(()=>Object.values(f.service.store.data.runs).every(r=>r.status==='completed'));
});

test('connections API requires local authorization and forged project billing cannot permit a denied model',async t=>{
  let calls=0;
  const f=await fixture(t,async()=>{calls++;return{text:'must not run'};});
  f.trusted.decision={allowed:false,reason:'Не підтверджено зупинку перед додатковими списаннями'};
  assert.equal((await f.call('/api/connections','GET',undefined,{'X-Execution-Token':'wrong'})).status,403);
  assert.equal((await f.call('/api/connections/scan','POST',{}, {Origin:'https://example.com'})).status,403);
  const scan=await f.call('/api/connections/scan','POST',{});
  assert.equal(scan.status,200);assert.equal(scan.value.routes[0].decision.allowed,false);
  f.workspace.catalog={routes:[{...f.trusted,decision:{allowed:true},billing:'free_tier',billingBoundary:'included_only'}]};
  assert.equal((await f.call('/api/workspace','PUT',{revision:1,workspace:f.workspace})).status,200);
  const launch=await f.call('/api/execution/runs','POST',{projectId:f.p.id,revision:1,bindings:{backend:'codex-write'},catalog:f.workspace.catalog});
  assert.equal(launch.status,400);assert.match(launch.value.error,/списаннями/);
  assert.equal(calls,0);assert.equal(Object.keys(f.service.store.data.runs).length,0);
});

test('routing API stores AI route proposals separately and detects stale plans without launching workers',async t=>{
  let calls=0;const f=await fixture(t,async()=>{calls++;return{text:JSON.stringify({assignments:f.p.tasks.map(task=>({taskId:task.id,routeIds:['codex:fake-model'],reason:'Test fixture route only'}))})};});
  assert.equal((await f.call('/api/routing?projectId='+f.p.id,'GET',undefined,{'X-Execution-Token':'wrong'})).status,403);
  const proposal=await f.call('/api/routing','POST',{projectId:f.p.id,revision:1});
  assert.equal(proposal.status,200);assert.equal(proposal.value.assignments.length,2);assert.equal(calls,1);
  assert.equal(Object.keys(f.service.store.data.runs).length,0);
  assert.equal((await f.call('/api/routing?projectId='+f.p.id)).value.stale,false);
  f.p.tasks[0].prompt='Changed after proposal';await f.call('/api/workspace','PUT',{revision:1,workspace:f.workspace});
  assert.equal((await f.call('/api/routing?projectId='+f.p.id)).value.stale,true);
});

test('routing API refuses duplicate requests and discards a decision if the plan changes during inference',async t=>{
  let finish,started=false;const f=await fixture(t,async()=>{started=true;await new Promise(r=>{finish=r;});return{text:JSON.stringify({
    assignments:f.p.tasks.map(task=>({taskId:task.id,routeIds:['codex:fake-model'],reason:'Test fixture route only'}))})};});
  const request={projectId:f.p.id,revision:1};const pending=f.call('/api/routing','POST',request);await until(()=>started);
  assert.equal((await f.call('/api/routing','POST',request)).status,400);
  f.p.tasks[0].title='Changed during selection';await f.call('/api/workspace','PUT',{revision:1,workspace:f.workspace});finish();
  const rejected=await pending;assert.equal(rejected.status,400);assert.match(rejected.value.error,/План змінився/);
  assert.equal(f.service.store.data.routing?.[f.p.id],undefined);
});

test('execution binds saved AI worker models and the pinned recovery manager, rejecting forged or stale proposals',async t=>{
  let workers=0;
  const f=await fixture(t,async(agent,ctx)=>{
    if(ctx.prompt.includes('TaskBrief:'))return{text:JSON.stringify({assignments:f.p.tasks.map(task=>({taskId:task.id,routeIds:[f.trusted.id],reason:'Verified fixture route'}))})};
    workers++;assert.equal(agent.model,f.trusted.model);assert.equal(agent.id.startsWith('route-'),true);assert.equal(ctx.canDelegate,true);
    await writeFile(join(ctx.cwd,'verified.txt'),String(workers));return{text:'done'};
  });
  const input={projectId:f.p.id,revision:f.p.revision,managerRouteId:f.trusted.id};
  const proposal=(await f.call('/api/routing','POST',input)).value;
  assert.equal((await f.call('/api/execution/runs','POST',{...input,proposalId:'forged'})).status,400);
  assert.equal((await f.call('/api/execution/preview','POST',{projectId:f.p.id})).value.proposal.id,proposal.id);
  const launched=await f.call('/api/execution/runs','POST',{...input,proposalId:proposal.id,bindings:{backend:'forged'}});
  assert.equal(launched.status,202);const run=f.service.engine.run(launched.value.id);await until(()=>run.status==='completed');
  assert.equal(workers,2);assert.equal(run.project.routingProposalId,proposal.id);assert.equal(run.project.workspaceMode,'isolated');
  assert.equal(proposal.managerRouteId,f.trusted.id);assert.equal(run.project.recovery.managerRouteId,f.trusted.id);
  const view=structuredClone(f.p);applyExecutionRun(view,run);assert.deepEqual(view.tasks[0].agentIds,['backend']);assert.ok(view.execution.tasks[0].assignedAgentIds[0].startsWith('route-'));
  f.p.tasks[0].prompt='Changed prompt';await f.call('/api/workspace','PUT',{revision:1,workspace:f.workspace});
  assert.equal((await f.call('/api/execution/runs','POST',{...input,proposalId:proposal.id})).status,400);
});

test('launch revalidates a free-only proposal even if its route changes to an otherwise allowed subscription',async t=>{
  let workers=0;const f=await fixture(t,async(agent,ctx)=>{
    if(ctx.prompt.includes('TaskBrief:'))return{text:JSON.stringify({assignments:f.p.tasks.map(task=>({taskId:task.id,routeIds:[f.trusted.id],reason:'Free-only fixture route'}))})};
    workers++;return{text:'must not execute'};
  });
  const input={projectId:f.p.id,revision:f.p.revision};
  const result=await f.call('/api/routing','POST',{...input,requirements:Object.fromEntries(f.p.tasks.map(t=>[t.id,{billing:'free_tier',workspaceWrite:true}]))});
  assert.equal(result.status,200);
  Object.assign(f.trusted,{billing:'subscription_included',subscriptionConfirmed:true,includedAccessConfirmed:true});
  const blocked=await f.call('/api/execution/runs','POST',{...input,proposalId:result.value.id});
  assert.equal(blocked.status,400);assert.match(blocked.value.error,/Немає дозволеної/);assert.equal(workers,0);assert.equal(Object.keys(f.service.store.data.runs).length,0);
});
