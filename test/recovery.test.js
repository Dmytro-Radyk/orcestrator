import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdir,mkdtemp,writeFile,readFile,access,rm} from 'node:fs/promises';
import {resolve,relative,isAbsolute,join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {createExecutionService} from '../scripts/execution-service.js';
import {seed} from '../apps/web/src/state.js';
import {readEventStream,applyRunFrame} from '../apps/web/src/event-stream.js';
import {applyExecutionRun} from '../apps/web/src/execution.js';

async function until(fn){for(let n=0;n<2500;n++){if(await fn())return;await delay(10);}throw Error('Recovery timed out');}
const route=(model,backend='opencode')=>({id:`${backend}:${model}`,connectionId:backend,backend,model,name:model,
  checkedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+300000).toISOString(),availability:'ready',billing:'free_tier',freeConfirmed:true,billingBoundary:'included_only',runtimeSupported:true,
  capabilities:{workspaceWrite:backend==='opencode',structuredOutput:true,tools:false},decision:{allowed:true,reason:'Fixture only'}});
async function fixture(t,{policy={enabled:true,maxAttempts:2},maxCalls=8,failCode='MODEL_ACCESS_BLOCKED',alwaysFail=false,failedModels=['opencode/bad'],manager,modify,worker,routingManagerRouteId,hostPolicy}={}){
  const owned=resolve('.orchestrator/tests');await mkdir(owned,{recursive:true});const dir=await mkdtemp(join(owned,'recovery-'));
  const routes=[route('manager','codex'),route('opencode/bad'),route('opencode/good'),route('opencode/check')];
  let managerCalls=0;const invocations=[],managerModels=[];
  const registry={snapshot:()=>({routes,connections:[]}),scan:async()=>registry.snapshot(),requireRoute:async id=>{
    const found=routes.find(r=>r.id===id);assert.ok(found,id);return {...found,command:'fixture-executable'};
  }};
  const service=createExecutionService({directory:join(dir,'data'),workspaces:join(dir,'workspaces'),registry,provider:async(agent,ctx)=>{
    if(ctx.prompt.includes('TaskBrief:')){
      managerCalls++;const brief=JSON.parse(ctx.prompt.split('TaskBrief: ')[1]);
      managerModels.push(agent.model);
      if(routingManagerRouteId&&brief.tasks.length===3)return{text:JSON.stringify({assignments:brief.tasks.map(task=>({taskId:task.id,
        routeIds:[`opencode:opencode/${task.id==='a'?'good':task.id==='b'?'bad':'check'}`],reason:'Initial fixture assignment with explicitly selected manager'}))})};
      assert.ok(brief.tasks.every(t=>!t.candidateRouteIds.includes('opencode:opencode/bad')));
      if(manager)return manager(agent,ctx,brief);
      return{text:JSON.stringify({assignments:brief.tasks.map(task=>({taskId:task.id,routeIds:[task.candidateRouteIds.find(id=>id.startsWith('opencode:'))],reason:'Alternate free route after the recorded failure'}))}),usage:{cost:0,input_tokens:2,output_tokens:3}};
    }
    const id=/Task: ([^\n]+)/.exec(ctx.prompt)[1];invocations.push({id,model:agent.model,cwd:ctx.cwd});
    if(worker){const handled=await worker(agent,ctx,id);if(handled!==undefined)return handled;}
    if(id==='accepted'){await writeFile(join(ctx.cwd,'accepted.txt'),'accepted once');return{text:'accepted'};}
    if(id==='failed'&&(failedModels.includes(agent.model)||alwaysFail)){
      await writeFile(join(ctx.cwd,'partial.txt'),'unaccepted');throw Object.assign(Error('Fixture model failed'),{code:failCode,decisionCode:'tools_not_supported',routeId:`${agent.provider}:${agent.model}`});
    }
    if(id==='failed'){assert.equal(await readFile(join(ctx.cwd,'accepted.txt'),'utf8'),'accepted once');await assert.rejects(access(join(ctx.cwd,'partial.txt')));await writeFile(join(ctx.cwd,'recovered.txt'),'recovered');return{text:'recovered',usage:{cost:0}};}
    assert.equal(id,'downstream');assert.equal(await readFile(join(ctx.cwd,'recovered.txt'),'utf8'),'recovered');return{text:'verified',usage:{cost:0}};
  },config:{command:'fixture-executable',reasoningEffort:'low'}});
  const server=createServer(service.handler);server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{service.close();for(const c of service.engine.controls.values()){await Promise.all(c.active.values());await c.recoveryWork;}server.closeAllConnections();server.close();
    const rel=relative(owned,dir);assert.ok(rel&&!rel.startsWith('..')&&!isAbsolute(rel));await rm(dir,{recursive:true,force:true});});
  const url=`http://127.0.0.1:${server.address().port}`,status=await(await fetch(url+'/api/execution/status')).json(),token=status.token;
  assert.deepEqual(status.capabilities.recovery,{automatic:true,defaultAttempts:2,maxAttempts:3});
  const call=async(path,method='GET',body)=>{const response=await fetch(url+path,{method,headers:{'X-Execution-Token':token,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});return{status:response.status,value:await response.json()};};
  const workspace=seed(),p=workspace.projects[0];workspace.projects=[p];p.recovery=policy;p.maxCalls=maxCalls;
  if(hostPolicy)await writeFile(join(dir,'data','host-verification.json'),JSON.stringify({projects:{[p.id]:hostPolicy}}));
  p.tasks=[{id:'a',title:'accepted',prompt:'Preserve this accepted file',agentIds:['architect'],dependsOn:[]},
    {id:'b',title:'failed',prompt:'Create recovered.txt',agentIds:['backend'],dependsOn:['a']},
    {id:'c',title:'downstream',prompt:'Verify files',agentIds:['reviewer'],dependsOn:['b']}];modify?.(p);
  if(routingManagerRouteId)p.tasks.forEach(task=>{task.acceptanceCriteria=['Required fixture file verified'];});
  assert.equal((await call('/api/workspace','PUT',{revision:0,workspace})).status,200);
  const bindings={architect:'opencode:opencode/good#write',backend:'opencode:opencode/bad#write',reviewer:'opencode:opencode/check#read'};
  let proposalId;
  if(routingManagerRouteId){
    const proposal=await call('/api/routing','POST',{projectId:p.id,revision:p.revision,managerRouteId:routingManagerRouteId,
      requirements:{a:{workspaceWrite:true},b:{workspaceWrite:true},c:{workspaceWrite:false}}});
    assert.equal(proposal.status,200,JSON.stringify(proposal.value));proposalId=proposal.value.id;
  }
  const launch=await call('/api/execution/runs','POST',{projectId:p.id,revision:p.revision,bindings,...(proposalId?{proposalId}:{})});assert.equal(launch.status,202,JSON.stringify(launch.value));
  const run=service.engine.run(launch.value.id);
  return {service,run,call,url,token,p,workspace,dir,invocations,managerModels,routes,managerCalls:()=>managerCalls,settle:()=>until(()=>!['running','paused'].includes(run.status)&&!service.engine.controls.get(run.id).recovering)};
}

