import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { resolve,join,relative,isAbsolute } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createExecutionService,executorConfig } from '../scripts/execution-service.js';
import { seed } from '../apps/web/src/state.js';
import { applyExecutionRun } from '../apps/web/src/execution.js';

async function fixture(t,provider,options={}) {
  const base=resolve('.orchestrator/tests');await mkdir(base,{recursive:true});const dir=await mkdtemp(join(base,'execution-'));
  const trusted={id:'codex:fake-model',backend:'codex',model:'fake-model',decision:{allowed:true,reason:'Test-only verified route'},
    checkedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+300000).toISOString(),availability:'ready',
    billing:'free_tier',freeConfirmed:true,billingBoundary:'included_only',runtimeSupported:true,reasoningEfforts:['low','high'],capabilities:{structuredOutput:true,tools:true,workspaceWrite:true}};
  const catalog=[trusted,...(options.reviewRuns?[{...trusted,id:'codex:review-model',model:'review-model'}]:[])];
  const registry={snapshot:()=>({routes:catalog,connections:[]}),scan:async()=>registry.snapshot(),requireRoute:async id=>{
    const route=catalog.find(item=>item.id===id);assert.ok(route);return {...route,command:'trusted-executable'};
  }};
  const service=createExecutionService({directory:join(dir,'data'),workspaces:join(dir,'workspaces'),config:{model:'fake-model',command:'trusted-executable',reasoningEffort:'high'},provider,registry,reviewRuns:false,...options});
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

test('real runs review each candidate with its author and require a separate reviewer after integration',async t=>{
  const calls=[];
  let selfReviews=0,finalReviews=0;
  const f=await fixture(t,async(agent,context)=>{
    const {cwd,prompt,review}=context;
    calls.push({model:agent.model,review});
    if(review==='project'){
      assert.equal(agent.access,'read-only');
      assert.equal(await readFile(join(cwd,'candidate.txt'),'utf8'),'corrected');
      return {text:JSON.stringify({approved:++finalReviews===2,feedback:'Окремий висновок'})};
    }
    if(review==='self'){
      assert.equal(agent.access,'read-only');
      assert.ok(await readFile(join(cwd,'candidate.txt'),'utf8'));
      return {text:JSON.stringify({approved:++selfReviews>1,feedback:'Уточніть реалізацію'})};
    }
    await writeFile(join(cwd,'candidate.txt'),calls.length===1?'draft':'corrected');
    if(calls.length===3)assert.match(prompt,/Виправ зауваження самоперевірки/);
    return {text:'Зміни виконано'};
  },{reviewRuns:true});
  const payload={projectId:f.p.id,revision:f.p.revision,bindings:{backend:'codex-write'},maxCalls:8};
  assert.match((await f.call('/api/execution/runs','POST',{...payload,maxCalls:4})).value.error,/щонайменше 5/);
  const started=await f.call('/api/execution/runs','POST',payload);
  assert.equal(started.status,202,JSON.stringify(started.value));
  const run=f.service.engine.run(started.value.id);
  await until(()=>run.events.some(event=>event.type==='run.drained'));
  assert.equal(run.status,'blocked');
  assert.deepEqual(calls.slice(0,-1).map(call=>call.review),[undefined,'self',undefined,'self',undefined,'self']);
  assert.ok(calls.slice(0,-1).every(call=>call.model==='fake-model'));
  assert.deepEqual(calls.at(-1),{model:'review-model',review:'project'});
  assert.equal(run.tasks.at(-1).review.approved,false);
  assert.equal((await f.call(`/api/execution/runs/${run.id}/retry-project-review`,'POST',{})).status,202);
  await until(()=>run.status==='completed');
  assert.equal(run.tasks.at(-1).review.approved,true);
  assert.equal(run.calls,8);
});

