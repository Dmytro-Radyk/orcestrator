import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,writeFile,readFile,rm,access } from 'node:fs/promises';
import { resolve,join,relative,isAbsolute } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { WorkspaceManager } from '../src/workspaces.js';

async function setup(t,provider,options={}) {
  const root=resolve('.orchestrator/tests');await mkdir(root,{recursive:true});const dir=await mkdtemp(join(root,'isolation-')),workspace=join(dir,'projects','project');await mkdir(workspace,{recursive:true});
  const manager=new WorkspaceManager(join(dir,'jobs'),{allowedRoot:join(dir,'projects')});
  const engine=new Engine(new Store(join(dir,'data')),provider,{workspaces:manager,...options});
  t.after(async()=>{for(const r of Object.values(engine.store.data.runs))if(['running','paused'].includes(r.status))engine.cancel(r.id);
    const rel=relative(root,dir);assert.ok(rel&&!rel.startsWith('..')&&!isAbsolute(rel));await rm(dir,{recursive:true,force:true});});
  const agents=[{id:'worker',provider:'codex',model:'test',skills:['code']},{id:'review',provider:'codex',model:'test-review',skills:['review']}];
  const start=tasks=>engine.start(engine.createProject({name:'Isolated project',workspace,workspaceMode:'isolated',agents,tasks,limits:{maxDepth:1}}).id);
  return {engine,workspace,manager,start};
}
const task=(id,change={})=>({id,title:id,prompt:`Task ${id}`,agentIds:['worker'],skills:['code'],...change});
async function settled(run){for(let n=0;n<1500;n++){if(!['running','paused'].includes(run.status))return;await delay(10);}throw Error('Workspace run timed out');}

test('independent file tasks execute concurrently in separate worktrees and dependent work sees both integrated results',async t=>{
  let active=0,peak=0,arrived=0,release;const gate=new Promise(r=>{release=r;}),paths=[];
  const f=await setup(t,async(a,ctx)=>{
    const id=/Task: ([abc])\n/.exec(ctx.prompt)[1];paths.push(ctx.cwd);
    if(id!=='c'){active++;peak=Math.max(peak,active);if(++arrived===2)release();await gate;await writeFile(join(ctx.cwd,`${id}.txt`),id);active--;}
    else{assert.equal(await readFile(join(ctx.cwd,'a.txt'),'utf8'),'a');assert.equal(await readFile(join(ctx.cwd,'b.txt'),'utf8'),'b');await writeFile(join(ctx.cwd,'c.txt'),'integrated');}
    return {text:'done'};
  });
  const run=f.start([task('a'),task('b'),task('c',{dependsOn:['a','b']})]);await settled(run);
  assert.equal(run.status,'completed',JSON.stringify(run.tasks.map(t=>t.error)));assert.equal(peak,2);assert.equal(new Set(paths).size,3);
  assert.equal(await readFile(join(f.workspace,'c.txt'),'utf8'),'integrated');assert.equal(await f.manager.git(f.workspace,['status','--porcelain']),'');
});

test('conflicting task results block integration without overwriting the first accepted result or retrying blindly',async t=>{
  let arrivals=0,release;const gate=new Promise(r=>{release=r;});
  const f=await setup(t,async(a,ctx)=>{const id=/Task: ([ab])\n/.exec(ctx.prompt)[1];if(++arrivals===2)release();await gate;await writeFile(join(ctx.cwd,'shared.txt'),id);return{text:'candidate'};});
  await writeFile(join(f.workspace,'shared.txt'),'base');const run=f.start([task('a',{retries:2}),task('b',{retries:2})]);await settled(run);
  assert.equal(run.status,'blocked');assert.equal(run.tasks.filter(t=>t.status==='blocked').length,1);assert.equal(run.calls,2);
  const blocked=run.tasks.find(t=>t.status==='blocked');assert.match(blocked.error,/Конфлікт/);assert.ok(['a','b'].includes(await readFile(join(f.workspace,'shared.txt'),'utf8')));
  assert.equal(await f.manager.git(f.workspace,['status','--porcelain']),'');assert.notEqual(await readFile(join(blocked.workspace.path,'shared.txt'),'utf8'),await readFile(join(f.workspace,'shared.txt'),'utf8'));
});

