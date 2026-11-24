import { access } from 'node:fs/promises';
import { delimiter,join,isAbsolute,resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { metadataRpc } from '../src/metadata-rpc.js';
import { runProcess,execute,subscriptionEnvironment } from '../src/providers.js';
import { routeDecision,chooseManager,CATALOG_TTL_MS,DEFAULT_MODEL_POLICY,modelAccessError } from '../src/model-policy.js';
import { inspectOpenCode,executeOpenCode,OPENCODE_BINARY } from './opencode-service.js';
import { executeFileWorker,sandboxChecks } from './file-worker.js';
import { SubscriptionGuard } from './subscription-guard.js';
import { inspectAntigravity,executeAntigravity } from './antigravity-service.js';

const cwd=fileURLToPath(new URL('../',import.meta.url));
const names={codex:'Codex',claude:'Claude Code',opencode:'OpenCode',ollama:'Ollama',antigravity:'Antigravity / Gemini'};
const paidPlans=new Set(['go','plus','pro','prolite','promax','team','self_serve_business_prolite']);
const meteredPlans=new Set(['self_serve_business_usage_based','enterprise_cbp_usage_based','enterprise_cbp_automation']);
async function exists(path){try{await access(path);return true;}catch{return false;}}
export async function locateCli(name,{env=process.env,platform=process.platform,home=homedir(),hints=[]}={}) {
  const windows=platform==='win32',ext=windows?'.exe':'';
  const known=windows?[
    join(env.LOCALAPPDATA??join(home,'AppData','Local'),'Programs','OpenAI','Codex','bin','codex.exe'),
    join(home,'.local','bin',name+ext),join(home,'.opencode','bin',name+ext),join(home,'.ollama',name+ext),join(home,'.gemini','bin',name+ext)
  ]:[join(home,'.local','bin',name),join(home,'.opencode','bin',name),join(home,'.bun','bin',name)];
  const paths=[...hints.filter(Boolean).map(p=>isAbsolute(p)?p:resolve(p)),...(name==='opencode'?[OPENCODE_BINARY]:[]),
    ...(env.PATH??env.Path??'').split(delimiter).filter(Boolean).map(p=>join(p,name+ext)),
    ...known.filter(p=>name==='codex'||!p.endsWith('codex.exe'))];
  for(const path of [...new Set(paths)])if((!windows||path.toLowerCase().endsWith('.exe'))&&await exists(path))return path;
  return null;
}
const windowSummary=v=>v&&typeof v.usedPercent==='number'?{usedPercent:v.usedPercent,resetsAt:v.resetsAt??null,windowDurationMins:v.windowDurationMins??null}:null;

export function normalizeCodexMetadata({account,models,limits,checkedAt=new Date().toISOString()},{autoReloadDisabled=false}={}) {
  const plan=account?.account?.planType??null,authType=account?.account?.type??null;
  const confirmed=authType==='chatgpt'&&paidPlans.has(plan);
  const billing=meteredPlans.has(plan)||authType==='apiKey'?'metered':plan==='free'?'free_tier':confirmed?'subscription_included':'unknown';
  const quota=limits?.rateLimits;
  const windows=[quota?.primary,quota?.secondary].filter(Boolean);
  const quotaKnown=windows.some(w=>Number.isFinite(w.usedPercent));
  const exhausted=windows.some(w=>w.usedPercent>=100)||Boolean(quota?.rateLimitReachedType);
  const checked=Date.parse(checkedAt),expiresAt=new Date(checked+CATALOG_TTL_MS).toISOString();
  const credits=quota?.credits;
  const paidCreditsAbsent=credits?.hasCredits===false&&credits?.unlimited===false&&typeof credits.balance==='string'&&Number(credits.balance)===0&&credits.balance.trim()!=='';
  const subscriptionGuard={authType,autoReloadDisabled:autoReloadDisabled===true,paidCreditsAbsent};
  const billingBoundary=confirmed&&autoReloadDisabled===true?'subscription_quota_guarded':'unknown';
  const connection={id:'codex',name:names.codex,installed:true,authenticated:Boolean(authType),authType,plan,
    subscriptionConfirmed:confirmed,checkedAt,source:'Codex account/read + model/list + account/rateLimits/read',
    quota:{primary:windowSummary(quota?.primary),secondary:windowSummary(quota?.secondary),known:quotaKnown},
    billingBoundary,subscriptionGuard,note:!confirmed?'Включений доступ підписки не підтверджено.':autoReloadDisabled!==true?'Підписку підтверджено. Для контрольованого запуску потрібне підтвердження вимкненого Automatic reload.':!paidCreditsAbsent?'Запуск підписки заблокований: додаткові кредити доступні або їхній стан невідомий.':'Підписка ChatGPT: без API-ключа; послідовні виклики з перевіркою квоти й відсутності додаткових кредитів. Це контроль квоти, а не серверний ліміт вартості.'};
  const routes=(models??[]).filter(m=>!m.hidden&&typeof m.model==='string').map(m=>({
    id:`codex:${m.model}`,connectionId:'codex',backend:'codex',model:m.model,name:m.displayName??m.model,
    description:m.description??'',specialty:m.modelSpecialty??null,isDefault:m.isDefault===true,
    reasoningEfforts:(m.supportedReasoningEfforts??[]).map(e=>e.reasoningEffort).filter(e=>typeof e==='string'),
    inputModalities:m.inputModalities??['text'],capabilities:{structuredOutput:true,code:true,tools:true,workspaceWrite:true},runtimeSupported:true,
    checkedAt,expiresAt,billing,subscriptionConfirmed:confirmed,
    includedAccessConfirmed:confirmed&&quotaKnown,freeConfirmed:false,billingBoundary,subscriptionGuard,
    availability:!authType?'unauthenticated':exhausted?'quota_exhausted':quotaKnown?'ready':'unknown',
    source:'Codex model/list',quota:connection.quota
  }));
  return {connection,routes};
}
export async function inspectCodex(command,{rpcFactory=metadataRpc,autoReloadDisabled=false,timeoutMs=45000,env=process.env,signal}={}) {
  signal?.throwIfAborted();
  const rpc=rpcFactory(command,['app-server','--listen','stdio://'],{cwd,env:subscriptionEnvironment(env),signal,timeoutMs:Math.min(timeoutMs,15000)});
  const deadline=setTimeout(()=>{void rpc.close(Object.assign(new Error('Не вдалося вчасно перевірити доступ до Codex'),{code:'METADATA_TIMEOUT'}));},timeoutMs);
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
    return normalizeCodexMetadata({account,models,limits},{autoReloadDisabled});
  }finally{clearTimeout(deadline);await rpc.close();}
}

