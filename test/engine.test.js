import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Engine } from '../src/engine.js';
import { Store } from '../src/store.js';
import { dependencyHandoff } from '../src/execution-context.js';
import { withModelPolicy } from '../scripts/model-registry.js';

const agents = [
  { id: 'dev', provider: 'demo', skills: ['code'] },
  { id: 'qa', provider: 'demo', skills: ['code', 'test'] }
];
const task = (id, more = {}) => ({ id, title: id, prompt: `Do ${id}`, skills: ['code'], ...more });
function fixture(t, provider) {
  const root = resolve('.orchestrator', 'tests');
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, 'engine-'));
  t.after(() => {
    const rel = relative(root, resolve(dir));
    assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel));
    rmSync(dir, { recursive: true, force: true });
  });
  return new Engine(new Store(dir), provider);
}
async function until(predicate) {
  for (let i = 0; i < 300; i++) { if (predicate()) return; await delay(10); }
  throw new Error('Timed out waiting for test condition');
}
const finished = run => !['running', 'paused'].includes(run.status);

test('storefront browser failure sends the defects for one automatic repair before blocking publication', async t => {
  const prompts=[];
  const engine=fixture(t,async(_agent,{prompt})=>{
    prompts.push(prompt);
    return {text:'Draft only',report:{status:'completed',summary:'Draft only',files:[],checks:[]}};
  });
  engine.storefrontVerifier=async()=>({status:'failed',issues:['Потрібні різні фото']});
  engine.workspaces={prepare:async()=>({cwd:process.cwd()}),candidateTree:async()=>'tree',
    verifyTree:async(lease,tree,verify)=>verify(lease.cwd),publish:async()=>assert.fail('Evidence must be checked before publishing')};
  const project=engine.createProject({name:'Storefront',workspace:process.cwd(),workspaceMode:'isolated',
    agents,tasks:[task('storefront-acceptance',{agentIds:['dev']})]});
  const run=engine.start(project.id);
  await until(()=>finished(run));
  assert.equal(run.status,'blocked');
  assert.equal(run.calls,2);
  assert.match(prompts[1],/Потрібні різні фото/);
  assert.equal(run.events.filter(event=>event.type==='task.storefront_evidence_retry').length,1);
});

test('storefront publishes only the Git tree that passed the independent check', async t=>{
  let calls=0,published;
  const engine=fixture(t,async()=>{calls++;return {text:'Draft ready'};});
  const lease={cwd:process.cwd()};
  engine.workspaces={prepare:async()=>lease,candidateTree:async()=>`tree-${calls}`,
    verifyTree:async(_lease,tree,verify)=>verify(tree),publish:async(_lease,_signal,{verifiedTree})=>{
      published=verifiedTree;
      return {commit:'accepted'};
    }};
  engine.storefrontVerifier=async(_run,tree)=>tree==='tree-1'
    ?{status:'failed',issues:['Зламане фото']}
    :{status:'passed',issues:[]};
  const project=engine.createProject({name:'Storefront',workspace:process.cwd(),workspaceMode:'isolated',
    agents,tasks:[task('storefront-acceptance',{agentIds:['dev']})]});
  const run=engine.start(project.id);
  await until(()=>finished(run));
  assert.equal(run.status,'completed');
  assert.equal(published,'tree-2');
  assert.deepEqual(run.events.filter(event=>event.type==='task.storefront_audit').map(event=>event.status),['failed','passed']);
});

test('completed worktree context keeps summaries, file references and checks without command logs',()=>{
  const output={agentId:'dev',text:'A long command log',report:{status:'completed',summary:'Implemented API',files:['src/api.js'],
    checks:[{command:'node --test',status:'passed',required:true,details:'A long command log'}]}};
  const dependency={title:'API',result:output.text,workspace:{commit:'accepted'},outputs:[output]};
  const brief=dependencyHandoff(dependency,true);
  assert.equal(brief.outputs[0].summary,'Implemented API');
  assert.deepEqual(brief.outputs[0].files,['src/api.js']);
  assert.equal(brief.outputs[0].checks[0].status,'passed');
  assert.ok(!JSON.stringify(brief).includes('A long command log'));
  assert.deepEqual(dependencyHandoff(dependency,false),{title:'API',result:output.text});
  assert.equal(dependencyHandoff({...dependency,outputs:[{text:'Text only'}]},true).result,output.text);
});