test('review failure keeps candidate files out of the accepted project workspace',async t=>{
  const f=await setup(t,async(a,ctx)=>{if(a.id==='review'){assert.equal(await readFile(join(ctx.cwd,'candidate.txt'),'utf8'),'candidate');return{text:'{"approved":false,"feedback":"reject"}'};}
    await writeFile(join(ctx.cwd,'candidate.txt'),'candidate');return{text:'done'};});
  const run=f.start([task('a',{reviewerId:'review'})]);await settled(run);assert.equal(run.status,'failed');
  await assert.rejects(access(join(f.workspace,'candidate.txt')));assert.equal(await readFile(join(run.tasks[0].workspace.path,'candidate.txt'),'utf8'),'candidate');
});

for(const budget of [2,4])test(`automatic integration reconciliation respects call budget ${budget} and preserves both results`,async t=>{
  let arrivals=0,release,resolutions=0;const gate=new Promise(r=>{release=r;});
  const f=await setup(t,async(a,ctx)=>{
    const id=/Task: ([ab])\n/.exec(ctx.prompt)[1];
    if(ctx.prompt.includes('Integration reconciliation:')){
      resolutions++;assert.equal(ctx.canDelegate,false);
      assert.match(await readFile(join(ctx.cwd,'shared.txt'),'utf8'),/<<<<<<< HEAD/);
      assert.equal(await readFile(join(ctx.cwd,'a.txt'),'utf8'),'a');assert.equal(await readFile(join(ctx.cwd,'b.txt'),'utf8'),'b');
      await writeFile(join(ctx.cwd,'shared.txt'),'a+b');return{text:'Combined result verified'};
    }
    if(++arrivals===2)release();await gate;await writeFile(join(ctx.cwd,'shared.txt'),id);await writeFile(join(ctx.cwd,`${id}.txt`),id);return{text:'Verified individual result'};
  },{maxIntegrationRetries:1});
  await writeFile(join(f.workspace,'shared.txt'),'base');
  const run=f.start([task('a'),task('b')]);run.project.limits.maxCalls=budget;await settled(run);
  assert.equal(run.status,budget===2?'blocked':'completed',JSON.stringify(run.tasks.map(t=>t.error)));
  assert.equal(run.calls,budget===2?2:3);assert.equal(resolutions,budget===2?0:1);
  if(budget===4){assert.equal(await readFile(join(f.workspace,'shared.txt'),'utf8'),'a+b');assert.ok(run.events.some(e=>e.type==='workspace.resolving'));assert.ok(run.tasks.some(t=>t.history?.some(h=>h.reason==='integration-conflict')));}
  assert.equal(await f.manager.git(f.workspace,['status','--porcelain']),'');
});

test('automatic reconciliation stops after a second conflict without overwriting newly accepted changes',async t=>{
  let arrivals=0,release,resolutions=0;const gate=new Promise(r=>{release=r;});
  const f=await setup(t,async(a,ctx)=>{
    const id=/Task: ([ab])\n/.exec(ctx.prompt)[1];
    if(ctx.prompt.includes('Integration reconciliation:')){
      resolutions++;await writeFile(join(ctx.cwd,'shared.txt'),'combined');
      await writeFile(join(f.workspace,'shared.txt'),'newly accepted edit');
      await f.manager.git(f.workspace,['add','shared.txt']);await f.manager.git(f.workspace,['commit','-m','Simulate concurrent accepted edit']);
      return{text:'Combined draft verified'};
    }
    if(++arrivals===2)release();await gate;await writeFile(join(ctx.cwd,'shared.txt'),id);return{text:'Verified candidate'};
  },{maxIntegrationRetries:1});
  await writeFile(join(f.workspace,'shared.txt'),'base');const run=f.start([task('a'),task('b')]);await settled(run);
  assert.equal(run.status,'blocked');assert.equal(run.calls,3);assert.equal(resolutions,1);
  assert.equal(run.tasks.find(t=>t.status==='blocked').failure.code,'WORKSPACE_CONFLICT');
  assert.equal(await readFile(join(f.workspace,'shared.txt'),'utf8'),'newly accepted edit');
});

