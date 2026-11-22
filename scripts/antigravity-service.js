import {mkdir,readFile,readdir,lstat} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {runProcess} from '../src/providers.js';
import {CATALOG_TTL_MS,modelAccessError} from '../src/model-policy.js';

export const ANTIGRAVITY_HOME=fileURLToPath(new URL('../.orchestrator/antigravity/',import.meta.url));
const fail=reason=>modelAccessError({code:'antigravity_unverified',reason});
export const antigravitySettings=()=>({modelProvider:'',useG1Credits:false,
  agentMode:'',toolPermission:'strict',permissions:{allow:[],ask:[],deny:['read_file(*)','write_file(*)','command(*)','unsandboxed(*)','read_url(*)','execute_url(*)','mcp(*)']},
  statusLine:{enabled:false},title:{enabled:false},notifications:false});
export const supportedAntigravityVersion=v=>/^1\.5\.(?:9|[1-9]\d+)\s*$/.test(v);
export function antigravityEnvironment(env=process.env) {
  return Object.fromEntries(Object.entries(env).filter(([key])=>/^(?:path|pathext|systemroot|windir|comspec|temp|tmp|programfiles|programfiles\(x86\)|programdata|lang|lc_all)$/i.test(key)));
}
async function runtimeContext({home,env,check}) {
  const profile=join(resolve(home),'profile'),cwd=join(resolve(home),'workspace');
  const appData=join(profile,'AppData','Roaming'),localAppData=join(profile,'AppData','Local');
  await mkdir(profile,{recursive:true});await mkdir(cwd,{recursive:true});
  await mkdir(appData,{recursive:true});await mkdir(localAppData,{recursive:true});
  await check({home:profile,workspace:cwd});
  // The native OS keyring handles sign-in. No credential files or user customizations are copied.
  return {cwd,env:{...antigravityEnvironment(env),HOME:profile,USERPROFILE:profile,APPDATA:appData,LOCALAPPDATA:localAppData}};
}
async function optionalJson(path) {
  try{if((await lstat(path)).isSymbolicLink())throw fail('Symlink конфігурації Antigravity не підтримується');const text=(await readFile(path,'utf8')).replace(/^\uFEFF/,'').trim();return text?JSON.parse(text):null;}
  catch(e){if(e.code==='ENOENT')return null;throw fail('Не вдалося перевірити конфігурацію Antigravity');}
}
// Reuse the CLI's native login, never copy or read credentials. Hooks and MCP are separate from tool permissions.
export async function checkAntigravityCustomizations({home=homedir(),workspace}={}) {
  const roots=[join(home,'.gemini','config')];
  if(workspace){let dir=resolve(workspace);while(true){roots.push(join(dir,'.agents'));const parent=resolve(dir,'..');if(parent===dir)break;dir=parent;}}
  for(const root of roots) {
    const rootInfo=await lstat(root).catch(e=>{if(e.code==='ENOENT')return null;throw fail('Не вдалося перевірити каталог конфігурації Antigravity');});
    if(rootInfo?.isSymbolicLink())throw fail('Symlink конфігурації Antigravity не підтримується');
    const hooks=await optionalJson(join(root,'hooks.json'));
    if(hooks&&Object.values(hooks).some(h=>!h||h.enabled!==false))throw fail('Активні hooks Antigravity несумісні з керованим текстовим runtime');
    const mcp=await optionalJson(join(root,'mcp_config.json'));
    if(mcp&&Object.keys(mcp.mcpServers??mcp).length)throw fail('Глобальні або проєктні MCP Antigravity потребують окремої ізоляції');
    const pluginsDir=join(root,'plugins');
    const pluginsInfo=await lstat(pluginsDir).catch(e=>{if(e.code==='ENOENT')return null;throw fail('Не вдалося перевірити plugins Antigravity');});
    if(pluginsInfo?.isSymbolicLink())throw fail('Symlink plugins Antigravity не підтримується');
    const plugins=pluginsInfo?await readdir(pluginsDir,{withFileTypes:true}).catch(e=>{if(e.code==='ENOENT')return [];throw fail('Не вдалося перевірити plugins Antigravity');}):[];
    if(plugins.some(p=>!p.name.startsWith('.')))throw fail('Plugins Antigravity потребують окремої ізоляції');
  }
}