export function createModelRegistry({store,env=process.env,find=locateCli,inspect=inspectCodex,inspectOpen=inspectOpenCode,inspectAgy=inspectAntigravity,run=runProcess}={}) {
  let scanning,refreshingAntigravity,refreshingOpenCode,internalCommands=new Map();
  const subscriptionGuard=new SubscriptionGuard({intervalMs:15000});
  const currentRoute=r=>r?.backend==='codex'&&r.subscriptionGuard?{...r,subscriptionGuard:{...r.subscriptionGuard,autoReloadDisabled:r.subscriptionGuard.autoReloadDisabled===true&&env.ORCHESTRATOR_CODEX_AUTO_RELOAD_DISABLED==='1'}}:r;
  const snapshot=()=>{
    const value=store.data.catalog??{version:1,checkedAt:null,connections:[],routes:[]};
    const routes=value.routes.map(currentRoute);
    return {...value,policy:DEFAULT_MODEL_POLICY,scanning:Boolean(scanning),routes:routes.map(r=>({...r,decision:routeDecision(r)})),
      manager:chooseManager(routes)?.id??null};
  };
  function updateBackend(backend,normalized,{persist=true}={}) {
    const catalog=store.data.catalog??{version:1,checkedAt:null,connections:[],routes:[]};
    const existing=catalog.connections.find(c=>c.id===backend);
    const nextAt=Date.parse(normalized.connection?.checkedAt??'');
    const prevAt=Date.parse(existing?.checkedAt??'');
    if(Number.isFinite(nextAt)&&Number.isFinite(prevAt)&&nextAt<prevAt)return;
    store.data.catalog={...catalog,
      connections:[...catalog.connections.filter(connection=>connection.id!==backend),normalized.connection],
      routes:[...normalized.routes,...catalog.routes.filter(route=>route.connectionId!==backend)]};
    if(persist)store.save();
  }
  async function scan(){
    if(scanning){await scanning;return {...snapshot(),scanning:false};}
    scanning=(async()=>{
      const checkedAt=new Date().toISOString(),commands=new Map();
      const found=await Promise.all(Object.keys(names).map(async name=>[name,await find(name==='antigravity'?'agy':name,{env,hints:name==='codex'?[env.ORCHESTRATOR_EXECUTOR_COMMAND,env.ORCHESTRATOR_PLANNER_COMMAND]:name==='opencode'?[env.ORCHESTRATOR_OPENCODE_COMMAND]:name==='antigravity'?[env.ORCHESTRATOR_ANTIGRAVITY_COMMAND]:[]})]));
      const probed=await Promise.all(found.map(async([name,path])=>{
        if(!path)return {connection:{id:name,name:names[name],installed:false,authenticated:null,checkedAt,note:'Не знайдено native CLI у PATH або стандартних каталогах'},routes:[]};
        commands.set(name,path);
        if(name==='codex') {
          try{return await inspect(path,{autoReloadDisabled:env.ORCHESTRATOR_CODEX_AUTO_RELOAD_DISABLED==='1',env});}
          catch{return {connection:{id:name,name:names[name],installed:true,authenticated:null,checkedAt,note:'Metadata-перевірка не завершилась. Авторизація, підписка та тариф залишаються невідомими.'},routes:[]};}
        }
        if(name==='opencode') {
          try{return await inspectOpen(path,{run,env});}
          catch{return {connection:{id:name,name:names[name],installed:true,authenticated:null,checkedAt,note:'Не вдалося перевірити ізольований metadata-каталог OpenCode V2; виклики заблоковані.'},routes:[]};}
        }
        if(name==='antigravity') {
          try{return await inspectAgy(path,{run,env});}
          catch{return {connection:{id:name,name:names[name],installed:true,authenticated:null,checkedAt,note:'Не підтверджено каталог, включену квоту або безпечну конфігурацію Antigravity. Оновіть CLI та перевірте вхід Google; активні hooks/MCP/plugins потребують окремої ізоляції.'},routes:[]};}
        }
        if(name==='claude') {
          try{
            const info=JSON.parse(await run(path,['auth','status'],{cwd,prompt:'',signal:AbortSignal.timeout(8000)}));
            return {connection:{id:name,name:names[name],installed:true,authenticated:info.loggedIn===true,
              authType:typeof info.authMethod==='string'?info.authMethod:'unknown',plan:typeof info.subscriptionType==='string'?info.subscriptionType:null,
              subscriptionConfirmed:info.loggedIn===true&&['pro','max','team'].includes(info.subscriptionType),checkedAt,
              note:'Стан входу перевірено. Каталог моделей і межа додаткових списань ще не підтверджені.'},routes:[]};
          }catch{return {connection:{id:name,name:names[name],installed:true,authenticated:null,checkedAt,note:'CLI знайдено; штатний auth status не повернув підтримувані метадані'},routes:[]};}
        }
        return {connection:{id:name,name:names[name],installed:true,authenticated:null,checkedAt,
          note:'Локальний runtime знайдено; локальні моделі є окремим режимом із апаратними витратами'},routes:[]};
      }));
      const connections=probed.map(p=>p.connection),routes=probed.flatMap(p=>p.routes);
      internalCommands=commands;
      store.data.catalog={version:1,checkedAt,connections,routes};store.save();
      return snapshot();
    })();
    try{await scanning;return {...snapshot(),scanning:false};}finally{scanning=null;}
  }
  return {snapshot,scan,commandFor:backend=>internalCommands.get(backend),guardSubscription:options=>subscriptionGuard.run(options),async requireRoute(id,{refresh=true,signal}={}) {
    signal?.throwIfAborted();
    // Every billable operation gets fresh entitlement metadata; persisted records never authorize calls alone.
    if(refresh==='subscription') {
      const command=internalCommands.get('codex');if(!command)throw Error('Повторно перевірте Codex CLI');
      const normalized=await inspect(command,{autoReloadDisabled:env.ORCHESTRATOR_CODEX_AUTO_RELOAD_DISABLED==='1',timeoutMs:30000,env,signal});
      const previous=store.data.catalog;
      const withoutTimestamps=entry=>JSON.stringify(entry, (key,value)=>['checkedAt','expiresAt'].includes(key)?undefined:value);
      const changed=withoutTimestamps(previous.routes.filter(route=>route.connectionId==='codex'))!==withoutTimestamps(normalized.routes)||
        withoutTimestamps(previous.connections.find(connection=>connection.id==='codex'))!==withoutTimestamps(normalized.connection);
      updateBackend('codex',normalized,{persist:changed});
    }else if(refresh) {
      const cached=currentRoute(store.data.catalog?.routes.find(r=>r.id===id));
      const guarded=refresh==='execution'&&cached?.billingBoundary==='subscription_quota_guarded'&&
        internalCommands.has(cached.connectionId)&&routeDecision(cached).allowed;
      if(refresh==='execution'&&cached?.backend==='antigravity'&&internalCommands.has('antigravity')){
        if(scanning)await scanning;
        else {
          refreshingAntigravity??=(async()=>{
            try{updateBackend('antigravity',await inspectAgy(internalCommands.get('antigravity'),{run,env}));}
            catch{
              if(store.data.catalog)store.data.catalog.routes=store.data.catalog.routes.map(r=>r.connectionId==='antigravity'?{...r,availability:'unknown'}:r);
              throw modelAccessError({code:'antigravity_metadata_failed',reason:'Не вдалося повторно перевірити доступ Gemini'});
            }
          })().finally(()=>{refreshingAntigravity=undefined;});
          await refreshingAntigravity;
        }
      }else if(refresh==='execution'&&cached?.backend==='opencode'&&internalCommands.has('opencode')){
        if(scanning)await scanning;
        else {
          refreshingOpenCode??=(async()=>{
            try{updateBackend('opencode',await inspectOpen(internalCommands.get('opencode'),{run,env}));}
            catch{
              if(store.data.catalog)store.data.catalog.routes=store.data.catalog.routes.map(r=>r.connectionId==='opencode'?{...r,availability:'unknown'}:r);
              throw modelAccessError({code:'opencode_metadata_failed',reason:'Не вдалося повторно перевірити доступ OpenCode'});
            }
          })().finally(()=>{refreshingOpenCode=undefined;});
          await refreshingOpenCode;
        }
      }else if(!guarded)await scan();
    }
    signal?.throwIfAborted();
    const route=currentRoute(store.data.catalog?.routes.find(r=>r.id===id)),decision=routeDecision(route);
    if(!decision.allowed)throw modelAccessError(decision);
    const command=internalCommands.get(route.connectionId);if(!command)throw new Error('Повторно перевірте CLI');
    return {...route,command};
  }};
}

