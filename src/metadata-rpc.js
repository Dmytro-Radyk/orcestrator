import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { terminate } from './providers.js';

const METHODS=new Set(['initialize','account/read','account/rateLimits/read','model/list']);
// Deliberately no thread/turn/login/tool methods: discovery cannot start model work.
export function metadataRpc(command,args,{cwd,env,signal,timeoutMs=15000}={}) {
  signal?.throwIfAborted();
  const child=spawn(command,args,{cwd,...(env?{env}:{}),shell:false,windowsHide:true,stdio:['pipe','pipe','pipe']});
  let next=1,closed=false,bytes=0,closing;
  const pending=new Map();
  const fail=error=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(error);}pending.clear();};
  const onAbort=()=>{void api.close(signal.reason??new Error('Перевірку доступу Codex скасовано'));};
  signal?.addEventListener('abort',onAbort,{once:true});
  child.on('error',()=>fail(new Error('Не вдалося запустити metadata-процес')));
  child.on('close',()=>{closed=true;signal?.removeEventListener('abort',onAbort);fail(new Error('Metadata-процес завершився до відповіді'));});
  child.stdin.on('error',()=>{});
  child.stderr.on('data',()=>{}); // Never forward config/auth stderr into UI or persisted state.
  child.stdout.on('data',chunk=>{
    bytes+=Buffer.isBuffer(chunk)?chunk.length:Buffer.byteLength(chunk);
    if(bytes>4*1024*1024){fail(new Error('Завелика metadata-відповідь'));if(child.pid)terminate(child);lines.close();child.stdout.destroy();}
  });
  const lines=createInterface({input:child.stdout});
  lines.on('line',line=>{
    let msg;try{msg=JSON.parse(line);}catch{return;}
    if(!msg||typeof msg!=='object'||Array.isArray(msg))return;
    if(msg.method && msg.id!=null) {
      child.stdin.write(JSON.stringify({id:msg.id,error:{code:-32601,message:'Read-only discovery does not handle server requests'}})+'\n');return;
    }
    const p=pending.get(msg.id);if(!p)return;
    clearTimeout(p.timer);pending.delete(msg.id);
    if(msg.error)p.reject(new Error(`Metadata ${p.method}: ${msg.error.code??'error'}`));else p.resolve(msg.result);
  });
  const api = {
    request(method,params={}) {
      if(!METHODS.has(method))return Promise.reject(new Error('Метод заборонено для discovery'));
      if(closed||closing)return Promise.reject(new Error('Metadata-процес уже закрито'));
      const id=next++;
      return new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>{pending.delete(id);reject(Object.assign(new Error('Не вдалося вчасно перевірити доступ до Codex'),{code:'METADATA_TIMEOUT'}));},timeoutMs);
        pending.set(id,{resolve,reject,timer,method});child.stdin.write(JSON.stringify({id,method,params})+'\n');
      });
    },
    initialized(){if(!closed)child.stdin.write(JSON.stringify({method:'initialized',params:{}})+'\n');},
    async close(reason=new Error('Перевірку доступу Codex перервано до отримання відповіді')){
      if(closing)return closing;
      closing=(async()=>{
        signal?.removeEventListener('abort',onAbort);
        fail(reason);lines.close();
        if(closed)return;
        const ended=new Promise(resolve=>child.once('close',resolve));
        child.stdin.end();
        const timer=setTimeout(()=>{if(!closed&&child.pid)terminate(child);},300);
        try{await ended;}finally{clearTimeout(timer);}
      })();
      return closing;
    }
  };
  return api;
}
