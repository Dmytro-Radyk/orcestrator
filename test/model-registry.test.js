import test from 'node:test';
import assert from 'node:assert/strict';
import { routeDecision,chooseManager } from '../src/model-policy.js';
import { metadataRpc } from '../src/metadata-rpc.js';
import { inspectCodex,normalizeCodexMetadata,createModelRegistry,withModelPolicy } from '../scripts/model-registry.js';
import { generatePlanning } from '../scripts/planning-service.js';

const now=Date.now();
const free={id:'free:1',backend:'codex',model:'free-model',checkedAt:new Date(now-1000).toISOString(),expiresAt:new Date(now+30000).toISOString(),
  availability:'ready',billing:'free_tier',freeConfirmed:true,billingBoundary:'included_only',runtimeSupported:true,capabilities:{structuredOutput:true}};

test('no-additional-charges policy distinguishes free, included subscriptions, metered and unknown routes',()=>{
  assert.equal(routeDecision(free,{now}).allowed,true);
  const subscribed={...free,billing:'subscription_included',subscriptionConfirmed:true,includedAccessConfirmed:true};
  assert.equal(routeDecision(subscribed,{now}).allowed,true);
  for(const change of [{billing:'metered'},{billing:'unknown'},{billing:'local'},{freeConfirmed:false},{billingBoundary:'may_use_paid_credits'},
    {billingBoundary:'unknown'},{runtimeSupported:false},{availability:'quota_exhausted'},{expiresAt:new Date(now-1).toISOString()}]) {
    assert.equal(routeDecision({...free,...change},{now}).allowed,false,JSON.stringify(change));
  }
  assert.equal(routeDecision({...subscribed,subscriptionConfirmed:false},{now}).allowed,false);
  assert.equal(routeDecision({...subscribed,includedAccessConfirmed:false},{now}).allowed,false);
  assert.equal(chooseManager([{...free,id:'a'},{...free,id:'b',isDefault:true}],{now}).id,'b');
  assert.equal(chooseManager([{...free,billing:'metered'}],{now}),null);
  assert.equal(chooseManager([free],{preferredId:'unavailable',now}),null);
});

test('Codex normalization omits account identity and never infers safe billing from a subscription or zero balance',()=>{
  const source={account:{account:{type:'chatgpt',email:'PRIVATE@example.test',workspaceName:'PRIVATE WORKSPACE',planType:'plus'}},
    models:[{model:'listed-model',displayName:'Listed',isDefault:true},{model:'hidden',hidden:true}],
    limits:{rateLimits:{primary:{usedPercent:25,resetsAt:1234,windowDurationMins:300},credits:{hasCredits:false,unlimited:false,balance:'0',secret:'PRIVATE'}}}};
  const result=normalizeCodexMetadata(source);
  assert.equal(result.connection.subscriptionConfirmed,true);assert.equal(result.routes.length,1);
  assert.equal(result.routes[0].billing,'subscription_included');assert.equal(result.routes[0].billingBoundary,'unknown');
  assert.equal(routeDecision(result.routes[0]).code,'credit_reload_unknown');assert.ok(!JSON.stringify(result).includes('PRIVATE'));
  const exhausted=normalizeCodexMetadata({...source,limits:{rateLimits:{primary:{usedPercent:100}}}});
  assert.equal(exhausted.routes[0].availability,'quota_exhausted');
  const api=normalizeCodexMetadata({...source,account:{account:{type:'apiKey'}}});assert.equal(api.routes[0].billing,'metered');
  const freePlan=normalizeCodexMetadata({...source,account:{account:{type:'chatgpt',planType:'free'}}});
  assert.equal(freePlan.routes[0].freeConfirmed,false);
});

test('Codex discovery performs handshake, paginated model metadata and quota reads without starting a turn',async()=>{
  const methods=[];let acknowledged=false,closed=false;
  const result=await inspectCodex('ignored',{rpcFactory:()=>({
    async request(method,params){
      methods.push(method);if(method==='initialize')return {};
      assert.equal(acknowledged,true);
      if(method==='account/read')return {account:{type:'chatgpt',planType:'pro',email:'PRIVATE'}};
      if(method==='model/list')return params.cursor?{data:[{model:'second'}],nextCursor:null}:{data:[{model:'first'}],nextCursor:'next'};
      return {rateLimits:{primary:{usedPercent:10}}};
    },initialized(){acknowledged=true;},async close(){closed=true;}
  })});
  assert.deepEqual(methods,['initialize','account/read','model/list','model/list','account/rateLimits/read']);
  assert.equal(closed,true);assert.equal(result.routes.length,2);assert.equal(result.connection.plan,'pro');
});

test('Codex allows the full five-hour and weekly allowances while enforcing the reserve for other windows',()=>{
  const weekly={usedPercent:99,windowDurationMins:10080};
  const short={usedPercent:99,windowDurationMins:300};
  const decision=rateLimits=>routeDecision(normalizeCodexMetadata({
    account:{account:{type:'chatgpt',planType:'plus'}},models:[{model:'model'}],
    limits:{rateLimits:{...rateLimits,credits:{hasCredits:false,unlimited:false,balance:'0'}}}
  },{autoReloadDisabled:true}).routes[0]);
  assert.equal(decision({primary:short,secondary:weekly}).allowed,true);
  assert.equal(decision({primary:weekly}).allowed,true);
  assert.equal(decision({primary:{...short,usedPercent:100},secondary:weekly}).code,'quota_exhausted');
  assert.equal(decision({primary:{usedPercent:90}}).code,'quota_reserve');
  assert.equal(decision({primary:short,secondary:{...weekly,usedPercent:100}}).code,'quota_exhausted');
  assert.equal(decision({primary:weekly,rateLimitReachedType:'rate_limit'}).code,'quota_exhausted');
});

