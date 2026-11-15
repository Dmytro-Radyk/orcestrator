import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,readFile,rm } from 'node:fs/promises';
import { join,resolve,relative,isAbsolute } from 'node:path';
import { opencodeEnvironment,normalizeOpenCodeMetadata,inspectOpenCode,executeOpenCode,supportedVersion } from '../scripts/opencode-service.js';
import { routeDecision,chooseManager } from '../src/model-policy.js';
import { createModelRegistry,withModelPolicy } from '../scripts/model-registry.js';

const tier={input:0,output:0,cache:{read:0,write:0}};
const model=(change={})=>({id:'test-free',providerID:'opencode',name:'Test model',enabled:true,status:'active',cost:[tier],
  capabilities:{tools:true,input:['text'],output:['text']},limit:{context:32000,output:4000},...change});
async function directory(t) {
  const base=resolve('.orchestrator/tests');await mkdir(base,{recursive:true});const home=await mkdtemp(join(base,'opencode-'));
  t.after(async()=>{const rel=relative(base,home);assert.ok(rel&&!rel.startsWith('..')&&!isAbsolute(rel));await rm(home,{recursive:true,force:true});});return home;
}

test('OpenCode free entitlement requires anonymous isolation and zero prices for every token tier and cache operation',()=>{
  const changes=[{cost:[{...tier,output:1}]},{cost:[{...tier,cache:{read:0,write:1}}]},
    {cost:[tier,{...tier,input:1,tier:{type:'context',size:10000}}]},{cost:[]},{cost:[{input:0,output:0}]},{providerID:'custom'}];
  const good=normalizeOpenCodeMetadata([model()],{isolated:true});
  assert.equal(routeDecision(good.routes[0]).allowed,true);assert.equal(chooseManager(good.routes).id,good.routes[0].id);
  assert.equal(good.routes[0].capabilities.workspaceWrite,false);assert.equal(good.connection.requiresAuth,false);
  for(const change of changes)assert.equal(routeDecision(normalizeOpenCodeMetadata([model(change)],{isolated:true}).routes[0]).allowed,false,JSON.stringify(change));
  assert.equal(routeDecision(normalizeOpenCodeMetadata([model()],{isolated:false}).routes[0]).allowed,false);
  assert.equal(routeDecision(normalizeOpenCodeMetadata([model({enabled:false})],{isolated:true}).routes[0]).allowed,false);
});

test('OpenCode metadata never persists provider keys, headers or request body',()=>{
  const value=normalizeOpenCodeMetadata([model({settings:{apiKey:'PRIVATE'},headers:{authorization:'PRIVATE'},body:{secret:'PRIVATE'}})],{isolated:true});
  assert.ok(!JSON.stringify(value).includes('PRIVATE'));assert.equal(value.routes[0].pricing[0].output,0);
});

test('OpenCode runtime strips credentials and overrides, isolates storage and denies tools, MCP and paid providers',async t=>{
  const home=await directory(t),env=await opencodeEnvironment({home,env:{PATH:'safe-path',TEMP:'safe-temp',OPENAI_API_KEY:'PRIVATE',
    OPENCODE_API_KEY:'PRIVATE',ANTHROPIC_API_KEY:'PRIVATE',OPENCODE_MODELS_URL:'https://private.invalid',OPENCODE_CONFIG:'PRIVATE'}});
  assert.equal(env.PATH,'safe-path');assert.equal(env.TEMP,'safe-temp');assert.ok(!JSON.stringify(env).includes('PRIVATE'));
  assert.equal(env.OPENCODE_DISABLE_PROJECT_CONFIG,'1');assert.equal(env.OPENCODE_DISABLE_CLAUDE_CODE,'1');
  assert.equal(env.OPENCODE_TEST_HOME,home);
  assert.ok(env.XDG_DATA_HOME.startsWith(home));
  const settings=JSON.parse(await readFile(join(env.OPENCODE_CONFIG_DIR,'opencode.json'),'utf8'));
  assert.ok(settings.policies.some(p=>p.action==='tool.use'&&p.resource==='*'&&p.effect==='deny'));
  assert.deepEqual(settings.policies.filter(p=>p.action==='provider.use'),[
    {action:'provider.use',resource:'*',effect:'deny'},{action:'provider.use',resource:'opencode',effect:'allow'}]);
});

