import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {inspectAntigravity,normalizeAntigravityMetadata,executeAntigravity,antigravitySettings,antigravityEnvironment,checkAntigravityCustomizations} from '../scripts/antigravity-service.js';
import {createModelRegistry,withModelPolicy} from '../scripts/model-registry.js';
import {routeDecision} from '../src/model-policy.js';
import {executionAgent} from '../scripts/execution-agent.js';
import {routingCandidates,createDirector} from '../scripts/director-service.js';
import {renderConnections} from '../apps/web/src/connections.js';
import {Engine} from '../src/engine.js';
import {Store} from '../src/store.js';
import {setTimeout as delay} from 'node:timers/promises';

const models='gemini-4-hydrogen-high\tGemini Hydrogen High\ngemini-3.8-flash-low\tGemini Flash Low\ngemini-4-argon-high\tGemini Argon\nclaude-opus-5-5-high\tClaude Opus';
const usage='Gemini Models\tWeekly Limit Remaining\t80%\t2099-01-01T00:00:00Z\nGemini Models\tFive Hour Limit Remaining\t90%\t2099-01-01T00:00:00Z\nClaude and GPT models\tWeekly Limit Remaining\t50%\t2099-01-01T00:00:00Z\nClaude and GPT models\tFive Hour Limit Remaining\t75%\t2099-01-01T00:00:00Z\nGemini 4 Argon\tGemini 4 Argon Weekly Limit\t30%\t2099-01-01T00:00:00Z';
const metadata=(m=models,u=usage)=>normalizeAntigravityMetadata(m,u,{version:'1.5.9'});
async function folder(t){const base=resolve('.orchestrator/tests');await mkdir(base,{recursive:true});const dir=await mkdtemp(join(base,'agy-'));t.after(async()=>{const rel=relative(base,dir);assert.ok(rel&&!rel.startsWith('..')&&!isAbsolute(rel));await rm(dir,{recursive:true,force:true});});return dir;}

test('Antigravity metadata pins exact live IDs, preserves group quotas and never publishes account data',()=>{
  const value=metadata(models,usage+'\nPRIVATE@example.test\tPRIVATE');
  assert.equal(value.routes.length,4);assert.equal(value.connection.plan,null);
  assert.equal(value.routes[0].quota.primary.usedPercent,10);
  assert.equal(value.routes[3].quota.primary.usedPercent,25);
  assert.equal(value.routes[2].quota.extra[0].usedPercent,70);
  assert.ok(value.routes.every(r=>routeDecision(r).allowed));
  const html=renderConnections({...value,connections:[value.connection],routes:value.routes.map(r=>({...r,decision:routeDecision(r)}))},false,{h:String,button:()=>'',heading:()=>''});
  assert.match(html,/Квоти різняться за групами/);assert.doesNotMatch(html,/Квота: не розкривається провайдером/);
  assert.doesNotMatch(JSON.stringify(value),/PRIVATE/);
  const unknown=metadata(models,usage.split('\n').filter(x=>!x.includes('Five Hour')).join('\n'));
  assert.ok(unknown.routes.every(r=>!routeDecision(r).allowed));
  assert.equal(routeDecision(metadata(models,usage.replace('80%','0%')).routes[0]).allowed,false);
  assert.equal(routeDecision(metadata(models,usage.replace('30%','0%')).routes[2]).allowed,false);
  assert.throws(()=>metadata(models+'\ngemini-4-hydrogen-high\tDuplicate'),/каталог/);
  assert.throws(()=>normalizeAntigravityMetadata(models,usage,{version:'2.0.0'}),/контракт/);
  const route=value.routes[0];
  assert.equal(routeDecision({...route,subscriptionGuard:{...route.subscriptionGuard,creditsDisabled:false}}).allowed,false);
  assert.equal(routeDecision({...route,billing:'metered'}).allowed,false);
});

test('discovery only runs metadata commands with an isolated profile and no API/ADC environment',async t=>{
  const home=await folder(t),calls=[];
  const value=await inspectAntigravity('trusted-agy',{home,env:{PATH:'runtime',GEMINI_API_KEY:'PRIVATE',AGY_ADC_AUTH:'true',GOOGLE_CLOUD_PROJECT:'PRIVATE',NODE_OPTIONS:'PRIVATE'},run:async(command,args,o)=>{
    calls.push(args);assert.equal(command,'trusted-agy');assert.equal(o.env.GEMINI_API_KEY,undefined);assert.equal(o.env.AGY_ADC_AUTH,undefined);assert.equal(o.env.NODE_OPTIONS,undefined);
    assert.equal(o.env.USERPROFILE,join(home,'profile'));assert.equal(o.env.HOME,join(home,'profile'));assert.equal(o.prompt,'');
    return args[0]==='--version'?'1.5.9':args[0]==='models'?models:usage;
  }});
  assert.equal(value.routes.length,4);assert.deepEqual(calls.map(x=>x[0]),['--version','models','--settings']);
  assert.equal(calls[2].at(-1),'/usage');assert.equal(JSON.parse(calls[2][1]).useG1Credits,false);
  assert.equal(antigravityEnvironment({GEMINI_API_KEY:'PRIVATE'}).GEMINI_API_KEY,undefined);
});