for(const override of [false,true])test(`pinned recovery manager follows ${override?'the explicit project override':'the saved routing selection'} through a real failed task`,async t=>{
  const routingManagerRouteId='opencode:opencode/check',expected=override?'manager':'opencode/check';
  const f=await fixture(t,{routingManagerRouteId,policy:{enabled:true,maxAttempts:2,...(override?{managerRouteId:'codex:manager'}:{})}});
  await f.settle();assert.equal(f.run.status,'completed');assert.equal(f.run.calls,5);
  assert.deepEqual(f.managerModels,['opencode/check',expected]);
  assert.equal(f.run.project.recovery.managerRouteId,override?'codex:manager':routingManagerRouteId);
  assert.equal(f.run.recovery.rounds[0].manager.model,expected);
  assert.equal(f.invocations.filter(i=>i.id==='accepted').length,1);
  assert.equal(await readFile(join(f.run.project.workspace,'recovered.txt'),'utf8'),'recovered');
});

test('pinned recovery manager becoming unavailable stops before any fallback director or replacement worker call',async t=>{
  let failReady=false,releaseFailure;const gate=new Promise(resolve=>{releaseFailure=resolve;});
  const routingManagerRouteId='opencode:opencode/check';
  const f=await fixture(t,{routingManagerRouteId,worker:async(agent,ctx,id)=>{
    if(id==='failed'&&agent.model==='opencode/bad'){failReady=true;await gate;}
  }});
  try{
    await until(()=>failReady);f.routes.find(r=>r.id===routingManagerRouteId).availability='unavailable';releaseFailure();await f.settle();
    assert.equal(f.run.status,'failed');assert.equal(f.run.calls,2);assert.equal(f.run.recovery.rounds.length,1);
    assert.match(f.run.recovery.reason,/Обраний маршрут керівника недоступний/);
    assert.deepEqual(f.managerModels,['opencode/check']);assert.equal(f.managerCalls(),1);
    assert.equal(f.invocations.filter(i=>i.id==='failed').length,1);assert.equal(f.invocations.some(i=>i.id==='downstream'),false);
    assert.equal(await readFile(join(f.run.project.workspace,'accepted.txt'),'utf8'),'accepted once');
    await assert.rejects(access(join(f.run.project.workspace,'recovered.txt')));
  }finally{releaseFailure();}
});

test('automatic recovery keeps the same run, accepted results and dependency graph; SSE carries the new assignment through to final completion',async t=>{
  const f=await fixture(t),response=await fetch(`${f.url}/api/execution/runs/${f.run.id}/events`,{headers:{'X-Execution-Token':f.token},signal:AbortSignal.timeout(30000)});
  let state,applied=false,finished=false;
  for await(const frame of readEventStream(response.body))if(['snapshot','change','finished'].includes(frame.event)){
    state=applyRunFrame(state,frame).run;if(frame.event==='change'&&JSON.parse(frame.data).event.type==='recovery.applied')applied=true;if(frame.event==='finished')finished=true;
  }
  await f.settle();assert.equal(f.run.status,'completed');assert.equal(f.run.calls,5);assert.equal(f.managerCalls(),1);assert.equal(applied,true);assert.equal(finished,true);
  assert.equal(f.invocations.filter(i=>i.id==='accepted').length,1);assert.equal(f.invocations.filter(i=>i.id==='failed').length,2);assert.equal(f.invocations.filter(i=>i.id==='downstream').length,1);
  assert.equal(f.run.tasks[1].history[0].status,'blocked');assert.equal(f.run.tasks[1].recoveryAttempts,1);assert.equal(f.run.tasks[1].history[0].failure.routeId,'opencode:opencode/bad');
  assert.equal(await readFile(join(f.run.project.workspace,'accepted.txt'),'utf8'),'accepted once');await assert.rejects(access(join(f.run.project.workspace,'partial.txt')));
  assert.equal(await readFile(join(f.run.tasks[1].history[0].workspace.path,'partial.txt'),'utf8'),'unaccepted');
  assert.equal(state.tasks[1].status,'completed');assert.ok(state.project.agents.some(a=>a.id===state.tasks[1].assignedAgentIds[0]));
  assert.equal(f.run.recovery.rounds[0].proposal.provenance.provider,'codex');assert.deepEqual(f.run.recovery.rounds[0].taskIds,['b']);
  assert.equal(f.service.store.data.ui.workspace.projects[0].revision,f.p.revision);assert.deepEqual(f.service.store.data.ui.workspace.projects[0].tasks[1].agentIds,['backend']);
});

test('persisting live UI status while recovery is thinking preserves the accepted plan and permits recovery',async t=>{
  let entered=false,release;const gate=new Promise(r=>{release=r;});
  const f=await fixture(t,{manager:async()=>{entered=true;await gate;return{text:JSON.stringify({assignments:[{taskId:'b',routeIds:['opencode:opencode/good'],reason:'Replacement after failure'}]})};}});
  try{
    await until(()=>entered);
    const before=structuredClone(f.p.tasks),live=(await f.call(`/api/execution/runs/${f.run.id}`)).value;
    applyExecutionRun(f.p,live);
    assert.deepEqual(f.p.tasks.map(({id,title,prompt,skills,dependsOn,acceptanceCriteria,agentIds})=>({id,title,prompt,skills,dependsOn,acceptanceCriteria,agentIds})),
      before.map(({id,title,prompt,skills,dependsOn,acceptanceCriteria,agentIds})=>({id,title,prompt,skills,dependsOn,acceptanceCriteria,agentIds})));
    assert.equal((await f.call('/api/workspace','PUT',{revision:1,workspace:f.workspace})).status,200);
    release();await f.settle();assert.equal(f.run.status,'completed');assert.equal(f.run.recovery.status,'applied');
    assert.equal(f.invocations.filter(i=>i.id==='accepted').length,1);assert.equal(f.run.calls,5);
  }finally{release();}
});

test('viewing runtime tasks never replaces editable instructions, criteria, dependencies or skills',()=>{
  const project={revision:3,tasks:[{id:'t',title:'Current title',prompt:'Edited prompt',skills:['review'],dependsOn:[],acceptanceCriteria:['Edited criterion'],agentIds:['profile']} ]};
  const before=structuredClone(project.tasks[0]);
  const run={id:'r',status:'running',calls:1,project:{uiRevision:2,agents:[]},events:[],tasks:[{id:'t',title:'Old title',prompt:'Frozen prompt',skills:['code'],dependsOn:['old'],acceptanceCriteria:['Old criterion'],agentIds:['runtime'],status:'running'}]};
  applyExecutionRun(project,run);
  for(const key of Object.keys(before))assert.deepEqual(project.tasks[0][key],before[key],key);
  assert.equal(project.tasks[0].status,'running');assert.equal(project.execution.tasks[0].prompt,'Frozen prompt');
});

