import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { mkdir, realpath, readdir, readFile, stat } from 'node:fs/promises';
import { resolve, relative, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Engine } from '../src/engine.js';
import { Store } from '../src/store.js';
import { validateTasks } from '../apps/web/src/state.js';
import { createModelRegistry,withModelPolicy } from './model-registry.js';
import { createDirector,planFingerprint,routingCandidates,validateRouteAssignments } from './director-service.js';
import { WorkspaceManager } from '../src/workspaces.js';
import { streamRun } from '../src/run-stream.js';
import { executionAgent } from './execution-agent.js';
import { createRecoveryHandler } from './recovery-service.js';

const inside = (root, path) => { const rel=relative(root,path); return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel); };
const excluded = name => /^(?:\.git|\.env(?:\..*)?|node_modules|\.codex|\.aws)$/i.test(name) || /\.(?:pem|key|p12|pfx)$/i.test(name);
const root = fileURLToPath(new URL('../.orchestrator/', import.meta.url));

export function executorConfig(env=process.env) {
  const model=env.ORCHESTRATOR_EXECUTOR_MODEL ?? 'gpt-6.1-sol';
  return { model, command:env.ORCHESTRATOR_EXECUTOR_COMMAND ?? env.ORCHESTRATOR_PLANNER_COMMAND ?? 'codex',
    reasoningEffort:env.ORCHESTRATOR_EXECUTOR_REASONING ?? 'high' };
}
export async function workspaceFiles(directory) {
  const result=[];
  async function walk(dir) {
    for (const entry of await readdir(dir,{withFileTypes:true})) {
      if (excluded(entry.name) || entry.isSymbolicLink()) continue;
      if(result.length>=200) return;
      const path=join(dir,entry.name);
      if(entry.isDirectory()) await walk(path);
      else if(entry.isFile()) {
        const info=await stat(path);
        const hash=info.size<=1024*1024 ? createHash('sha256').update(await readFile(path)).digest('hex') : null;
        result.push({path:relative(directory,path).replaceAll('\\','/'),size:info.size,hash});
      }
    }
  }
  await walk(directory); return result;
}
export function createExecutionService({directory=join(root,'ui'),workspaces=join(root,'workspaces'),config=executorConfig(),provider,registry:injectedRegistry}={}) {
  const store=new Store(directory);
  const registry=injectedRegistry??createModelRegistry({store,env:{...process.env,ORCHESTRATOR_EXECUTOR_COMMAND:config.command}});
  const director=createDirector({registry,provider});
  const engine=new Engine(store,withModelPolicy(registry,provider),{workspaces:new WorkspaceManager(join(workspaces,'.runs'),{allowedRoot:workspaces})});
  const token=randomBytes(32).toString('hex');
  const launching=new Set();
  const routingControls=new Map();
  const streams=new Set();
  const routingPlan=p=>({summary:p.description||p.name,assumptions:[],risks:[],tasks:p.tasks.filter(t=>!t.parentId).map(t=>({
    id:t.id,title:t.title,prompt:t.prompt,skills:t.skills??[],dependsOn:t.dependsOn,acceptanceCriteria:t.acceptanceCriteria??[]}))});
  const isCurrentRun=run=>{
    const p=store.data.ui?.workspace.projects.find(p=>p.id===run.project.uiProjectId);
    return Boolean(p&&p.revision===run.project.uiRevision&&planFingerprint(routingPlan(p))===run.project.uiPlanFingerprint);
  };
  engine.recover=createRecoveryHandler({engine,registry,director,config,isCurrent:isCurrentRun});
  const runtimes=()=>registry.snapshot().routes.filter(r=>['codex','opencode'].includes(r.backend)).flatMap(r=>[
    ...(r.capabilities?.workspaceWrite?[{id:`${r.id}#write`,name:`${r.backend} · розробка`,provider:r.backend,model:r.model,routeId:r.id,billing:r.billing,billingBoundary:r.billingBoundary,access:'workspace-write',allowed:r.decision.allowed,reason:r.decision.reason}]:[]),
    {id:`${r.id}#read`,name:`${r.backend} · перевірка`,provider:r.backend,model:r.model,routeId:r.id,billing:r.billing,billingBoundary:r.billingBoundary,access:'read-only',allowed:r.decision.allowed,reason:r.decision.reason}]);
  function uiProject(key) {
    const p=store.data.ui?.workspace.projects.find(p=>p.id===key);
    if(!p) throw new Error('Проєкт не збережений на сервері'); return p;
  }
  async function workspace(key) {
    await mkdir(workspaces,{recursive:true});
    const base=await realpath(workspaces);
    const path=join(base,createHash('sha256').update(key).digest('hex').slice(0,24));
    await mkdir(path,{recursive:true});
    const actual=await realpath(path);
    if(!inside(base,actual)) throw new Error('Робоча папка виходить за межі каталогу проєктів');
    return actual;
  }
  async function present(run) {
    run.draining=!['running','paused'].includes(run.status)&&Boolean(engine.controls.get(run.id)?.active.size||engine.controls.get(run.id)?.recovering);
    if(!['running','paused'].includes(run.status) && !run.files && !run.draining) {
      const before=new Map((run.beforeFiles??[]).map(f=>[f.path,f]));
      const current=await workspaceFiles(run.project.workspace),present=new Set(current.map(f=>f.path));
      run.files=[...current.map(f=>({...f,change:!before.has(f.path)?'created':before.get(f.path).hash!==f.hash?'modified':'unchanged'})),
        ...[...before.values()].filter(f=>!present.has(f.path)).map(f=>({...f,change:'deleted'}))];
      store.save();
    }
    return run;
  }
  const summary=run=>({id:run.id,projectId:run.projectId,uiProjectId:run.project.uiProjectId,uiRevision:run.project.uiRevision,
    name:run.project.name,status:run.status,calls:run.calls,createdAt:run.createdAt,finishedAt:run.finishedAt});
  async function readBody(req) {
    let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>5*1024*1024)throw new Error('Завеликий запит');}
    return raw?JSON.parse(raw):{};
  }
  function saveWorkspace(input) {
    if(input.revision!==(store.data.ui?.revision??0)) throw new Error('Конфлікт збереження: оновіть сторінку, щоб отримати актуальні дані');
    const value=input.workspace;
    if(value?.version!==1 || !Array.isArray(value.projects) || !value.projects.length || !Array.isArray(value.agents) || !value.agents.length || value.projects.length>100 || value.agents.length>100) throw new Error('Некоректний робочий простір');
    const ids=new Set();
    for(const p of value.projects) {
      if(typeof p.id!=='string'||!p.id||ids.has(p.id)||typeof p.name!=='string'||!p.name.trim()||!Array.isArray(p.tasks)||p.tasks.length>100)throw new Error('Некоректний проєкт');
      ids.add(p.id);validateTasks(p.tasks);
    }
    store.data.ui={revision:input.revision+1,workspace:structuredClone(value)};store.save();return store.data.ui;
  }
  async function launchReady(input) {
    const p=uiProject(input.projectId);
    if(p.revision!==input.revision)throw new Error('План змінився: відкрийте налаштування запуску знову');
    if(Object.values(store.data.runs).some(r=>r.project.uiProjectId===p.id&&(['running','paused'].includes(r.status)||engine.controls.get(r.id)?.active.size)))throw new Error('Цей проєкт уже виконується або завершує скасування');
    await registry.scan();
    const proposal=input.proposalId?store.data.routing?.[p.id]:null;
    if(input.proposalId&&(!proposal||proposal.id!==input.proposalId||proposal.revision!==p.revision||proposal.planFingerprint!==planFingerprint(routingPlan(p))))throw new Error('Пропозиція AI застаріла або не знайдена');
    if(proposal)validateRouteAssignments(proposal,routingPlan(p),routingCandidates(routingPlan(p),registry.snapshot().routes,proposal.requirements),{maxAgentsPerTask:proposal.maxAgentsPerTask});
    const agents=[],tasks=[],seen=new Map();
    function bind(a,runtime) {
      if(!runtime)throw new Error(`Оберіть реального виконавця для ${a.name}`);
      if(!runtime.allowed)throw new Error(runtime.reason);
      const id=proposal?`route-${createHash('sha256').update(runtime.id).digest('hex').slice(0,16)}`:a.id;
      if(seen.has(id))return id;seen.set(id,true);
      agents.push(executionAgent(registry.snapshot().routes.find(r=>r.id===runtime.routeId),{id,name:proposal?runtime.model:a.name,role:a.role,skills:a.skills??[],access:runtime.access,config}));return id;
    }
    for(const t of p.tasks.filter(t=>!t.parentId)) {
      let ids;
      if(proposal) {
        const assignment=proposal.assignments.find(a=>a.taskId===t.id);if(!assignment?.routeIds?.length)throw Error('Неповне AI-призначення');
        ids=assignment.routeIds.map(routeId=>bind({role:t.title,skills:t.skills},runtimes().find(r=>r.routeId===routeId&&r.access===(proposal.requirements[t.id]?.workspaceWrite===false?'read-only':'workspace-write'))));
      }else {
        ids=t.agentIds.map(id=>{
          const a=store.data.ui.workspace.agents.find(a=>a.id===id);if(!a)throw Error('Профіль виконавця не знайдено');
          const selected=input.bindings?.[id],alias=selected==='codex-write'?`codex:${config.model}#write`:selected==='codex-read'?`codex:${config.model}#read`:selected;
          return bind(a,runtimes().find(r=>r.id===alias));
        });
      }
      if(!ids.length)throw Error('Призначте виконавців задач');
      tasks.push({id:t.id,title:t.title,prompt:t.prompt,skills:t.skills??[],agentIds:ids,dependsOn:t.dependsOn,
        acceptanceCriteria:t.acceptanceCriteria??[],mode:t.mode??'pipeline',allowDelegation:p.allowDelegation!==false&&t.allowDelegation!==false});
    }
    const dir=await workspace(p.id);
    const inputProject={name:p.name,goal:p.description,uiProjectId:p.id,uiRevision:p.revision,planning:p.planning,
      uiPlanFingerprint:planFingerprint(routingPlan(p)),routingRequirements:structuredClone(proposal?.requirements??{}),
      recovery:{enabled:p.recovery?.enabled??true,maxAttempts:p.recovery?.maxAttempts??2,...(p.recovery?.managerRouteId?{managerRouteId:p.recovery.managerRouteId}:{})},
      workspace:dir,workspaceMode:'isolated',agents,tasks,...(proposal?{routingProposalId:proposal.id}:{}),
      limits:{concurrency:p.concurrency,maxCalls:p.maxCalls,timeoutMs:240000,maxOutputTokens:12000,maxDepth:p.allowDelegation===false?0:p.maxDepth??2,maxTasks:p.maxTasks??100}};
    const previous=Object.values(store.data.projects).find(v=>v.uiProjectId===p.id);
    const project=previous?engine.updateProject(previous.id,{...inputProject,revision:previous.revision}):engine.createProject(inputProject);
    const beforeFiles=await workspaceFiles(dir);
    const run=engine.start(project.id);run.beforeFiles=beforeFiles;store.save();return run;
  }
  async function launch(input) {
    if(launching.has(input.projectId))throw new Error('Запуск цього проєкту вже готується');
    launching.add(input.projectId);
    try{return await launchReady(input);}finally{launching.delete(input.projectId);}
  }
  const handler=async(req,res)=>{
    const send=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
    try {
      const host=req.headers.host;
      if(!host||!/^127\.0\.0\.1:\d+$/.test(host)||(req.headers.origin&&req.headers.origin!==`http://${host}`))return send(403,{error:'Лише локальний same-origin доступ'});
      const url=new URL(req.url,'http://localhost');
      if(req.method==='GET'&&url.pathname==='/api/execution/status')return send(200,{token,runtimes:runtimes(),reasoningEffort:config.reasoningEffort,capabilities:{recovery:{automatic:true,defaultAttempts:2,maxAttempts:3}}});
      const supplied=Buffer.from(req.headers['x-execution-token']??''),expected=Buffer.from(token);
      if(supplied.length!==expected.length||!timingSafeEqual(supplied,expected))return send(403,{error:'Оновіть сторінку для доступу до виконання'});
      if(['POST','PUT'].includes(req.method)&&!req.headers['content-type']?.startsWith('application/json'))return send(415,{error:'Потрібен JSON'});
      if(req.method==='GET'&&url.pathname==='/api/connections')return send(200,registry.snapshot());
      if(req.method==='POST'&&url.pathname==='/api/connections/scan')return send(200,await registry.scan());
      if(url.pathname==='/api/routing') {
        if(req.method==='GET'){const p=uiProject(url.searchParams.get('projectId'));const proposal=store.data.routing?.[p.id]??null;
          return send(200,{proposal,stale:proposal?proposal.revision!==p.revision||proposal.planFingerprint!==planFingerprint(routingPlan(p)):false});}
        if(req.method==='POST') {
          const input=await readBody(req),p=structuredClone(uiProject(input.projectId));
          if(input.revision!==p.revision)throw new Error('План змінився: оновіть проєкт');
          if(routingControls.has(p.id))throw new Error('Підбір моделей цього проєкту вже триває');
          if(input.requirements!==undefined&&(!input.requirements||typeof input.requirements!=='object'||Array.isArray(input.requirements)||
            Object.keys(input.requirements).some(id=>!p.tasks.some(t=>t.id===id))))throw new Error('Некоректні вимоги задач');
          const plan=routingPlan(p),fingerprint=planFingerprint(plan);
          // Project execution writes files by default; text-only routes require explicit task requirements.
          const requirements=Object.fromEntries(p.tasks.map(t=>[t.id,{workspaceWrite:true,...input.requirements?.[t.id]}]));
          const controller=new AbortController();routingControls.set(p.id,controller);
          res.on('close',()=>{if(!res.writableEnded)controller.abort();});
          try {
            const proposal=await director.propose({plan,requirements,managerRouteId:input.managerRouteId,priority:input.priority,maxAgentsPerTask:input.maxAgentsPerTask},
              AbortSignal.any([controller.signal,AbortSignal.timeout(120000)]));
            const current=uiProject(p.id);
            if(current.revision!==p.revision||planFingerprint(routingPlan(current))!==fingerprint)throw new Error('План змінився під час підбору: рішення не збережено');
            store.data.routing??={};store.data.routing[p.id]={...proposal,projectId:p.id,revision:p.revision};store.save();
            return send(200,store.data.routing[p.id]);
          }finally{routingControls.delete(p.id);}
        }
      }
      if(url.pathname==='/api/workspace') {
        if(req.method==='GET')return send(200,store.data.ui??{revision:0,workspace:null});
        if(req.method==='PUT')return send(200,saveWorkspace(await readBody(req)));
      }
      if(url.pathname==='/api/execution/preview'&&req.method==='POST') {
        await registry.scan();
        const {projectId}=await readBody(req);uiProject(projectId);
        const p=uiProject(projectId),proposal=store.data.routing?.[projectId];
        return send(200,{workspace:await workspace(projectId),runtimes:runtimes(),reasoningEffort:config.reasoningEffort,
          proposal:proposal&&proposal.revision===p.revision&&proposal.planFingerprint===planFingerprint(routingPlan(p))?proposal:null});
      }
      if(url.pathname==='/api/execution/runs') {
        if(req.method==='GET')return send(200,Object.values(store.data.runs).map(summary));
        if(req.method==='POST')return send(202,await launch(await readBody(req)));
      }
      const parts=url.pathname.split('/').filter(Boolean);
      if(parts[0]==='api'&&parts[1]==='execution'&&parts[2]==='runs'&&parts[3]) {
        const run=engine.run(parts[3]),action=parts[4];
        if(req.method==='GET'&&action==='events') {
          let close;close=streamRun(engine,run,req,res,{present,onClose:()=>streams.delete(close)});if(!res.writableEnded)streams.add(close);return;
        }
        if(req.method==='POST'&&['pause','resume','cancel'].includes(action))return send(200,await present(engine[action](run.id)));
        if(req.method==='POST'&&action==='recover'){
          if(!isCurrentRun(run))throw Error('План змінився: відновлювати старий запуск не можна');
          if(launching.has(run.project.uiProjectId)||Object.values(store.data.runs).some(other=>other.id!==run.id&&other.project.uiProjectId===run.project.uiProjectId&&(['running','paused'].includes(other.status)||engine.controls.get(other.id)?.active.size||engine.controls.get(other.id)?.recovering)))throw Error('Інший запуск цього проєкту вже активний');
          return send(202,engine.requestRecovery(run.id));
        }
        if(req.method==='POST'&&action==='cancel-task')return send(200,engine.cancelTask(run.id,(await readBody(req)).taskId));
        if(req.method==='GET'&&action==='file') {
          const path=url.searchParams.get('path');
          if(!path||path.split(/[\\/]/).some(excluded))throw new Error('Недоступний файл');
          const base=await realpath(run.project.workspace),actual=await realpath(resolve(base,path));
          if(!inside(base,actual))throw new Error('Файл виходить за межі проєкту');
          const info=await stat(actual);if(!info.isFile()||info.size>1024*1024)throw new Error('Файл не є текстовим артефактом до 1 MB');
          const bytes=await readFile(actual);if(bytes.includes(0))throw new Error('Бінарний файл: відкрийте у робочій папці');
          return send(200,{path,text:bytes.toString('utf8')});
        }
        if(req.method==='GET'&&!action)return send(200,await present(run));
      }
      send(404,{error:'Route not found'});
    }catch(error){send(400,{error:error.message});}
  };
  return {handler,engine,store,registry,director,close(){for(const stream of streams)stream();for(const controller of routingControls.values())controller.abort();for(const run of Object.values(store.data.runs))if(['running','paused'].includes(run.status))engine.cancel(run.id);}};
}
