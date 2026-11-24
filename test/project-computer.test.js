import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createProjectComputer } from '../scripts/project-computer.js';
import { createHostVerifier } from '../scripts/host-verifier.js';
import { createDockerReadiness } from '../scripts/project-test-runtime.js';

test('a missing Docker Engine starts once for concurrent checks and unavailable Docker never fails a test',async()=>{
  const transportError=Error('Failed to connect to the Docker API: open //./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified');
  let ready=false,starts=0;
  const ensure=createDockerReadiness(async()=>{if(!ready)throw transportError;},async()=>{starts++;ready=true;});
  await Promise.all([ensure(),ensure()]);
  await ensure();
  assert.equal(starts,1);

  const broken=createDockerReadiness(async()=>{throw transportError;},async()=>{throw Error('Desktop failed to start');});
  const command='node --test tests/integration/http.test.mjs';
  const verifier=createHostVerifier('nonexistent-project-computer-policy.json',{testNode:()=>broken()});
  const task={status:'blocked',workspace:{path:'draft'},failure:{code:'AGENT_BLOCKED'},blockedReport:{checks:[
    {command,required:true,status:'failed',details:'connect EACCES 127.0.0.1:5000'}
  ]}};
  const plan=verifier.plan({project:{uiProjectId:'unconfigured'}},task,{partial:true});
  const [result]=await verifier.verify(plan,task.blockedReport,'.',new AbortController().signal,{continueOnFailure:true});
  assert.equal(result.status,'not_run');
  assert.equal(result.actualExitCode,null);
  assert.equal(result.environmentUnavailable,true);
  assert.equal(result.repairable,undefined);
});

test('project tools bind to one worktree, reject external pages and expire with the invocation',async t=>{
  const actions=[];
  const server=createServer((req,res)=>void computer.handle(req,res,req.url));
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  t.after(()=>{server.closeAllConnections();server.close();});
  const origin='http://127.0.0.1:'+server.address().port;
  const computer=createProjectComputer({
    origin,
    preview:{async open(project,cwd,_,options){
      actions.push([project,cwd,options.candidate]);
      return {url:'http://127.0.0.1:9123/',close(){actions.push('closed');}};
    }},
    inspect:async(url,width)=>({page:{url,width},image:'aW1hZ2U='}),
    testNode:async(cwd,files)=>({exitCode:0,output:cwd+' '+files.join(',')})
  });
  t.after(()=>computer.close());
  const lease={cwd:'draft'};
  const scope=computer.open({run:{project:{uiProjectId:'test-project'}},lease,
    signal:new AbortController().signal,workspaces:{
      async candidateTree(current){assert.equal(current,lease);return 'tree';},
      async verifyTree(current,tree,check){assert.equal(current,lease);assert.equal(tree,'tree');return check('snapshot');}
    }});
  const rpc=(method,params,headers={})=>fetch(scope.server.url,{method:'POST',headers:{'Content-Type':'application/json',...headers},
    body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
  const result=async(method,params)=>(await (await rpc(method,params)).json()).result;
  assert.equal((await result('initialize',{protocolVersion:'2025-06-18'})).protocolVersion,'2025-06-18');
  assert.deepEqual((await result('tools/list')).tools.map(tool=>tool.name),['inspect_preview','run_node_tests']);
  const inspection=await result('tools/call',{name:'inspect_preview',arguments:{path:'/catalog',width:360}});
  assert.deepEqual(inspection.structuredContent,{url:'http://127.0.0.1:9123/catalog',width:360});
  assert.equal(inspection.content[1].type,'image');
  assert.equal((await result('tools/call',{name:'inspect_preview',arguments:{path:'//example.com'}})).isError,true);
  assert.equal((await result('tools/call',{name:'run_node_tests',arguments:{files:['tests/../../outside.test.mjs']}})).isError,true);
  assert.equal((await result('tools/call',{name:'run_node_tests',arguments:{files:['tests/ui.test.mjs']}})).structuredContent.output,
    'snapshot tests/ui.test.mjs');
  assert.equal((await rpc('ping',{}, {Origin:'http://example.com'})).status,403);
  assert.deepEqual(actions,[['test-project','snapshot',true],'closed']);
  scope.close();
  assert.equal((await rpc('ping')).status,404);
});

test('an unconfigured project can rerun a Node loopback test in the isolated runtime',async()=>{
  const command='node --test tests/integration/http.test.mjs';
  const verifier=createHostVerifier('nonexistent-project-computer-policy.json',{testNode:async(cwd,files)=>{
    assert.deepEqual(files,['tests/integration/http.test.mjs']);
    return {exitCode:1,output:'not ok 1 - returns the saved order\n  expected: 200\n  actual: 500'};
  }});
  const task={status:'blocked',workspace:{path:'draft'},failure:{code:'AGENT_BLOCKED'},blockedReport:{checks:[
    {command,required:true,status:'failed',details:'connect EACCES 127.0.0.1:5000'},
    {command:'docker compose up --build',required:true,status:'not_run',details:'Needs Docker'}
  ]}};
  const plan=verifier.plan({project:{uiProjectId:'unconfigured'}},task,{partial:true});
  assert.equal(plan.automatic,true);
  assert.deepEqual([...plan.checks.keys()],[command]);
  const [result,deferred]=await verifier.verify(plan,task.blockedReport,'.',new AbortController().signal,{continueOnFailure:true});
  assert.equal(result.status,'failed');
  assert.equal(result.repairable,true);
  assert.match(result.details,/expected: 200.*actual: 500/);
  assert.equal(deferred.status,'not_run');
});