test('quota admission failures do not consume the internal call budget',async t=>{
  const policy=withModelPolicy({requireRoute:async()=>{throw Object.assign(Error('Quota exceeded'),{code:'MODEL_ACCESS_BLOCKED'});}},
    async()=>assert.fail('The blocked model must not run'));
  const engine=fixture(t,policy);
  const project=engine.createProject({name:'Admission',agents:[{id:'dev',provider:'codex',model:'fixture',skills:['code']}],tasks:[task('a')]});
  const run=engine.start(project.id);
  await until(()=>finished(run));
  assert.equal(run.calls,0);
  assert.equal(run.tasks[0].failure.code,'MODEL_ACCESS_BLOCKED');
});

test('waiting Codex work does not occupy the execution slot Gemini can use', async t=>{
  let release; const gate=new Promise(resolve=>{release=resolve;});
  const entered=[];
  const engine=fixture(t,async(agent)=>{
    entered.push(agent.id);
    if(agent.id==='codex'&&entered.length===1)await gate;
    return {text:'Done'};
  });
  const project=engine.createProject({name:'Two subscriptions',agents:[
    {id:'codex',provider:'codex',model:'fixture',skills:['code'],billingBoundary:'subscription_quota_guarded'},
    {id:'gemini',provider:'antigravity',model:'gemini-fixture',skills:['code']}
  ],limits:{concurrency:2},tasks:[task('a',{agentIds:['codex']}),task('b',{agentIds:['codex']}),task('c',{agentIds:['gemini']})]});
  const run=engine.start(project.id);
  try{
    await until(()=>entered.includes('gemini'));
    assert.deepEqual(entered,['codex','gemini']);
  }finally{release();}
  await until(()=>finished(run));
  assert.equal(run.status,'completed');
});

test('parallel teams obey concurrency, dependencies and persist results', async t => {
  let active = 0, peak = 0;
  const engine = fixture(t, async (agent, { prompt }) => {
    peak = Math.max(peak, ++active); await delay(15); active--;
    return { text: `${agent.id}: ${prompt}`, usage: { total_tokens: 10 } };
  });
  const project = engine.createProject({ name: 'Parallel', agents, limits: { concurrency: 2 }, tasks: [task('a', { teamSize: 2 }), task('b'), task('c', { dependsOn: ['a', 'b'] })] });
  const run = engine.start(project.id);
  await until(() => finished(run));
  assert.equal(run.status, 'completed'); assert.equal(peak, 2); assert.equal(run.calls, 4);
  assert.equal(run.tasks[0].outputs.length, 2);
  const events = run.events.map(e => `${e.type}:${e.taskId}`);
  assert.ok(events.indexOf('task.started:c') > events.indexOf('task.completed:a'));
  assert.equal(new Store(engine.store.directory).data.runs[run.id].status, 'completed');
});

test('cycles, missing dependencies and duplicate IDs fail before execution', t => {
  const engine = fixture(t);
  assert.throws(() => engine.createProject({ name: 'x', agents, tasks: [task('a', { dependsOn: ['b'] }), task('b', { dependsOn: ['a'] })] }), /cycle/);
  assert.throws(() => engine.createProject({ name: 'x', agents, tasks: [task('a', { dependsOn: ['missing'] })] }), /Unknown task/);
  assert.throws(() => engine.createProject({ name: 'x', agents, tasks: [task('a'), task('a')] }), /unique/);
});

test('edits create revisions without changing a running snapshot', async t => {
  const engine = fixture(t);
  const project = engine.createProject({ name: 'Before', agents, tasks: [task('a')] });
  const run = engine.start(project.id);
  const revised = engine.updateProject(project.id, { revision: 1, name: 'After' });
  assert.equal(revised.revision, 2); assert.equal(run.project.name, 'Before');
  assert.throws(() => engine.updateProject(project.id, { revision: 1 }), /conflict/);
  await until(() => finished(run));
});

test('failure blocks transitive dependants even with reverse ordering', async t => {
  const engine = fixture(t, async () => { throw new Error('offline'); });
  const project = engine.createProject({ name: 'x', agents, tasks: [task('c', { dependsOn: ['b'] }), task('b', { dependsOn: ['a'] }), task('a')] });
  const run = engine.start(project.id); await until(() => finished(run));
  assert.equal(run.status, 'failed'); assert.deepEqual(run.tasks.map(t => t.status), ['blocked', 'blocked', 'failed']);
});

