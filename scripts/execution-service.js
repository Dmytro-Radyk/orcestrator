import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { mkdir, realpath, readdir, readFile, stat, lstat } from 'node:fs/promises';
import { resolve, relative, isAbsolute, join, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Engine,budgetBlocked,retryableAccessTasks } from '../src/engine.js';
import { selectAgents,validateProject,safeKey } from '../src/domain.js';
import { Store } from '../src/store.js';
import { validateTasks } from '../apps/web/src/state.js';
import { validatePlan } from '../apps/web/src/planning.js';
import { createModelRegistry,withModelPolicy } from './model-registry.js';
import { createDirector,planFingerprint,routingCandidates,validateRouteAssignments,suits } from './director-service.js';
import { isGeminiWorker,geminiByHeadroom,suitsManagedWorker } from './worker-routing.js';
import { WorkspaceManager } from '../src/workspaces.js';
import { streamRun } from '../src/run-stream.js';
import { executionAgent } from './execution-agent.js';
import { createRecoveryHandler } from './recovery-service.js';
import { readJsonBody } from '../src/http-body.js';
import { reportNeedsCorrection,workspaceNeedsResolution,verificationBlockers,waitsForVerification } from '../src/execution-report.js';
import { plannedCalls } from '../apps/web/src/call-budget.js';
import { createHostVerifier } from './host-verifier.js';
import { storefrontAcceptanceId } from '../src/storefront-quality.js';
import { createProjectPreview, localPreviewUrl } from './project-preview.js';

const inside = (root, path) => { const rel=relative(root,path); return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); };
const excluded = name => /^(?:\.git|\.env(?:\..*)?|node_modules|\.codex|\.gemini|\.agents|\.aws)$/i.test(name) || /\.(?:pem|key|p12|pfx|db|sqlite(?:3|-wal|-shm)?)$/i.test(name);
const root = fileURLToPath(new URL('../.orchestrator/', import.meta.url));