test('OpenCode discovery uses supported V2 model.list in standalone mode and does not start sessions',async t=>{
  const home=await directory(t),calls=[];
  const result=await inspectOpenCode('trusted',{home,env:{},run:async(command,args,options)=>{
    calls.push(args);assert.equal(command,'trusted');assert.equal(options.prompt,'');
    assert.equal(options.env.OPENCODE_DISABLE_PROJECT_CONFIG,'1');
    return args[0]==='--version'?'opencode v2.3.0':args[0]==='auth'?'[]':JSON.stringify({location:{directory:'PRIVATE'},data:[model()]});
  }});
  assert.deepEqual(calls,[['--version'],['auth','list','--format','json','--standalone','--log-level','none'],['api','model.list','--standalone','--log-level','none']]);
  assert.equal(result.routes.length,1);assert.ok(!JSON.stringify(result).includes('PRIVATE'));
  for(const version of ['opencode v1.2.0','opencode v2.2.5','opencode v3.0.0','unknown'])assert.equal(supportedVersion(version),false);
  assert.equal(supportedVersion('opencode v2.2.6'),true);
  await assert.rejects(inspectOpenCode('trusted',{home,env:{},run:async(c,args)=>args[0]==='--version'?'opencode v2.3.0':'[{"account":"PRIVATE"}]'}),/облікові записи/);
});

test('OpenCode execution pins the exact model, uses stdin and requires complete zero-cost JSONL output',async t=>{
  const home=await directory(t),agent={provider:'opencode',model:'opencode/test-free',command:'trusted',access:'read-only'};
  const events=[{type:'step_start'},{type:'text',part:{id:'text-1',text:'{"ok":true}'}},{type:'text',part:{id:'text-1',text:'{"ok":true}'}},
    {type:'step_finish',part:{messageID:'m',reason:'stop',cost:0,tokens:{input:20,output:4,cache:{read:10}}}}];
  const result=await executeOpenCode(agent,{prompt:'literal $(secret) & `value`',signal:AbortSignal.timeout(1000)},{home,env:{},run:async(command,args,options)=>{
    assert.equal(command,'trusted');assert.ok(args.includes('--standalone'));assert.ok(args.includes('opencode/test-free'));
    assert.ok(!args.includes('--auto'));assert.ok(!args.some(v=>v.includes('literal')));
    assert.equal(options.prompt,'literal $(secret) & `value`');events.forEach(e=>options.onLine(JSON.stringify(e)));return '';
  }});
  assert.equal(result.text,'{"ok":true}');assert.equal(result.usage.cost,0);assert.equal(result.usage.cached_input_tokens,10);
  for(const bad of [events.slice(0,2),[{type:'error'}],[{type:'tool_use'}],[{type:'step_finish',part:{cost:1,reason:'stop'}}],
    [{type:'step_finish',part:{cost:0,reason:'length'}}]]) {
    await assert.rejects(executeOpenCode(agent,{prompt:'test',signal:AbortSignal.timeout(1000)},{home,env:{},run:async(c,a,o)=>{bad.forEach(e=>o.onLine(JSON.stringify(e)));return '';}}));
  }
  await assert.rejects(executeOpenCode({...agent,access:'workspace-write'},{prompt:'test'}),/без інструментів/);
});

test('registry discovers OpenCode routes and guards trusted executables and file-write capability',async()=>{
  const normalized=normalizeOpenCodeMetadata([model()],{isolated:true}),store={data:{},save(){}};
  const registry=createModelRegistry({store,env:{},find:async name=>name==='opencode'?'/trusted/opencode':null,inspectOpen:async()=>normalized});
  await registry.scan();assert.equal(registry.snapshot().manager,normalized.routes[0].id);
  let calls=0;const invoke=withModelPolicy(registry,async agent=>{calls++;assert.equal(agent.command,'/trusted/opencode');return{text:'ok'};});
  await invoke({provider:'opencode',model:'opencode/test-free',access:'read-only',command:'untrusted'},{});
  await assert.rejects(invoke({provider:'opencode',model:'opencode/test-free',access:'workspace-write'},{}),/запис/);
  assert.equal(calls,1);
});
