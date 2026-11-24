import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir,mkdtemp,readFile,writeFile,rm,access,symlink } from 'node:fs/promises';
import { join,resolve,relative,isAbsolute } from 'node:path';
import { applyWorkerChanges,workerContext,executeFileWorker,sandboxChecks } from '../scripts/file-worker.js';

async function folder(t){const root=resolve('.orchestrator/tests');await mkdir(root,{recursive:true});const dir=await mkdtemp(join(root,'file-worker-'));
  t.after(async()=>{const rel=relative(root,dir);assert.ok(rel&&!rel.startsWith('..')&&!isAbsolute(rel));await rm(dir,{recursive:true,force:true});});return dir;}
test('file worker rejects traversal, secrets, symlinks, stale hashes and mixed invalid batches before any writes',async t=>{
  const root=await folder(t);await writeFile(join(root,'source.txt'),'original');await writeFile(join(root,'.env'),'PRIVATE');
  const files=await workerContext(root);assert.ok(!JSON.stringify(files).includes('PRIVATE'));
  for(const path of ['../outside.txt','/absolute','C:/outside','folder\\file','.git/config','.env','nested/.aws/secret','.gemini/credentials.json'])await assert.rejects(applyWorkerChanges(root,[{path,baseHash:null,content:'bad'}]));
  await assert.rejects(applyWorkerChanges(root,[{path:'first.txt',baseHash:null,content:'first'},{path:'source.txt',baseHash:'wrong',content:'changed'}]));
  await assert.rejects(access(join(root,'first.txt')));assert.equal(await readFile(join(root,'source.txt'),'utf8'),'original');
  const outside=await folder(t);await symlink(outside,join(root,'link'),process.platform==='win32'?'junction':'dir');
  await assert.rejects(applyWorkerChanges(root,[{path:'link/leak.txt',baseHash:null,content:'bad'}]),/Symlink/);
});
test('file changes require successful independent checks and return actual files and check results',async t=>{
  const cwd=await folder(t),agent={access:'workspace-write'},context={cwd,prompt:'Create code',signal:AbortSignal.timeout(10000)};
  const value={status:'completed',summary:'Created code',changes:[{path:'code.mjs',baseHash:null,content:'export const value = 1;'},
    {path:'code.test.mjs',baseHash:null,content:'import assert from "node:assert/strict";import{value}from"./code.mjs";assert.equal(value,1);'}],testFiles:['code.test.mjs']};
  let checked=false;const result=await executeFileWorker(agent,context,{model:async()=>({text:JSON.stringify(value),usage:{cost:0}}),checks:async(root,paths)=>{
    checked=true;assert.equal(await readFile(join(root,'code.mjs'),'utf8'),'export const value = 1;');assert.deepEqual(paths,['code.test.mjs']);return {status:'passed',command:'node --test code.test.mjs',required:true,details:'passed'};
  }});
  assert.equal(checked,true);assert.equal(result.report.checks[0].status,'passed');assert.equal(result.report.files.length,2);assert.equal(result.usage.cost,0);
  value.changes=[];await assert.rejects(executeFileWorker(agent,context,{model:async()=>({text:JSON.stringify(value)}),checks:async()=>({status:'failed',details:'failed test'})}),/failed test/);
});
test('delegation is bounded and read-only file workers cannot apply changes',async t=>{
  const cwd=await folder(t),context={cwd,prompt:'Task',signal:AbortSignal.timeout(1000)},delegate={status:'delegated',summary:'split',changes:[],testFiles:[],subtasks:[{title:'a',prompt:'a',skills:[]}]};
  await assert.rejects(executeFileWorker({access:'workspace-write'},context,{model:async()=>({text:JSON.stringify(delegate)})}),/делегування/);
  assert.equal((await executeFileWorker({access:'workspace-write'},{...context,canDelegate:true},{model:async()=>({text:JSON.stringify(delegate)})})).delegation.length,1);
  const value={status:'completed',summary:'x',changes:[{path:'file.txt',baseHash:null,content:'x'}],testFiles:[]};
  await assert.rejects(executeFileWorker({access:'read-only'},context,{model:async()=>({text:JSON.stringify(value)})}),/Read-only/);
});
test('file-worker self-review receives the reviewed files and never applies proposed edits',async t=>{
  const cwd=await folder(t);
  await writeFile(join(cwd,'candidate.mjs'),'export const answer=1;');
  const verdict={approved:false,feedback:'Check the value.',changes:[{path:'candidate.mjs',baseHash:null,content:'edited'}]};
  const result=await executeFileWorker({access:'read-only'},{cwd,review:'self',prompt:'Review candidate.mjs',signal:AbortSignal.timeout(10000)},
    {model:async(agent,{prompt})=>{
      assert.equal(agent.access,'read-only');assert.match(prompt,/export const answer=1;/);
      return {text:JSON.stringify(verdict)};
    },checks:()=>assert.fail('Review must not apply or test model-proposed edits')});
  assert.equal(JSON.parse(result.text).approved,false);
  assert.equal(await readFile(join(cwd,'candidate.mjs'),'utf8'),'export const answer=1;');
});
test('check runner requires a network-disabled OS sandbox, scoped Node permissions and no shell or credentials',async t=>{
  const cwd=await folder(t);await writeFile(join(cwd,'test.mjs'),'');let captured;
  const result=await sandboxChecks(cwd,['test.mjs'],{signal:AbortSignal.timeout(1000),command:'trusted-sandbox',run:async(command,args,options)=>{captured={command,args,options};return 'passed';}});
  assert.equal(result.status,'passed');assert.equal(captured.command,'trusted-sandbox');assert.ok(captured.args.includes('--permission'));
  assert.ok(captured.args.some(a=>a.includes('network={enabled=false}')));assert.ok(!Object.keys(captured.options.env).some(k=>/API_KEY|TOKEN|PASSWORD/.test(k)));
});