test('isolated configuration rejects executable customizations and accepts native empty config files',async t=>{
  const home=await folder(t),config=join(home,'.gemini','config');await mkdir(config,{recursive:true});
  await writeFile(join(config,'mcp_config.json'),'');await checkAntigravityCustomizations({home});
  await writeFile(join(config,'hooks.json'),JSON.stringify({hook:{SessionStart:[{command:'DO NOT RUN'}]}}));
  await assert.rejects(checkAntigravityCustomizations({home}),/hooks/);
  await writeFile(join(config,'hooks.json'),JSON.stringify({hook:{enabled:false}}));
  await writeFile(join(config,'mcp_config.json'),JSON.stringify({mcpServers:{private:{command:'DO NOT RUN'}}}));
  await assert.rejects(checkAntigravityCustomizations({home}),/MCP/);
  await writeFile(join(config,'mcp_config.json'),'{}');await mkdir(join(config,'plugins','custom'),{recursive:true});
  await assert.rejects(checkAntigravityCustomizations({home}),/Plugins/);
});

test('headless execution pins the model, disables credits/tools and only accepts one successful terminal result',async t=>{
  const home=await folder(t),agent={command:'agy',model:'gemini-4-hydrogen-high',access:'read-only'},context={prompt:'/do not expand a skill',signal:AbortSignal.timeout(5000)};
  const execute=events=>executeAntigravity(agent,context,{home,run:async(_cmd,args,o)=>{
    const settings=JSON.parse(args[args.indexOf('--settings')+1]);assert.equal(settings.useG1Credits,false);assert.equal(settings.modelProvider,'');
    assert.equal(args[args.indexOf('--print-timeout')+1],'0s');assert.equal(o.signal,context.signal);
    assert.ok(settings.permissions.deny.includes('read_file(*)'));assert.ok(args.includes('--disable-slash-commands'));assert.ok(!args.includes('--dangerously-skip-permissions'));
    assert.equal(JSON.parse(o.prompt).message.content,context.prompt);for(const event of events)o.onLine(JSON.stringify(event));return '';
  }});
  const init={event:'init',init:{model:agent.model}},result={event:'result',result:{status:'SUCCESS',response:'verified',usage:{input_tokens:8,output_tokens:2}}};
  assert.equal((await execute([init,result])).text,'verified');
  for(const events of [[result],[{...init,init:{model:'wrong'}},result],[init,{...result,result:{status:'ERROR',error:'PRIVATE'}}],[init,result,result],[init,{event:'step_update',step_update:{step_type:'tool'}},result]]){
    await assert.rejects(execute(events),e=>e.code==='MODEL_ACCESS_BLOCKED'&&!e.message.includes('PRIVATE'));
  }
  await assert.rejects(executeAntigravity({...agent,access:'workspace-write'},context,{home}),/текстовий доступ/);
  assert.equal(antigravitySettings().toolPermission,'strict');
});

test('registry and AI director route Antigravity by real capabilities and recheck authorization before calls',async()=>{
  const store={data:{},save(){}},found=[];
  const registry=createModelRegistry({store,env:{},find:async name=>{found.push(name);return name==='agy'?'trusted-agy':null;},inspectAgy:async()=>metadata()});
  await registry.scan();assert.ok(found.includes('agy'));const route=await registry.requireRoute('antigravity:gemini-4-hydrogen-high');
  assert.equal(route.command,'trusted-agy');assert.equal(registry.snapshot().connections.find(x=>x.id==='antigravity').authenticated,true);
  const plan={summary:'Project',assumptions:[],risks:[],tasks:[{id:'task',title:'Create API',prompt:'Implement API',skills:['backend'],dependsOn:[],acceptanceCriteria:['Tests pass']}]};
  assert.equal(routingCandidates(plan,store.data.catalog.routes,{task:{workspaceWrite:true}}).get('task').length,4);
  assert.throws(()=>routingCandidates(plan,store.data.catalog.routes,{task:{tools:true}}),/Немає дозволеної/);
  const agent=executionAgent(route);assert.equal(agent.fileWorker,true);assert.equal(agent.provider,'antigravity');
  let invoked=0;
  const director=createDirector({registry,preferredId:route.id,provider:async(a)=>{assert.equal(a.command,'trusted-agy');assert.equal(a.provider,'antigravity');invoked++;return {text:JSON.stringify({assignments:[{taskId:'task',routeIds:[route.id],reason:'Verified included route'}]})};}});
  const proposal=await director.propose({plan});assert.equal(proposal.provenance.provider,'antigravity');assert.equal(invoked,1);
  let deniedCalls=0;const denied=withModelPolicy({requireRoute:async()=>{throw Error('quota denied');}},()=>{deniedCalls++;});
  await assert.rejects(denied(agent,{}),/quota denied/);assert.equal(deniedCalls,0);
});

test('Antigravity failures retain the exact route so successive recovery rounds exclude all failed models',async t=>{
  const home=await folder(t),engine=new Engine(new Store(join(home,'data')),async()=>{throw Error('QA recovery probe');});
  const run=engine.start(engine.createProject({name:'AGY route failure',agents:[{id:'worker',provider:'antigravity',model:'gemini-4-hydrogen-high',skills:[]}],tasks:[{id:'task',title:'Probe',prompt:'Probe',agentIds:['worker']}]}).id);
  for(let i=0;i<100&&['running','paused'].includes(run.status);i++)await delay(5);
  assert.equal(run.status,'failed');
  assert.equal(run.events.find(e=>e.type==='agent.failed').routeId,'antigravity:gemini-4-hydrogen-high');
  assert.equal(run.tasks[0].failure.routeId,'antigravity:gemini-4-hydrogen-high');
});