test('recovery attempts are bounded and failed candidates never reach the accepted workspace',async t=>{
  const f=await fixture(t,{policy:{enabled:true,maxAttempts:1},alwaysFail:true});await f.settle();
  assert.equal(f.run.status,'failed');assert.equal(f.run.recovery.rounds.length,1);assert.equal(f.managerCalls(),1);assert.equal(f.run.calls,4);
  assert.match(f.run.recovery.reason,/Ліміт спроб/);assert.equal(f.invocations.filter(i=>i.id==='failed').length,2);await assert.rejects(access(join(f.run.project.workspace,'partial.txt')));
});

test('successive recovery rounds accumulate failed routes and keep the same accepted results and total call budget',async t=>{
  const f=await fixture(t,{failedModels:['opencode/bad','opencode/good']});await f.settle();
  assert.equal(f.run.status,'completed');assert.equal(f.managerCalls(),2);assert.equal(f.run.calls,7);assert.equal(f.run.tasks[1].history.length,2);
  assert.deepEqual(f.run.recovery.rounds[1].excludedRouteIds.b,['opencode:opencode/bad','opencode:opencode/good']);
  assert.equal(f.invocations.filter(i=>i.id==='accepted').length,1);assert.equal(f.run.tasks[1].outputs[0].agentId,f.run.tasks[1].assignedAgentIds[0]);
});

test('a depleted shared call budget stops before an extra director invocation',async t=>{
  const f=await fixture(t,{maxCalls:2});await f.settle();assert.equal(f.run.status,'failed');assert.equal(f.managerCalls(),0);assert.equal(f.run.calls,2);assert.match(f.run.recovery.reason,/Недостатньо викликів/);
});

for(const failCode of ['WORKSPACE_CONFLICT','CHECKS_BLOCKED','EXECUTION_SCHEMA_INVALID'])test(`${failCode} requires intervention rather than model rerouting`,async t=>{
  const f=await fixture(t,{failCode});await f.settle();assert.equal(f.run.status,'failed');assert.equal(f.managerCalls(),0);assert.equal(f.run.recovery.rounds.length,0);
});

test('an excluded-route proposal is rejected without a replacement worker invocation',async t=>{
  const f=await fixture(t,{manager:async()=>({text:JSON.stringify({assignments:[{taskId:'b',routeIds:['opencode:opencode/bad'],reason:'Invalid same route'}]})})});await f.settle();
  assert.equal(f.run.status,'failed');assert.equal(f.run.calls,3);assert.equal(f.managerCalls(),1);assert.equal(f.invocations.filter(i=>i.id==='failed').length,1);assert.equal(f.run.recovery.rounds[0].status,'failed');
});

test('manual recovery uses the same frozen plan and refuses duplicate or completed requests',async t=>{
  const f=await fixture(t,{policy:{enabled:false,maxAttempts:2}});await f.settle();assert.equal(f.managerCalls(),0);
  assert.equal((await f.call(`/api/execution/runs/${f.run.id}/recover`,'POST',{})).status,202);
  assert.equal((await f.call(`/api/execution/runs/${f.run.id}/recover`,'POST',{})).status,400);
  await f.settle();assert.equal(f.run.status,'completed');assert.equal(f.managerCalls(),1);assert.equal((await f.call(`/api/execution/runs/${f.run.id}/recover`,'POST',{})).status,400);
});

test('pause during recovery holds replacement work until resume',async t=>{
  let entered=false,release;const gate=new Promise(r=>{release=r;});
  const f=await fixture(t,{manager:async()=>{entered=true;await gate;return{text:JSON.stringify({assignments:[{taskId:'b',routeIds:['opencode:opencode/good'],reason:'New route'}]})};}});
  await until(()=>entered);await f.call(`/api/execution/runs/${f.run.id}/pause`,'POST',{});release();await until(()=>f.run.recovery.status==='applied');
  assert.equal(f.run.status,'paused');assert.equal(f.invocations.filter(i=>i.id==='failed').length,1);
  await f.call(`/api/execution/runs/${f.run.id}/resume`,'POST',{});await f.settle();assert.equal(f.run.status,'completed');
});

test('cancellation aborts an active recovery director and never starts a replacement worker',async t=>{
  let entered=false;const f=await fixture(t,{manager:async(a,ctx)=>{entered=true;await new Promise((resolve,reject)=>ctx.signal.addEventListener('abort',()=>reject(ctx.signal.reason),{once:true}));}});
  await until(()=>entered);const cancelled=await f.call(`/api/execution/runs/${f.run.id}/cancel`,'POST',{});assert.equal(cancelled.value.status,'cancelled');assert.equal(cancelled.value.draining,true);
  await f.settle();assert.equal(f.run.recovery.status,'cancelled');assert.equal(f.invocations.filter(i=>i.id==='failed').length,1);
});

test('a plan changed during director inference discards the proposal and keeps accepted files',async t=>{
  let entered=false,release;const gate=new Promise(r=>{release=r;});
  const f=await fixture(t,{manager:async()=>{entered=true;await gate;return{text:JSON.stringify({assignments:[{taskId:'b',routeIds:['opencode:opencode/good'],reason:'New route'}]})};}});
  await until(()=>entered);f.p.revision++;await f.call('/api/workspace','PUT',{revision:1,workspace:f.workspace});release();await f.settle();
  assert.equal(f.run.status,'failed');assert.match(f.run.recovery.reason,/План змінився/);assert.equal(f.invocations.filter(i=>i.id==='failed').length,1);
  assert.equal((await f.call(`/api/execution/runs/${f.run.id}/recover`,'POST',{})).status,400);
});

test('editing a task without bumping the UI revision still stops recovery and identifies the changed field',async t=>{
  let entered=false,release;const gate=new Promise(r=>{release=r;});
  const f=await fixture(t,{manager:async()=>{entered=true;await gate;return{text:JSON.stringify({assignments:[{taskId:'b',routeIds:['opencode:opencode/good'],reason:'Replacement'}]})};}});
  try{
    await until(()=>entered);f.p.tasks[1].prompt='Changed instruction that must not execute under the old run';
    assert.equal((await f.call('/api/workspace','PUT',{revision:1,workspace:f.workspace})).status,200);
    release();await f.settle();assert.equal(f.run.status,'failed');assert.match(f.run.recovery.reason,/задача «failed», інструкція/);
    assert.equal(f.invocations.filter(i=>i.id==='failed').length,1);
  }finally{release();}
});

test('recovering a failed child preserves its completed siblings and resumes parent synthesis without duplicating children',async t=>{
  const f=await fixture(t,{modify:p=>{p.tasks=[{id:'parent',title:'parent',prompt:'Delegate one child then synthesize',agentIds:['backend'],dependsOn:[]}];},worker:async(a,ctx,id)=>{
    if(id==='parent'&&ctx.canDelegate)return{text:'delegate',delegation:[{title:'failed',prompt:'Create recovered.txt',skills:[]},{title:'accepted',prompt:'Create accepted.txt',skills:[]}]};
    if(id==='parent'){assert.equal(await readFile(join(ctx.cwd,'recovered.txt'),'utf8'),'recovered');await writeFile(join(ctx.cwd,'parent.txt'),'synthesized');return{text:'synthesis'};}
    if(id==='failed'&&a.model!=='opencode/bad'){await writeFile(join(ctx.cwd,'recovered.txt'),'recovered');return{text:'child complete'};}
  }});await f.settle();assert.equal(f.run.status,'completed');assert.equal(f.run.tasks.length,3);assert.equal(f.run.calls,6);assert.equal(f.invocations.filter(i=>i.id==='accepted').length,1);
  assert.equal(f.run.tasks.find(t=>t.parentId).history.length,1);assert.equal(await readFile(join(f.run.project.workspace,'parent.txt'),'utf8'),'synthesized');
});