test('clarification resolves a committed conflict in a fresh worktree and reruns verification before dependencies',async t=>{
  let arrivals=0,release;const gate=new Promise(r=>{release=r;});let resolutions=0;
  const f=await setup(t,async(a,ctx)=>{
    const id=/Task: ([abc])\n/.exec(ctx.prompt)[1];
    if(ctx.prompt.includes('Combine both verified edits')){
      resolutions++;assert.match(await readFile(join(ctx.cwd,'shared.txt'),'utf8'),/<<<<<<< HEAD/);
      assert.equal(await readFile(join(ctx.cwd,'a.txt'),'utf8'),'a');assert.equal(await readFile(join(ctx.cwd,'b.txt'),'utf8'),'b');
      await writeFile(join(ctx.cwd,'shared.txt'),'a+b\n');await writeFile(join(ctx.cwd,'formatting.txt'),'  \ntext with harmless spaces  \n\n');return{text:'Combined and verified'};
    }
    if(id==='c'){assert.equal(await readFile(join(ctx.cwd,'shared.txt'),'utf8'),'a+b\n');return{text:'Dependency sees verified integration'};}
    if(++arrivals===2)release();await gate;await writeFile(join(ctx.cwd,'shared.txt'),id);await writeFile(join(ctx.cwd,`${id}.txt`),id);return{text:'Checked candidate'};
  });
  await writeFile(join(f.workspace,'shared.txt'),'base');
  const run=f.start([task('a'),task('b'),task('c',{dependsOn:['a','b']})]);await settled(run);
  assert.equal(run.status,'blocked');assert.equal(run.calls,2);assert.equal(f.engine.canClarify(run),true);
  const blocked=run.tasks.find(t=>t.failure?.code==='WORKSPACE_CONFLICT'),originalPath=blocked.workspace.path;
  assert.equal(blocked.workspace.candidateCommit,await f.manager.git(originalPath,['rev-parse','HEAD']));
  await assert.rejects(f.manager.resolveDraft(run,{...blocked.workspace,candidateCommit:'f'.repeat(40)},blocked.id),/Commit/);
  const legacy={...blocked.workspace};delete legacy.candidateCommit;
  const restored=await f.manager.resume(run,legacy,{committed:true});assert.equal(restored.baseCommit,blocked.workspace.candidateCommit);
  const lease=await f.manager.resolveDraft(run,blocked.workspace,blocked.id);assert.notEqual(lease.cwd,originalPath);assert.deepEqual(lease.conflicts,['shared.txt']);
  await assert.rejects(f.manager.publish(lease),error=>error.code==='WORKSPACE_CHECK_FAILED');
  assert.notEqual(await readFile(join(f.workspace,'shared.txt'),'utf8'),await readFile(join(lease.cwd,'shared.txt'),'utf8'));
  f.engine.clarify(run.id,{taskId:blocked.id,answer:'Combine both verified edits and rerun checks.',lease});await settled(run);
  assert.equal(run.status,'completed',JSON.stringify(run.tasks.map(t=>t.error)));assert.equal(resolutions,1);assert.equal(run.calls,4);
  assert.equal(await readFile(join(f.workspace,'shared.txt'),'utf8'),'a+b\n');assert.equal(await f.manager.git(f.workspace,['status','--porcelain']),'');
});

test('bounded real delegation creates isolated children and synthesizes their integrated results',async t=>{
  const f=await setup(t,async(a,ctx)=>{
    const id=/Task: ([a-z]+)\n/.exec(ctx.prompt)[1];
    if(id==='parent'&&ctx.canDelegate)return{text:'delegate',delegation:[{title:'childa',prompt:'a',skills:['code']},{title:'childb',prompt:'b',skills:['code']}]};
    if(id==='parent'){assert.equal(ctx.canDelegate,false);assert.equal(await readFile(join(ctx.cwd,'childa.txt'),'utf8'),'childa');assert.equal(await readFile(join(ctx.cwd,'childb.txt'),'utf8'),'childb');}
    await writeFile(join(ctx.cwd,`${id}.txt`),id);return{text:'done'};
  });
  const run=f.start([task('parent',{allowDelegation:true})]);await settled(run);
  assert.equal(run.status,'completed',JSON.stringify(run.tasks.map(t=>t.error)));assert.equal(run.tasks.length,3);assert.equal(run.calls,4);
  assert.equal(run.tasks.filter(t=>t.depth===1).length,2);assert.ok(run.tasks.filter(t=>t.parentId).every(t=>t.workspace?.commit));
});

test('reported files cannot be silently discarded by a generated gitignore',async t=>{
  const f=await setup(t,async(a,ctx)=>{await writeFile(join(ctx.cwd,'.gitignore'),'*\n');await writeFile(join(ctx.cwd,'result.txt'),'required');
    return{text:'done',report:{files:['.gitignore','result.txt']}};});
  const run=f.start([task('a')]);await settled(run);assert.equal(run.status,'completed');assert.equal(await readFile(join(f.workspace,'result.txt'),'utf8'),'required');
});