test('call budget includes parallel agents and retries', async t => {
  const engine = fixture(t, async () => { throw new Error('offline'); });
  const project = engine.createProject({ name: 'x', agents, limits: { maxCalls: 2 }, tasks: [task('a', { teamSize: 2, retries: 2 })] });
  const run = engine.start(project.id); await until(() => finished(run));
  assert.equal(run.calls, 2); assert.equal(run.status, 'failed'); assert.match(run.tasks[0].error, /budget/);
});

test('pause drains active calls, resume starts queued calls', async t => {
  let count = 0;
  const engine = fixture(t, async () => { count++; await delay(30); return { text: 'ok' }; });
  const project = engine.createProject({ name: 'x', agents, limits: { concurrency: 1 }, tasks: [task('a'), task('b')] });
  const run = engine.start(project.id); await until(() => count === 1);
  engine.pause(run.id); await delay(60); assert.equal(count, 1);
  engine.resume(run.id); await until(() => finished(run)); assert.equal(count, 2);
});

test('cancel stops running and queued work', async t => {
  const engine = fixture(t, async (_, { signal }) => { await delay(1000, undefined, { signal }); return { text: 'late' }; });
  const project = engine.createProject({ name: 'x', agents, limits: { concurrency: 1 }, tasks: [task('a'), task('b')] });
  const run = engine.start(project.id); await until(() => run.calls === 1);
  engine.cancel(run.id); await until(() => engine.controls.get(run.id).active.size === 0);
  assert.equal(run.status, 'cancelled'); assert.ok(run.tasks.every(t => t.status === 'cancelled'));
});

test('individual task cancellation leaves independent work running', async t => {
  const engine = fixture(t, async (_, { signal }) => { await delay(40, undefined, { signal }); return { text: 'ok' }; });
  const project = engine.createProject({ name: 'x', agents, tasks: [task('a'), task('b'), task('c', { dependsOn: ['a'] })] });
  const run = engine.start(project.id); await until(() => run.calls === 2);
  engine.cancelTask(run.id, 'a'); await until(() => finished(run));
  assert.deepEqual(run.tasks.map(t => t.status), ['cancelled', 'completed', 'blocked']);
});

test('approval gate prevents invocation until approved', async t => {
  const engine = fixture(t);
  const project = engine.createProject({ name: 'x', agents, tasks: [task('a', { requiresApproval: true })] });
  const run = engine.start(project.id); assert.equal(run.calls, 0);
  engine.approve(run.id, 'a'); await until(() => finished(run)); assert.equal(run.status, 'completed');
});

test('pipeline passes previous results to the next agent', async t => {
  const prompts = [];
  const engine = fixture(t, async (_, { prompt }) => { prompts.push(prompt); return { text: `answer-${prompts.length}` }; });
  const project = engine.createProject({ name: 'x', agents, tasks: [task('a', { agentIds: ['dev', 'qa'], mode: 'pipeline' })] });
  const run = engine.start(project.id); await until(() => finished(run)); assert.match(prompts[1], /answer-1/);
});

test('review rejects, retries with feedback, then accepts', async t => {
  let reviews = 0; const prompts = [];
  const engine = fixture(t, async (agent, { prompt }) => {
    prompts.push(prompt);
    return { text: agent.id === 'qa' ? JSON.stringify({ approved: ++reviews > 1, feedback: 'add tests' }) : 'implementation' };
  });
  const project = engine.createProject({ name: 'x', agents, tasks: [task('a', { agentIds: ['dev'], reviewerId: 'qa', retries: 1 })] });
  const run = engine.start(project.id); await until(() => finished(run));
  assert.equal(run.status, 'completed'); assert.equal(run.calls, 4); assert.match(prompts[2], /add tests/);
});

test('delegated children finish before parent synthesis and downstream tasks', async t => {
  let calls = 0;
  const engine = fixture(t, async () => ({ text: ++calls === 1 ? JSON.stringify({ subtasks: [{ title: 'Child', prompt: 'Research', skills: ['test'] }] }) : `result-${calls}` }));
  const project = engine.createProject({ name: 'x', agents, tasks: [task('parent', { allowDelegation: true }), task('next', { dependsOn: ['parent'] })] });
  const run = engine.start(project.id); await until(() => finished(run));
  assert.equal(run.status, 'completed'); assert.equal(run.tasks.length, 3); assert.equal(run.calls, 4);
  assert.equal(run.tasks[2].parentId, 'parent'); assert.equal(run.tasks[2].depth, 1);
});

