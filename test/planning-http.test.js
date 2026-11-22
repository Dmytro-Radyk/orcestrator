import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { planningHandler } from '../scripts/planning-service.js';
import { demoPlan } from '../apps/web/src/planning.js';

test('planning HTTP enforces same-origin/token and returns validated AI output',async t=>{
  let calls=0;
  const brief={name:'Local test',description:'A test project'};
  const server=createServer(planningHandler({configured:true,label:'fake-model',provider:'responses',agent:{}},async()=>{calls++;return{text:JSON.stringify(demoPlan(brief))};}));
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});
  const base=`http://127.0.0.1:${server.address().port}`;
  const status=await (await fetch(base+'/api/planning/status')).json();
  assert.equal(status.configured,true); assert.equal(status.model,'fake-model');
  assert.equal((await fetch(base+'/api/planning/status',{headers:{Origin:'https://example.com'}})).status,403);
  const request={method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({kind:'plan',input:brief})};
  assert.equal((await fetch(base+'/api/planning',request)).status,403); assert.equal(calls,0);
  request.headers['X-Planning-Token']=status.token;
  const response=await fetch(base+'/api/planning',request);assert.equal(response.status,200);
  const result=await response.json();assert.equal(result.provenance.mode,'ai');assert.equal(result.value.tasks.length,5);assert.equal(calls,1);
});

test('planning HTTP rechecks server billing authorization even when a client forges access',async t=>{
  let calls=0,checks=0;
  const reason='Не підтверджено зупинку перед додатковими списаннями';
  const server=createServer(planningHandler({configured:true,label:'fake-model',provider:'codex',agent:{provider:'codex',model:'fake-model'},
    access:()=>({allowed:false,reason}),authorize:async()=>{checks++;throw new Error(reason);}
  },async()=>{calls++;throw new Error('must not invoke model');}));
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});
  const base=`http://127.0.0.1:${server.address().port}`;
  const status=await (await fetch(base+'/api/planning/status')).json();
  assert.equal(status.configured,false);assert.equal(status.blockedReason,reason);
  const res=await fetch(base+'/api/planning',{method:'POST',headers:{'Content-Type':'application/json','X-Planning-Token':status.token},
    body:JSON.stringify({kind:'plan',input:{name:'Test',description:'Project',allowed:true,billingBoundary:'included_only'}})});
  assert.equal(res.status,400);assert.equal((await res.json()).error,reason);
  assert.equal(checks,1);assert.equal(calls,0);
});

test('planning HTTP resolves the actual permitted director for status and refreshes selection before a request',async t=>{
  const refreshes=[];
  const server=createServer(planningHandler({resolve:async(options={})=>{refreshes.push(Boolean(options.refresh));return{
    configured:true,label:'opencode/test-free',provider:'opencode',routeId:'opencode:opencode/test-free',agent:{provider:'opencode',model:'opencode/test-free',access:'read-only'}};
  }},async agent=>{assert.equal(agent.model,'opencode/test-free');return{text:JSON.stringify(demoPlan({name:'Test',description:'A test'}))};}));
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});
  const base=`http://127.0.0.1:${server.address().port}`,status=await (await fetch(base+'/api/planning/status')).json();
  assert.equal(status.configured,true);assert.equal(status.provider,'opencode');
  const result=await fetch(base+'/api/planning',{method:'POST',headers:{'Content-Type':'application/json','X-Planning-Token':status.token},
    body:JSON.stringify({kind:'plan',input:{name:'Test',description:'A test'}})});
  assert.equal(result.status,200);assert.equal((await result.json()).provenance.routeId,status.routeId);assert.deepEqual(refreshes,[false,true]);
});