export function withModelPolicy(registry,provider) {
  const checks=(cwd,testFiles,options)=>sandboxChecks(cwd,testFiles,{...options,command:options?.command??registry.commandFor?.('codex')??process.env.ORCHESTRATOR_SANDBOX_COMMAND??process.env.ORCHESTRATOR_EXECUTOR_COMMAND??process.env.ORCHESTRATOR_PLANNER_COMMAND??'codex'});
  const invoke=provider??((agent,context)=>agent.provider==='antigravity'?(agent.fileWorker?executeFileWorker(agent,context,{model:(a,c,o)=>executeAntigravity(a,c,o),checks}):executeAntigravity(agent,context)):agent.provider==='opencode'?(agent.fileWorker?executeFileWorker(agent,context,{checks}):executeOpenCode(agent,context)):execute(agent,context));
  const run=(agent,context)=>{
    context.signal?.throwIfAborted();
    context.onInvoke?.();
    return invoke(agent,context);
  };
  const guarded=async(agent,context={})=>{
    if(agent.provider==='demo')return run(agent,context);
    if(!['codex','opencode','antigravity'].includes(agent.provider))throw new Error('Маршрут цього провайдера ще не має підтверджених умов без додаткових списань');
    const route=await registry.requireRoute(`${agent.provider}:${agent.model}`,{refresh:'execution',signal:context.signal});
    if(route.backend!==agent.provider||route.model!==agent.model)throw new Error('Маршрут не відповідає обраній моделі');
    if(['opencode','antigravity'].includes(agent.provider)&&agent.access!=='read-only'&&!(agent.fileWorker===true&&route.capabilities?.workspaceWrite===true))throw new Error('Текстовий runtime не має дозволу на прямий запис файлів');
    if(route.billingBoundary==='subscription_quota_guarded') {
      if(typeof registry.guardSubscription!=='function')throw Error('Контроль виконання підписки не підключений');
      return registry.guardSubscription({authorize:signal=>registry.requireRoute(route.id,{refresh:'subscription',signal}),signal:context.signal,onEvent:context.onEvent,
        invoke:(current,signal)=>run({...agent,command:current.command,model:current.model,subscriptionOnly:true,ignoreUserConfig:true},{...context,signal})});
    }
    return run({...agent,command:route.command,model:route.model},context);
  };
  guarded.admitsInvocation=true;
  return guarded;
}
