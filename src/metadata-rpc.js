import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { terminate } from './providers.js';

const METHODS=new Set(['initialize','account/read','account/rateLimits/read','model/list']);
// Deliberately no thread/turn/login/tool methods: discovery cannot start model work.
export function metadataRpc(command,args,{cwd,timeoutMs=15000}={}) {
  const child=spawn(command,args,{cwd,shell:false,windowsHide:true,stdio:['pipe','pipe','pipe']});
  let next=1,closed=false,bytes=0;
  const pending=new Map();
  const fail=error=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(error);}pending.clear();};
  child.on('error',()=>fail(new Error('Не вдалося запустити metadata-процес')));
  child.on('close',()=>{closed=true;fail(new Error('Metadata-процес завершився до відповіді'));});
  child.stdin.on('error',()=>{});
  child.stderr.on('data',()=>{}); // Never forward config/auth stderr into UI or persisted state.
  const lines=createInterface({input:child.stdout});
  lines.on('line',line=>{
    bytes+=Buffer.byteLength(line);if(bytes>4*1024*1024){fail(new Error('Завелика metadata-відповідь'));if(child.pid)terminate(child);return;}
    let msg;try{msg=JSON.parse(line);}catch{return;}
    if(msg.method && msg.id!=null) {
      child.stdin.write(JSON.stringify({id:msg.id,error:{code:-32601,message:'Read-only discovery does not handle server requests'}})+'\n');return;
    }
    const p=pending.get(msg.id);if(!p)return;
    clearTimeout(p.timer);pending.delete(msg.id);
    if(msg.error)p.reject(new Error(`Metadata ${p.method}: ${msg.error.code??'error'}`));else p.resolve(msg.result);
  });
  return {
    request(method,params={}) {
      if(!METHODS.has(method))return Promise.reject(new Error('Метод заборонено для discovery'));
      if(closed)return Promise.reject(new Error('Metadata-процес уже закрито'));
      const id=next++;
      return new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>{pending.delete(id);reject(new Error(`Metadata timeout: ${method}`));},timeoutMs);
        pending.set(id,{resolve,reject,timer,method});child.stdin.write(JSON.stringify({id,method,params})+'\n');
      });
    },
    initialized(){if(!closed)child.stdin.write(JSON.stringify({method:'initialized',params:{}})+'\n');},
    async close(){
      fail(new Error('Discovery завершено'));lines.close();
      if(closed)return;
      const ended=new Promise(resolve=>child.once('close',resolve));
      child.stdin.end();
      const timer=setTimeout(()=>{if(!closed&&child.pid)terminate(child);},300);
      await ended;clearTimeout(timer);
    }
  };
}