export function normalizeAntigravityMetadata(models,usage,{version,checkedAt=new Date().toISOString()}={}) {
  if(!supportedAntigravityVersion(version??''))throw fail('Підтримується перевірений контракт Antigravity CLI 1.5.9–1.5.x');
  if(typeof models!=='string'||typeof usage!=='string'||models.length>200000||usage.length>200000)throw fail('Непідтримуваний формат метаданих Antigravity');
  const groups=new Map();
  for(const line of usage.trim().split(/\r?\n/)) {
    const [group,label,remaining,reset,...rest]=line.split('\t');
    if(rest.length||!['Gemini Models','Claude and GPT models','Gemini 4 Argon'].includes(group)||!/^\d+(?:\.\d+)?%$/.test(remaining??''))continue;
    const percent=Number(remaining.slice(0,-1)),resets=Date.parse(reset);
    if(percent>100||!Number.isFinite(resets))continue;
    const window={usedPercent:100-percent,resetsAt:resets/1000};
    const kind=/Five Hour Limit/.test(label)?'primary':/Weekly Limit/.test(label)?'secondary':null;
    if(kind){const q=groups.get(group)??{};if(q[kind])throw fail('Повторне вікно квоти Antigravity');q[kind]=window;groups.set(group,q);}
  }
  const routes=[],seen=new Set(),expiresAt=new Date(Date.parse(checkedAt)+CATALOG_TTL_MS).toISOString();
  for(const line of models.trim().split(/\r?\n/)) {
    const [model,name,...rest]=line.split('\t');
    if(rest.length||!name||name.length>200||!/^[a-z0-9][a-z0-9.-]{0,150}$/.test(model??'')||seen.has(model))throw fail('Некоректний каталог Antigravity');seen.add(model);
    if(routes.length>=200)throw fail('Завеликий каталог Antigravity');
    const group=model.startsWith('gemini-')?'Gemini Models':/^(claude-|gpt-)/.test(model)?'Claude and GPT models':null;
    const base=groups.get(group),argonGroup=model.startsWith('gemini-4-argon-')?groups.get('Gemini 4 Argon'):null;
    const extraWindows=[argonGroup?.primary,argonGroup?.secondary].filter(Boolean);
    const known=Boolean(base?.primary&&base?.secondary)&&(!model.startsWith('gemini-4-argon-')||Boolean(argonGroup?.secondary));
    const quota={...base,known,...(extraWindows.length?{extra:extraWindows}:{})};
    const exhausted=known&&[base.primary,base.secondary,...extraWindows].some(q=>q.usedPercent>=100);
    routes.push({id:`antigravity:${model}`,connectionId:'antigravity',backend:'antigravity',model,name,
      checkedAt,expiresAt,source:'Antigravity CLI models + --print /usage; per-session useG1Credits=false',
      billing:known?'subscription_included':'unknown',subscriptionConfirmed:known,includedAccessConfirmed:known,freeConfirmed:false,
      billingBoundary:'included_only',subscriptionGuard:{authType:'google',creditsDisabled:true},quota,
      availability:!known?'unknown':exhausted?'quota_exhausted':'ready',runtimeSupported:true,
      capabilities:{code:true,tools:false,workspaceWrite:true,managedFileChanges:true,jsonOutput:'prompt_validated',structuredOutput:false},
      description:'Штатний Google-вхід і квота підписки; без додаткових кредитів. Файли й перевірки контролює оркестратор.'});
  }
  if(!routes.length)throw fail('Antigravity не повернув моделей');
  return {connection:{id:'antigravity',name:'Antigravity / Gemini',installed:true,authenticated:true,authType:'google',
    subscriptionConfirmed:routes.some(r=>r.subscriptionConfirmed),plan:null,version:version.trim(),checkedAt,quotaScope:'model-group',
    source:'Antigravity CLI models + /usage',note:'Google-вхід перевірено штатним CLI. Квоти визначено окремо для груп моделей; точний план Pro/Ultra CLI не розкриває. Додаткові кредити примусово вимкнені для кожного виклику.'},routes};
}

export async function inspectAntigravity(command,{run=runProcess,home=ANTIGRAVITY_HOME,env=process.env,check=checkAntigravityCustomizations}={}) {
  const options={...await runtimeContext({home,env,check}),prompt:'',signal:AbortSignal.timeout(20000)};
  const version=await run(command,['--version'],options);
  if(!supportedAntigravityVersion(version))throw fail('Потрібен Antigravity CLI 1.5.9–1.5.x');
  const models=await run(command,['models'],options);
  const usage=await run(command,['--settings',JSON.stringify(antigravitySettings()),'--print','/usage'],options);
  return normalizeAntigravityMetadata(models,usage,{version});
}

export async function executeAntigravity(agent,{prompt,signal=new AbortController().signal,onEvent},{run=runProcess,home=ANTIGRAVITY_HOME,env=process.env,check=checkAntigravityCustomizations}={}) {
  if(agent.access!=='read-only'||!/^[a-z0-9][a-z0-9.-]{0,150}$/.test(agent.model??''))throw fail('Потрібен точний Antigravity model ID і керований текстовий доступ');
  const runtime=await runtimeContext({home,env,check});
  let initialized=false,result;
  try {
    await run(agent.command,['--settings',JSON.stringify(antigravitySettings()),'--model',agent.model,'--disable-slash-commands',
      '--input-format','stream-json','--output-format','stream-json','--print-timeout','0s'],{
      ...runtime,signal,prompt:JSON.stringify({event:'user',message:{content:prompt}})+'\n',onLine:line=>{
        if(!line.trim())return;
        let e;try{e=JSON.parse(line);}catch{throw fail('Antigravity повернув некоректний JSONL');}
        if(e.event==='init') {if(initialized||e.init?.model!==agent.model)throw fail('Antigravity не підтвердив точну модель');initialized=true;onEvent?.({kind:'model',message:`Antigravity · ${agent.model}`});}
        else if(e.event==='step_update'&&e.step_update?.step_type==='tool')throw fail('Інструменти Antigravity заборонені для керованого виконавця');
        else if(e.event==='result'){if(result)throw fail('Повторний результат Antigravity');result=e.result;}
      }});
  }catch(error){
    if(signal?.aborted)throw signal.reason;
    if(error.code==='MODEL_ACCESS_BLOCKED'){error.usage??=result?.usage;throw error;}
    const denied=fail('Antigravity не завершив запит: перевірте вхід, доступ до моделі та включену квоту');denied.usage=result?.usage;throw denied;
  }
  if(!initialized||result?.status!=='SUCCESS'||typeof result.response!=='string'||!result.response.trim())throw fail('Antigravity повернув незавершений результат або відмову доступу');
  return {text:result.response,usage:result.usage??null};
}