test('a discovery deadline rejects with a timeout reason instead of a successful completion message',async()=>{
  let rejectRequest,closeReason;
  await assert.rejects(inspectCodex('ignored',{timeoutMs:10,rpcFactory:()=>({
    request:()=>new Promise((resolve,reject)=>{rejectRequest=reject;}),initialized(){},
    async close(reason){if(reason){closeReason=reason;rejectRequest(reason);}}
  })}),error=>error.code==='METADATA_TIMEOUT'&&!error.message.includes('завершено'));
  assert.equal(closeReason.code,'METADATA_TIMEOUT');
});

test('scan coalesces concurrent requests, persists sanitized data and does not trust a cached authorization',async()=>{
  const store={data:{},save(){}};let probes=0,finds=0;
  const registry=createModelRegistry({store,env:{},find:async name=>{finds++;return name==='codex'?'/trusted/codex':null;},inspect:async()=>{
    probes++;await new Promise(resolve=>setTimeout(resolve,10));return normalizeCodexMetadata({account:{account:{type:'chatgpt',planType:'plus',email:'PRIVATE'}},models:[{model:'model'}],limits:{rateLimits:{primary:{usedPercent:5}}}});
  }});
  const [a,b]=await Promise.all([registry.scan(),registry.scan()]);
  assert.equal(probes,1);assert.equal(finds,5);assert.equal(a.scanning,false);assert.equal(b.scanning,false);
  assert.equal(store.data.catalog.connections.length,5);assert.ok(!JSON.stringify(store.data).includes('PRIVATE'));
  assert.ok(!JSON.stringify(store.data).includes('/trusted/codex'));
  await assert.rejects(registry.requireRoute('codex:model'),/Automatic reload/);assert.equal(probes,2);
});

test('Codex inference skips unrelated provider discovery but still makes a fresh subscription check',async()=>{
  const store={data:{},save(){}};
  let finds=0,probes=0,calls=0;
  const registry=createModelRegistry({store,env:{ORCHESTRATOR_CODEX_AUTO_RELOAD_DISABLED:'1'},
    find:async name=>{finds++;return name==='codex'?'/trusted/codex':null;},
    inspect:async(_command,options)=>{
      probes++;
      return normalizeCodexMetadata({account:{account:{type:'chatgpt',planType:'plus'}},models:[{model:'model'}],
        limits:{rateLimits:{primary:{usedPercent:probes===3?100:99,windowDurationMins:300},credits:{hasCredits:false,unlimited:false,balance:'0'}}}},options);
    }});
  await registry.scan();
  const execute=withModelPolicy(registry,async()=>{calls++;return {text:'ok'};});
  const signal=new AbortController().signal;
  const agent={provider:'codex',model:'model'};
  assert.equal((await execute(agent,{signal})).text,'ok');
  await assert.rejects(execute(agent,{signal}),error=>error.decisionCode==='quota_exhausted');
  assert.equal(calls,1);assert.equal(probes,3);assert.equal(finds,5);
});

test('provider and planner guards stop disallowed calls before invoking a model',async()=>{
  let calls=0,checks=0;
  const guarded=withModelPolicy({async requireRoute(){checks++;throw Error('Оплата не підтверджена');}},async()=>{calls++;return{text:'demo'};});
  await assert.rejects(guarded({provider:'codex',model:'x'},{}),/Оплата/);
  await assert.rejects(guarded({provider:'responses',model:'x'},{}),/списань/);
  assert.equal(calls,0);assert.equal(checks,1);
  await guarded({provider:'demo'},{});assert.equal(calls,1);
  await assert.rejects(generatePlanning('idea',{name:'Test',description:'Test'},
    {configured:true,provider:'codex',agent:{provider:'codex',model:'x'},authorize:async()=>{throw Error('Billing blocked');}},async()=>{calls++;}),/Billing blocked/);
  assert.equal(calls,1);
});

test('read-only metadata transport rejects inference and server tool requests, handles JSONL and closes its process',async()=>{
  const script=`import{createInterface}from'node:readline';
    createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);
      if(m.method==='initialize'){
        process.stdout.write(JSON.stringify({id:88,method:'item/tool/call',params:{}})+'\\n');
        const response=JSON.stringify({id:m.id,result:{ready:true}});process.stdout.write(response.slice(0,10));setTimeout(()=>process.stdout.write(response.slice(10)+'\\n'),5);
      }else if(m.id===88){if(m.error?.code!==-32601)process.exit(3);}
      else if(m.method==='account/read')process.stdout.write(JSON.stringify({id:m.id,result:{account:null}})+'\\n');
    });`;
  const rpc=metadataRpc(process.execPath,['--input-type=module','-e',script],{cwd:process.cwd(),timeoutMs:1000});
  try {
    await assert.rejects(rpc.request('turn/start',{}),/заборонено/);
    assert.equal((await rpc.request('initialize',{})).ready,true);rpc.initialized();
    assert.equal((await rpc.request('account/read',{})).account,null);
  }finally{await rpc.close();}
});

test('metadata close preserves the actual interruption reason and rejects new work while closing',async()=>{
  const rpc=metadataRpc(process.execPath,['--input-type=module','-e',"process.stdin.resume();setInterval(()=>{},1000)"],{cwd:process.cwd(),timeoutMs:2000});
  const reason=Object.assign(Error('Discovery deadline exceeded'),{code:'METADATA_TIMEOUT'});
  const rejected=assert.rejects(rpc.request('initialize'),error=>error===reason);
  const closing=rpc.close(reason);
  try{await rejected;await assert.rejects(rpc.request('account/read'),/закрито/);await Promise.all([closing,rpc.close()]);}
  finally{await rpc.close();}
});
