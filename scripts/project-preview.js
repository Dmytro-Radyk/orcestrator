import { createServer, request } from 'node:http';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFile, realpath, stat } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute, sep, extname } from 'node:path';
import { pipeline } from 'node:stream';

const inside = (base,target) => {
  const path=relative(base,target);
  return Boolean(path)&&path!=='..'&&!path.startsWith(`..${sep}`)&&!isAbsolute(path);
};
const types=new Map(Object.entries({
  '.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8','.json':'application/json','.svg':'image/svg+xml','.png':'image/png',
  '.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.ico':'image/x-icon','.avif':'image/avif',
  '.woff':'font/woff','.woff2':'font/woff2','.gif':'image/gif','.wasm':'application/wasm'
}));

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

async function startConfigured(workspace, entry, appOrigin) {
  if(typeof entry.script!=='string')throw Error('Некоректна команда перегляду');
  const script=await realpath(resolve(workspace,entry.script));
  if(!inside(workspace,script)||!['.js','.mjs','.cjs'].includes(extname(script)))throw Error('Команда перегляду виходить за межі проєкту');
  const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>/^(?:path|systemroot|windir|temp|tmp|comspec)$/i.test(key)));
  const child=spawn(process.execPath,[script],{cwd:workspace,env,windowsHide:true,stdio:['ignore','pipe','ignore']});
  const lines=createInterface({input:child.stdout});
  try{
    const target=await new Promise((resolve,reject)=>{
      const timeout=setTimeout(()=>reject(Error('Локальний перегляд не запустився')),12000);
      const finish=(fn,value)=>{clearTimeout(timeout);fn(value);};
      child.once('error',error=>finish(reject,error));
      child.once('exit',()=>finish(reject,Error('Сервер перегляду завершився')));
      lines.on('line',line=>{
        try{
          const data=JSON.parse(line);
          if(data.mode==='TEST_ONLY'&&data.externalCalls===false)finish(resolve,localPreviewUrl(data.url,appOrigin));
        }catch{}
      });
    });
    return {child,target};
  }catch(error){child.kill();throw error;}
  finally{lines.close();child.stdout.resume();}
}

export function createProjectPreview(directory) {
  const sessions=new Map();
  function stop(session){
    clearTimeout(session.timer);
    session.server?.closeAllConnections();session.server?.close();
    session.child?.kill();
  }
  async function open(key,workspace,appOrigin) {
    const cached=sessions.get(key);
    if(cached)return cached;
    const operation=(async()=>{
      const policy=await readFile(join(directory,'preview-commands.json'),'utf8').then(JSON.parse)
        .catch(error=>{if(error.code==='ENOENT')return {};throw error;});
      const configured=policy.projects&&Object.hasOwn(policy.projects,key)?policy.projects[key]:null;
      const base=configured?null:await staticRoot(workspace);
      if(!configured&&!base)return {url:null};
      const session=configured?await startConfigured(workspace,configured,appOrigin):{};
      const framePolicy=`frame-ancestors ${appOrigin}`;
      const staticPolicy=`default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; form-action 'self'; base-uri 'none'; object-src 'none'; ${framePolicy}`;
      const server=createServer(async(req,res)=>{
        if(req.headers.host!==`127.0.0.1:${server.address()?.port}`){res.writeHead(403).end();return;}
        if(session.target){
          const incoming=URL.parse(req.url,session.target.origin);
          if(!incoming||incoming.origin!==session.target.origin){res.writeHead(400).end();return;}
          const headers={...req.headers,host:session.target.host};
          if(headers.origin===`http://${req.headers.host}`)headers.origin=session.target.origin;
          const upstream=request(incoming,{method:req.method,headers},response=>{
            const headers={...response.headers};
            delete headers['x-frame-options'];
            const csp=String(headers['content-security-policy']??'').split(';')
              .filter(part=>part.trim()&&!part.trim().startsWith('frame-ancestors'));
            headers['content-security-policy']=[...csp,framePolicy].join('; ');
            res.writeHead(response.statusCode,headers);
            pipeline(response,res,()=>{});
          });
          upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end();});
          pipeline(req,upstream,()=>{});
          return;
        }
        if(!['GET','HEAD'].includes(req.method)){res.writeHead(405).end();return;}
        try{
          const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
          if(pathname.split('/').some(segment=>segment.startsWith('.')||segment==='node_modules')||pathname.includes('\\')||pathname.includes(':'))throw Error();
          const path=await realpath(resolve(base,`.${pathname.endsWith('/')?pathname+'index.html':pathname}`));
          if(!inside(base,path)||relative(base,path).split(sep).some(segment=>segment.startsWith('.')||segment==='node_modules'))throw Error();
          const type=types.get(extname(path).toLowerCase());
          const info=await stat(path);
          if(!type||!info.isFile()||info.size>32*1024*1024)throw Error();
          const content=req.method==='HEAD'?undefined:await readFile(path);
          res.writeHead(200,{'Content-Type':type,'X-Content-Type-Options':'nosniff','Cache-Control':'no-store','Content-Security-Policy':staticPolicy});
          res.end(content);
        }catch{if(!res.headersSent)res.writeHead(404);res.end();}
      });
      session.server=server;
      try{await new Promise((done,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',done);});}
      catch(error){stop(session);throw error;}
      session.timer=setTimeout(()=>{sessions.delete(key);stop(session);},60*60*1000).unref();
      const path=configured?new URL(configured.startPath??session.target.pathname,'http://localhost').pathname:'/';
      session.url=`http://127.0.0.1:${server.address().port}${path}`;
      session.child?.once('exit',()=>{sessions.delete(key);stop(session);});
      return session;
    })();
    sessions.set(key,operation);
    try{const session=await operation;if(!session.url)sessions.delete(key);return session;}
    catch(error){sessions.delete(key);throw error;}
  }
  return {open,close(){for(const promise of sessions.values())void promise.then(stop).catch(()=>{});sessions.clear();}};
}
