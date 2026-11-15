import { mkdir,writeFile,rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join,resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProcess } from '../src/providers.js';
import { CATALOG_TTL_MS } from '../src/model-policy.js';

export const OPENCODE_HOME=fileURLToPath(new URL('../.orchestrator/opencode/',import.meta.url));
export const OPENCODE_BINARY=fileURLToPath(new URL('../.orchestrator/tools/opencode-2.3.0/package/bin/opencode.exe',import.meta.url));
const deny=(action,resource='*')=>({action,resource,effect:'deny'});
const allow=(action,resource)=>({action,resource,effect:'allow'});

// Dedicated anonymous runtime. Never copy API keys, saved accounts or host OpenCode settings.
export async function opencodeEnvironment({home=OPENCODE_HOME,env=process.env}={}) {
  const safe={};
  for(const [key,value] of Object.entries(env))if(/^(?:path|pathext|systemroot|windir|comspec|temp|tmp|localappdata|appdata|programfiles|programfiles\(x86\)|programdata|userprofile|lang|lc_all)$/i.test(key)&&typeof value==='string')safe[key]=value;
  const config=join(resolve(home),'config');
  await mkdir(config,{recursive:true});await mkdir(join(home,'workspace'),{recursive:true});
  const settings={update:'disable',snapshots:false,plugins:[],policies:[
    deny('provider.use'),allow('provider.use','opencode'),
    deny('integration.connect'),deny('integration.use'),allow('integration.use','opencode'),
    deny('plugin.use'),allow('plugin.use','opencode.*'),
    deny('mcp.use'),deny('skill.use'),deny('websearch.use'),deny('tool.use')
  ]};
  const temporary=join(config,`config-${randomUUID()}.tmp`);
  await writeFile(temporary,JSON.stringify(settings,null,2));await rename(temporary,join(config,'opencode.json'));
  return {...safe,OPENCODE_CONFIG_DIR:config,OPENCODE_CONFIG_CONTENT:JSON.stringify(settings),
    OPENCODE_TEST_HOME:resolve(home),
    OPENCODE_DISABLE_PROJECT_CONFIG:'1',OPENCODE_DISABLE_CLAUDE_CODE:'1',OPENCODE_DISABLE_FILEWATCHER:'1',
    XDG_DATA_HOME:join(resolve(home),'data'),XDG_CACHE_HOME:join(resolve(home),'cache'),XDG_CONFIG_HOME:config,XDG_STATE_HOME:join(resolve(home),'state')};
}

const zeroTier=t=>t&&[t.input,t.output,t.cache?.read,t.cache?.write].every(n=>typeof n==='number'&&Number.isFinite(n)&&n===0);
export function normalizeOpenCodeMetadata(models,{checkedAt=new Date().toISOString(),isolated=false,version}={}) {
  if(!Array.isArray(models)||models.length>2000)throw new Error('Непідтримуваний формат каталогу OpenCode');
  const expiresAt=new Date(Date.parse(checkedAt)+CATALOG_TTL_MS).toISOString();
  const seen=new Set(),routes=[];
  for(const m of models) {
    if(typeof m?.id!=='string'||typeof m.providerID!=='string'||!m.id||!m.providerID)continue;
    const model=`${m.providerID}/${m.id}`,id=`opencode:${model}`;if(seen.has(id))continue;seen.add(id);
    const tiers=Array.isArray(m.cost)?m.cost:[],zero=tiers.length>0&&tiers.every(zeroTier);
    const free=isolated&&m.providerID==='opencode'&&zero;
    const metered=tiers.some(t=>[t?.input,t?.output,t?.cache?.read,t?.cache?.write].some(n=>typeof n==='number'&&n>0));
    routes.push({id,connectionId:'opencode',backend:'opencode',model,name:typeof m.name==='string'?m.name:model,
      description:'Текстовий маршрут без інструментів у відокремленому anonymous runtime',
      checkedAt,expiresAt,source:'OpenCode V2 model.list (isolated anonymous runtime)',
      billing:free?'free_tier':metered?'metered':'unknown',freeConfirmed:free,subscriptionConfirmed:false,includedAccessConfirmed:false,
      billingBoundary:free?'included_only':'unknown',runtimeSupported:free,
      availability:m.enabled===true&&m.status!=='deprecated'?'ready':'unavailable',
      capabilities:{code:true,tools:false,workspaceWrite:false,jsonOutput:'prompt_validated',structuredOutput:false},
      inputModalities:Array.isArray(m.capabilities?.input)?m.capabilities.input.filter(v=>typeof v==='string'):[],
      limit:{context:m.limit?.context??null,input:m.limit?.input??null,output:m.limit?.output??null},
      // Copy only documented numeric tariff fields; never provider headers/settings/body.
      pricing:tiers.map(t=>({input:t?.input??null,output:t?.output??null,cache:{read:t?.cache?.read??null,write:t?.cache?.write??null},
        ...(typeof t?.tier?.size==='number'?{contextFrom:t.tier.size}:{})}))
    });
  }
  return {connection:{id:'opencode',name:'OpenCode',installed:true,authenticated:false,authType:'anonymous',plan:null,
    subscriptionConfirmed:false,requiresAuth:false,checkedAt,version:version??null,source:'OpenCode V2 model.list',
    note:isolated?'Вхід не потрібний. Окремий anonymous runtime: лише нульові тарифи OpenCode, без ключів, MCP та інструментів. Безкоштовна квота може обмежувати запити.':'Ізоляцію runtime не підтверджено; виклики заблоковані.'},routes};
}

