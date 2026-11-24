import { createServer } from 'node:http';
import { readFile, realpath, stat, lstat } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute, sep, extname } from 'node:path';
import { unsafePathSegment } from '../src/workspaces.js';

const inside = (base,target) => {
  const a=process.platform==='win32'?resolve(base).toLowerCase():resolve(base);
  const b=process.platform==='win32'?resolve(target).toLowerCase():resolve(target);
  const path=relative(a,b);
  return Boolean(path)&&path!=='..'&&!path.startsWith(`..${sep}`)&&!isAbsolute(path);
};
const types=new Map(Object.entries({
  '.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8','.json':'application/json','.svg':'image/svg+xml','.png':'image/png',
  '.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.ico':'image/x-icon','.avif':'image/avif',
  '.woff':'font/woff','.woff2':'font/woff2','.gif':'image/gif','.wasm':'application/wasm'
}));
const hopHeaders = new Set(['connection','keep-alive','proxy-authenticate','proxy-authorization','te','trailer','transfer-encoding','upgrade','content-length','x-frame-options']);

export function localPreviewUrl(value, appOrigin) {
  const target=typeof value==='string'?URL.parse(value):null;
  if(!target||target.protocol!=='http:'||target.hostname!=='127.0.0.1'||!target.port||target.username||target.password||target.origin===appOrigin)
    throw Error('Вкажіть HTTP-адресу локального сервера проєкту на окремому порту 127.0.0.1');
  return target;
}

async function staticRoot(workspace) {
  for(const path of ['dist','build','out','apps/web/dist','apps/web','public','.']){
    const candidate=await realpath(join(workspace,path)).catch(()=>null);
    if(!candidate||candidate!==workspace&&!inside(workspace,candidate))continue;
    const entry=await realpath(join(candidate,'index.html')).catch(()=>null);
    if(entry&&inside(candidate,entry)&&(await stat(entry)).isFile())return candidate;
  }
}

async function startConfigured(workspace, entry, previewRuntime) {
  if(typeof previewRuntime!=='function')throw Error('Динамічний перегляд запускається лише в ізольованому Docker-контейнері, який зараз недоступний.');
  const demo=typeof entry.fixture==='string';
  const source=demo?entry.fixture:entry.script;
  if(typeof source!=='string'||!source.trim())throw Error('Некоректна команда перегляду');
  const workspaceReal=await realpath(workspace);
  const candidate=resolve(workspaceReal,source);
  const info=await lstat(candidate).catch(()=>null);
  if(!info?.isFile()||info.isSymbolicLink())throw Error('Скрипт перегляду має бути звичайним файлом у папці проєкту');
  const script=await realpath(candidate);
  const rel=relative(workspaceReal,script).replaceAll('\\','/');
  if(!inside(workspaceReal,script)||!['.js','.mjs','.cjs'].includes(extname(script))||rel.split('/').some(p=>!p||p.startsWith('.')||p==='node_modules'||unsafePathSegment(p)))
    throw Error('Команда перегляду виходить за межі проєкту');
  const bridge=await previewRuntime(workspaceReal,{script:rel,demo});
  return {bridge,demo,pathname:bridge.pathname??'/'};
}

async function readRequestBytes(req, limit = 2 * 1024 * 1024) {
  const chunks=[];
  let size=0;
  for await(const chunk of req){
    size+=chunk.length;
    if(size>limit)throw Error('Preview request body too large');
    chunks.push(chunk);
  }
  return chunks.length?Buffer.concat(chunks).toString('base64'):'';
}