test('invalid delegation does not insert partial children', async t => {
  const engine = fixture(t, async () => ({ text: JSON.stringify({ subtasks: [{ title: 'valid', prompt: 'ok' }, { title: 'bad' }] }) }));
  const project = engine.createProject({ name: 'x', agents, tasks: [task('parent', { allowDelegation: true })] });
  const run = engine.start(project.id); await until(() => finished(run)); assert.equal(run.status, 'failed'); assert.equal(run.tasks.length, 1);
});

test('workspace CLI jobs serialize across runs', async t => {
  let active = 0, peak = 0;
  const engine = fixture(t, async () => { peak = Math.max(peak, ++active); await delay(20); active--; return { text: 'ok' }; });
  const project = engine.createProject({ name: 'x', agents: [{ id: 'dev', provider: 'codex', skills: ['code'] }], tasks: [task('a'), task('b')] });
  const one = engine.start(project.id), two = engine.start(project.id);
  await until(() => finished(one) && finished(two)); assert.equal(peak, 1);
});

test('restart marks unfinished work interrupted instead of replaying edits', t => {
  const engine = fixture(t);
  const project = engine.createProject({ name: 'x', agents, tasks: [task('a', { requiresApproval: true })] });
  const run = engine.start(project.id);
  const recovered = new Store(engine.store.directory).data.runs[run.id];
  assert.equal(recovered.status, 'interrupted');
});

test('restart resumes from a clean checkpoint and leaves an interrupted writer untouched', async t => {
  const engine=fixture(t);
  const project=engine.createProject({name:'Checkpoint',workspaceMode:'isolated',workspace:engine.store.directory,
    agents:[agents[0]],tasks:[task('done'),task('remaining',{dependsOn:['done']})]});
  const snapshot={id:'checkpoint',projectId:project.id,project,status:'running',calls:1,
    events:[{id:1,type:'task.completed',taskId:'done'}],tasks:[
      {...project.tasks[0],status:'completed',depth:0,outputs:[],attempts:1,result:'Integrated'},
      {...project.tasks[1],status:'pending',depth:0,outputs:[],attempts:0}
    ]};
  engine.store.data.runs.checkpoint=snapshot;
  engine.store.data.runs.unfinished={...structuredClone(snapshot),id:'unfinished'};
  engine.store.data.runs.unfinished.tasks[1].status='running';
  engine.store.save();
  const calls=[];
  const restarted=new Engine(new Store(engine.store.directory),async(_agent,{prompt})=>{
    calls.push(prompt);return {text:'Resumed'};
  },{workspaces:{prepare:async()=>({cwd:engine.store.directory}),publish:async()=>({commit:'fixture',changed:true})}});
  const recovered=restarted.run('checkpoint');
  assert.equal(restarted.resumeCheckpoint(restarted.run('unfinished')),false);
  assert.equal(restarted.resumeCheckpoint(recovered),true);
  await until(()=>finished(recovered));
  assert.equal(recovered.status,'completed');
  assert.equal(recovered.tasks[0].result,'Integrated');
  assert.equal(recovered.calls,2);
  assert.equal(calls.length,1);
  assert.match(calls[0],/Task: remaining/);
});

test('execution has no default deadline, accepts an explicit timeout and rejects invalid values',async t=>{
  const engine=fixture(t,async(_,ctx)=>{await delay(80,undefined,{signal:ctx.signal});return{text:'completed'};});
  const project=engine.createProject({name:'No deadline',agents,tasks:[task('a')]});
  assert.equal(project.limits.timeoutMs,null);
  const run=engine.start(project.id);await until(()=>finished(run));assert.equal(run.status,'completed');
  for(const value of [0,-1,1.5,'100',undefined])assert.throws(()=>engine.createProject({name:'Invalid',agents,tasks:[task('a')],limits:{timeoutMs:value}}),/timeoutMs/);
  const limited=engine.start(engine.createProject({name:'Limited',agents,tasks:[task('a')],limits:{timeoutMs:20}}).id);
  await until(()=>finished(limited));assert.equal(limited.tasks[0].failure.code,'AGENT_TIMEOUT');assert.match(limited.tasks[0].error,/20 мс/);
});

test('an explicit execution deadline starts after acquiring the workspace slot',async t=>{
  const engine=fixture(t,async(_,ctx)=>{await delay(125,undefined,{signal:ctx.signal});return{text:'done'};});
  const project=engine.createProject({name:'Queued deadline',agents:[{id:'dev',provider:'codex',skills:['code']}],tasks:[task('a')],limits:{timeoutMs:200}});
  const first=engine.start(project.id),second=engine.start(project.id);
  await until(()=>finished(first)&&finished(second));assert.equal(first.status,'completed');assert.equal(second.status,'completed');
});