test('local verification integrates the exact draft approved by its author before final review',async t=>{
  const file='tests/local-http.test.mjs',steps=[];
  const f=await fixture(t,async(_agent,{cwd,review})=>{
    steps.push(review??'implementation');
    if(review){
      assert.equal(await readFile(join(cwd,file),'utf8'),'approved draft');
      return {text:'{"approved":true,"feedback":"Чернетку перевірено"}'};
    }
    await mkdir(join(cwd,'tests'),{recursive:true});
    await writeFile(join(cwd,file),'approved draft');
    throw Object.assign(Error('No loopback in worker'),{code:'AGENT_BLOCKED',report:{status:'blocked',summary:'Saved draft',files:[file],
      checks:[{command:`node --test ${file}`,required:true,status:'failed',details:'connect EACCES 127.0.0.1:5000'}]}});
  },{reviewRuns:true,testNode:async(cwd,files)=>{
    steps.push('local-check');assert.deepEqual(files,[file]);
    assert.equal(await readFile(join(cwd,file),'utf8'),'approved draft');
    return {exitCode:0,output:'ok'};
  }});
  f.p.tasks=f.p.tasks.slice(0,1);
  assert.equal((await f.call('/api/workspace','PUT',{revision:1,workspace:f.workspace})).status,200);
  const started=await f.call('/api/execution/runs','POST',{projectId:f.p.id,revision:f.p.revision,bindings:{backend:'codex-write'},maxCalls:3});
  assert.equal(started.status,202,JSON.stringify(started.value));
  const run=f.service.engine.run(started.value.id);
  await until(()=>run.status==='completed'||run.status==='failed');
  assert.equal(run.status,'completed');
  assert.deepEqual(steps,['implementation','self','local-check','project']);
});

test('project chat queues during execution and applies follow-ups to the same workspace',async t=>{
  const initial=Promise.withResolvers();
  const calls=[];
  const f=await fixture(t,async(_agent,{cwd,prompt,signal})=>{
    if(prompt.includes('Task: Правки з чату проєкту')){
      calls.push(prompt);
      const current=await readFile(join(cwd,'result.txt'),'utf8');
      if(prompt.includes('Поточний запит користувача:\nОнови результат\nAcceptance criteria:')){
        assert.equal(current,'initial');
        await writeFile(join(cwd,'result.txt'),'updated');
      }else{
        assert.match(prompt,/Поточний запит користувача:\nВидали зайвий файл\nAcceptance criteria:/);
        assert.match(prompt,/Попередні виконані запити[\s\S]*Онови результат/);
        assert.equal(current,'updated');
        await unlink(join(cwd,'obsolete.txt'));
      }
      return {text:'Правки внесено'};
    }
    await Promise.race([initial.promise,once(signal,'abort')]);
    signal.throwIfAborted();
    await writeFile(join(cwd,'result.txt'),'initial');
    await writeFile(join(cwd,'obsolete.txt'),'old');
    return {text:'Початковий проєкт готовий'};
  });
  t.after(()=>initial.resolve());
  const main=await f.call('/api/execution/runs','POST',{projectId:f.p.id,revision:f.p.revision,bindings:{backend:'codex-write'}});
  assert.equal(main.status,202);
  const chat=projectId=>`/api/execution/project-chat?projectId=${encodeURIComponent(projectId)}`;
  const url=chat(f.p.id), message={id:randomUUID(),text:'Онови результат'};
  const sent=await f.call(url,'POST',message);
  assert.equal(sent.status,202);
  assert.equal(sent.value.messages[0].status,'queued');
  assert.equal((await f.call(url,'POST',message)).value.messages.length,1);
  assert.equal((await f.call(url,'POST',{id:randomUUID(),text:' '})).status,400);
  assert.deepEqual((await f.call(chat(f.workspace.projects[1].id))).value.messages,[]);
  initial.resolve();
  let history;
  await until(async()=>{
    history=(await f.call(url)).value.messages;
    assert.ok(['queued','running','completed'].includes(history[0].status),JSON.stringify(history[0]));
    return history[0].status==='completed';
  });
  assert.equal(history[0].result,'Правки внесено');
  assert.equal((await f.call(url,'POST',{id:randomUUID(),text:'Видали зайвий файл'})).status,202);
  await until(async()=>{
    history=(await f.call(url)).value.messages;
    assert.ok(['queued','running','completed'].includes(history[1].status),JSON.stringify(history[1]));
    return history[1].status==='completed';
  });
  assert.equal(calls.length,2);
  const run=f.service.engine.run(main.value.id);
  assert.equal(run.status,'completed');
  assert.equal(await readFile(join(run.project.workspace,'result.txt'),'utf8'),'updated');
  await assert.rejects(readFile(join(run.project.workspace,'obsolete.txt')),{code:'ENOENT'});
  const runs=(await f.call('/api/execution/runs')).value;
  assert.equal(runs.find(item=>item.id===main.value.id).kind,undefined);
  assert.equal(runs.filter(item=>item.kind==='project-chat').length,2);
  const saved=JSON.parse(await readFile(f.service.store.path,'utf8'));
  assert.equal(saved.projectChats[f.p.id].length,2);
});

