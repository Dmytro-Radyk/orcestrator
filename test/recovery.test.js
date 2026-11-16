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

async function until(fn){for(let n=0;n<2500;n++){if(await fn())return;await delay(10);}throw Error('Recovery timed out');}
const route=(model,backend='opencode')=>({id:`${backend}:${model}`,connectionId:backend,backend,model,name:model,
  checkedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+300000).toISOString(),availability:'ready',billing:'free_tier',freeConfirmed:true,billingBoundary:'included_only',runtimeSupported:true,
  capabilities:{workspaceWrite:backend==='opencode',structuredOutput:true,tools:false},decision:{allowed:true,reason:'Fixture only'}});
async function fixture(t,{policy={enabled:true,maxAttempts:2},maxCalls=8,failCode='MODEL_ACCESS_BLOCKED',alwaysFail=false,failedModels=['opencode/bad'],manager,modify,worker,routingManagerRouteId}={}){
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

for(const failCode of ['WORKSPACE_CONFLICT','CHECKS_BLOCKED'])test(`${failCode} requires intervention rather than model rerouting`,async t=>{
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