test('cancelled tasks and their dependants stay cancelled or blocked when an unrelated task recovers',async t=>{
  let entered=false;const f=await fixture(t,{maxCalls:10,modify:p=>{p.tasks.push({id:'q',title:'cancelled',prompt:'Wait until cancelled',agentIds:['architect'],dependsOn:[]},
    {id:'z',title:'cancelled-dependent',prompt:'Must not run',agentIds:['architect'],dependsOn:['q']});},worker:async(a,ctx,id)=>{
      if(id==='cancelled'){entered=true;await new Promise((resolve,reject)=>ctx.signal.addEventListener('abort',()=>reject(ctx.signal.reason),{once:true}));}
    }});
  await until(()=>entered);await f.call(`/api/execution/runs/${f.run.id}/cancel-task`,'POST',{taskId:'q'});await f.settle();
  assert.equal(f.run.tasks.find(t=>t.id==='q').status,'cancelled');assert.equal(f.run.tasks.find(t=>t.id==='z').status,'blocked');assert.equal(f.run.tasks.find(t=>t.id==='b').status,'completed');
  assert.equal(f.invocations.some(i=>i.id==='cancelled-dependent'),false);
});

test('external accepted-workspace changes during planning discard recovery without overwriting them',async t=>{
  let entered=false,release;const gate=new Promise(r=>{release=r;});
  const f=await fixture(t,{manager:async()=>{entered=true;await gate;return{text:JSON.stringify({assignments:[{taskId:'b',routeIds:['opencode:opencode/good'],reason:'New route'}]})};}});
  await until(()=>entered);await writeFile(join(f.run.project.workspace,'accepted.txt'),'external edit');release();await f.settle();
  assert.equal(f.run.status,'failed');assert.match(f.run.recovery.reason,/сторонні зміни/);assert.equal(await readFile(join(f.run.project.workspace,'accepted.txt'),'utf8'),'external edit');
  assert.equal(f.invocations.filter(i=>i.id==='failed').length,1);
});

test('manual continuation after exhausted recovery preserves accepted files, call budget and recovery history',async t=>{
  let continuing=false,entered=false,release;const gate=new Promise(r=>{release=r;});
  const f=await fixture(t,{policy:{enabled:true,maxAttempts:1},failCode:'AGENT_TIMEOUT',alwaysFail:true,worker:async(a,ctx,id)=>{
    if(continuing&&id==='failed'){
      entered=true;await gate;assert.equal(await readFile(join(ctx.cwd,'accepted.txt'),'utf8'),'accepted once');
      await assert.rejects(access(join(ctx.cwd,'partial.txt')));await writeFile(join(ctx.cwd,'recovered.txt'),'recovered');return{text:'continued'};
    }
  }});
  try{
    await f.settle();assert.equal(f.run.status,'failed');assert.equal(f.run.calls,4);assert.equal(f.run.recovery.rounds.length,1);
    const originalCompleted=f.run.tasks[0],managerCalls=f.managerCalls();f.run.project.limits.timeoutMs=240000;
    f.service.engine.controls.delete(f.run.id); // Same persisted state after a server restart.
    // Old persisted runs used DOMException's numeric timeout code.
    f.run.tasks[1].failure={...f.run.tasks[1].failure,code:23,message:'The operation was aborted due to timeout'};
    assert.equal((await f.call(`/api/execution/runs/${f.run.id}`)).value.canContinue,true);
    continuing=true;const response=await f.call(`/api/execution/runs/${f.run.id}/continue`,'POST',{});assert.equal(response.status,202,JSON.stringify(response.value));
    await until(()=>entered);assert.equal((await f.call(`/api/execution/runs/${f.run.id}/continue`,'POST',{})).status,400);
    assert.equal(f.run.project.limits.timeoutMs,null);assert.equal(f.run.tasks[0].result,originalCompleted.result);
    release();await f.settle();assert.equal(f.run.status,'completed');assert.equal(f.run.calls,6);assert.equal(f.managerCalls(),managerCalls);
    assert.equal(f.invocations.filter(i=>i.id==='accepted').length,1);assert.equal(f.run.recovery.rounds.length,1);
    assert.equal(f.run.tasks[1].history.at(-1).reason,'manual-timeout-continuation');
    assert.ok(f.run.events.some(e=>e.type==='run.continued'&&e.previousTimeoutMs===240000&&e.timeoutMs===null));
    assert.equal((await f.call(`/api/execution/runs/${f.run.id}/continue`,'POST',{})).status,400);
  }finally{release();}
});

for(const reason of ['plan','workspace','budget','not-timeout','active-run'])test(`timeout continuation refuses ${reason} changes`,async t=>{
  const f=await fixture(t,{policy:{enabled:false,maxAttempts:1},failCode:'AGENT_TIMEOUT'});await f.settle();
  if(reason==='plan'){f.p.tasks[1].prompt='Different instruction';await f.call('/api/workspace','PUT',{revision:1,workspace:f.workspace});}
  if(reason==='workspace')await writeFile(join(f.run.project.workspace,'accepted.txt'),'external edit');
  if(reason==='budget')f.run.project.limits.maxCalls=f.run.calls;
  if(reason==='not-timeout')f.run.tasks[1].failure.code='AGENT_FAILED';
  if(reason==='active-run')f.service.store.data.runs.other={id:'other',project:{uiProjectId:f.p.id},status:'running'};
  try{
    const before=f.run.calls;assert.equal((await f.call(`/api/execution/runs/${f.run.id}/continue`,'POST',{})).status,400);
    assert.equal(f.run.calls,before);assert.equal(f.run.status,'failed');
  }finally{delete f.service.store.data.runs.other;}
});

const blockedFixture=(t,{legacy=false}={})=>fixture(t,{worker:async(agent,ctx,id)=>{
  if(id!=='failed')return;
  if(ctx.prompt.includes('Launch-ready without real sales')){
    assert.equal(await readFile(join(ctx.cwd,'draft.txt'),'utf8'),'prepared once');
    await writeFile(join(ctx.cwd,'recovered.txt'),'recovered');return{text:'Clarified and checked',report:{status:'completed',summary:'Ready without sales',files:['draft.txt','recovered.txt'],checks:[]}};
  }
  await writeFile(join(ctx.cwd,'draft.txt'),'prepared once');
  const report={status:'blocked',summary:'Market and inventory are not confirmed',files:['draft.txt'],checks:[{command:'check draft',status:'passed',required:true,details:'passed'}]};
  ctx.onEvent({kind:'agent_message',message:JSON.stringify(report)});
  throw Object.assign(Error(`Codex blocked: ${report.summary}`),legacy?{}:{code:'AGENT_BLOCKED',report,usage:{input_tokens:11,output_tokens:2}});
},...(legacy?{policy:{enabled:false,maxAttempts:2}}:{})});

