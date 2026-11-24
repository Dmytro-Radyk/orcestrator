import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { lstat, realpath } from 'node:fs/promises';
import { existsSync,readFileSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { redactSecrets, runProcess, terminate } from '../src/providers.js';
import { resolveProjectRuntime } from './project-runtime-profile.js';
import { resolveIsolatedCompanionFile } from '../src/domain-profiles.js';

export const nodeTestPath=/^(?:tests?|src)\/(?:[\w-]+\/)*[\w.-]+\.(?:test|spec)\.(?:[cm]?js|ts)$/;
export const managedCheckKind=file=>/^scripts\/check-[a-z0-9-]+-browser\.mjs$/.test(file)?'browser':
  /^scripts\/test-[a-z0-9-]+-postgres\.mjs$/.test(file)?'postgres':null;
const imageDirectory=fileURLToPath(new URL('./project-check-image/',import.meta.url));
const previewContainerScript=fileURLToPath(new URL('./project-preview-container.mjs',import.meta.url));
const isDockerTransportError=error=>/failed to connect to the docker (?:API|daemon)|cannot connect to the docker daemon|open \/\/\.\/pipe\/dockerDesktopLinuxEngine/i.test(error.message);
const unavailable=error=>Object.assign(Error('Docker Engine недоступний. '+redactSecrets(error.message,450)),{code:'LOCAL_DOCKER_UNAVAILABLE'});

export function createDockerReadiness(probe,start,{sleep=delay}={}){
  let starting, lastFailure, retryAt=0;
  async function startAndWait(){
    await start();
    for(const wait of [0,500,1500,3000]){
      if(wait)await sleep(wait);
      try{await probe();return;}
      catch(error){if(wait===3000||!isDockerTransportError(error))throw error;}
    }
  }
  return async function ensureEngine(signal){
    signal?.throwIfAborted();
    try{await probe(signal);return;}
    catch(error){
      signal?.throwIfAborted();
      if(!isDockerTransportError(error))throw unavailable(error);
    }
    if(Date.now()<retryAt)throw lastFailure;
    starting??=startAndWait().catch(error=>{
      lastFailure=unavailable(error);
      retryAt=Date.now()+30000;
      throw lastFailure;
    })
      .finally(()=>{starting=undefined;});
    await starting;
    signal?.throwIfAborted();
  };
}

export function localTestRuntime(env=process.env,{run=runProcess}={}) {
  const desktop=env.LOCALAPPDATA&&join(env.LOCALAPPDATA,'Programs','DockerDesktop','resources','bin','docker.exe');
  const installed=process.platform==='win32'&&[
    desktop,env.ProgramFiles&&join(env.ProgramFiles,'Docker','Docker','resources','bin','docker.exe')
  ].find(path=>path&&isAbsolute(path)&&existsSync(path));
  if(!installed)return null;
  const processEnv=Object.fromEntries(Object.entries(env).filter(([key])=>
    /^(?:path|pathext|systemroot|windir|temp|tmp|localappdata|appdata|userprofile)$/i.test(key)));
  const pathKey=Object.keys(processEnv).find(key=>key.toLowerCase()==='path')??'Path';
  processEnv[pathKey]=dirname(installed)+delimiter+(processEnv[pathKey]??'');
  const invoke=(args,options)=>run(installed,['--context','desktop-linux',...args],
    {env:processEnv,prompt:'',...options});
  const ensureEngine=createDockerReadiness(
    signal=>invoke(['version','--format','{{.Server.Version}}'],{cwd:imageDirectory,
      signal:signal?AbortSignal.any([signal,AbortSignal.timeout(12000)]):AbortSignal.timeout(12000)}),
    ()=>invoke(['desktop','start','--timeout','70'],{cwd:imageDirectory,signal:AbortSignal.timeout(75000)})
  );
  const imageVersion=['Dockerfile','run-check.mjs'].reduce((hash,file)=>hash.update(readFileSync(join(imageDirectory,file))),
    createHash('sha256')).digest('hex').slice(0,16);
  const version=createHash('sha256').update(imageVersion)
    .update(readFileSync(new URL('./project-runtime-profile.js',import.meta.url))).digest('hex').slice(0,16);
  const builds=new Map();
  async function prepare(signal,{node='24',postgres='17'}={}){
    signal?.throwIfAborted();
    const image=`orcestrator-project-checks:${imageVersion}-node${node}-pg${postgres}`;
    let building=builds.get(image);
    if(!building){
      building=(async()=>{
        await ensureEngine();
        try{await invoke(['image','inspect','--format','{{.Id}}',image],
          {cwd:imageDirectory,signal:AbortSignal.timeout(12000)});}
        catch{
          await invoke(['build','--quiet','--tag',image,'--build-arg',`NODE_VERSION=${node}`,
            '--build-arg',`POSTGRES_VERSION=${postgres}`,imageDirectory],
            {cwd:imageDirectory,signal:AbortSignal.timeout(360000)});
        }
        return image;
      })().catch(error=>{
        builds.delete(image);
        if(error.code==='LOCAL_DOCKER_UNAVAILABLE'||isDockerTransportError(error))throw error.code==='LOCAL_DOCKER_UNAVAILABLE'?error:unavailable(error);
        throw Error('Не вдалося підготувати Docker-середовище тестів: '+redactSecrets(error.message,400));
      });
      builds.set(image,building);
    }
    if(!signal)return building;
    return new Promise((resolve,reject)=>{
      const abort=()=>reject(signal.reason);
      signal.addEventListener('abort',abort,{once:true});
      building.then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
      if(signal.aborted)abort();
    });
  }
  async function runIsolated(cwd,files,image,command,signal){
    const root=await realpath(cwd);
    if(root.includes(','))throw Error('Docker не підтримує цей шлях до робочої папки.');
    for(const file of files){
      const path=join(root,file),actual=await realpath(path);
      if(!(await lstat(path)).isFile()||(process.platform==='win32'?actual.toLowerCase()!==path.toLowerCase():actual!==path))throw Error('Тест має бути звичайним файлом у знімку проєкту.');
    }
    await ensureEngine(signal);
    const name='orcestrator-node-test-'+randomUUID();
    const timeout=AbortSignal.timeout(140000);
    const deadline=signal?AbortSignal.any([signal,timeout]):timeout;
    try {
      deadline.throwIfAborted();
      const output=await invoke(['run','--name',name,'--rm','--network','none','--read-only','--cap-drop','ALL',
        '--security-opt','no-new-privileges:true','--pids-limit','128','--memory','768m','--cpus','2','--user','1000:1000',
        '--tmpfs','/tmp:rw,nosuid,nodev,size=256m','--mount',`type=bind,source=${root},target=/project,readonly`,
        '--workdir','/project','--entrypoint','node',image,...command],
      {cwd:root,signal:deadline});
      return {exitCode:0,output:redactSecrets(output.slice(-5000),5000)};
    }catch(error){
      signal?.throwIfAborted();
      if(timeout.aborted)throw Error('Перевищено час тестування в Docker.');
      if(isDockerTransportError(error)||error.exitCode==null||[125,126,127].includes(error.exitCode))throw unavailable(error);
      return {exitCode:error.exitCode,output:redactSecrets([error.stdout,error.message].filter(Boolean).join('\n').slice(-8000),5500)};
    }finally{
      await invoke(['rm','--force',name],{cwd:root,signal:AbortSignal.timeout(8000)}).catch(()=>{});
    }
  };
  async function startPreview(cwd,{script,demo=false}={}){
    const root=await realpath(cwd);
    if(root.includes(',')||previewContainerScript.includes(','))throw Error('Docker не підтримує цей шлях до робочої папки.');
    const target=join(root,script),actualTarget=await realpath(target);
    if(!(await lstat(target)).isFile()||(process.platform==='win32'?actualTarget.toLowerCase()!==target.toLowerCase():actualTarget!==target))throw Error('Скрипт перегляду має бути звичайним файлом у папці проєкту.');
    await ensureEngine();
    const runtime=await resolveProjectRuntime(root);
    const name='orcestrator-preview-'+randomUUID();
    const child=spawn(installed,['--context','desktop-linux','run','-i','--name',name,'--rm','--network','none','--read-only',
      '--cap-drop','ALL','--security-opt','no-new-privileges:true','--pids-limit','128','--memory','768m','--cpus','2','--user','1000:1000',
      '--tmpfs','/tmp:rw,nosuid,nodev,size=256m','--mount',`type=bind,source=${root},target=/project,readonly`,
      '--mount',`type=bind,source=${previewContainerScript},target=/opt/orcestrator-preview-runner.mjs,readonly`,
      '--workdir','/project','--entrypoint','node',`node:${runtime.node}-bookworm-slim`,
      '/opt/orcestrator-preview-runner.mjs',demo?'fixture':'script',script],
      {cwd:root,env:processEnv,shell:false,windowsHide:true,stdio:['pipe','pipe','pipe']});
    let seq=0,closed=false,stderr='';
    const pending=new Map(),exitListeners=new Set();
    child.stderr.setEncoding('utf8').on('data',chunk=>{if(stderr.length<4096)stderr+=chunk;});
    child.stdin.on('error',()=>{});
    const lines=createInterface({input:child.stdout});
    const failAll=err=>{for(const entry of pending.values()){clearTimeout(entry.timer);entry.reject(err);}pending.clear();};
    const cleanup=()=>{
      if(closed)return;
      closed=true;
      lines.close();
      try{child.stdin.end();}catch{}
      if(child.pid)terminate(child);
      void invoke(['rm','--force',name],{cwd:root,signal:AbortSignal.timeout(8000)}).catch(()=>{});
      failAll(new Error('Контейнер перегляду зупинено'));
      for(const fn of exitListeners){try{fn();}catch{}}
      exitListeners.clear();
    };
    child.once('exit',cleanup);
    child.once('error',cleanup);
    try{
      const ready=await new Promise((done,reject)=>{
        const timer=setTimeout(()=>reject(new Error('Контейнер перегляду не відповів вчасно')),25000);
        const finish=(fn,val)=>{clearTimeout(timer);fn(val);};
        child.once('error',err=>finish(reject,err));
        child.once('exit',()=>finish(reject,new Error(redactSecrets(stderr||'Контейнер перегляду завершився',400))));
        lines.on('line',line=>{
          let msg;try{msg=JSON.parse(line);}catch{return;}
          if(msg?.type==='ready'){finish(done,msg);return;}
          if(msg?.type==='error'){finish(reject,new Error(redactSecrets(msg.message??'Помилка перегляду',400)));return;}
          if(msg?.id!==undefined&&pending.has(msg.id)){
            const entry=pending.get(msg.id);pending.delete(msg.id);clearTimeout(entry.timer);entry.resolve(msg);
          }
        });
      });
      return {
        pathname:ready.pathname??'/',
        request(payload){
          if(closed)return Promise.reject(new Error('Контейнер перегляду вже закрито'));
          const id=++seq;
          return new Promise((done,reject)=>{
            const timer=setTimeout(()=>{pending.delete(id);reject(new Error('Таймаут відповіді перегляду'));},16000);
            pending.set(id,{resolve:done,reject,timer});
            child.stdin.write(`${JSON.stringify({id,...payload})}\n`);
          });
        },
        onExit(fn){if(closed)fn();else exitListeners.add(fn);},
        close:cleanup
      };
    }catch(error){
      cleanup();
      if(isDockerTransportError(error))throw unavailable(error);
      throw error;
    }
  }
  const testNode=async(cwd,files,signal)=>{
    if(!validNodeTests(files))throw Error('Потрібні від 1 до 20 відносних шляхів до Node.js тестів.');
    const runtime=await resolveProjectRuntime(cwd);
    const result=await runIsolated(cwd,files,`node:${runtime.node}-bookworm-slim`,
      ['--test','--test-reporter=tap','--',...files],signal);
    return {...result,runtime};
  };
  testNode.prepare=prepare;
  testNode.version=version;
  testNode.preview=startPreview;
  testNode.script=async(cwd,file,signal)=>{
    const mode=managedCheckKind(file);
    if(!mode)throw Error('Вкажіть підтримуваний сценарій Chromium або PostgreSQL.');
    const companion=resolveIsolatedCompanionFile(file);
    const app=companion&&existsSync(join(cwd,companion))?companion:null;
    const files=app?[file,app]:[file];
    const runtime=await resolveProjectRuntime(cwd,{includePostgres:true});
    const image=await prepare(signal,runtime);
    const result=await runIsolated(cwd,files,image,['/opt/orcestrator/run-check.mjs',mode,...files],signal);
    return {...result,runtime};
  };
  return testNode;
}

export function validNodeTests(files) {
  return Array.isArray(files)&&files.length>=1&&files.length<=20&&new Set(files).size===files.length&&
    files.every(file=>typeof file==='string'&&file.length<=240&&nodeTestPath.test(file)&&!file.split('/').some(part=>part.startsWith('.')));
}
