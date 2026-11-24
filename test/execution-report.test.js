import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {normalizeReportChecks,reportNeedsCorrection,verificationBlockers,waitsForVerification} from '../src/execution-report.js';
import {createHostVerifier} from '../scripts/host-verifier.js';

test('Windows browser startup failure can use the local verifier, but an application assertion cannot',()=>{
  const task={status:'blocked',workspace:{path:'draft'},failure:{code:'AGENT_BLOCKED'},blockedReport:{checks:[
    check({command:'npm run test:http',details:'connect EACCES 127.0.0.1:64549'}),
    check({command:'npm run test:inventory-postgres',details:'POSTGRES_TOOL_REQUIRED:initdb'}),
    check({command:'npm run test:inventory-browser',details:'Chrome завершився кодом 2147483651; звіт порожній.'})
  ]}};
  assert.equal(waitsForVerification(task),true);
  task.blockedReport.checks[2].details='BROWSER_START_FAILED:exit=2147483651:signal=null:(empty stderr). Chromium failed to start.';
  assert.equal(waitsForVerification(task),true);
  task.blockedReport.checks[2].details='BROWSER_REPORT_MISSING; Page load failed: net::ERR_NETWORK_ACCESS_DENIED. No browser loopback HTTP.';
  assert.equal(waitsForVerification(task),true);
  task.blockedReport.checks[2].details='Chrome crashed: crash server failed to launch, self-terminating';
  assert.equal(waitsForVerification(task),true);
  task.blockedReport.checks[2].details='Timed out waiting for the Chromium debugging endpoint';
  assert.equal(waitsForVerification(task),true);
  task.blockedReport.checks[2].details='Chrome started; assertion: reserve button is missing';
  assert.equal(waitsForVerification(task),false);
});

const check=(more={})=>({command:'node check-ready.mjs --require-ready',status:'failed',required:true,details:'Expected activation refusal',kind:'exit_code',expectedExitCode:1,actualExitCode:1,...more});

test('Windows PostgreSQL loopback permissions are classified as an environment blocker',()=>{
  const command='node scripts/test-catalog-postgres.mjs';
  const details='connection to server at "127.0.0.1", port 5432 failed: Permission denied (0x0000271D/10013)';
  const result=check({command,details});
  const task={status:'blocked',workspace:{path:'draft'},failure:{code:'AGENT_BLOCKED'},blockedReport:{checks:[result]}};
  assert.deepEqual(verificationBlockers(task).map(blocker=>blocker.command),[command]);
  result.details='permission denied for schema catalog_test';
  assert.deepEqual(verificationBlockers(task),[]);
});

test('the local verifier retries transient browser reports once and preserves genuine assertions',async()=>{
  const report={checks:[check({command:'browser',expectedExitCode:0})]};
  const plan={checks:new Map([['browser',{argv:['browser.mjs'],expected:0,timeoutMs:1000,env:{},retryTransientBrowser:true}]])};
  const signal=new AbortController().signal;
  for(const [message,transient] of [['UI_WAIT_TIMEOUT:Waiting for auth',true],['Assertion failed: reserve did not update',false]]){
    let calls=0;
    const verifier=createHostVerifier('unused',{run:async()=>{
      if(++calls===1)throw Object.assign(Error('CLI exited with code 1: '+message),{exitCode:1});
    }});
    if(transient)assert.equal((await verifier.verify(plan,report,'.',signal))[0].status,'passed');
    else await assert.rejects(verifier.verify(plan,report,'.',signal),/отримано код 1/);
    assert.equal(calls,transient?2:1);
  }
});

test('project-defined checks reject shell syntax, Node flags and paths outside the test tree',async t=>{
  const cwd=await mkdtemp(join(tmpdir(),'host-verifier-'));
  t.after(()=>rm(cwd,{recursive:true,force:true}));
  const command='npm run test:http',policy=join(cwd,'policy.json');
  const report={checks:[check({command,expectedExitCode:0})]};
  const task={blockedReport:report},run={project:{uiProjectId:'trusted'}};
  let calls=0;
  const verifier=createHostVerifier(policy,{run:async()=>{calls++;}});
  await writeFile(policy,JSON.stringify({projects:{trusted:{automatic:true,nodeProjectChecks:{http:true}}}}));
  assert.equal(verifier.plan({project:{uiProjectId:'other'}},task),null);
  const plan=verifier.plan(run,task);
  for(const script of ['node --test tests/integration/example.test.mjs && whoami',
    'node --test --import tests/integration/example.test.mjs','node --test ../example.test.mjs']){
    await writeFile(join(cwd,'package.json'),JSON.stringify({scripts:{'test:http':script}}));
    await assert.rejects(verifier.verify(plan,report,cwd,new AbortController().signal),/дозволеному формату/);
  }
  assert.equal(calls,0);
});

