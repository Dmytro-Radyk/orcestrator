import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile,readFile,access,rm} from 'node:fs/promises';
import {resolve,join,relative,isAbsolute} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {Engine} from '../src/engine.js';
import {Store} from '../src/store.js';
import {WorkspaceManager} from '../src/workspaces.js';
import {SubscriptionGuard} from '../scripts/subscription-guard.js';
import {normalizeCodexMetadata,withModelPolicy} from '../scripts/model-registry.js';
import {routeDecision,modelAccessError} from '../src/model-policy.js';

for(const reason of ['quota','credits','metadata'])test(`mixed execution preserves accepted files and completes independent free work when subscription ${reason} blocks`,async t=>{
  const owned=resolve('.orchestrator/tests');await mkdir(owned,{recursive:true});const root=await mkdtemp(join(owned,'mixed-')),workspace=join(root,'project');await mkdir(workspace);
  await writeFile(join(workspace,'accepted.txt'),'original');
  const base=normalizeCodexMetadata({account:{account:{type:'chatgpt',planType:'plus'}},models:[{model:'model'}],
    limits:{rateLimits:{primary:{usedPercent:5},credits:{hasCredits:false,unlimited:false,balance:'0'}}}},{autoReloadDisabled:true}).routes[0];
  const free={id:'opencode:opencode/free',backend:'opencode',model:'opencode/free',billing:'free_tier',freeConfirmed:true,billingBoundary:'included_only',runtimeSupported:true,availability:'ready',checkedAt:base.checkedAt,expiresAt:base.expiresAt,capabilities:{workspaceWrite:true}};
  let revoked=false,paidCalls=0,freeCalls=0,engine;
  const gate=new SubscriptionGuard({intervalMs:10});
  const registry={guardSubscription:o=>gate.run(o),requireRoute:async id=>{
    if(id===free.id)return {...free,command:'fake-free'};
    if(revoked&&reason==='metadata')throw Error('Metadata became unavailable');
    const route=structuredClone(base);
    if(revoked&&reason==='quota')route.quota.primary.usedPercent=90;
    if(revoked&&reason==='credits')route.subscriptionGuard.paidCreditsAbsent=false;
    const decision=routeDecision(route);if(!decision.allowed)throw modelAccessError(decision);return {...route,command:'fake-subscription'};
  }};
  engine=new Engine(new Store(join(root,'data')),withModelPolicy(registry,async(agent,ctx)=>{
    if(agent.provider==='codex'){
      paidCalls++;await writeFile(join(ctx.cwd,'accepted.txt'),'unaccepted');await writeFile(join(ctx.cwd,'partial.txt'),'partial');revoked=true;
      // Deliberately return success after abort; neither guard nor engine may accept it.
      await new Promise(resolve=>ctx.signal.aborted?resolve():ctx.signal.addEventListener('abort',resolve,{once:true}));return{text:'must not integrate'};
    }
    freeCalls++;await writeFile(join(ctx.cwd,'README.md'),'independent free work');return{text:'free work complete'};
  }),{workspaces:new WorkspaceManager(join(root,'worktrees'))});
  t.after(async()=>{for(const run of Object.values(engine.store.data.runs)){if(['running','paused'].includes(run.status))engine.cancel(run.id);await Promise.all(engine.controls.get(run.id)?.active.values()??[]);}
    const rel=relative(owned,root);assert.ok(rel&&!rel.startsWith('..')&&!isAbsolute(rel));await rm(root,{recursive:true,force:true});});
  const agents=[{id:'sub',provider:'codex',model:'model',skills:[]},{id:'free',provider:'opencode',model:'opencode/free',skills:[],access:'workspace-write',fileWorker:true}];
  const task=(id,agent,dependsOn=[])=>({id,title:id,prompt:id,agentIds:[agent],dependsOn,retries:3});
  const run=engine.start(engine.createProject({name:'mixed failure',workspace,workspaceMode:'isolated',agents,
    tasks:[task('paid','sub'),task('independent','free'),task('dependent','free',['paid'])],limits:{concurrency:2,maxCalls:8}}).id);
  for(let n=0;n<1500&&['running','paused'].includes(run.status);n++)await delay(10);
  assert.equal(run.status,'failed');assert.equal(paidCalls,1);assert.equal(freeCalls,1);
  assert.equal(run.tasks[0].status,'blocked');assert.equal(run.tasks[0].attempts,1);assert.equal(run.tasks[1].status,'completed');assert.equal(run.tasks[2].status,'blocked');
  assert.equal(run.tasks[0].blockedReason,{quota:'quota_reserve',credits:'paid_credits_available',metadata:'subscription_check_failed'}[reason]);
  assert.equal(await readFile(join(workspace,'accepted.txt'),'utf8'),'original');await assert.rejects(access(join(workspace,'partial.txt')));
  assert.equal(await readFile(join(workspace,'README.md'),'utf8'),'independent free work');
  assert.equal(run.events.some(e=>e.type==='task.retrying'),false);assert.ok(run.events.some(e=>e.kind==='subscription.guard'));
});
