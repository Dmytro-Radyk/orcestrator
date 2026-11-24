import { spawn } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { dirname,isAbsolute } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { terminate } from '../src/providers.js';

export const loopback=url=>['127.0.0.1','localhost','[::1]'].includes(new URL(url).hostname);

export function serviceLauncher(value,url){
  if(value===undefined)return undefined;
  if(!loopback(url)||typeof value?.executable!=='string'||!isAbsolute(value.executable)||
    !Array.isArray(value.args??[])||(value.args??[]).length>24||
    (value.args??[]).some(arg=>typeof arg!=='string'||arg.length>1000||arg.includes('\0'))||
    (value.cwd!==undefined&&(typeof value.cwd!=='string'||!isAbsolute(value.cwd))))
    throw Error('Для запуску локального сервісу потрібна loopback-адреса й абсолютний шлях до програми.');
  return {executable:value.executable,args:value.args??[],cwd:value.cwd??dirname(value.executable)};
}

async function startLocal({executable,args,cwd}){
  if(!(await lstat(executable)).isFile())throw Error('Програму локального підключення не знайдено.');
  const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>
    /^(?:path|pathext|systemroot|windir|comspec|temp|tmp|localappdata|appdata|userprofile|home|lang|lc_all)$/i.test(key)));
  const child=spawn(executable,args,{cwd,env,shell:false,detached:process.platform!=='win32',stdio:'ignore',windowsHide:true});
  await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
  child.unref();
  return child;
}

async function mcpInitialized(response,signal){
  const contentType=response.headers.get('content-type')??'';
  if(!response.body||!/(?:application\/json|text\/event-stream)/i.test(contentType))return false;
  const reader=response.body.getReader(), decoder=new TextDecoder();
  let body='', bytes=0;
  const valid=text=>{
    try{
      const value=JSON.parse(text);
      return value.jsonrpc==='2.0'&&value.id===1&&typeof value.result?.protocolVersion==='string';
    }catch{return false;}
  };
  try{
    while(bytes<32768){
      signal.throwIfAborted();
      const {value,done}=await reader.read();
      if(done)break;
      bytes+=value.length;
      body+=decoder.decode(value,{stream:true});
      if(contentType.includes('text/event-stream')){
        const events=body.split(/\r?\n\r?\n/);
        body=events.pop();
        if(events.some(event=>valid(event.split(/\r?\n/).filter(line=>line.startsWith('data:'))
          .map(line=>line.slice(5).trimStart()).join('\n'))))return true;
      }
    }
    return bytes<=32768&&valid(body);
  }finally{await reader.cancel().catch(()=>{});}
}

export function createConnectionRecovery({request=fetch,start=startLocal,sleep=delay}={}){
  const active=new Map(), recent=new Map(), spawned=new Map(), failures=new Map();
  let closed=false;
  async function check(entry){
    const signal=AbortSignal.timeout(2500);
    try{
      const mcp=entry.kind==='mcp';
      const response=await request(entry.url,{redirect:'manual',signal,...(mcp?{
        method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream'},
        body:JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',
          params:{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'orcestrator-health',version:'1.0.0'}}})
      }:{method:'GET',headers:{Accept:'application/json'}})});
      if(response.ok&&mcp&&response.status!==204){
        const ready=await mcpInitialized(response,signal);
        const session=response.headers.get('mcp-session-id');
        if(ready&&session&&/^[!-~]{1,256}$/.test(session)){
          try{
            const closed=await request(entry.url,{method:'DELETE',redirect:'manual',signal:AbortSignal.timeout(1000),
              headers:{'MCP-Session-Id':session}});
            await closed.body?.cancel();
          }catch{ /* The health handshake succeeded even if the server does not end probe sessions. */ }
        }
        return ready?'ready':'invalid';
      }
      await response.body?.cancel().catch(()=>{});
      if(response.status===401||response.status===403)return 'auth';
      if(response.ok)return mcp?'invalid':'ready';
      return response.status===429||response.status>=500?'retry':'invalid';
    }catch(error){
      return error.cause?.code==='ECONNREFUSED'||/connection refused/i.test(error.message)?'offline':'retry';
    }
  }
  async function recover(entry,key){
    if(closed)return {state:'offline'};
    const state=await check(entry);
    if(!['offline','retry'].includes(state)){failures.delete(key);return {state};}
    if(state==='offline'&&entry.start){
      const running=spawned.get(key);
      const alive=running&&running.exitCode===null&&running.signalCode===null;
      if(!alive){
        try{
          const child=await start(entry.start);
          if(child&&typeof child==='object')spawned.set(key,child);
        }catch{return {state:'start_failed'};}
      }
      for(let i=0;i<5;i++){
        await sleep(500*(i+1));
        if(closed)return {state:'offline'};
        const nextState=await check(entry);
        if(!['offline','retry'].includes(nextState)){failures.delete(key);return {state:nextState,started:!alive};}
      }
      failures.set(key,(failures.get(key)??0)+1);
      return {state:'offline'};
    }
    await sleep(650);
    return {state:await check(entry)};
  }
  function ensure(entry){
    const key=JSON.stringify([entry.kind,entry.url,entry.start]);
    const cached=recent.get(key);
    if(cached?.expires>Date.now())return Promise.resolve(cached.result);
    if(active.has(key))return active.get(key);
    const current=recover(entry,key).then(result=>{
      const failCount=failures.get(key)??0;
      const ttl=result.state==='ready'?15000:Math.min(60000,4000*2**Math.min(4,failCount));
      recent.set(key,{result:{state:result.state},expires:Date.now()+ttl});
      return result;
    }).finally(()=>active.delete(key));
    active.set(key,current);
    return current;
  }
  ensure.close=()=>{
    closed=true;
    for(const child of spawned.values())terminate(child);
    spawned.clear();
  };
  return ensure;
}