test('planning has no total time limit and still explains an upstream model timeout',async t=>{
  const server=createServer(planningHandler({configured:true,label:'slow-model',provider:'codex',agent:{}},async()=>{
    throw new DOMException('The operation was aborted due to timeout','TimeoutError');
  }));
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});
  const base=`http://127.0.0.1:${server.address().port}`,status=await(await fetch(base+'/api/planning/status')).json();
  assert.equal(status.timeouts.plan,null);assert.equal(status.timeouts.idea,null);assert.equal(status.timeouts.team,null);
  const response=await fetch(base+'/api/planning',{method:'POST',headers:{'Content-Type':'application/json','X-Planning-Token':status.token},
    body:JSON.stringify({kind:'plan',input:{name:'Test',description:'Project'}})});
  assert.equal(response.status,408);const result=await response.json();assert.equal(result.code,'PLANNING_TIMEOUT');
  assert.match(result.error,/Планування не завершилося/);assert.match(result.error,/дані залишилися/);assert.ok(!result.error.includes('operation was aborted'));
});

test('planning HTTP selects by project before inference, preserves the explanation, and honors manual overrides',async t=>{
  const selections=[],calls=[];
  const configFor=(model,selection)=>({configured:true,label:model,provider:'opencode',routeId:`opencode:${model}`,agent:{provider:'opencode',model},...(selection?{selection}:{})});
  const server=createServer(planningHandler({resolve:async({preferred}={})=>configFor(preferred?'manual':'bootstrap'),
    select:async(request,signal)=>{assert.equal(signal.aborted,false);selections.push(request);return configFor('project-planner',{mode:'project',stage:request.kind,reason:'Chosen for the described architecture'});}
  },async agent=>{calls.push(agent.model);return{text:JSON.stringify(demoPlan({name:'Test',description:'Project'}))};}));
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});
  const base=`http://127.0.0.1:${server.address().port}`,status=await(await fetch(base+'/api/planning/status')).json();assert.equal(status.selectionMode,'project');
  const send=body=>fetch(base+'/api/planning',{method:'POST',headers:{'Content-Type':'application/json','X-Planning-Token':status.token},body:JSON.stringify(body)});
  const automatic=await send({kind:'plan',input:{name:'Shop',description:'E-commerce with API contracts',priority:'quality'}});
  assert.equal(automatic.status,200);const result=await automatic.json();assert.equal(result.provenance.model,'project-planner');assert.match(result.provenance.selection.reason,/architecture/);
  assert.equal(selections[0].input.description,'E-commerce with API contracts');assert.equal(selections[0].kind,'plan');
  const manual=await send({kind:'plan',input:{name:'Shop',description:'Existing plan'},managerRouteId:'opencode:manual'});assert.equal(manual.status,200);
  assert.equal(selections.length,1);assert.deepEqual(calls,['project-planner','manual']);
  assert.equal((await send({kind:'plan',input:{name:'',description:''}})).status,400);assert.equal(selections.length,1);
});

test('unlimited planning remains cancellable and releases the planner for the next request',async t=>{
  let entered=false,aborted=false,calls=0;
  const server=createServer(planningHandler({configured:true,label:'slow',provider:'codex',agent:{}},async(agent,{signal})=>{
    if(++calls===1){entered=true;await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(signal.reason);},{once:true}));}
    return{text:JSON.stringify(demoPlan({name:'Test',description:'Project'}))};
  }));
  server.listen(0,'127.0.0.1');await once(server,'listening');const controller=new AbortController();
  t.after(()=>{controller.abort();server.closeAllConnections();server.close();});
  const base=`http://127.0.0.1:${server.address().port}`,status=await(await fetch(base+'/api/planning/status')).json();
  const options={method:'POST',headers:{'Content-Type':'application/json','X-Planning-Token':status.token},body:JSON.stringify({kind:'plan',input:{name:'Test',description:'Project'}})};
  const pending=fetch(base+'/api/planning',{...options,signal:controller.signal}),rejected=assert.rejects(pending,error=>error.name==='AbortError');
  for(let i=0;i<200&&!entered;i++)await new Promise(r=>setTimeout(r,5));assert.equal(entered,true);
  assert.equal((await(await fetch(base+'/api/planning/status')).json()).busy,true);
  controller.abort();await rejected;
  for(let i=0;i<200&&!aborted;i++)await new Promise(r=>setTimeout(r,5));assert.equal(aborted,true);
  assert.equal((await(await fetch(base+'/api/planning/status')).json()).busy,false);
  assert.equal((await fetch(base+'/api/planning',options)).status,200);assert.equal(calls,2);
});