for(const legacy of [false,true])test(`${legacy?'legacy':'structured'} blocked report waits for clarification, preserves the worktree and resumes with the project brief`,async t=>{
  const f=await blockedFixture(t,{legacy});await f.settle();
  const snapshot=await f.call(`/api/execution/runs/${f.run.id}`);assert.equal(snapshot.value.status,'blocked');assert.equal(snapshot.value.canClarify,true);
  assert.equal(f.managerCalls(),0);assert.equal(f.run.calls,2);assert.equal(f.run.tasks[1].blockedReport.files[0],'draft.txt');
  const draft=f.run.tasks[1].workspace.path;await assert.rejects(access(join(f.run.project.workspace,'draft.txt')));
  const streams=await fetch(`${f.url}/api/execution/runs/${f.run.id}/events`,{headers:{'X-Execution-Token':f.token},signal:AbortSignal.timeout(30000)});
  let final;for await(const frame of readEventStream(streams.body))if(frame.event==='finished')final=applyRunFrame(null,frame).run;
  assert.equal(final.status,'blocked');assert.equal(final.canClarify,true);
  // The same persisted draft can be resumed after restarting the server.
  f.service.engine.controls.delete(f.run.id);
  const response=await f.call(`/api/execution/runs/${f.run.id}/clarify`,'POST',{taskId:'b',answer:'Launch-ready without real sales. Keep stock empty and require configuration before enabling checkout.',scope:'project'});
  assert.equal(response.status,202,JSON.stringify(response.value));await until(()=>f.run.status==='completed');
  assert.equal(f.run.calls,4);assert.equal(f.managerCalls(),0);assert.equal(f.invocations.filter(i=>i.id==='accepted').length,1);
  assert.equal(f.invocations.filter(i=>i.id==='failed').at(-1).cwd,draft);
  assert.match(f.service.store.data.ui.workspace.projects[0].executionBrief,/Launch-ready without real sales/);
  assert.equal(f.run.tasks[1].history.at(-1).reason,'user-clarification');
  assert.equal(await readFile(join(f.run.project.workspace,'draft.txt'),'utf8'),'prepared once');
  assert.equal((await f.call(`/api/execution/runs/${f.run.id}/clarify`,'POST',{taskId:'b',answer:'duplicate'})).status,400);
});

test('clarification can resume the same file-worker draft with a verified native executor',async t=>{
  const f=await blockedFixture(t);await f.settle();
  const original=f.run.tasks[1],draft=original.workspace.path,agentIds=[...original.agentIds];
  const native=route('native','codex');
  native.capabilities={...native.capabilities,tools:true,workspaceWrite:true};
  f.routes.push(native);
  const path=`/api/execution/runs/${f.run.id}/clarify`;
  const input={taskId:'b',scope:'task',answer:'Launch-ready without real sales'};
  assert.equal((await f.call(path,'POST',{...input,routeId:'opencode:opencode/good'})).status,400);
  assert.equal(f.run.calls,2);
  const accepted=await f.call(path,'POST',{...input,routeId:native.id});
  assert.equal(accepted.status,202,JSON.stringify(accepted.value));
  await until(()=>f.run.status==='completed');
  const finished=f.run.tasks[1];
  assert.equal(f.invocations.filter(i=>i.id==='failed').at(-1).cwd,draft);
  assert.equal(f.invocations.filter(i=>i.id==='failed').at(-1).model,'native');
  assert.equal(finished.history.at(-1).reason,'resume-with-tools');
  assert.deepEqual(finished.history.at(-1).agentIds,agentIds);
  assert.equal(f.run.calls,4);
});

for(const reason of ['plan','workspace','budget','foreign-draft','invalid-answer'])test(`clarification refuses ${reason} changes without accepting draft files`,async t=>{
  const f=await blockedFixture(t);await f.settle();
  if(reason==='plan'){f.p.tasks[1].prompt='Changed plan';await f.call('/api/workspace','PUT',{revision:1,workspace:f.workspace});}
  if(reason==='workspace')await writeFile(join(f.run.project.workspace,'accepted.txt'),'outside edit');
  if(reason==='budget')f.run.project.limits.maxCalls=f.run.calls;
  if(reason==='foreign-draft')f.run.tasks[1].workspace.path=f.run.project.workspace;
  const calls=f.run.calls,result=await f.call(`/api/execution/runs/${f.run.id}/clarify`,'POST',{taskId:'b',answer:reason==='invalid-answer'?'':'Launch-ready without real sales',scope:'project'});
  assert.equal(result.status,400);assert.equal(f.run.calls,calls);assert.equal(f.run.status,'blocked');
  await assert.rejects(access(join(f.run.project.workspace,'draft.txt')));
});

for(const terminalStatus of ['failed','blocked'])test(`retrying restored access from ${terminalStatus} revalidates entitlement and keeps the candidate workspace and completed tasks`,async t=>{
  let retrying=false,entered=false,release;const gate=new Promise(r=>{release=r;});
  const f=await fixture(t,{policy:{enabled:false,maxAttempts:1},failCode:'MODEL_ACCESS_BLOCKED',worker:async(agent,ctx,id)=>{
    if(retrying&&id==='failed'){
      entered=true;await gate;assert.equal(await readFile(join(ctx.cwd,'partial.txt'),'utf8'),'unaccepted');
      await rm(join(ctx.cwd,'partial.txt'));await writeFile(join(ctx.cwd,'recovered.txt'),'recovered');return{text:'Access restored; candidate checked'};
    }
  }});
  try{
    await f.settle();f.run.status=terminalStatus;const original=f.run.tasks[1].workspace.path;assert.equal(f.run.calls,2);
    let routeId;
    if(terminalStatus==='blocked'){
      f.run.tasks[1].failure={code:'AGENT_FAILED',routeId:'codex:fixture',message:'Codex: You’ve hit your usage limit.'};
      const native=route('native-retry','codex');
      native.capabilities={...native.capabilities,workspaceWrite:true,tools:true};
      f.routes.push(native);routeId=native.id;
    }
    const status=await f.call(`/api/execution/runs/${f.run.id}`);assert.equal(status.value.canRetryAccess,true);
    const requireRoute=f.service.registry.requireRoute;let allowed=false,preflights=0;
    f.service.registry.requireRoute=async id=>{preflights++;if(!allowed)throw Error('Included quota is still unavailable');return requireRoute(id);};
    assert.equal((await f.call(`/api/execution/runs/${f.run.id}/retry-access`,'POST',{})).status,400);
    assert.equal(f.run.calls,2);assert.equal(f.run.status,terminalStatus);assert.equal(f.invocations.length,2);
    allowed=true;retrying=true;f.service.engine.controls.delete(f.run.id);
    assert.equal((await f.call(`/api/execution/runs/${f.run.id}/retry-access`,'POST',{taskId:'a'})).status,400);
    const response=await f.call(`/api/execution/runs/${f.run.id}/retry-access`,'POST',{taskId:'b',routeId});assert.equal(response.status,202,JSON.stringify(response.value));
    await until(()=>entered);assert.equal((await f.call(`/api/execution/runs/${f.run.id}/retry-access`,'POST',{})).status,400);
    release();await f.settle();assert.equal(f.run.status,'completed');assert.equal(f.run.calls,4);assert.equal(f.managerCalls(),0);
    assert.equal(f.invocations.filter(i=>i.id==='accepted').length,1);assert.equal(f.invocations.filter(i=>i.id==='failed').at(-1).cwd,original);
    if(routeId)assert.equal(f.invocations.filter(i=>i.id==='failed').at(-1).model,'native-retry');
    assert.ok(preflights>=4);assert.equal(f.run.tasks[1].history.at(-1).reason,'manual-access-retry');
    assert.ok(f.run.events.some(e=>e.type==='run.access_retried'));
    assert.equal((await f.call(`/api/execution/runs/${f.run.id}/retry-access`,'POST',{})).status,400);
  }finally{release();}
});

