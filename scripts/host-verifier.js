import { readFileSync } from 'node:fs';
import { readFile, lstat, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { redactSecrets, runProcess } from '../src/providers.js';
import { verificationBlockers } from '../src/execution-report.js';
import { managedCheckKind,validNodeTests } from './project-test-runtime.js';

const inside=(root,target)=>{
  const a=process.platform==='win32'?resolve(root).toLowerCase():resolve(root);
  const b=process.platform==='win32'?resolve(target).toLowerCase():resolve(target);
  const rel=relative(a,b);
  return Boolean(rel)&&rel!=='..'&&!rel.startsWith(`..${sep}`)&&!isAbsolute(rel);
};

const inherited=/^(?:path|pathext|systemroot|windir|comspec|temp|tmp|lang|lc_all)$/i;
const postgresCheck=/^npm run test:([a-z0-9]+(?:-[a-z0-9]+)*)-postgres$/;
const postgresFile=/^scripts\/test-[a-z0-9]+(?:-[a-z0-9]+)*-postgres\.mjs$/;
const browserCheck=/^npm run test:([a-z0-9]+(?:-[a-z0-9]+)*)-browser$/;
const browserFile=/^scripts\/check-[a-z0-9]+(?:-[a-z0-9]+)*-browser\.mjs$/;
const httpTestFile=/^tests\/integration\/[a-z0-9]+(?:-[a-z0-9]+)*\.test\.mjs$/;
const testFile=/^tests\/(?:integration\/)?[a-z0-9]+(?:-[a-z0-9]+)*\.test\.mjs$/;

function projectCheck(command,rules) {
  if(!rules)return null;
  const [node,...argv]=command.split(/[ \t]+/);
  const entry={expected:0,timeoutMs:120000,env:Object.fromEntries(Object.entries(process.env).filter(([key])=>inherited.test(key)))};
  if(rules.http===true){
    if(command==='npm run test:http')return {...entry,projectScript:'test:http'};
    if(node==='node'&&argv[0]==='--test'&&argv.slice(1).some(file=>httpTestFile.test(file))&&argv.slice(1).every(file=>testFile.test(file)))
      return {...entry,argv};
  }
  if(typeof rules.postgresBin==='string'&&isAbsolute(rules.postgresBin)){
    const env={...entry.env,STORE_TEST_POSTGRES_BIN:rules.postgresBin};
    const match=command.match(postgresCheck);
    if(match)return {...entry,env,projectScript:`test:${match[1]}-postgres`,scriptFile:`scripts/test-${match[1]}-postgres.mjs`};
    if(node==='node'&&argv.length===1&&postgresFile.test(argv[0]))return {...entry,env,argv};
  }
  if(rules.browser===true){
    const browser={...entry,timeoutMs:150000,retryTransientBrowser:true};
    const match=command.match(browserCheck);
    if(match)return {...browser,projectScript:`test:${match[1]}-browser`,scriptFile:`scripts/check-${match[1]}-browser.mjs`};
    if(node==='node'&&argv.length===1&&browserFile.test(argv[0]))return {...browser,argv};
  }
  return null;
}

function containerCheck(command,testNode) {
  if(!testNode)return null;
  if(command==='npm run test:http')return {isolatedNode:true,expected:0,timeoutMs:235000,projectScript:'test:http'};
  const files=/^node --test (.+)$/.exec(command)?.[1].split(/[ \t]+/);
  if(validNodeTests(files))return {isolatedNode:true,expected:0,timeoutMs:235000,argv:['--test',...files]};
  if(!testNode.script)return null;
  const direct=/^node (scripts\/[a-z0-9.-]+\.mjs)$/.exec(command)?.[1];
  if(direct&&managedCheckKind(direct))return {isolatedScript:true,expected:0,timeoutMs:600000,argv:[direct]};
  const postgres=command.match(postgresCheck);
  const browser=command.match(browserCheck);
  if(postgres||browser)return {isolatedScript:true,expected:0,timeoutMs:600000,projectScript:command.slice('npm run '.length),
    scriptFile:postgres?`scripts/test-${postgres[1]}-postgres.mjs`:`scripts/check-${browser[1]}-browser.mjs`};
  return null;
}

// This file is owned by the operator and lives outside managed project worktrees.
// Project script rules are opt-in because Node loads code from the verified worktree.
export function createHostVerifier(policyPath,{run=runProcess,testNode}={}) {
  return {
    plan(runSnapshot,task,{partial=false}={}) {
      let policy;
      try { policy=JSON.parse(readFileSync(policyPath,'utf8')); }
      catch(error) { if(error.code==='ENOENT')policy={};else throw Error('Не вдалося прочитати політику локальних перевірок'); }
      const projectId=runSnapshot.project.uiProjectId;
      const project=policy.projects&&Object.hasOwn(policy.projects,projectId)?policy.projects[projectId]:{};
      const exact=project.checks??{},rules=project.nodeProjectChecks;
      const outstanding=task.blockedReport.checks.filter(check=>check.required!==false&&check.status!=='passed');
      const overrides=project.taskChecks&&Object.hasOwn(project.taskChecks,task.id)?project.taskChecks[task.id]:{};
      const isolated=command=>project.isolatedNodeTests!==false?containerCheck(command,testNode):null;
      const pending=new Set((partial?verificationBlockers(task):outstanding).map(check=>check.command));
      const additionalChecks=partial?outstanding.filter(({command})=>!pending.has(command)&&
        (Object.hasOwn(overrides,command)||Object.hasOwn(exact,command)||isolated(command))).map(({command})=>command):[];
      for(const command of additionalChecks)pending.add(command);
      const preflights=partial&&project.taskPreflights&&Object.hasOwn(project.taskPreflights,task.id)
        ?Object.entries(project.taskPreflights[task.id]).filter(([name,entry])=>
          outstanding.some(check=>check.command===entry.before)&&!task.blockedReport.checks.some(check=>check.command===name))
        :[];
      const configuredPreflights=new Map(preflights);
      for(const [name] of preflights)pending.add(name);
      const checks=new Map();
      for(const command of pending){
        const preflight=configuredPreflights.get(command);
        const entry=preflight??(Object.hasOwn(overrides,command)?overrides[command]:Object.hasOwn(exact,command)?exact[command]:null);
        if(!entry){
          const check=isolated(command)??projectCheck(command,rules);
          if(!check){
            if(partial)continue;
            return null;
          }
          checks.set(command,check);
          continue;
        }
        if(!Array.isArray(entry.argv)||!entry.argv.length||!entry.argv.every(arg=>typeof arg==='string'))return null;
        const expected=entry.expectedExitCode??0, timeoutMs=entry.timeoutMs??120000;
        if(!Number.isInteger(expected)||expected<0||expected>255||!Number.isInteger(timeoutMs)||timeoutMs<100||timeoutMs>900000)return null;
        const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>inherited.test(key)));
        for(const [key,value] of Object.entries(entry.env??{})){
          if(!/^[a-z_][a-z0-9_]*$/i.test(key)||typeof value!=='string')return null;
          env[key]=value;
        }
        checks.set(command,{argv:entry.argv,expected,timeoutMs,env,preflight:Boolean(preflight),
          ...(preflight?{before:preflight.before}:{}),retryTransientBrowser:entry.retryTransientBrowser===true});
      }
      const testCompletion=partial&&project.testCompletion?.taskId===task.id?project.testCompletion:undefined;
      return checks.size?{automatic:project.automatic===true||(project.automatic!==false&&[...checks.values()].some(check=>check.isolatedNode||check.isolatedScript)),checks,testCompletion,additionalChecks,
        runtimeVersion:[...checks.values()].some(check=>check.isolatedScript)?testNode?.version:undefined,
        preflights:preflights.map(([command])=>({command,required:true,status:'not_run',details:''}))}:null;
    },
    async verify(plan,report,cwd,signal,{continueOnFailure=false}={}) {
      const checks=new Map();
      const results=new Map();
      const commands=new Map(plan.checks);
      const cwdReal=await realpath(cwd);
      const assertSafeWorktreePath=async relPath=>{
        const candidate=resolve(cwdReal,relPath);
        if(!inside(cwdReal,candidate))throw Error(`${relPath}: шлях виходить за межі worktree`);
        const info=await lstat(candidate).catch(()=>null);
        if(info?.isSymbolicLink())throw Error(`${relPath}: symlink заборонено для локальної перевірки`);
        if(info){
          const resolved=await realpath(candidate);
          if(!inside(cwdReal,resolved))throw Error(`${relPath}: шлях виходить за межі worktree`);
        }
      };
      if([...commands.values()].some(entry=>entry.projectScript)){
        await assertSafeWorktreePath('package.json');
        const {scripts}=JSON.parse(await readFile(join(cwd,'package.json'),{encoding:'utf8',signal}));
        for(const [command,entry] of commands){
          if(!entry.projectScript)continue;
          const script=scripts?.[entry.projectScript];
          const args=typeof script==='string'?script.trim().split(/[ \t]+/):[];
          const valid=entry.isolatedNode ? args[1]==='--test'&&validNodeTests(args.slice(2)) : entry.scriptFile
            ?args.length===2&&args[1]===entry.scriptFile
            :args.length>2&&args[1]==='--test'&&args.slice(2).every(path=>httpTestFile.test(path));
          if(args[0]!=='node'||!valid)throw Error(`${command}: package.json не відповідає дозволеному формату локальної перевірки`);
          commands.set(command,{...entry,argv:args.slice(1)});
        }
      }
      const preflights=report.checks.filter(check=>commands.get(check.command)?.preflight);
      const ordered=report.checks.filter(check=>!commands.get(check.command)?.preflight).flatMap(check=>[
        ...preflights.filter(preflight=>commands.get(preflight.command).before===check.command),check
      ]);
      for(const check of ordered){
        const entry=check.required!==false&&check.status!=='passed'?commands.get(check.command):null;
        if(!entry||preflights.some(preflight=>commands.get(preflight.command).before===check.command&&checks.get(preflight)?.status!=='passed'))continue;
        if(!results.has(check.command)){
          for(const arg of entry.argv){if(!arg.startsWith('-')&&!isAbsolute(arg))await assertSafeWorktreePath(arg);}
          const timeout=AbortSignal.timeout(entry.timeoutMs);
          const deadline=AbortSignal.any([signal,timeout]);
          let actual=0, output='', timedOut=false, infrastructureError, runtime, versionConflict=false;
          for(let attempt=0;attempt<2;attempt++){
            try {
              if(entry.isolatedNode||entry.isolatedScript){
                const result=entry.isolatedScript?await testNode.script(cwd,entry.argv[0],deadline):
                  await testNode(cwd,entry.argv.slice(1),deadline);
                output=result.output;
                actual=result.exitCode;
                runtime=result.runtime;
              }else{
                output=await run(process.execPath,entry.argv,{cwd,env:entry.env,prompt:'',signal:deadline});
                actual=0;
              }
              break;
            } catch(error) {
              if(signal.aborted)throw signal.reason;
              if(['LOCAL_DOCKER_UNAVAILABLE','PROJECT_RUNTIME_UNAVAILABLE','PROJECT_RUNTIME_CONFLICT'].includes(error.code)){
                if(!continueOnFailure)throw error;
                actual=null;
                infrastructureError=error.message;
                versionConflict=error.code==='PROJECT_RUNTIME_CONFLICT';
                break;
              }
              if(timeout.aborted){
                if(!continueOnFailure)throw timeout.reason;
                actual=124;timedOut=true;output=`Таймаут локальної перевірки (${entry.timeoutMs} мс)`;
                break;
              }
              if(error.exitCode==null)throw error;
              actual=error.exitCode;
              output=entry.preflight?(error.stdout?.trim()||error.message.replace(/^CLI exited with code \d+:\s*/,'')):error.message;
              if(attempt||!entry.retryTransientBrowser||actual===entry.expected||
                !/(?:^|\n)(?:CLI exited with code \d+: )?(?:UI_WAIT_TIMEOUT:|BROWSER_REPORT_MISSING(?::|\b))/.test(error.message))break;
            }
          }
          const lines=typeof output==='string'?output.trim().split(/\r?\n/).filter(Boolean):[];
          const assertions=lines.filter(line=>/not ok |AssertionError|ERR_ASSERTION|expected:|actual:|failureType:/.test(line));
          const errors=lines.filter(line=>/\b(?:[A-Za-z]*Error|ERROR|FATAL):/.test(line));
          const repairable=!infrastructureError&&!timedOut&&actual!==entry.expected&&
            (entry.isolatedNode||entry.isolatedScript||assertions.some(line=>/AssertionError|ERR_ASSERTION/.test(line)));
          const diagnostic=(actual!==entry.expected||entry.preflight)&&lines.length
            ?redactSecrets((assertions.length?assertions:errors.length?errors:lines).slice(0,8).join(' '),850):'';
          results.set(check.command,{actual,repairable,diagnostic,infrastructureError,runtime,versionConflict});
        }
        const {actual,diagnostic,repairable,infrastructureError,runtime,versionConflict}=results.get(check.command), passed=actual===entry.expected;
        if(infrastructureError){
          checks.set(check,{...check,kind:'exit_code',status:'not_run',expectedExitCode:entry.expected,actualExitCode:null,
            source:'host',details:infrastructureError,environmentUnavailable:true,...(versionConflict?{repairable:true}:{})});
          continue;
        }
        const versions=runtime?` · Node.js ${runtime.node}${runtime.postgres?`, PostgreSQL ${runtime.postgres}`:''}`:'';
        const details=passed?(diagnostic||'Перевірено локальним верифікатором за політикою проєкту')+versions:entry.preflight&&diagnostic?diagnostic:
          `${check.command}: отримано код ${actual}, очікувався ${entry.expected}${diagnostic?' · '+diagnostic:''}`;
        if(!passed&&!continueOnFailure)throw Error(details);
        checks.set(check,{...check,kind:'exit_code',status:passed?'passed':'failed',expectedExitCode:entry.expected,actualExitCode:actual,
          source:'host',details,...(repairable?{repairable:true}:{})});
      }
      return report.checks.map(check=>checks.get(check)??check);
    }
  };
}
