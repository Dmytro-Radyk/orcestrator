import { readFileSync } from 'node:fs';
import { readFile, lstat, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { runProcess } from '../src/providers.js';
import { verificationBlockers } from '../src/execution-report.js';

const inside=(root,target)=>{const rel=relative(root,target);return Boolean(rel)&&rel!=='..'&&!rel.startsWith(`..${sep}`)&&!isAbsolute(rel);};

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

// This file is owned by the operator and lives outside managed project worktrees.
// Project script rules are opt-in because Node loads code from the verified worktree.
export function createHostVerifier(policyPath,{run=runProcess}={}) {
  return {
    plan(runSnapshot,task,{partial=false}={}) {
      let policy;
      try { policy=JSON.parse(readFileSync(policyPath,'utf8')); }
      catch(error) { if(error.code==='ENOENT')return null; throw Error('Не вдалося прочитати політику локальних перевірок'); }
      const projectId=runSnapshot.project.uiProjectId;
      const project=policy.projects&&Object.hasOwn(policy.projects,projectId)?policy.projects[projectId]:null;
      if(!project)return null;
      const exact=project.checks??{},rules=project.nodeProjectChecks;
      const outstanding=task.blockedReport.checks.filter(check=>check.required!==false&&check.status!=='passed');
      const pending=new Set((partial?verificationBlockers(task):
        outstanding).map(check=>check.command));
      const overrides=project.taskChecks&&Object.hasOwn(project.taskChecks,task.id)?project.taskChecks[task.id]:{};
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
          const check=projectCheck(command,rules);
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
        checks.set(command,{argv:entry.argv,expected,timeoutMs,env,preflight:Boolean(preflight),retryTransientBrowser:entry.retryTransientBrowser===true});
      }
      const testCompletion=partial&&project.testCompletion?.taskId===task.id?project.testCompletion:undefined;
      return checks.size?{automatic:project.automatic===true,checks,testCompletion,
        preflights:preflights.map(([command])=>({command,required:true,status:'not_run',details:''}))}:null;
    },
    async verify(plan,report,cwd,signal,{continueOnFailure=false}={}) {
      const checks=[];
      const results=new Map();
      const commands=new Map(plan.checks);
      const cwdReal=await realpath(cwd);
      const assertSafeWorktreePath=async relPath=>{
        const target=join(cwd,relPath);
        const info=await lstat(target).catch(()=>null);
        if(info?.isSymbolicLink())throw Error(`${relPath}: symlink заборонено для локальної перевірки`);
        if(info){
          const resolved=await realpath(target);
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
          const valid=entry.scriptFile
            ?args.length===2&&args[1]===entry.scriptFile
            :args.length>2&&args[1]==='--test'&&args.slice(2).every(path=>httpTestFile.test(path));
          if(args[0]!=='node'||!valid)throw Error(`${command}: package.json не відповідає дозволеному формату локальної перевірки`);
          commands.set(command,{...entry,argv:args.slice(1)});
        }
      }
      for(const check of report.checks){
        const entry=check.required!==false&&check.status!=='passed'?commands.get(check.command):null;
        if(!entry){checks.push(check);continue;}
        if(!results.has(check.command)){
          for(const arg of entry.argv){if(!arg.startsWith('-')&&!isAbsolute(arg))await assertSafeWorktreePath(arg);}
          const timeout=AbortSignal.timeout(entry.timeoutMs);
          const deadline=AbortSignal.any([signal,timeout]);
          let actual=0, output='', timedOut=false;
          for(let attempt=0;attempt<2;attempt++){
            try {
              output=await run(process.execPath,entry.argv,{cwd,env:entry.env,prompt:'',signal:deadline});
              actual=0;
              break;
            } catch(error) {
              if(signal.aborted)throw signal.reason;
              if(timeout.aborted){
                if(!continueOnFailure)throw timeout.reason;
                actual=124;timedOut=true;output=`Таймаут локальної перевірки (${entry.timeoutMs} мс)`;
                break;
              }
              if(error.exitCode==null)throw error;
              actual=error.exitCode;
              output=error.stdout;
              if(attempt||!entry.retryTransientBrowser||actual===entry.expected||
                !/(?:^|\n)(?:CLI exited with code \d+: )?(?:UI_WAIT_TIMEOUT:|BROWSER_REPORT_MISSING(?::|\b))/.test(error.message))break;
            }
          }
          results.set(check.command,{actual,timedOut,diagnostic:(timedOut||entry.preflight)&&typeof output==='string'?output.trim().split(/\r?\n/).at(-1).slice(0,500):''});
        }
        const {actual,diagnostic}=results.get(check.command), passed=actual===entry.expected;
        const details=diagnostic||(passed?'Перевірено локальним верифікатором за політикою проєкту':
          `${check.command}: отримано код ${actual}, очікувався ${entry.expected}`);
        if(!passed&&!continueOnFailure)throw Error(details);
        checks.push({...check,kind:'exit_code',status:passed?'passed':'failed',expectedExitCode:entry.expected,actualExitCode:actual,
          source:'host',details});
      }
      return checks;
    }
  };
}