export function executorConfig(env=process.env) {
  const model=env.ORCHESTRATOR_EXECUTOR_MODEL ?? 'gpt-6.1-sol';
  const optionalTimeout=key=>{
    if(env[key]===undefined||env[key]==='')return null;
    const value=Number(env[key]);
    if(!Number.isInteger(value)||value<10||value>3600000)throw Error(`${key}: очікується від 10 до 3600000 мс`);
    return value;
  };
  return { model, command:env.ORCHESTRATOR_EXECUTOR_COMMAND ?? env.ORCHESTRATOR_PLANNER_COMMAND ?? 'codex',
    reasoningEffort:env.ORCHESTRATOR_EXECUTOR_REASONING ?? 'auto',
    timeoutMs:optionalTimeout('ORCHESTRATOR_EXECUTOR_TIMEOUT_MS'),recoveryTimeoutMs:optionalTimeout('ORCHESTRATOR_RECOVERY_TIMEOUT_MS') };
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
export function createExecutionService({directory=join(root,'ui'),workspaces=join(root,'workspaces'),config=executorConfig(),provider,registry:injectedRegistry,
  hostVerifier=createHostVerifier(join(directory,'host-verification.json'))}={}) {
  const store=new Store(directory);
  const projectPreview=createProjectPreview(directory);
  const registry=injectedRegistry??createModelRegistry({store,env:{...process.env,ORCHESTRATOR_EXECUTOR_COMMAND:config.command}});
  const director=createDirector({registry,provider});
  const projectLocation=id=>store.data.projectLocations&&Object.hasOwn(store.data.projectLocations,id)?store.data.projectLocations[id]:null;
  const engine=new Engine(store,withModelPolicy(registry,provider),{workspaces:new WorkspaceManager(join(workspaces,'.runs'),
    {allowedRoot:workspaces,projectLocation}),maxIntegrationRetries:1});
  const token=randomBytes(32).toString('hex');
  const launching=new Set();
  const hostChecks=new Map();
  const hostQueued=new Set();
  let closing=false;
  const isHostChecking=run=>hostQueued.has(run.id)||hostChecks.has(run.id);
  const routingControls=new Map();
  const draftProposals=new Map(),draftRoutingKey=Symbol('draft-routing');
  const streams=new Set();
  const routingPlan=p=>({summary:p.description||p.name,assumptions:[],risks:[],tasks:p.tasks.filter(t=>!t.parentId).map(t=>({
    id:t.id,title:t.title,prompt:t.prompt,skills:t.skills??[],dependsOn:t.dependsOn,acceptanceCriteria:t.acceptanceCriteria??[]}))});
  const currentPlanError=run=>{
    const p=store.data.ui?.workspace.projects.find(p=>p.id===run.project.uiProjectId);
    if(!p)return 'План змінився під час відновлення: проєкт видалено з робочого простору';
    if(p.revision!==run.project.uiRevision)return `План змінився під час відновлення: ревізія ${run.project.uiRevision} → ${p.revision}`;
    if((p.executionBrief??'')!==(run.project.executionBrief??''))return 'План змінився під час відновлення: змінено уточнення вимог';
    if(planFingerprint(routingPlan(p))===run.project.uiPlanFingerprint)return null;
    if((p.description||p.name)!==run.project.goal)return 'План змінився під час відновлення: змінено опис проєкту';
    const tasks=p.tasks.filter(t=>!t.parentId);
    if(tasks.length!==run.project.tasks.length||tasks.some((t,i)=>t.id!==run.project.tasks[i]?.id))return 'План змінився під час відновлення: змінено список або порядок задач';
    const labels={title:'назва',prompt:'інструкція',skills:'навички',dependsOn:'залежності',acceptanceCriteria:'критерії готовності'};
    for(const task of tasks){const original=run.project.tasks.find(t=>t.id===task.id);
      for(const [key,label] of Object.entries(labels))if(JSON.stringify(task[key]??[])!==JSON.stringify(original[key]??[]))return `План змінився під час відновлення: задача «${task.title}», ${label}`;
    }
    return 'План змінився під час відновлення: вміст плану не відповідає знімку запуску';
  };
  const isCurrentRun=run=>currentPlanError(run)===null;
  engine.recover=createRecoveryHandler({engine,registry,director,config,isCurrent:isCurrentRun,currentPlanError});
  async function refreshEmptyDraft(run,task,lease){
    if(await engine.workspaces.git(lease.cwd,['status','--porcelain'])||
      lease.baseCommit===await engine.workspaces.git(lease.target,['rev-parse','HEAD']))return lease;
    const fresh=await engine.workspaces.prepare(run,task);
    return {...fresh,resolvedFrom:lease.cwd};
  }
  async function verifyOnHost(run,task,plan,{automatic=false,preflightKey}={}) {
    const projectId=run.project.uiProjectId;
    if(launching.has(projectId)||!isCurrentRun(run)||engine.hostVerificationTask(run,task.id)!==task||
      Object.values(store.data.runs).some(other=>other.id!==run.id&&other.project.uiProjectId===projectId&&
        (['running','paused'].includes(other.status)||engine.controls.get(other.id)?.active.size||engine.controls.get(other.id)?.recovering)))
      throw Error('Проєкт змінився або вже виконується');
    const controller=new AbortController(),signal=controller.signal;
    launching.add(projectId);hostChecks.set(run.id,controller);
    try {
      engine.event(run,'task.host_verification_started',{taskId:task.id,attempt:task.attempts,automatic,preflightKey,
        message:'Запущено обов’язкові локальні перевірки'});
      const lease=await engine.workspaces.resume(run,task.workspace);
      lease.files=task.blockedReport.files;
      const tree=await engine.workspaces.candidateTree(lease,signal);
      const progress=task.hostVerificationProgress;
      const previous=progress?.tree===tree&&progress.attempt===task.attempts
        ?new Map(progress.checks.filter(check=>check.status==='passed').map(check=>[check.command,check])):new Map();
      const report={...task.blockedReport,checks:[...task.blockedReport.checks,...plan.preflights].map(check=>
        check.required!==false&&check.status!=='passed'&&!plan.checks.get(check.command)?.preflight
          ?(previous.get(check.command)??check):check)};
      const checks=await engine.workspaces.verifyTree(lease,tree,
        cwd=>hostVerifier.verify(plan,report,cwd,signal,{continueOnFailure:true}),signal);
      if(!isCurrentRun(run))throw Error('План змінився під час локальної перевірки');
      const test=plan.testCompletion;
      if(test){
        const deferred=checks.find(check=>check.command===test.deferCheck&&check.required!==false&&check.status==='not_run');
        if(deferred&&Array.isArray(test.require)&&test.require.length&&
          test.require.every(command=>plan.checks.get(command)?.preflight&&checks.some(check=>
            check.command===command&&check.source==='host'&&check.status==='passed'))&&
          checks.every(check=>check===deferred||check.required===false||check.status==='passed')){
          const finalChecks=checks.map(check=>check===deferred?{...check,required:false,
            details:`Відкладено до реального запуску: ${check.details}`}:check);
          return await engine.acceptHostVerification(run,task,lease,tree,finalChecks,signal,{testCompletion:test});
        }
      }
      if(checks.some(check=>check.required!==false&&check.status!=='passed')){
        const local=checks.filter(check=>check.source==='host');
        task.hostVerificationProgress={tree,attempt:task.attempts,checks:local};
        const failed=local.find(check=>check.status==='failed');
        if(failed)throw Error(failed.details);
        engine.event(run,'task.host_verification_partial',{taskId:task.id,tree,
          message:'Доступні локальні перевірки пройшли. Залишилися обов’язкові перевірки.'});
        return run;
      }
      if(test)throw Error('Політика тестового завершення не підтверджена. Реальні етапи залишилися відкладеними.');
      return await engine.acceptHostVerification(run,task,lease,tree,checks,signal);
    } catch(error) {
      engine.event(run,'task.host_verification_failed',{taskId:task.id,message:error.message});
      throw error;
    } finally {
      hostChecks.delete(run.id);launching.delete(projectId);
      queueHostVerification(run,task.id);
      engine.event(run,'task.host_verification_finished',{taskId:task.id,message:'Локальний верифікатор завершив роботу'});
    }
  }
  function queueHostVerification(run,finishedTaskId){
    if(closing||run.status!=='blocked'||isHostChecking(run)||!isCurrentRun(run))return;
    for(const item of run.tasks){
      if(finishedTaskId&&item.id===finishedTaskId)continue;
      const task=engine.hostVerificationTask(run,item.id);
      if(!task)continue;
      let plan;
      try { plan=hostVerifier.plan(run,task,{partial:true}); } catch { return; }
      if(!plan?.automatic)continue;
      const preflightKey=plan.preflights.length||plan.testCompletion?createHash('sha256').update(JSON.stringify(
        [plan.preflights.map(({command})=>[command,plan.checks.get(command)]),plan.testCompletion])).digest('hex'):undefined;
      const started=run.events.findLastIndex(event=>event.taskId===task.id&&event.attempt===task.attempts&&
        event.automatic===true&&event.preflightKey===preflightKey&&event.type==='task.host_verification_started');
      if(started>=0&&run.events.slice(started+1).some(event=>event.taskId===task.id&&event.type==='task.host_verification_finished'))continue;
      hostQueued.add(run.id);
      queueMicrotask(()=>{
        hostQueued.delete(run.id);
        if(!closing)void verifyOnHost(run,task,plan,{automatic:true,preflightKey}).catch(()=>{}); // The verification records its own failure.
      });
      return;
    }
  }
  engine.subscribe((run,event)=>{
    if(event.type==='run.blocked')queueHostVerification(run);
  });
  const latestRuns=new Map();
  for(const run of Object.values(store.data.runs)){
    const projectId=run.project.uiProjectId;
    if(!latestRuns.has(projectId)||run.createdAt>latestRuns.get(projectId).createdAt)latestRuns.set(projectId,run);
  }
  for(const run of latestRuns.values()){
    if(run.events.some(event=>event.type==='run.drained'))queueHostVerification(run);
  }
  const runtimes=()=>registry.snapshot().routes.filter(r=>['codex','opencode','antigravity'].includes(r.backend)).flatMap(r=>[
    ...(r.capabilities?.workspaceWrite?[{id:`${r.id}#write`,name:`${r.backend} · розробка`,provider:r.backend,model:r.model,routeId:r.id,billing:r.billing,billingBoundary:r.billingBoundary,access:'workspace-write',allowed:r.decision.allowed,reason:r.decision.reason}]:[]),
    {id:`${r.id}#read`,name:`${r.backend} · перевірка`,provider:r.backend,model:r.model,routeId:r.id,billing:r.billing,billingBoundary:r.billingBoundary,access:'read-only',allowed:r.decision.allowed,reason:r.decision.reason}]);
  function uiProject(key) {
    const p=store.data.ui?.workspace.projects.find(p=>p.id===key);
    if(!p) throw new Error('Проєкт не збережений на сервері'); return p;
  }
  function unstartedTasks(run) {
    const control=engine.controls.get(run.id);
    if(!['failed','blocked'].includes(run.status)||run.project.workspaceMode!=='isolated'||!isCurrentRun(run)||
      control?.recovering||control?.active.size||isHostChecking(run))return [];
    return run.tasks.filter(task=>['pending','blocked'].includes(task.status)&&!task.attempts&&!task.workspace&&
      !task.resumeWorkspace&&!task.failure&&!task.error&&task.agentIds.length===1&&!task.parentId&&!task.reviewerId);
  }
  function geminiAssignments(run,routes) {
    const tasks=unstartedTasks(run);
    const agents=new Map(run.project.agents.map(agent=>[agent.id,agent]));
    const eligible=tasks.filter(task=>agents.get(task.agentIds[0])?.provider==='codex'&&
      suitsManagedWorker(task,run.project.routingRequirements?.[task.id]));
    const existing=tasks.filter(task=>{
      const agent=agents.get(task.agentIds[0]);
      return agent&&isGeminiWorker({backend:agent.provider,model:agent.model});
    }).length;
    const limit=Math.max(0,Math.ceil(tasks.length/2)-existing);
    const gemini=geminiByHeadroom(routes);
    const assignments=[];
    for(const task of eligible.sort((a,b)=>a.dependsOn.length-b.dependsOn.length)){
      if(assignments.length>=limit)break;
      const original=agents.get(task.agentIds[0]);
      const need={workspaceWrite:original.access!=='read-only',...run.project.routingRequirements?.[task.id]};
      const route=gemini.find(route=>suits(route,need));
      if(route)assignments.push({task,original,route});
    }
    return assignments;
  }
  async function workspace(key) {
    const chosen=projectLocation(key);
    if(chosen){
      if(await realpath(chosen)!==chosen)throw Error('Робочу папку проєкту переміщено або замінено');
      return chosen;
    }
    await mkdir(workspaces,{recursive:true});
    const base=await realpath(workspaces);
    const path=join(base,createHash('sha256').update(key).digest('hex').slice(0,24));
    await mkdir(path,{recursive:true});
    const actual=await realpath(path);
    if(!inside(base,actual)) throw new Error('Робоча папка виходить за межі каталогу проєктів');
    return actual;
  }
  async function localDirectory(path) {
    if(typeof path!=='string'||path.length>1024||/[\x00-\x1f]/.test(path)||
      !isAbsolute(path)||process.platform==='win32'&&(!/^[A-Za-z]:[\\/]/.test(path)||path.slice(2).includes(':')))
      throw Error('Вкажіть абсолютний шлях до локальної папки');
    const actual=await realpath(path);
    if(!(await stat(actual)).isDirectory())throw Error('Шлях має вказувати на папку');
    return actual;
  }
  async function listFolders(path) {
    if(!path){
      const roots=process.platform==='win32'?Array.from('ABCDEFGHIJKLMNOPQRSTUVWXYZ',letter=>letter+':\\'):['/'];
      const found=await Promise.all(roots.map(root=>localDirectory(root).then(path=>({name:root,path})).catch(()=>null)));
      return {path:null,parent:null,folders:found.filter(Boolean)};
    }
    const actual=await localDirectory(path), entries=await readdir(actual,{withFileTypes:true});
    return {path:actual,parent:dirname(actual)===actual?null:dirname(actual),folders:entries
      .filter(entry=>entry.isDirectory()&&!entry.isSymbolicLink()&&!excluded(entry.name)&&!entry.name.startsWith('.'))
      .sort((a,b)=>a.name.localeCompare(b.name,'uk')).map(entry=>({name:entry.name,path:join(actual,entry.name)}))};
  }
  async function present(run) {
    engine.restoreBlockedReports(run);
    for(const task of run.tasks){
      task.needsCorrection=reportNeedsCorrection(task);
      const blockers=verificationBlockers(task);
      if(blockers.length)task.verificationBlockers=blockers;
      else delete task.verificationBlockers;
      const eligible=engine.hostVerificationTask(run,task.id);
      if(eligible){
        try {
          const plan=hostVerifier.plan(run,task,{partial:true});
          task.hostVerificationAutomatic=plan?.automatic===true;
          const progress=task.hostVerificationProgress;
          const prior=progress?.attempt===task.attempts?progress?.checks??[]:[];
          const passed=new Set(prior.filter(check=>check.status==='passed').map(check=>check.command));
          const attempted=new Set(prior.map(check=>check.command));
          task.canVerifyOnHost=Boolean(plan&&[...plan.checks].some(([command,entry])=>
            !passed.has(command)&&!(plan.automatic&&entry.preflight&&attempted.has(command))));
          if(blockers.length||plan)task.pendingVerificationChecks=[...task.blockedReport.checks,...(plan?.preflights??[])].filter(check=>
            check.required!==false&&check.status!=='passed'&&!passed.has(check.command));
          else delete task.pendingVerificationChecks;
        } catch { task.canVerifyOnHost=false; delete task.hostVerificationAutomatic; delete task.pendingVerificationChecks; }
      } else {
        delete task.canVerifyOnHost;delete task.hostVerificationAutomatic;delete task.pendingVerificationChecks;
      }
    }
    run.draining=!['running','paused'].includes(run.status)&&Boolean(engine.controls.get(run.id)?.active.size||engine.controls.get(run.id)?.recovering);
    run.canContinue=engine.canContinue(run)&&isCurrentRun(run);
    run.canRetryAccess=engine.canRetryAccess(run)&&isCurrentRun(run);
    run.canRetryBudget=engine.canRetryBudget(run)&&isCurrentRun(run);
    run.canIncreaseBudget=engine.canIncreaseBudget(run)&&isCurrentRun(run);
    run.canResumeCancelled=engine.canResumeCancelled(run)&&isCurrentRun(run);
    run.canClarify=engine.canClarify(run)&&isCurrentRun(run);
    run.hostChecking=isHostChecking(run);
    run.canBalanceGemini=registry.snapshot().routes.some(isGeminiWorker)&&unstartedTasks(run).some(task=>
      run.project.agents.some(agent=>agent.id===task.agentIds[0]&&agent.provider==='codex')&&
      suitsManagedWorker(task,run.project.routingRequirements?.[task.id]));
    if(!['running','paused'].includes(run.status) && !run.files && !run.draining) {
      const before=new Map((run.beforeFiles??[]).map(f=>[f.path,f]));
      const current=await workspaceFiles(run.project.workspace),presentSet=new Set(current.map(f=>f.path));
      if(!['running','paused'].includes(run.status)&&!engine.controls.get(run.id)?.active.size&&!engine.controls.get(run.id)?.recovering){
        run.files=[...current.map(f=>({...f,change:!before.has(f.path)?'created':before.get(f.path).hash!==f.hash?'modified':'unchanged'})),
          ...[...before.values()].filter(f=>!presentSet.has(f.path)).map(f=>({...f,change:'deleted'}))];
        store.save();
      }
    }
    return run;
  }
  const hasActiveRun=(projectId,ignoreRunId)=>Object.values(store.data.runs).some(other=>other.id!==ignoreRunId&&other.project.uiProjectId===projectId&&
    (['running','paused'].includes(other.status)||engine.controls.get(other.id)?.active.size||engine.controls.get(other.id)?.recovering));
  const summary=run=>({id:run.id,projectId:run.projectId,uiProjectId:run.project.uiProjectId,uiRevision:run.project.uiRevision,
    name:run.project.name,status:run.status,calls:run.calls,createdAt:run.createdAt,finishedAt:run.finishedAt});
  const readBody=req=>readJsonBody(req,{maxBytes:5*1024*1024,limitMessage:'Завеликий запит'});
  const storedRouting=projectId=>store.data.routing&&Object.hasOwn(store.data.routing,projectId)?store.data.routing[projectId]:null;
  async function saveWorkspace(input) {
    if(input.revision!==(store.data.ui?.revision??0)) throw new Error('Конфлікт збереження: оновіть сторінку, щоб отримати актуальні дані');
    const value=input.workspace;
    if(value?.version!==1 || !Array.isArray(value.projects) || !value.projects.length || !Array.isArray(value.agents) || !value.agents.length || value.projects.length>100 || value.agents.length>100) throw new Error('Некоректний робочий простір');
    const ids=new Set();
    for(const p of value.projects) {
      if(!safeKey(p.id)||ids.has(p.id)||typeof p.name!=='string'||!p.name.trim()||!Array.isArray(p.tasks)||p.tasks.length>100)throw new Error('Некоректний проєкт');
      if(p.executionBrief!==undefined&&(typeof p.executionBrief!=='string'||p.executionBrief.length>12000))throw Error('Некоректне уточнення вимог');
      ids.add(p.id);validateTasks(p.tasks);
    }
    let adopted;
    if(input.routingDraftId!==undefined){
      const draft=draftProposals.get(input.routingDraftId),p=value.projects.find(p=>p.id===input.routingProjectId);
      if(!draft||draft.expiresAt<=Date.now())throw Error('Підбір команди застарів: повторіть його в майстрі');
      if(!p||store.data.ui?.workspace.projects.some(old=>old.id===p.id)||p.revision!==1||draft.proposal.planFingerprint!==planFingerprint(routingPlan(p)))throw Error('План змінився після підбору команди');
      await registry.scan();
      validateRouteAssignments(draft.proposal,routingPlan(p),routingCandidates(routingPlan(p),registry.snapshot().routes,draft.proposal.requirements),{maxAgentsPerTask:draft.proposal.maxAgentsPerTask});
      if(input.revision!==(store.data.ui?.revision??0))throw Error('Конфлікт збереження: оновіть сторінку, щоб отримати актуальні дані');
      if(draftProposals.get(input.routingDraftId)!==draft||draft.expiresAt<=Date.now())throw Error('Підбір команди застарів: повторіть його в майстрі');
      adopted={...draft.proposal,projectId:p.id,revision:p.revision};
    }
    for(const key of hostChecks.keys()){
      const run=engine.run(key),previous=uiProject(run.project.uiProjectId),next=value.projects.find(p=>p.id===previous.id);
      if(!next||next.revision!==previous.revision||(next.executionBrief??'')!==(previous.executionBrief??'')||
        planFingerprint(routingPlan(next))!==planFingerprint(routingPlan(previous)))throw Error('Дочекайтеся завершення локальної перевірки перед зміною плану');
    }
    if(input.projectLocation!==undefined){
      const {projectId,parent}=input.projectLocation??{};
      const pending=value.projects.find(project=>project.id===projectId);
      if(!pending||projectLocation(projectId)||store.data.ui?.workspace.projects.some(old=>old.id===projectId))
        throw Error('Папку можна вибрати лише для нового проєкту');
      const base=await localDirectory(parent);
      if(input.revision!==(store.data.ui?.revision??0))throw Error('Конфлікт збереження: оновіть сторінку');
      const name=pending.name.replace(/[<>:"/\\|?*\x00-\x1f]/g,'-').replace(/[. ]+$/g,'').trim().slice(0,64)||'Проєкт';
      const hash=createHash('sha256').update(projectId).digest('hex').slice(0,8);
      const destination=join(base,`${name} - ${hash}`);
      await mkdir(destination);
      const actual=await realpath(destination);
      if(!inside(base,actual)||input.revision!==(store.data.ui?.revision??0))throw Error('Папку або робочий простір змінено. Повторіть створення.');
      store.data.projectLocations??={};
      store.data.projectLocations[projectId]=actual;
    }
    if(adopted){store.data.routing??={};store.data.routing[adopted.projectId]=adopted;}
    store.data.ui={revision:input.revision+1,workspace:structuredClone(value)};store.save();
    if(adopted)draftProposals.delete(input.routingDraftId);
    return store.data.ui;
  }
  async function launchReady(input) {
    let p=uiProject(input.projectId);
    if(p.revision!==input.revision)throw new Error('План змінився: відкрийте налаштування запуску знову');
    if(hasActiveRun(p.id))throw new Error('Цей проєкт уже виконується або завершує скасування');
    const initialFingerprint=planFingerprint(routingPlan(p));
    await registry.scan();
    p=uiProject(input.projectId);
    if(p.revision!==input.revision||planFingerprint(routingPlan(p))!==initialFingerprint)throw new Error('План змінився: відкрийте налаштування запуску знову');
    if(hasActiveRun(p.id))throw new Error('Цей проєкт уже виконується або завершує скасування');
    const proposal=input.proposalId?storedRouting(p.id):null;
    if(input.proposalId&&(!proposal||proposal.id!==input.proposalId||proposal.revision!==p.revision||proposal.planFingerprint!==planFingerprint(routingPlan(p))))throw new Error('Пропозиція AI застаріла або не знайдена');
    if(proposal)validateRouteAssignments(proposal,routingPlan(p),routingCandidates(routingPlan(p),registry.snapshot().routes,proposal.requirements),{maxAgentsPerTask:proposal.maxAgentsPerTask});
    const agents=[],tasks=[],seen=new Map();
    function bind(a,runtime) {
      if(!runtime)throw new Error(`Оберіть реального виконавця для ${a.name}`);
      if(!runtime.allowed)throw new Error(runtime.reason);
      const id=proposal?`route-${createHash('sha256').update(runtime.id).digest('hex').slice(0,16)}`:a.id;
      if(seen.has(id))return id;seen.set(id,true);
      agents.push(executionAgent(registry.snapshot().routes.find(r=>r.id===runtime.routeId),{id,name:proposal?runtime.model:a.name,role:a.role,skills:a.skills??[],access:runtime.access,config,...(runtime.provider==='codex'&&a.reasoningEffort!==undefined?{reasoningEffort:a.reasoningEffort}:{})}));return id;
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
      if(t.id===storefrontAcceptanceId&&(ids.length!==1||!agents.some(agent=>agent.id===ids[0]&&agent.access==='workspace-write'&&!agent.fileWorker)))
        throw Error('Для браузерного приймання потрібен один виконавець із браузерними інструментами й доступом до запису');
      tasks.push({id:t.id,title:t.title,prompt:t.prompt,skills:t.skills??[],agentIds:ids,dependsOn:t.dependsOn,
        acceptanceCriteria:t.acceptanceCriteria??[],mode:t.mode??'pipeline',
        allowDelegation:t.id!==storefrontAcceptanceId&&p.allowDelegation!==false&&t.allowDelegation!==false});
    }
    const dir=await workspace(p.id);
    const maxCalls=input.maxCalls??p.maxCalls;
    if(input.maxCalls!==undefined&&(!Number.isSafeInteger(maxCalls)||maxCalls<plannedCalls(tasks)||maxCalls>10000))
      throw Error(`Для призначеної команди потрібно щонайменше ${plannedCalls(tasks)} викликів (максимум 10 000)`);
    const recoveryManager=p.recovery?.managerRouteId??proposal?.managerRouteId;
    const inputProject={name:p.name,goal:p.description,executionBrief:p.executionBrief??'',uiProjectId:p.id,uiRevision:p.revision,planning:p.planning,
      uiPlanFingerprint:planFingerprint(routingPlan(p)),routingRequirements:structuredClone(proposal?.requirements??{}),
      recovery:{enabled:p.recovery?.enabled??true,maxAttempts:p.recovery?.maxAttempts??2,...(recoveryManager?{managerRouteId:recoveryManager}:{})},
      workspace:dir,workspaceMode:'isolated',agents,tasks,...(proposal?{routingProposalId:proposal.id}:{}),
      limits:{concurrency:p.concurrency,maxCalls,timeoutMs:config.timeoutMs??null,maxOutputTokens:12000,maxDepth:p.allowDelegation===false?0:p.maxDepth??2,maxTasks:p.maxTasks??100}};
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
    const send=(status,data)=>{
      if(res.headersSent||res.destroyed||res.writableEnded)return;
      const payload=JSON.stringify(data);
      res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Cross-Origin-Resource-Policy':'same-origin'});
      res.end(payload);
    };
    try {
      const host=req.headers.host;
      const fetchSite=req.headers['sec-fetch-site'];
      if(!host||!/^127\.0\.0\.1:\d+$/.test(host)||(req.headers.origin&&req.headers.origin!==`http://${host}`)||(fetchSite&&!['same-origin','none'].includes(fetchSite)))return send(403,{error:'Лише локальний same-origin доступ'});
      const url=new URL(req.url,'http://localhost');
      if(req.method==='GET'&&url.pathname==='/api/execution/status')return send(200,{token,runtimes:runtimes(),reasoningEffort:config.reasoningEffort,timeouts:{task:config.timeoutMs??null,recovery:config.recoveryTimeoutMs??null},capabilities:{recovery:{automatic:true,defaultAttempts:2,maxAttempts:3}}});
      const supplied=Buffer.from(req.headers['x-execution-token']??''),expected=Buffer.from(token);
      if(supplied.length!==expected.length||!timingSafeEqual(supplied,expected))return send(403,{error:'Оновіть сторінку для доступу до виконання'});
      if(['POST','PUT'].includes(req.method)&&!req.headers['content-type']?.startsWith('application/json'))return send(415,{error:'Потрібен JSON'});
      if(req.method==='GET'&&url.pathname==='/api/connections')return send(200,registry.snapshot());
      if(req.method==='POST'&&url.pathname==='/api/connections/scan')return send(200,await registry.scan());
      if(req.method==='POST'&&url.pathname==='/api/routing/draft'){
        const input=await readBody(req);validatePlan(input.plan);
        if(typeof input.name!=='string'||!input.name.trim()||input.name.length>80||typeof input.description!=='string'||!input.description.trim()||input.description.length>12000)throw Error('Потрібні назва та опис проєкту');
        if(input.requirements!==undefined&&(!input.requirements||typeof input.requirements!=='object'||Array.isArray(input.requirements)||Object.keys(input.requirements).some(id=>!input.plan.tasks.some(t=>t.id===id))))throw Error('Некоректні вимоги задач');
        if(routingControls.has(draftRoutingKey))throw Error('Підбір команди в майстрі вже триває');
        const plan=routingPlan({name:input.name,description:input.description,tasks:input.plan.tasks});
        const requirements=Object.fromEntries(plan.tasks.map(t=>[t.id,{workspaceWrite:true,...input.requirements?.[t.id],
          ...(t.id===storefrontAcceptanceId?{workspaceWrite:true,tools:true}:{})}]));
        const controller=new AbortController();routingControls.set(draftRoutingKey,controller);
        res.on('close',()=>{if(!res.writableEnded)controller.abort();});
        try{
          const proposal=await director.propose({plan,requirements,managerRouteId:input.managerRouteId,priority:input.priority,maxAgentsPerTask:input.maxAgentsPerTask,repairInvalid:true,allowManagerFallback:input.allowManagerFallback===true},
            controller.signal);
          controller.signal.throwIfAborted();
          for(const [id,draft] of draftProposals)if(draft.expiresAt<=Date.now())draftProposals.delete(id);
          while(draftProposals.size>=20)draftProposals.delete(draftProposals.keys().next().value);
          const expiresAt=Date.now()+30*60*1000;draftProposals.set(proposal.id,{proposal,expiresAt});
          return send(200,{...proposal,expiresAt:new Date(expiresAt).toISOString()});
        }finally{routingControls.delete(draftRoutingKey);}
      }
      if(url.pathname==='/api/routing') {
        if(req.method==='GET'){const p=uiProject(url.searchParams.get('projectId'));const proposal=storedRouting(p.id);
          return send(200,{proposal,stale:proposal?proposal.revision!==p.revision||proposal.planFingerprint!==planFingerprint(routingPlan(p)):false});}
        if(req.method==='POST') {
          const input=await readBody(req),p=structuredClone(uiProject(input.projectId));
          if(input.revision!==p.revision)throw new Error('План змінився: оновіть проєкт');
          if(routingControls.has(p.id))throw new Error('Підбір моделей цього проєкту вже триває');
          const plan=routingPlan(p),fingerprint=planFingerprint(plan);
          if(input.requirements!==undefined&&(!input.requirements||typeof input.requirements!=='object'||Array.isArray(input.requirements)||
            Object.keys(input.requirements).some(id=>!plan.tasks.some(t=>t.id===id))))throw new Error('Некоректні вимоги задач');
          // Project execution writes files by default; text-only routes require explicit task requirements.
          const requirements=Object.fromEntries(plan.tasks.map(t=>[t.id,{workspaceWrite:true,...input.requirements?.[t.id],
            ...(t.id===storefrontAcceptanceId?{workspaceWrite:true,tools:true}:{})}]));
          const controller=new AbortController();routingControls.set(p.id,controller);
          res.on('close',()=>{if(!res.writableEnded)controller.abort();});
          try {
            const proposal=await director.propose({plan,requirements,managerRouteId:input.managerRouteId,priority:input.priority,maxAgentsPerTask:input.maxAgentsPerTask,repairInvalid:true},
              controller.signal);
            const current=uiProject(p.id);
            if(current.revision!==p.revision||planFingerprint(routingPlan(current))!==fingerprint)throw new Error('План змінився під час підбору: рішення не збережено');
            store.data.routing??={};store.data.routing[p.id]={...proposal,projectId:p.id,revision:p.revision};store.save();
            return send(200,store.data.routing[p.id]);
          }finally{routingControls.delete(p.id);}
        }
      }
      if(url.pathname==='/api/workspace') {
        if(req.method==='GET')return send(200,store.data.ui??{revision:0,workspace:null});
        if(req.method==='PUT')return send(200,await saveWorkspace(await readBody(req)));
      }
      if(url.pathname==='/api/project-folders'&&req.method==='GET')
        return send(200,await listFolders(url.searchParams.get('path')));
      if(url.pathname==='/api/project-preview'&&req.method==='POST'){
        const input=await readBody(req),project=uiProject(input.projectId);
        const appOrigin=`http://${req.headers.host}`;
        if(input.url)return send(200,{url:localPreviewUrl(input.url,appOrigin).href});
        const result=await projectPreview.open(project.id,await workspace(project.id),appOrigin);
        return send(200,{url:result.url});
      }
      if(url.pathname==='/api/execution/preview'&&req.method==='POST') {
        await registry.scan();
        const {projectId}=await readBody(req);uiProject(projectId);
        const p=uiProject(projectId),proposal=storedRouting(projectId);
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
          let close;close=streamRun(engine,run,req,res,{present,hostChecking:()=>isHostChecking(run),onClose:()=>streams.delete(close)});if(!res.writableEnded)streams.add(close);return;
        }
        if(req.method==='POST'&&['pause','resume','cancel'].includes(action))return send(200,await present(engine[action](run.id)));
        if(req.method==='POST'&&action==='budget'){
          const input=await readBody(req),projectId=run.project.uiProjectId;
          if(!isCurrentRun(run))throw Error('План змінився: ліміт старого запуску не можна редагувати');
          if(launching.has(projectId))throw Error('Дочекайтеся завершення поточної операції із запуском');
          return send(200,await present(engine.increaseBudget(run.id,input)));
        }
        if(req.method==='POST'&&action==='verify-host'){
          const input=await readBody(req),task=engine.hostVerificationTask(run,input.taskId);
          const plan=task&&hostVerifier.plan(run,task,{partial:true});
          if(!plan)throw Error('Для цієї чернетки потрібні дозволені локальні перевірки');
          return send(200,await present(await verifyOnHost(run,task,plan)));
        }
        if(req.method==='POST'&&action==='balance-gemini'){
          const projectId=run.project.uiProjectId;
          if(launching.has(projectId)||!unstartedTasks(run).length)throw Error('Запуск активний або немає нерозпочатих задач');
          launching.add(projectId);
          try {
            await registry.scan();
            const assignments=geminiAssignments(run,registry.snapshot().routes);
            if(!assignments.length)throw Error('Немає сумісних нерозпочатих задач або доступної квоти Gemini');
            const agents=new Map(run.project.agents.map(agent=>[agent.id,agent])),byTask=new Map();
            for(const {task,original,route} of assignments){
              const agent=executionAgent(route,{access:original.access,role:task.title,skills:task.skills,config});
              if(!agents.has(agent.id))agents.set(agent.id,agent);
              byTask.set(task.id,agent.id);
            }
            const nextTasks=run.tasks.map(task=>byTask.has(task.id)?{...task,agentIds:[byTask.get(task.id)]}:task);
            validateProject({...run.project,agents:[...agents.values()],tasks:nextTasks});
            run.project.agents=[...agents.values()];run.tasks=nextTasks;
            engine.event(run,'run.gemini_balanced',{assignments:assignments.map(({task,original,route})=>({
              taskId:task.id,from:original.model,to:route.id
            })),message:`Нерозпочаті задачі передано Gemini: ${assignments.map(({task})=>task.title).join(', ')}`});
            return send(200,await present(run));
          }finally{launching.delete(projectId);}
        }
        if(req.method==='POST'&&action==='clarify'){
          engine.restoreBlockedReports(run);
          const input=await readBody(req),projectId=run.project.uiProjectId;
          if(typeof input.answer!=='string'||!input.answer.trim()||input.answer.length>6000||!['task','project',undefined].includes(input.scope))throw Error('Потрібне уточнення до 6000 символів і допустима область застосування');
          if(!isCurrentRun(run))throw Error('План змінився: уточнювати старий запуск не можна');
          if(!engine.canClarify(run))throw Error('Запуск не очікує уточнення або бюджет вичерпано');
          if(launching.has(projectId)||Object.values(store.data.runs).some(other=>other.id!==run.id&&other.project.uiProjectId===projectId&&(['running','paused'].includes(other.status)||engine.controls.get(other.id)?.active.size||engine.controls.get(other.id)?.recovering)))throw Error('Інший запуск цього проєкту вже активний');
          const task=run.tasks.find(t=>t.id===input.taskId&&(t.failure?.code==='AGENT_BLOCKED'&&t.status==='blocked'||reportNeedsCorrection(t)||workspaceNeedsResolution(t)||waitsForVerification(t)));
          if(!task?.workspace)throw Error('Не знайдено чернетку задачі, яка очікує уточнення');
          launching.add(projectId);
          try{
            let lease=workspaceNeedsResolution(task)?await engine.workspaces.resolveDraft(run,task.workspace,task.id):await engine.workspaces.resume(run,task.workspace);
            let replacement;
            if(input.routeId!==undefined){
              const team=selectAgents(run.project,task);
              if(typeof input.routeId!=='string'||input.scope==='project'||team.length!==1||!team[0].fileWorker||task.failure?.code!=='AGENT_BLOCKED')
                throw Error('Заміна доступна для заблокованої чернетки одного файлового виконавця');
              const route=await registry.requireRoute(input.routeId);
              const access=team[0].access;
              if(route.backend!=='codex'||!suits(route,{...run.project.routingRequirements?.[task.id],tools:true,workspaceWrite:access==='workspace-write'}))
                throw Error('Маршрут не має підтвердженого доступу до потрібних інструментів');
              replacement=executionAgent(route,{access,role:task.title,skills:task.skills,config});
              lease=await refreshEmptyDraft(run,task,lease);
            }
            if(!isCurrentRun(run))throw Error('План змінився під час перевірки чернетки');
            const updated=engine.clarify(run.id,{taskId:task.id,answer:input.answer,projectScope:input.scope==='project',lease,replacement});
            if(input.scope==='project')uiProject(projectId).executionBrief=updated.project.executionBrief;
            store.save();return send(202,await present(updated));
          }finally{launching.delete(projectId);}
        }
        if(req.method==='POST'&&['continue','retry-access','retry-budget','resume-cancelled'].includes(action)){
          const accessRetry=action==='retry-access';
          const {taskId,routeId}=accessRetry?(await readBody(req)??{}):{};
          if(routeId!==undefined&&(typeof routeId!=='string'||typeof taskId!=='string'))throw Error('Потрібні точні ідентифікатори задачі та моделі');
          const budgetRetry=action==='retry-budget';
          const cancelledResume=action==='resume-cancelled';
          const projectId=run.project.uiProjectId;
          if(!isCurrentRun(run))throw Error('План змінився: продовжувати старий запуск не можна');
          if(launching.has(projectId)||Object.values(store.data.runs).some(other=>other.id!==run.id&&other.project.uiProjectId===projectId&&(['running','paused'].includes(other.status)||engine.controls.get(other.id)?.active.size||engine.controls.get(other.id)?.recovering)))throw Error('Інший запуск цього проєкту вже активний');
          const eligible=cancelledResume?engine.canResumeCancelled(run):budgetRetry?engine.canRetryBudget(run):accessRetry?engine.canRetryAccess(run,taskId):engine.canContinue(run);
          if(!eligible)throw Error('Немає відповідних задач, які можна продовжити в межах бюджету');
          launching.add(projectId);
          try{
            const dir=run.project.workspace;
            const uninitialized=cancelledResume&&run.calls===0&&!run.tasks.some(task=>task.workspace||task.resumeWorkspace)&&
              !(await lstat(join(dir,'.git')).catch(error=>{if(error.code!=='ENOENT')throw error;return null;}));
            if(!uninitialized&&(resolve(await engine.workspaces.git(dir,['rev-parse','--show-toplevel']))!==resolve(dir)||await engine.workspaces.git(dir,['status','--porcelain'])))throw Error('Прийнята робоча папка змінилася; перевірте зміни перед продовженням');
            let replacement,replacementWorkspace;
            if(cancelledResume||accessRetry||budgetRetry){
              const candidates=cancelledResume?engine.cancelledRunTasks(run):
                (accessRetry?retryableAccessTasks(run,taskId):run.tasks.filter(budgetBlocked)).map(task=>({task,draft:task.workspace}));
              const routes=new Set();
              await registry.scan();
              for(const {task,draft} of candidates){
                let agents=selectAgents(run.project,task);
                if(routeId!==undefined){
                  if(agents.length!==1||!agents[0].fileWorker)throw Error('Заміна доступна для одного файлового виконавця');
                  const route=await registry.requireRoute(routeId,{refresh:false}),access=agents[0].access;
                  if(route.backend!=='codex'||!suits(route,{...run.project.routingRequirements?.[task.id],tools:true,workspaceWrite:access==='workspace-write'}))
                    throw Error('Маршрут не має підтвердженого доступу до потрібних інструментів');
                  replacement=executionAgent(route,{access,role:task.title,skills:task.skills,config});
                  agents=[replacement];
                }
                if(task.reviewerId){
                  const reviewer=run.project.agents.find(agent=>agent.id===task.reviewerId&&agent.enabled!==false);
                  if(!reviewer)throw Error('Рецензент недоступний');
                  agents.push(reviewer);
                }
                for(const agent of agents)routes.add(`${agent.provider}:${agent.model}`);
                if(draft){
                  const verified=await engine.workspaces.resume(run,draft);
                  if(replacement){
                    const fresh=await refreshEmptyDraft(run,task,verified);
                    if(fresh!==verified)replacementWorkspace={path:fresh.cwd,branch:fresh.branch,baseCommit:fresh.baseCommit};
                  }
                }
              }
              for(const route of routes)await registry.requireRoute(route,{refresh:false});
            }
            if(!isCurrentRun(run))throw Error('План змінився під час підготовки продовження');
            if(cancelledResume)return send(202,await present(engine.resumeCancelled(run.id)));
            if(budgetRetry)return send(202,await present(engine.retryBudget(run.id)));
            return send(202,await present(accessRetry?engine.retryAccess(run.id,taskId,replacement,replacementWorkspace):engine.continueTimedOut(run.id,{timeoutMs:config.timeoutMs??null})));
          }finally{launching.delete(projectId);}
        }
        if(req.method==='POST'&&action==='recover'){
          if(!isCurrentRun(run))throw Error('План змінився: відновлювати старий запуск не можна');
          if(launching.has(run.project.uiProjectId)||Object.values(store.data.runs).some(other=>other.id!==run.id&&other.project.uiProjectId===run.project.uiProjectId&&(['running','paused'].includes(other.status)||engine.controls.get(other.id)?.active.size||engine.controls.get(other.id)?.recovering)))throw Error('Інший запуск цього проєкту вже активний');
          return send(202,engine.requestRecovery(run.id));
        }
        if(req.method==='POST'&&action==='cancel-task')return send(200,engine.cancelTask(run.id,(await readBody(req)).taskId));
        if(req.method==='GET'&&action==='file') {
          const path=url.searchParams.get('path');
          if(!path||(process.platform==='win32'&&path.includes(':'))||path.split(/[\\/]/).some(excluded))throw new Error('Недоступний файл');
          const base=await realpath(run.project.workspace);
          let actual;
          try { actual=await realpath(resolve(base,path)); } catch { throw new Error('Файл не знайдено'); }
          if(!inside(base,actual))throw new Error('Файл виходить за межі проєкту');
          if(relative(base,actual).split(/[\\/]/).some(excluded))throw new Error('Недоступний файл');
          const info=await stat(actual);if(!info.isFile()||info.size>1024*1024)throw new Error('Файл не є текстовим артефактом до 1 MB');
          const bytes=await readFile(actual);if(bytes.includes(0))throw new Error('Бінарний файл: відкрийте у робочій папці');
          return send(200,{path,text:bytes.toString('utf8')});
        }
        if(req.method==='GET'&&!action)return send(200,await present(run));
      }
      send(404,{error:'Route not found'});
    }catch(error){
      if(res.headersSent||res.destroyed||res.writableEnded){res.end();return;}
      send(error.statusCode??400,{error:error.message});
    }
  };
  return {handler,engine,store,registry,director,close(){closing=true;projectPreview.close();for(const stream of streams)stream();for(const controller of routingControls.values())controller.abort();for(const controller of hostChecks.values())controller.abort();for(const run of Object.values(store.data.runs))if(['running','paused'].includes(run.status))engine.cancel(run.id);store.flush?.();}};
}