for(const reason of ['plan','workspace','budget','not-access','active-run'])test(`restored-access retry refuses ${reason} changes`,async t=>{
  const f=await fixture(t,{policy:{enabled:false,maxAttempts:1},failCode:'MODEL_ACCESS_BLOCKED'});await f.settle();
  if(reason==='plan'){f.p.tasks[1].prompt='Another task';await f.call('/api/workspace','PUT',{revision:1,workspace:f.workspace});}
  if(reason==='workspace')await writeFile(join(f.run.project.workspace,'accepted.txt'),'outside edit');
  if(reason==='budget')f.run.project.limits.maxCalls=f.run.calls;
  if(reason==='not-access')f.run.tasks[1].failure.code='AGENT_FAILED';
  if(reason==='active-run')f.service.store.data.runs.other={id:'other',project:{uiProjectId:f.p.id},status:'running'};
  try{
    const before=f.run.calls;assert.equal((await f.call(`/api/execution/runs/${f.run.id}/retry-access`,'POST',{})).status,400);
    assert.equal(f.run.calls,before);assert.equal(f.run.status,'failed');
  }finally{delete f.service.store.data.runs.other;}
});

for(const legacy of [false,true])test(`resuming a ${legacy?'legacy':'recorded'} cancellation reuses its draft and keeps accepted tasks and call budget`,async t=>{
  let draftReady=false, resuming=false;
  const f=await fixture(t,{policy:{enabled:false,maxAttempts:1},maxCalls:4,worker:async(_agent,ctx,id)=>{
    if(id!=='failed')return;
    if(!resuming){
      await writeFile(join(ctx.cwd,'draft.txt'),'saved on cancellation');
      draftReady=true;
      await delay(30000,null,{signal:ctx.signal});
      throw Error('Expected cancellation');
    }
    assert.equal(await readFile(join(ctx.cwd,'draft.txt'),'utf8'),'saved on cancellation');
    await writeFile(join(ctx.cwd,'recovered.txt'),'recovered');
    return {text:'Resumed the saved draft'};
  }});
  const runPath=`/api/execution/runs/${f.run.id}`;
  await until(()=>draftReady);
  const draft=f.run.tasks[1].workspace.path;
  assert.equal((await f.call(runPath+'/cancel','POST',{})).status,200);
  await until(()=>f.run.events.some(event=>event.type==='run.drained'));
  const cancellation=f.run.events.findLast(event=>event.type==='run.cancelled');
  assert.deepEqual(cancellation.taskStates,{b:'running',c:'pending'});
  if(legacy){
    delete cancellation.taskStates;
    delete cancellation.draining;
  }
  f.service.engine.controls.delete(f.run.id);
  const unconfirmed=structuredClone(f.run);
  unconfirmed.events=unconfirmed.events.filter(event=>event.type!=='run.drained');
  assert.equal(f.service.engine.canResumeCancelled(unconfirmed),false);
  assert.equal((await f.call(runPath)).value.canResumeCancelled,true);
  const accepted=structuredClone(f.run.tasks[0]);

  const requireRoute=f.service.registry.requireRoute;
  f.service.registry.requireRoute=async(...args)=>{
    if(!resuming)throw Error('Included quota unavailable');
    return requireRoute(...args);
  };
  const denied=await f.call(runPath+'/resume-cancelled','POST',{});
  assert.equal(denied.status,400);
  assert.match(denied.value.error,/Included quota unavailable/);
  assert.equal(f.run.status,'cancelled');
  assert.equal(f.run.calls,2);
  assert.equal(f.invocations.length,2);

  resuming=true;
  const response=await f.call(runPath+'/resume-cancelled','POST',{});
  assert.equal(response.status,202,JSON.stringify(response.value));
  assert.equal(response.value.id,f.run.id);
  assert.equal(response.value.canResumeCancelled,false);
  await f.settle();
  assert.equal(f.run.status,'completed');
  assert.deepEqual(f.run.tasks[0],accepted);
  assert.equal(f.run.calls,4);
  assert.equal(f.invocations.filter(invocation=>invocation.id==='accepted').length,1);
  assert.equal(f.invocations.filter(invocation=>invocation.id==='failed').at(-1).cwd,draft);
  assert.equal(f.run.tasks[1].history.at(-1).reason,'manual-cancelled-resume');
  assert.equal(await readFile(join(f.run.project.workspace,'draft.txt'),'utf8'),'saved on cancellation');
  assert.equal((await f.call(runPath+'/resume-cancelled','POST',{})).status,400);
});

test('an exhausted budget can be increased explicitly before resuming the same run',async t=>{
  const f=await fixture(t,{policy:{enabled:false,maxAttempts:1},maxCalls:1,worker:async(_agent,ctx,id)=>{
    if(id!=='failed')return;
    await writeFile(join(ctx.cwd,'recovered.txt'),'recovered');
    return {text:'Resumed after increasing the budget'};
  }});
  await f.settle();
  const path=`/api/execution/runs/${f.run.id}`;
  const blocked=await f.call(path);
  assert.equal(blocked.value.canIncreaseBudget,true);
  assert.equal(blocked.value.canRetryBudget,false);
  assert.equal(blocked.value.tasks[1].failure.code,'RUN_CALL_BUDGET');
  const draft=blocked.value.tasks[1].workspace.path;
  assert.equal((await f.call(path+'/budget','POST',{previousMaxCalls:1,maxCalls:3})).status,200);
  assert.equal((await f.call(path+'/budget','POST',{previousMaxCalls:1,maxCalls:4})).status,400);
  assert.equal(f.run.status,'failed');
  assert.equal(f.run.calls,1);
  assert.equal((await f.call(path)).value.canRetryBudget,true);
  assert.equal((await f.call(path+'/retry-budget','POST',{})).status,202);
  await f.settle();
  assert.equal(f.run.status,'completed');
  assert.equal(f.run.calls,3);
  assert.equal(f.invocations.filter(invocation=>invocation.id==='accepted').length,1);
  assert.equal(f.invocations.find(invocation=>invocation.id==='failed').cwd,draft);
});