test('a failed isolated test returns to the agent and gates its dependency without user input',async t=>{
  const file='tests/http.test.mjs',command='node --test '+file;
  let calls=0,checks=0;
  const f=await fixture(t,async(_agent,context)=>{
    calls++;
    if(calls===3)return {text:'Dependent task completed'};
    if(calls===2)assert.match(context.prompt,/expected: 200.*actual: 500/);
    await mkdir(join(context.cwd,'tests'),{recursive:true});
    await writeFile(join(context.cwd,file),calls===1?'broken':'fixed');
    throw Object.assign(Error('Worker loopback unavailable'),{code:'AGENT_BLOCKED',report:{status:'blocked',
      summary:'Saved draft',files:[file],checks:[{command,required:true,status:'failed',details:'connect EACCES 127.0.0.1:5000'}]}});
  },{testNode:async(cwd,files)=>{
    checks++;
    assert.deepEqual(files,[file]);
    const fixed=await readFile(join(cwd,file),'utf8')==='fixed';
    return {exitCode:fixed?0:1,output:fixed?'ok':'not ok 1\n  expected: 200\n  actual: 500'};
  }});
  const started=await f.call('/api/execution/runs','POST',{projectId:f.p.id,revision:f.p.revision,bindings:{backend:'codex-write'}});
  assert.equal(started.status,202);
  const run=f.service.engine.run(started.value.id);
  await until(()=>run.status==='completed');
  assert.equal(calls,3);
  assert.equal(checks,2);
  assert.ok(run.events.some(event=>event.type==='run.draft_recovery_started'));
  assert.ok(run.events.some(event=>event.type==='task.host_verified'));
});

test('UI execution and recovery deadlines are opt-in and reported by the status endpoint',async t=>{
  assert.equal(executorConfig({}).timeoutMs,null);assert.equal(executorConfig({}).recoveryTimeoutMs,null);
  assert.equal(executorConfig({ORCHESTRATOR_EXECUTOR_TIMEOUT_MS:'600000'}).timeoutMs,600000);
  assert.equal(executorConfig({ORCHESTRATOR_RECOVERY_TIMEOUT_MS:'300000'}).recoveryTimeoutMs,300000);
  for(const value of ['0','bad','-3'])assert.throws(()=>executorConfig({ORCHESTRATOR_EXECUTOR_TIMEOUT_MS:value}),/TIMEOUT_MS/);
  const f=await fixture(t,async()=>({text:'done'}));
  assert.deepEqual((await f.call('/api/execution/status')).value.timeouts,{task:null,recovery:null});
  const started=await f.call('/api/execution/runs','POST',{projectId:f.p.id,revision:f.p.revision,bindings:{backend:'codex-write'}});
  assert.equal(started.status,202);const run=f.service.engine.run(started.value.id);
  await until(()=>run.status==='completed');assert.equal(run.project.limits.timeoutMs,null);
  const response=await f.call('/api/execution/notifications');
  assert.equal(response.status,200);
  assert.deepEqual(response.value.items.map(item=>item.kind),['stage','stage','completed']);
  assert.equal(new Set(response.value.items.map(item=>item.id)).size,3);
});

