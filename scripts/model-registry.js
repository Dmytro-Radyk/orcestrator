import { access } from 'node:fs/promises';
import { delimiter,join,isAbsolute,resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { metadataRpc } from '../src/metadata-rpc.js';
import { runProcess } from '../src/providers.js';
import { execute } from '../src/providers.js';
import { routeDecision,chooseManager,CATALOG_TTL_MS,DEFAULT_MODEL_POLICY } from '../src/model-policy.js';
import { inspectOpenCode,executeOpenCode,OPENCODE_BINARY } from './opencode-service.js';

const cwd=fileURLToPath(new URL('../',import.meta.url));
const names={codex:'Codex',claude:'Claude Code',opencode:'OpenCode',ollama:'Ollama'};
const paidPlans=new Set(['go','plus','pro','prolite','promax','team','self_serve_business_prolite']);
const meteredPlans=new Set(['self_serve_business_usage_based','enterprise_cbp_usage_based','enterprise_cbp_automation']);
async function exists(path){try{await access(path);return true;}catch{return false;}}
export async function locateCli(name,{env=process.env,platform=process.platform,home=homedir(),hints=[]}={}) {
  const windows=platform==='win32',ext=windows?'.exe':'';
  const known=windows?[
    join(env.LOCALAPPDATA??join(home,'AppData','Local'),'Programs','OpenAI','Codex','bin','codex.exe'),
    join(home,'.local','bin',name+ext),join(home,'.opencode','bin',name+ext),join(home,'.ollama',name+ext)
  ]:[join(home,'.local','bin',name),join(home,'.opencode','bin',name),join(home,'.bun','bin',name)];
  const paths=[...hints.filter(Boolean).map(p=>isAbsolute(p)?p:resolve(p)),...(name==='opencode'?[OPENCODE_BINARY]:[]),
    ...(env.PATH??env.Path??'').split(delimiter).filter(Boolean).map(p=>join(p,name+ext)),
    ...known.filter(p=>name==='codex'||!p.endsWith('codex.exe'))];
  for(const path of [...new Set(paths)])if((!windows||path.toLowerCase().endsWith('.exe'))&&await exists(path))return path;
  return null;
}
const windowSummary=v=>v&&typeof v.usedPercent==='number'?{usedPercent:v.usedPercent,resetsAt:v.resetsAt??null,windowDurationMins:v.windowDurationMins??null}:null;

export function normalizeCodexMetadata({account,models,limits,checkedAt=new Date().toISOString()}) {
  const plan=account?.account?.planType??null,authType=account?.account?.type??null;
  const confirmed=authType==='chatgpt'&&paidPlans.has(plan);
  const billing=meteredPlans.has(plan)||authType==='apiKey'?'metered':plan==='free'?'free_tier':confirmed?'subscription_included':'unknown';
  const quota=limits?.rateLimits;
  const windows=[quota?.primary,quota?.secondary].filter(Boolean);
  const quotaKnown=windows.some(w=>Number.isFinite(w.usedPercent));
  const exhausted=windows.some(w=>w.usedPercent>=100)||Boolean(quota?.rateLimitReachedType);
  const checked=Date.parse(checkedAt),expiresAt=new Date(checked+CATALOG_TTL_MS).toISOString();
  const connection={id:'codex',name:names.codex,installed:true,authenticated:Boolean(authType),authType,plan,
    subscriptionConfirmed:confirmed,checkedAt,source:'Codex account/read + model/list + account/rateLimits/read',
    quota:{primary:windowSummary(quota?.primary),secondary:windowSummary(quota?.secondary),known:quotaKnown},
    billingBoundary:'unknown',note:'Тариф і каталог отримані. CLI не надав гарантії лише включеного використання; додаткові списання не дозволені.'};
  const routes=(models??[]).filter(m=>!m.hidden&&typeof m.model==='string').map(m=>({
    id:`codex:${m.model}`,connectionId:'codex',backend:'codex',model:m.model,name:m.displayName??m.model,
    description:m.description??'',specialty:m.modelSpecialty??null,isDefault:m.isDefault===true,
    reasoningEfforts:(m.supportedReasoningEfforts??[]).map(e=>e.reasoningEffort).filter(e=>typeof e==='string'),
    inputModalities:m.inputModalities??['text'],capabilities:{structuredOutput:true,code:true,tools:true,workspaceWrite:true},runtimeSupported:true,
    checkedAt,expiresAt,billing,subscriptionConfirmed:confirmed,
    includedAccessConfirmed:confirmed&&quotaKnown,freeConfirmed:false,billingBoundary:'unknown',
    availability:!authType?'unauthenticated':exhausted?'quota_exhausted':quotaKnown?'ready':'unknown',
    source:'Codex model/list',quota:connection.quota
  }));
  return {connection,routes};
}
export async function inspectCodex(command,{rpcFactory=metadataRpc}={}) {
  const rpc=rpcFactory(command,['app-server','--listen','stdio://'],{cwd,timeoutMs:15000});
  const deadline=setTimeout(()=>{void rpc.close();},45000);
  try {
    await rpc.request('initialize',{clientInfo:{name:'orcestrator_metadata',title:'Orcestrator read-only discovery',version:'0.1.0'}});rpc.initialized();
    const account=await rpc.request('account/read',{refreshToken:false});
    let cursor=null;const models=[];
    for(let page=0;page<20;page++) {
      const result=await rpc.request('model/list',{limit:100,includeHidden:false,...(cursor?{cursor}:{})});
      models.push(...(result.data??[]));if(!result.nextCursor)break;
      if(result.nextCursor===cursor)throw new Error('Повторний cursor каталогу');cursor=result.nextCursor;
      if(page===19)throw new Error('Каталог перевищив ліміт discovery');
    }
    const limits=await rpc.request('account/rateLimits/read',{}).catch(()=>null);
    return normalizeCodexMetadata({account,models,limits});
  }finally{clearTimeout(deadline);await rpc.close();}
}

export function createModelRegistry({store,env=process.env,find=locateCli,inspect=inspectCodex,inspectOpen=inspectOpenCode,run=runProcess}={}) {
  let scanning,internalCommands=new Map();
  const snapshot=()=>{
    const value=store.data.catalog??{version:1,checkedAt:null,connections:[],routes:[]};
    return {...value,policy:DEFAULT_MODEL_POLICY,scanning:Boolean(scanning),routes:value.routes.map(r=>({...r,decision:routeDecision(r)})),
      manager:chooseManager(value.routes)?.id??null};
  };
  async function scan(){
    if(scanning){await scanning;return {...snapshot(),scanning:false};}
    scanning=(async()=>{
      const checkedAt=new Date().toISOString(),connections=[],routes=[];const commands=new Map();
      const found=await Promise.all(Object.keys(names).map(async name=>[name,await find(name,{env,hints:name==='codex'?[env.ORCHESTRATOR_EXECUTOR_COMMAND,env.ORCHESTRATOR_PLANNER_COMMAND]:name==='opencode'?[env.ORCHESTRATOR_OPENCODE_COMMAND]:[]})]));
      for(const [name,path] of found) {
        if(!path){connections.push({id:name,name:names[name],installed:false,authenticated:null,checkedAt,note:'Не знайдено native CLI у PATH або стандартних каталогах'});continue;}
        commands.set(name,path);
        if(name==='codex') {
          try{const normalized=await inspect(path);connections.push(normalized.connection);routes.push(...normalized.routes);}catch{connections.push({id:name,name:names[name],installed:true,authenticated:null,checkedAt,note:'Metadata-перевірка не завершилась. Авторизація, підписка та тариф залишаються невідомими.'});}
        } else if(name==='opencode') {
          try{const normalized=await inspectOpen(path,{run,env});connections.push(normalized.connection);routes.push(...normalized.routes);}
          catch{connections.push({id:name,name:names[name],installed:true,authenticated:null,checkedAt,note:'Не вдалося перевірити ізольований metadata-каталог OpenCode V2; виклики заблоковані.'});}
        } else if(name==='claude') {
          try{
            const info=JSON.parse(await run(path,['auth','status'],{cwd,prompt:'',signal:AbortSignal.timeout(8000)}));
            connections.push({id:name,name:names[name],installed:true,authenticated:info.loggedIn===true,
              authType:typeof info.authMethod==='string'?info.authMethod:'unknown',plan:typeof info.subscriptionType==='string'?info.subscriptionType:null,
              subscriptionConfirmed:info.loggedIn===true&&['pro','max','team'].includes(info.subscriptionType),checkedAt,
              note:'Стан входу перевірено. Каталог моделей і межа додаткових списань ще не підтверджені.'});
          }catch{connections.push({id:name,name:names[name],installed:true,authenticated:null,checkedAt,note:'CLI знайдено; штатний auth status не повернув підтримувані метадані'});}
        } else {
          connections.push({id:name,name:names[name],installed:true,authenticated:null,checkedAt,
            note:name==='opencode'?'CLI знайдено; підключення провайдерів, тарифи та доступ до моделей потребують підтримуваного metadata-адаптера':'Локальний runtime знайдено; локальні моделі є окремим режимом із апаратними витратами'});
        }
      }
      internalCommands=commands;
      store.data.catalog={version:1,checkedAt,connections,routes};store.save();
      return snapshot();
    })();
    try{await scanning;return {...snapshot(),scanning:false};}finally{scanning=null;}
  }
  return {snapshot,scan,async requireRoute(id,{refresh=true}={}) {
    // Every billable operation gets fresh entitlement metadata; persisted records never authorize calls alone.
    if(refresh)await scan();const route=store.data.catalog?.routes.find(r=>r.id===id),decision=routeDecision(route);
    if(!decision.allowed)throw new Error(decision.reason);
    const command=internalCommands.get(route.connectionId);if(!command)throw new Error('Повторно перевірте CLI');
    return {...route,command};
  }};
}

export function withModelPolicy(registry,provider) {
  const invoke=provider??((agent,context)=>agent.provider==='opencode'?executeOpenCode(agent,context):execute(agent,context));
  return async(agent,context)=>{
    if(agent.provider==='demo')return invoke(agent,context);
    if(!['codex','opencode'].includes(agent.provider))throw new Error('Маршрут цього провайдера ще не має підтверджених умов без додаткових списань');
    const route=await registry.requireRoute(`${agent.provider}:${agent.model}`);
    if(route.backend!==agent.provider||route.model!==agent.model)throw new Error('Маршрут не відповідає обраній моделі');
    if(agent.provider==='opencode'&&agent.access!=='read-only')throw new Error('OpenCode не має дозволу на запис файлів');
    return invoke({...agent,command:route.command,model:route.model},context);
  };
}