test('known environment failures retain the draft and wait for verification without rerouting',async t=>{
  const f=await fixture(t,{worker:async(_agent,ctx,id)=>{
    if(id!=='failed')return;
    await writeFile(join(ctx.cwd,'draft.txt'),'candidate');
    const report={status:'completed',summary:'Draft candidate',files:['draft.txt'],checks:[
      {command:'npm run test:http',status:'failed',required:true,details:'connect EACCES 127.0.0.1:45555'},
      {command:'npm run test:postgres',status:'not_run',required:true,details:'POSTGRES_TOOL_REQUIRED:initdb'}
    ]};
    throw Object.assign(Error('Verifications unavailable'),{code:'CHECKS_BLOCKED',report});
  }});
  await f.settle();
  const {value}=await f.call(`/api/execution/runs/${f.run.id}`);
  assert.equal(value.status,'blocked');
  assert.equal(value.canClarify,true);
  assert.equal(f.managerCalls(),0);
  assert.deepEqual(value.tasks[1].verificationBlockers.map(check=>check.command),['npm run test:http','npm run test:postgres']);
  await assert.rejects(access(join(f.run.project.workspace,'draft.txt')));
});

for(const automatic of [false,true])test(`${automatic?'automatic':'one-click'} host checks accept the exact candidate without another model call`,async t=>{
  const command='npm run test:http';
  const f=await fixture(t,{hostPolicy:{automatic,checks:{
    [command]:{argv:['--eval',"require('node:assert/strict').equal(require('node:fs').readFileSync('recovered.txt','utf8'),'checked draft')"]}
  }},worker:async(_agent,ctx,id)=>{
    if(id==='downstream')return {text:'Integrated draft verified'};
    if(id!=='failed')return;
    await writeFile(join(ctx.cwd,'recovered.txt'),'checked draft');
    const report={status:'blocked',summary:'Candidate',files:['recovered.txt'],
      checks:[{command,status:'failed',required:true,details:'connect EACCES 127.0.0.1:30123'}]};
    throw Object.assign(Error('Test environment unavailable'),{code:'AGENT_BLOCKED',report});
  }});
  const path=`/api/execution/runs/${f.run.id}`;
  if(!automatic){
    await f.settle();
    const {value}=await f.call(path);
    assert.equal(value.tasks[1].canVerifyOnHost,true);
    const result=await f.call(path+'/verify-host','POST',{taskId:'b'});
    assert.equal(result.status,200,JSON.stringify(result.value));
  }
  await until(()=>f.run.status==='completed'||f.run.events.some(event=>event.type==='task.host_verification_failed'));
  assert.equal(f.run.status,'completed',JSON.stringify(f.run.events.slice(-4)));
  assert.equal(f.run.calls,3);
  assert.equal(f.invocations.filter(invocation=>invocation.id==='failed').length,1);
  assert.equal(f.run.tasks[1].outputs.at(-1).report.checks[0].source,'host');
  assert.equal(await readFile(join(f.run.project.workspace,'recovered.txt'),'utf8'),'checked draft');
});

test('automatic host verification continues to the next draft after a failed check',async t=>{
  const f=await fixture(t,{hostPolicy:{automatic:true,checks:{
    'first check':{argv:['--eval','process.exit(1)']},
    'second check':{argv:['--eval','process.exit(0)']}
  }},modify:p=>p.tasks.push({id:'d',title:'other draft',prompt:'Create candidate',agentIds:['backend'],dependsOn:['a']}),
  worker:async(_agent,ctx,id)=>{
    if(!['failed','other draft'].includes(id))return;
    await writeFile(join(ctx.cwd,id+'.txt'),'draft');
    const report={status:'blocked',summary:'Candidate',files:[id+'.txt'],
      checks:[{command:id==='failed'?'first check':'second check',status:'failed',required:true,details:'connect EACCES 127.0.0.1:30123'}]};
    throw Object.assign(Error('Test environment unavailable'),{code:'AGENT_BLOCKED',report});
  }});
  await until(()=>f.run.events.some(event=>event.type==='task.host_verified'&&event.taskId==='d')&&f.run.status==='blocked');
  assert.equal(f.run.tasks.find(task=>task.id==='b').status,'blocked');
  assert.equal(f.run.tasks.find(task=>task.id==='d').status,'completed');
  assert.equal(f.run.events.filter(event=>event.type==='task.host_verification_started'&&event.taskId==='b').length,1);
  assert.equal(f.run.calls,3);
});

test('automatic host checks save mixed results and keep manual checks pending',async t=>{
  const f=await fixture(t,{hostPolicy:{automatic:true,checks:{
    'failing local test':{argv:['--eval','process.exit(1)']},
    'passing local test':{argv:['--eval','process.exit(0)']},
    'physical device check':{argv:['--eval','process.exit(0)']}
  },taskPreflights:{b:{'load profile':{before:'physical device check',
    argv:['--eval',"console.log('Profile exceeds the configured limit');process.exit(1)"]}}}},worker:async(_agent,ctx,id)=>{
    if(id!=='failed')return;
    await writeFile(join(ctx.cwd,'recovered.txt'),'draft');
    throw Object.assign(Error('Verification pending'),{code:'AGENT_BLOCKED',report:{
      status:'blocked',summary:'Candidate',files:['recovered.txt'],checks:[
        {command:'failing local test',status:'failed',required:true,details:'connect EACCES 127.0.0.1:30123'},
        {command:'passing local test',status:'failed',required:true,details:'POSTGRES_TOOL_REQUIRED:initdb'},
        {command:'physical device check',status:'not_run',required:true,details:'Physical device required'}
      ]
    }});
  }});
  await until(()=>f.run.events.some(event=>event.type==='task.host_verification_finished'));
  const {value}=await f.call(`/api/execution/runs/${f.run.id}`);
  const task=value.tasks.find(task=>task.id==='b');
  assert.equal(value.status,'blocked');
  assert.equal(value.calls,2);
  assert.deepEqual(task.hostVerificationProgress.checks.map(({command,status})=>[command,status]),
    [['failing local test','failed'],['passing local test','passed'],['load profile','failed']]);
  assert.equal(task.hostVerificationProgress.checks[2].details,'Profile exceeds the configured limit');
  assert.deepEqual(task.pendingVerificationChecks.map(check=>check.command),['failing local test','physical device check','load profile']);
  assert.equal(f.run.events.filter(event=>event.type==='task.host_verification_started').length,1);
  const persisted=JSON.parse(await readFile(join(f.dir,'data','state.json'),'utf8'));
  assert.deepEqual(persisted.runs[f.run.id].tasks.find(task=>task.id==='b').hostVerificationProgress,task.hostVerificationProgress);
  await assert.rejects(access(join(f.run.project.workspace,'recovered.txt')));
});