test('trusted project rules accept direct Node checks for HTTP, PostgreSQL and Chromium together',async t=>{
  const cwd=await mkdtemp(join(tmpdir(),'host-verifier-'));
  t.after(()=>rm(cwd,{recursive:true,force:true}));
  const policy=join(cwd,'policy.json'),postgresBin=resolve(cwd,'postgres','bin');
  const rules={http:true,postgresBin,browser:true};
  const project={uiProjectId:'trusted'};
  const argv=[
    ['--test','tests/payments.test.mjs','tests/integration/payments-http.test.mjs'],
    ['scripts/test-payments-postgres.mjs'],
    ['scripts/check-payments-browser.mjs']
  ];
  const report={checks:argv.map(args=>check({command:'node '+args.join(' '),expectedExitCode:0}))};
  const calls=[];
  const verifier=createHostVerifier(policy,{run:async(executable,args,{env})=>calls.push({executable,args,env})});
  await writeFile(policy,JSON.stringify({projects:{trusted:{automatic:true,nodeProjectChecks:rules}}}));
  const plan=verifier.plan({project},{blockedReport:report});
  assert.ok(plan?.automatic);
  const checks=await verifier.verify(plan,report,cwd,new AbortController().signal);
  assert.ok(checks.every(result=>result.status==='passed'&&result.source==='host'));
  assert.deepEqual(calls.map(call=>call.args),argv);
  assert.ok(calls.every(call=>call.executable===process.execPath));
  assert.equal(calls[1].env.STORE_TEST_POSTGRES_BIN,postgresBin);
  for(const command of ['node --test tests/integration/payments-http.test.mjs && whoami',
    'node scripts/test-payments-postgres.mjs --worker','node scripts/check-payments-browser.mjs --no-sandbox',
    'node --test tests/integration/../example.test.mjs','node --test tests/payments.test.mjs']){
    assert.equal(verifier.plan({project},{blockedReport:{checks:[check({command})]}}),null);
  }
  await writeFile(policy,JSON.stringify({projects:{trusted:{automatic:true,nodeProjectChecks:{...rules,browser:false}}}}));
  assert.equal(verifier.plan({project},{blockedReport:report}),null);
});

test('an explicitly expected nonzero exit passes without requiring product activation',()=>{
  const input=check(),[result]=normalizeReportChecks([input]);
  assert.equal(result.status,'passed');assert.equal(result.reportedStatus,'failed');assert.equal(input.status,'failed');
});

test('mismatched exit codes fail even if the model claimed success',()=>{
  for(const [expectedExitCode,actualExitCode] of [[0,1],[1,0],[2,1]]){
    const [result]=normalizeReportChecks([check({status:'passed',expectedExitCode,actualExitCode})]);assert.equal(result.status,'failed');
  }
});

test('unexecuted checks and failed assertions remain unsuccessful',()=>{
  assert.equal(normalizeReportChecks([check({status:'not_run'})])[0].status,'not_run');
  assert.equal(normalizeReportChecks([check({kind:'assertion',expectedExitCode:null,actualExitCode:null})])[0].status,'failed');
  const legacy={command:'node test.mjs',status:'failed',required:true,details:'Expected refusal in prose alone is insufficient'};
  assert.equal(normalizeReportChecks([legacy])[0].status,'failed');
});

test('ambiguous or invalid exit assertions are rejected',()=>{
  for(const value of [null,undefined,-1,1.5,NaN,Infinity,'1'])assert.throws(()=>normalizeReportChecks([check({expectedExitCode:value})]),/коди/);
  assert.throws(()=>normalizeReportChecks([check({kind:'assertion'})]),/підмінятися/);
});

test('legacy publication-check failure permits correction only with a completed checked draft',()=>{
  const report={status:'completed',checks:[{status:'passed',required:true}]};
  const task={status:'failed',workspace:{path:'draft'},result:'verified draft',failure:{code:2,message:'Command failed: git -C draft diff --cached --check\n'},outputs:[{report}]};
  assert.equal(reportNeedsCorrection(task),true);
  assert.equal(reportNeedsCorrection({...task,failure:{code:2,message:'Command failed: codex exec'}}),false);
  assert.equal(reportNeedsCorrection({...task,outputs:[]}),false);
  assert.equal(reportNeedsCorrection({...task,outputs:[{report:{...report,checks:[{status:'failed',required:true}]}}]}),false);
});
