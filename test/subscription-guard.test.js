import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { SubscriptionGuard } from '../scripts/subscription-guard.js';
import { normalizeCodexMetadata,withModelPolicy,createModelRegistry } from '../scripts/model-registry.js';
import { routeDecision } from '../src/model-policy.js';
import { subscriptionEnvironment } from '../src/providers.js';

function metadata(change={}) {
  return {account:{account:{type:'chatgpt',planType:'plus'}},models:[{model:'model'}],limits:{rateLimits:{primary:{usedPercent:10},credits:{hasCredits:false,unlimited:false,balance:'0'},...change}}};
}
const allowed=()=>normalizeCodexMetadata(metadata(),{autoReloadDisabled:true}).routes[0];
async function until(fn){for(let n=0;n<400;n++){if(fn())return;await delay(5);}throw Error('Timed out');}

test('a verified subscription requires declared disabled auto reload, known unused quota and no extra credits; it remains distinct from free',()=>{
  const route=allowed();assert.equal(route.billing,'subscription_included');assert.equal(route.freeConfirmed,false);
  assert.equal(route.billingBoundary,'subscription_quota_guarded');assert.equal(routeDecision(route).allowed,true);
  assert.equal(routeDecision(normalizeCodexMetadata(metadata()).routes[0]).allowed,false);
  for(const change of [{credits:null},{credits:{hasCredits:true,unlimited:false,balance:'10'}},{credits:{hasCredits:false,unlimited:true,balance:'0'}},
    {credits:{hasCredits:false,unlimited:false,balance:''}},{primary:{usedPercent:90}},{primary:{usedPercent:NaN}},
    {primary:{usedPercent:10},secondary:{usedPercent:100}},{primary:null}]) {
    assert.equal(routeDecision(normalizeCodexMetadata(metadata(change),{autoReloadDisabled:true}).routes[0]).allowed,false,JSON.stringify(change));
  }
  const api=metadata();api.account.account.type='apiKey';assert.equal(routeDecision(normalizeCodexMetadata(api,{autoReloadDisabled:true}).routes[0]).allowed,false);
  assert.equal(routeDecision({...route,subscriptionGuard:{...route.subscriptionGuard,autoReloadDisabled:false}}).allowed,false);
});

test('subscription gate serializes inference across models, rechecks after waiting and cancels queued calls',async()=>{
  const guard=new SubscriptionGuard({intervalMs:1000}),signal=AbortSignal.timeout(5000);let active=0,peak=0,started=0,finish,checks=0;
  const operation=async()=>{started++;active++;peak=Math.max(peak,active);await new Promise(r=>{finish=r;});active--;return 'done';};
  const run=()=>guard.run({signal,authorize:async()=>{checks++;return allowed();},invoke:operation});
  const first=run();await until(()=>started===1);const second=run();
  const queued=new AbortController();const cancelled=guard.run({signal:queued.signal,authorize:async()=>allowed(),invoke:operation});
  const rejection=assert.rejects(cancelled,/cancelled/);queued.abort(Error('queued cancelled'));await rejection;
  assert.equal(started,1);finish();assert.equal(await first,'done');await until(()=>started===2);finish();await second;
  assert.equal(peak,1);assert.equal(checks,2);assert.equal(guard.busy,false);assert.equal(guard.waiters.length,0);
});

test('a subscription invocation aborts if credits appear or quota reaches the reserve threshold',async()=>{
  for(const unsafe of [{...allowed(),subscriptionGuard:{...allowed().subscriptionGuard,paidCreditsAbsent:false}},
    {...allowed(),quota:{primary:{usedPercent:90}}}]) {
    const guard=new SubscriptionGuard({intervalMs:5});let changed=false,started=false,event;
    const run=guard.run({signal:AbortSignal.timeout(3000),authorize:async()=>changed?unsafe:allowed(),onEvent:e=>{event=e;},
      invoke:async(route,signal)=>{started=true;return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));}});
    const rejected=assert.rejects(run);await until(()=>started);changed=true;await rejected;assert.match(event.message,/зупинено/);assert.equal(guard.busy,false);
  }
});

test('policy wrapper cannot run a subscription without its gate and forces the trusted runtime, auth and clean configuration',async()=>{
  const route={...allowed(),command:'trusted-codex'};let invoked=false;
  const registry={requireRoute:async()=>route};
  await assert.rejects(withModelPolicy(registry,async()=>{invoked=true;})({provider:'codex',model:'model'},{signal:AbortSignal.timeout(1000)}),/не підключений/);
  assert.equal(invoked,false);
  const gate=new SubscriptionGuard();registry.guardSubscription=o=>gate.run(o);
  const output=await withModelPolicy(registry,async(a,c)=>{assert.equal(a.subscriptionOnly,true);assert.equal(a.ignoreUserConfig,true);assert.equal(a.command,'trusted-codex');assert.ok(c.signal);return{text:'done'};})
    ({provider:'codex',model:'model',subscriptionOnly:false,ignoreUserConfig:false,command:'forged'},{signal:AbortSignal.timeout(1000)});
  assert.equal(output.text,'done');
  assert.deepEqual(subscriptionEnvironment({PATH:'runtime',USERPROFILE:'profile',CODEX_HOME:'auth-location',OPENAI_API_KEY:'PRIVATE',CODEX_API_KEY:'PRIVATE',OPENAI_BASE_URL:'evil',NODE_OPTIONS:'evil'}),
    {PATH:'runtime',USERPROFILE:'profile',CODEX_HOME:'auth-location'});
});

test('removing operator confirmation disables cached subscription permissions immediately',()=>{
  const store={data:{catalog:{routes:[allowed()],connections:[]}},save(){}};
  assert.equal(createModelRegistry({store,env:{}}).snapshot().routes[0].decision.allowed,false);
  assert.equal(createModelRegistry({store,env:{ORCHESTRATOR_CODEX_AUTO_RELOAD_DISABLED:'1'}}).snapshot().routes[0].decision.allowed,true);
});

test('a provider cannot report success after the subscription guard revoked access',async()=>{
  const guard=new SubscriptionGuard({intervalMs:5});let checks=0;
  await assert.rejects(guard.run({signal:AbortSignal.timeout(3000),authorize:async()=>{
    if(++checks>1)throw Error('metadata offline');return allowed();
  },invoke:async(route,signal)=>{await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));return{text:'ignored abort'};}}),
  error=>error.code==='MODEL_ACCESS_BLOCKED'&&error.decisionCode==='subscription_check_failed');
  await assert.rejects(guard.run({signal:AbortSignal.timeout(1000),authorize:async()=>{throw Error('preflight offline');},invoke:async()=>{throw Error('must not invoke');}}),
    error=>error.code==='MODEL_ACCESS_BLOCKED');
});