test('test completion accepts verified draft and defers unstarted release tasks without a worker call',async t=>{
  const f=await fixture(t,{hostPolicy:{automatic:true,
    taskPreflights:{b:{'simulated check':{before:'physical check',argv:['--eval','process.exit(0)']}}},
    testCompletion:{taskId:'b',deferCheck:'physical check',require:['simulated check'],deferTasks:['c']}
  },worker:async(_agent,ctx,id)=>{
    if(id!=='failed')return;
    await writeFile(join(ctx.cwd,'recovered.txt'),'test-only');
    throw Object.assign(Error('Physical device pending'),{code:'AGENT_BLOCKED',report:{
      status:'blocked',summary:'Candidate',files:['recovered.txt'],
      checks:[{command:'physical check',required:true,status:'not_run',details:'Requires a release device'}]
    }});
  }});
  await until(()=>f.run.status==='completed'||f.run.events.some(event=>event.type==='task.host_verification_failed'));
  assert.equal(f.run.status,'completed');
  assert.equal(f.run.calls,2);
  assert.equal(f.run.tasks[2].status,'deferred');
  assert.equal(f.run.tasks[2].attempts,0);
  assert.equal(f.invocations.some(invocation=>invocation.id==='downstream'),false);
  assert.deepEqual(f.run.testCompletion.taskIds,['c']);
  assert.equal(f.run.tasks[1].outputs.at(-1).report.checks[0].status,'not_run');
  assert.equal(f.run.tasks[1].outputs.at(-1).report.checks[0].required,false);
  assert.equal(await readFile(join(f.run.project.workspace,'recovered.txt'),'utf8'),'test-only');
});

test('trusted project rules verify new HTTP and PostgreSQL checks and resume without reassigning the task',async t=>{
  const postgresBin=resolve('.orchestrator/tests/postgres-fixture');
  const f=await fixture(t,{hostPolicy:{automatic:true,nodeProjectChecks:{http:true,postgresBin}},worker:async(_agent,ctx,id)=>{
    if(id!=='failed')return;
    await mkdir(join(ctx.cwd,'tests','integration'),{recursive:true});
    await mkdir(join(ctx.cwd,'scripts'),{recursive:true});
    const http='tests/integration/new-feature-http.test.mjs',postgres='scripts/test-new-feature-postgres.mjs';
    const scripts={
      'test:http':`node --test ${http}`,
      'test:new-feature-postgres':`node ${postgres}`,
      'pretest:http':'node --eval "process.exit(7)"'
    };
    await writeFile(join(ctx.cwd,'package.json'),JSON.stringify({scripts}));
    await writeFile(join(ctx.cwd,http),"import { readFileSync } from 'node:fs';\nif (readFileSync('recovered.txt','utf8')!=='recovered') process.exit(8);");
    await writeFile(join(ctx.cwd,postgres),`if(process.env.STORE_TEST_POSTGRES_BIN!==${JSON.stringify(postgresBin)}) process.exit(9);`);
    await writeFile(join(ctx.cwd,'recovered.txt'),'recovered');
    const report={status:'blocked',summary:'Candidate',files:['package.json',http,postgres,'recovered.txt'],checks:[
      {command:'npm run test:http',status:'failed',required:true,details:'connect EACCES 127.0.0.1:30123'},
      {command:'npm run test:new-feature-postgres',status:'failed',required:true,details:'POSTGRES_TOOL_REQUIRED:initdb'}
    ]};
    throw Object.assign(Error('Test environment unavailable'),{code:'AGENT_BLOCKED',report});
  }});
  await until(()=>f.run.status==='completed'||f.run.events.some(event=>event.type==='task.host_verification_failed'));
  assert.equal(f.run.status,'completed',JSON.stringify(f.run.events.slice(-4)));
  assert.equal(f.run.calls,3);
  assert.equal(f.run.tasks[1].outputs.at(-1).report.checks.filter(check=>check.source==='host').length,2);
  assert.equal(f.invocations.filter(invocation=>invocation.id==='failed').length,1);
});

test('host checks cannot accept or alter the draft if the tested snapshot changes',async t=>{
  const command='npm run test:http';
  const f=await fixture(t,{hostPolicy:{automatic:true,checks:{
    [command]:{argv:['--eval',"require('node:fs').writeFileSync('candidate.txt','different content')"]}
  }},worker:async(_agent,ctx,id)=>{
    if(id!=='failed')return;
    await writeFile(join(ctx.cwd,'candidate.txt'),'original draft');
    const report={status:'blocked',summary:'Candidate',files:['candidate.txt'],
      checks:[{command,status:'failed',required:true,details:'connect EACCES 127.0.0.1:30123'}]};
    throw Object.assign(Error('Test environment unavailable'),{code:'AGENT_BLOCKED',report});
  }});
  await until(()=>f.run.events.some(event=>event.type==='task.host_verification_finished'));
  assert.equal(f.run.status,'blocked');
  assert.equal(f.run.calls,2);
  assert.match(f.run.events.find(event=>event.type==='task.host_verification_failed').message,/змінила файли/);
  assert.equal(await readFile(join(f.run.tasks[1].workspace.path,'candidate.txt'),'utf8'),'original draft');
  await assert.rejects(access(join(f.run.project.workspace,'candidate.txt')));
});

test('a rejected completed report can be corrected through a new checked invocation without accepting its draft early',async t=>{
  const f=await fixture(t,{policy:{enabled:false,maxAttempts:1},worker:async(a,ctx,id)=>{
    if(id!=='failed')return;
    if(ctx.prompt.includes('Expected exit 1 is passing')){
      assert.equal(await readFile(join(ctx.cwd,'draft.txt'),'utf8'),'not accepted yet');
      await writeFile(join(ctx.cwd,'recovered.txt'),'recovered');return{text:'Validated negative check and technical result',report:{status:'completed',files:['draft.txt','recovered.txt'],checks:[{command:'negative assertion',status:'passed',required:true,details:'verified'}]}};
    }
    await writeFile(join(ctx.cwd,'draft.txt'),'not accepted yet');
    const report={status:'completed',summary:'Technical task is done, commerce disabled',files:['draft.txt'],checks:[{command:'check ready',status:'failed',required:true,details:'Expected refusal'}]};
    throw Object.assign(Error('Required check was not satisfied'),{code:'WORKER_FAILED',report});
  }});
  await f.settle();assert.equal(f.run.status,'failed');assert.equal(f.managerCalls(),0);
  assert.equal((await f.call(`/api/execution/runs/${f.run.id}`)).value.canClarify,true);
  const draft=f.run.tasks[1].workspace.path;await assert.rejects(access(join(f.run.project.workspace,'draft.txt')));
  const response=await f.call(`/api/execution/runs/${f.run.id}/clarify`,'POST',{taskId:'b',answer:'Expected exit 1 is passing. Correct and re-run verification; do not activate commerce.',scope:'task'});
  assert.equal(response.status,202,JSON.stringify(response.value));await until(()=>f.run.status==='completed');
  assert.equal(f.run.calls,4);assert.equal(f.invocations.filter(i=>i.id==='accepted').length,1);assert.equal(f.invocations.filter(i=>i.id==='failed').at(-1).cwd,draft);
  assert.equal(await readFile(join(f.run.project.workspace,'draft.txt'),'utf8'),'not accepted yet');assert.equal(f.managerCalls(),0);
});