export function createProjectPreview(directory, {previewRuntime}={}) {
  const sessions=new Map();
  function stop(session){
    if(!session||session.stopped)return;
    session.stopped=true;
    clearTimeout(session.timer);
    session.server?.closeAllConnections();session.server?.close();
    session.bridge?.close?.();
  }
  async function open(key,workspace,appOrigin,{candidate=false,revision}={}) {
    const sessionKey=candidate?Symbol(key):key;
    const cached=sessions.get(sessionKey);
    if(cached&&cached.revision===revision)return cached.operation;
    if(cached)(await cached.operation).close?.();
    const operation=(async()=>{
      const policy=await readFile(join(directory,'preview-commands.json'),'utf8').then(JSON.parse)
        .catch(error=>{if(error.code==='ENOENT')return {};throw error;});
      const configured=policy.projects&&Object.hasOwn(policy.projects,key)?policy.projects[key]:null;
      if(candidate&&configured)return {url:null,reason:'Для приймання серверного перегляду потрібне окреме ізольоване середовище.'};
      const base=configured?null:await staticRoot(workspace);
      if(!configured&&!base)return {url:null};
      const session=configured?await startConfigured(workspace,configured,previewRuntime):{};
      const framePolicy=`frame-ancestors ${appOrigin}`;
      const staticPolicy=`default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'; object-src 'none'; ${framePolicy}`;
      const server=createServer(async(req,res)=>{
        const fetchSite=req.headers['sec-fetch-site'];
        if(req.headers.host!==`127.0.0.1:${server.address()?.port}`||fetchSite==='cross-site'){res.writeHead(403).end();return;}
        if(session.bridge){
          try{
            const incoming=URL.parse(req.url,'http://127.0.0.1');
            if(!incoming||incoming.origin!=='http://127.0.0.1'){res.writeHead(400).end();return;}
            const body=await readRequestBytes(req);
            const forwardedHeaders=Object.fromEntries(Object.entries(req.headers)
              .filter(([k,v])=>typeof v==='string'&&!['host','origin','referer','cookie','authorization'].includes(k.toLowerCase())));
            const upstream=await session.bridge.request({method:req.method,path:`${incoming.pathname}${incoming.search}`,headers:forwardedHeaders,body});
            const headers={};
            for(const [k,v] of Object.entries(upstream.headers??{})){
              if(!hopHeaders.has(k.toLowerCase())&&v!==undefined)headers[k]=v;
            }
            const rawCsp=String(headers['content-security-policy']??'').split(';')
              .map(part=>part.trim()).filter(part=>part&&!part.startsWith('frame-ancestors'));
            headers['content-security-policy']=rawCsp.length?[...rawCsp,framePolicy].join('; '):staticPolicy;
            headers['x-content-type-options']='nosniff';
            headers['cache-control']='no-store';
            const payload=upstream.body?Buffer.from(upstream.body,'base64'):Buffer.alloc(0);
            headers['content-length']=String(payload.length);
            res.writeHead(upstream.statusCode??502,headers);
            res.end(req.method==='HEAD'?undefined:payload);
          }catch{if(!res.headersSent)res.writeHead(502);res.end();}
          return;
        }
        if(!['GET','HEAD'].includes(req.method)){res.writeHead(405).end();return;}
        try{
          const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
          if(pathname.split('/').some(segment=>segment&&(segment.startsWith('.')||segment==='node_modules'||unsafePathSegment(segment)))||pathname.includes('\\')||pathname.includes(':'))throw Error();
          const path=await realpath(resolve(base,`.${pathname.endsWith('/')?pathname+'index.html':pathname}`));
          if(!inside(base,path)||relative(base,path).split(sep).some(segment=>segment.startsWith('.')||segment==='node_modules'||unsafePathSegment(segment)))throw Error();
          const type=types.get(extname(path).toLowerCase());
          const info=await stat(path);
          if(!type||!info.isFile()||info.size>32*1024*1024)throw Error();
          const content=req.method==='HEAD'?undefined:await readFile(path);
          res.writeHead(200,{'Content-Type':type,'X-Content-Type-Options':'nosniff','Cache-Control':'no-store','Content-Security-Policy':staticPolicy});
          res.end(content);
        }catch{if(!res.headersSent)res.writeHead(404).end();}
      });
      session.server=server;
      try{await new Promise((done,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',done);});}
      catch(error){stop(session);throw error;}
      session.close=()=>{if(sessions.get(sessionKey)?.operation===operation)sessions.delete(sessionKey);stop(session);};
      session.timer=setTimeout(session.close,60*60*1000).unref();
      const path=configured?new URL(configured.startPath??session.pathname,'http://localhost').pathname:'/';
      session.url=`http://127.0.0.1:${server.address().port}${path}`;
      session.bridge?.onExit?.(session.close);
      return session;
    })();
    sessions.set(sessionKey,{operation,revision});
    try{
      const session=await operation;
      if(!session.url&&sessions.get(sessionKey)?.operation===operation)sessions.delete(sessionKey);
      return session;
    }catch(error){
      if(sessions.get(sessionKey)?.operation===operation)sessions.delete(sessionKey);
      throw error;
    }
  }
  return {open,close(){for(const {operation} of sessions.values())void operation.then(stop).catch(()=>{});sessions.clear();}};
}