test('a new project uses its selected folder for execution and static preview',async t=>{
  const f=await fixture(t,async(_agent,{cwd})=>{
    await writeFile(join(cwd,'result.txt'),'done');
    return {text:'done'};
  });
  const parent=join(f.dir,'Власні проєкти');
  await mkdir(parent);
  const listed=await f.call(`/api/project-folders?path=${encodeURIComponent(f.dir)}`);
  assert.equal(listed.status,200);
  assert.ok(listed.value.folders.some(folder=>folder.path===parent));
  const project={...f.p,id:'with-custom-location',name:'Магазин',tasks:f.p.tasks.slice(0,1)};
  const workspace={...f.workspace,projects:[...f.workspace.projects,project]};
  const save=await f.call('/api/workspace','PUT',{revision:1,workspace,projectLocation:{projectId:project.id,parent}});
  assert.equal(save.status,200);
  const plan=await f.call('/api/execution/preview','POST',{projectId:project.id});
  const folder=plan.value.workspace;
  assert.match(relative(parent,folder),/^Магазин - [0-9a-f]{8}$/);

  const launch=await f.call('/api/execution/runs','POST',{projectId:project.id,revision:project.revision,bindings:{backend:'codex-write'}});
  assert.equal(launch.status,202);
  const run=f.service.engine.run(launch.value.id);
  await until(()=>['completed','failed','blocked'].includes(run.status));
  assert.equal(run.status,'completed');
  const file=await f.call(`/api/execution/runs/${run.id}/file?path=result.txt`);
  assert.equal(file.value.text,'done');

  const empty=await f.call('/api/project-preview','POST',{projectId:project.id});
  assert.deepEqual(empty.value,{url:null});
  await mkdir(join(folder,'dist'));
  await writeFile(join(folder,'dist','index.html'),'<h1>Магазин</h1>');
  await writeFile(join(folder,'dist','.private.json'),'{}');
  const preview=await f.call('/api/project-preview','POST',{projectId:project.id});
  assert.equal(preview.status,200);
  const page=await fetch(preview.value.url);
  assert.equal(page.status,200);
  assert.match(page.headers.get('content-security-policy'),/frame-ancestors http:\/\/127\.0\.0\.1:/);
  assert.equal(await page.text(),'<h1>Магазин</h1>');
  assert.equal((await fetch(new URL('.private.json',preview.value.url))).status,404);
  assert.equal((await f.call('/api/project-preview','POST',{projectId:project.id,url:'https://example.com'})).status,400);
});

test('execution resolves a matching MCP server from local settings and records its id',async t=>{
  const observed=[];
  const f=await fixture(t,async(_agent,context)=>{
    observed.push(context);
    if(observed.length===1)await writeFile(join(context.cwd,'package.json'),JSON.stringify({scripts:{test:'node --test'}}));
    return {text:'done'};
  });
  const setting={id:'docs',terms:['integration docs'],url:'http://127.0.0.1:3000/mcp',tools:['search']};
  await writeFile(join(f.dir,'data','task-extensions.json'),JSON.stringify({skills:[],mcpServers:[setting]}));
  f.p.tasks[0].skills=['integration docs'];
  assert.equal((await f.call('/api/workspace','PUT',{revision:1,workspace:f.workspace})).status,200);
  const launch=await f.call('/api/execution/runs','POST',{projectId:f.p.id,revision:f.p.revision,bindings:{backend:'codex-write'}});
  assert.equal(launch.status,202);
  const run=f.service.engine.run(launch.value.id);
  await until(()=>['completed','failed'].includes(run.status));
  assert.equal(run.status,'completed');
  const mcp=observed.map(({mcpServers})=>mcpServers).filter(servers=>servers.length);
  assert.deepEqual(mcp,[[{id:'docs',url:setting.url,tools:['search']}]]);
  assert.equal(run.events.find(event=>event.type==='agent.extensions')?.message,'MCP дозволено: docs');
  assert.match(observed[1].hooks[0].text,/npm run test/);
  assert.ok(run.events.some(event=>event.type==='agent.started'&&Number.isFinite(event.timing?.queueMs)));
  assert.ok(run.events.some(event=>event.type==='agent.completed'&&Number.isFinite(event.timing?.executionMs)));
  assert.equal(run.calls,2);
});

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
  const preview=await f.call('/api/project-preview','POST',{projectId:f.p.id,url:'http://127.0.0.1:3000/'});
  assert.deepEqual(preview,{status:200,value:{url:'http://127.0.0.1:3000/'}});
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