test('a reported folder summarizes normal changes without force-adding ignored files',async t=>{
  const f=await setup(t,async(a,ctx)=>{
    await mkdir(join(ctx.cwd,'covers'));
    await writeFile(join(ctx.cwd,'.gitignore'),'covers/*.tmp\n');
    await writeFile(join(ctx.cwd,'covers','cover.jpg'),'cover');
    await writeFile(join(ctx.cwd,'covers','scratch.tmp'),'scratch');
    return {text:'done',report:{files:['covers/']}};
  });
  const run=f.start([task('a')]);
  await settled(run);
  assert.equal(run.status,'completed');
  assert.equal(await readFile(join(f.workspace,'covers','cover.jpg'),'utf8'),'cover');
  await assert.rejects(access(join(f.workspace,'covers','scratch.tmp')),{code:'ENOENT'});
});

test('local verification resumes a shared pipeline at its next agent before integration',async t=>{
  const invoked=[];
  const command='node --test tests/http.test.mjs';
  const f=await setup(t,async(agent,{cwd,prompt})=>{
    invoked.push(agent.id);
    if(agent.id==='worker'){
      await writeFile(join(cwd,'draft.txt'),'prepared');
      throw Object.assign(Error('Loopback unavailable'),{code:'AGENT_BLOCKED',report:{status:'blocked',
        summary:'Prepared checkout',files:['draft.txt'],checks:[{command,status:'failed',required:true,details:'EACCES 127.0.0.1'}]}});
    }
    assert.equal(await readFile(join(cwd,'draft.txt'),'utf8'),'prepared');
    assert.match(prompt,/Prepared checkout/);
    await writeFile(join(cwd,'review.txt'),'verified');
    return {text:'Reviewed in the same worktree'};
  });
  const run=f.start([task('a',{agentIds:['worker','review'],mode:'pipeline'})]);
  await settled(run);
  const entry=f.engine.hostVerificationTask(run,'a');
  assert.ok(entry);
  const lease=await f.manager.resume(run,entry.workspace);
  lease.files=entry.blockedReport.files;
  const signal=new AbortController().signal;
  const tree=await f.manager.candidateTree(lease,signal);
  await f.engine.acceptHostVerification(run,entry,lease,tree,[{command,status:'passed',required:true,source:'host'}],signal);
  await settled(run);
  assert.equal(run.status,'completed');
  assert.deepEqual(invoked,['worker','review']);
  assert.ok(run.events.some(event=>event.type==='task.pipeline_step_verified'));
  assert.equal(await readFile(join(f.workspace,'review.txt'),'utf8'),'verified');
});

test('cancellation retains partial changes only in the isolated candidate workspace',async t=>{
  let started=false;const f=await setup(t,async(a,ctx)=>{await writeFile(join(ctx.cwd,'partial.txt'),'partial');started=true;
    await new Promise((resolve,reject)=>ctx.signal.addEventListener('abort',()=>reject(ctx.signal.reason),{once:true}));});
  const run=f.start([task('a')]);for(let n=0;n<1000&&!started;n++)await delay(10);assert.equal(started,true);f.engine.cancel(run.id);
  await Promise.all(f.engine.controls.get(run.id).active.values());await assert.rejects(access(join(f.workspace,'partial.txt')));
  assert.equal(await readFile(join(run.tasks[0].workspace.path,'partial.txt'),'utf8'),'partial');
});

test('parallel agents in one task use independent branches before their reviewed result is accepted',async t=>{
  let arrivals=0,release;const gate=new Promise(r=>{release=r;}),paths=[];
  const f=await setup(t,async(a,ctx)=>{if(a.id==='review'){paths.push(ctx.cwd);if(++arrivals===2)release();await gate;await writeFile(join(ctx.cwd,'review.txt'),'independent');}
    else{paths.push(ctx.cwd);if(++arrivals===2)release();await gate;await writeFile(join(ctx.cwd,'worker.txt'),'independent');}return{text:'done'};});
  const run=f.start([task('a',{agentIds:['worker','review'],mode:'parallel'})]);await settled(run);assert.equal(run.status,'completed');assert.notEqual(paths[0],paths[1]);
  assert.equal(await readFile(join(f.workspace,'worker.txt'),'utf8'),'independent');assert.equal(await readFile(join(f.workspace,'review.txt'),'utf8'),'independent');
});