test('documenting a test command does not require unavailable tests in a parallel documentation branch',async t=>{
  const cwd=await folder(t);
  const value={status:'completed',summary:'Documented test command',changes:[{path:'README.md',baseHash:null,content:'Run node --test code.test.mjs'}],testFiles:[]};
  const result=await executeFileWorker({access:'workspace-write'},{cwd,prompt:'Document node --test code.test.mjs',signal:AbortSignal.timeout(1000)},
    {model:async()=>({text:JSON.stringify(value)})});
  assert.deepEqual(result.report.files,['README.md']);assert.deepEqual(result.report.checks,[]);
});

test('blocked file worker reports need clarification and do not apply proposed changes',async t=>{
  const cwd=await folder(t),value={status:'blocked',summary:'Confirm whether to build launch-ready without enabling sales',changes:[{path:'unapproved.txt',baseHash:null,content:'candidate'}],testFiles:[]};
  await assert.rejects(executeFileWorker({access:'workspace-write'},{cwd,prompt:'Build shop',signal:AbortSignal.timeout(1000)},
    {model:async()=>({text:JSON.stringify(value),usage:{input_tokens:2}})}),error=>{
      assert.equal(error.code,'AGENT_BLOCKED');assert.equal(error.report.summary,value.summary);assert.equal(error.usage.input_tokens,2);return true;
    });
  await assert.rejects(access(join(cwd,'unapproved.txt')));
});

test('file worker keeps the full task before the most relevant files within the serialized request budget',async t=>{
  const cwd=await folder(t);
  await mkdir(join(cwd,'src'));
  for(let i=0;i<15;i++)await writeFile(join(cwd,'src',`fixture-${i}.mjs`),'/* '+ 'ї\\\n'.repeat(7000)+' */');
  await writeFile(join(cwd,'src','seo.mjs'),'export const sitemap = [];');
  const task='Додати SEO в src/seo.mjs.\nAcceptance criteria: sitemap, policies and funnel analytics.';
  let sent;
  await executeFileWorker({access:'workspace-write'},{cwd,prompt:task,signal:AbortSignal.timeout(10000),
    skills:[{id:'ux',text:'Keep the keyboard focus visible.'}]},{model:async(_agent,{prompt})=>{
    sent=prompt;
    return {text:JSON.stringify({status:'completed',summary:'Checked context',changes:[],testFiles:[]})};
  }});
  assert.ok(Buffer.byteLength(JSON.stringify({event:'user',message:{content:sent}})+'\n')<=48*1024);
  assert.ok(sent.indexOf(task)<sent.indexOf('Файли з вмістом:'));
  assert.match(sent,/Keep the keyboard focus visible/);
  assert.match(sent,/export const sitemap = \[\];/);
  assert.match(sent,/Виявлені шляхи.*src\/fixture-0\.mjs/);
});