export async function inspectOpenCode(command,{run=runProcess,home=OPENCODE_HOME,env=process.env}={}) {
  const isolatedEnv=await opencodeEnvironment({home,env}),cwd=join(home,'workspace');
  const options={cwd,prompt:'',env:isolatedEnv,signal:AbortSignal.timeout(45000)};
  const version=await run(command,['--version'],options);
  if(!supportedVersion(version))throw new Error('Потрібен підтримуваний OpenCode 2.2.6+ у гілці V2');
  const accounts=JSON.parse(await run(command,['auth','list','--format','json','--standalone','--log-level','none'],options));
  if(!Array.isArray(accounts)||accounts.length)throw new Error('Anonymous runtime містить облікові записи або їхній стан невідомий');
  const raw=await run(command,['api','model.list','--standalone','--log-level','none'],options);
  const result=JSON.parse(raw);
  return normalizeOpenCodeMetadata(result.data,{isolated:true,version:version.trim()});
}

export function supportedVersion(value) {
  const match=/^opencode v2\.(\d+)\.(\d+)$/.exec(value.trim());
  return Boolean(match&&(Number(match[1])>2||(Number(match[1])===2&&Number(match[2])>=6)));
}

export async function executeOpenCode(agent,{prompt,signal,onEvent}, {run=runProcess,home=OPENCODE_HOME,env=process.env}={}) {
  if(agent.access!=='read-only')throw new Error('OpenCode поки підтримує лише текстові задачі без інструментів та запису файлів');
  if(!/^opencode\/[^\s#]+$/.test(agent.model??''))throw new Error('Потрібен точний anonymous OpenCode model ID');
  const isolatedEnv=await opencodeEnvironment({home,env});
  const text=[],finished=new Map(),parts=new Set();let steps=0;
  await run(agent.command,['run','--standalone','--model',agent.model,'--format','json','--archived','--log-level','none'],{
    cwd:join(home,'workspace'),env:isolatedEnv,prompt,signal,onLine:line=>{
      let event;try{event=JSON.parse(line);}catch{throw new Error('OpenCode повернув некоректний JSONL');}
      if(event.type==='error')throw new Error('OpenCode не завершив запит: перевірте доступність безкоштовної квоти');
      if(event.type==='tool_use')throw new Error('Інструменти заборонені для текстового маршруту OpenCode');
      if(event.type==='step_start'){steps++;onEvent?.({kind:'model',message:`OpenCode · ${agent.model}`});}
      if(event.type==='text'&&typeof event.part?.text==='string') {
        const id=event.part.id;if(!id||!parts.has(id)){text.push(event.part.text);if(id)parts.add(id);}
      }
      if(event.type==='step_finish') {
        const p=event.part??{};
        if(p.cost!==0)throw new Error('OpenCode не підтвердив нульову вартість результату');
        if(!['stop','end_turn'].includes(p.reason))throw new Error('OpenCode завершив відповідь без повного результату');
        finished.set(p.messageID??p.id??finished.size,p.tokens??null);
      }
    }
  });
  if(!text.join('').trim()||!finished.size||finished.size<steps)throw new Error('OpenCode повернув незавершений результат');
  const tokens=[...finished.values()],usage=tokens.every(t=>t&&Number.isFinite(t.input)&&Number.isFinite(t.output))?{
    input_tokens:tokens.reduce((sum,t)=>sum+t.input,0),output_tokens:tokens.reduce((sum,t)=>sum+t.output,0),
    cached_input_tokens:tokens.reduce((sum,t)=>sum+(t.cache?.read??0),0),cost:0
  }:null;
  return {text:text.join('\n'),usage};
}
