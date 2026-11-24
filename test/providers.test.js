import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execute, runProcess } from '../src/providers.js';

const context = () => ({ prompt: 'Hello $() `literal` Привіт', cwd: process.cwd(), signal: AbortSignal.timeout(5000), maxOutputTokens: 100 });

test('CLI passes prompt literally over stdin without a shell', async () => {
  const input = context();
  const output = await runProcess(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], input);
  assert.equal(output, input.prompt);
});

test('CLI failures and timeouts reject', async () => {
  await assert.rejects(runProcess(process.execPath, ['-e', 'process.exit(3)'], context()), /code 3/);
  await assert.rejects(runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { ...context(), signal: AbortSignal.timeout(100) }), /timeout|aborted/i);
});

for (const provider of ['responses', 'chat']) {
  test(`${provider} sends correct protocol and records usage`, async t => {
    let received;
    const server = createServer(async (req, res) => {
      let raw = ''; for await (const c of req) raw += c;
      received = { url: req.url, body: JSON.parse(raw) };
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(provider === 'responses'
        ? { output: [{ content: [{ type: 'output_text', text: 'answer' }] }], usage: { total_tokens: 7 } }
        : { choices: [{ message: { content: 'answer' } }], usage: { total_tokens: 7 } }));
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => { server.closeAllConnections(); server.close(); });
    const result = await execute({ provider, model: 'test', baseUrl: `http://127.0.0.1:${server.address().port}/v1` }, context());
    assert.equal(result.text, 'answer'); assert.equal(result.usage.total_tokens, 7);
    assert.equal(received.url, provider === 'responses' ? '/v1/responses' : '/v1/chat/completions');
    assert.equal(received.body.model, 'test');
  });
}

test('missing API key fails before any HTTP request', async () => {
  await assert.rejects(execute({ provider: 'responses', model: 'x', apiKeyEnv: 'ORCHESTRATOR_TEST_MISSING_KEY', baseUrl: 'http://127.0.0.1:1' }, context()), /Missing environment/);
});

test('Codex subprocess gets planning controls and returns final JSON without commentary', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'orcestrator-codex-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  // node.exe treats the first Codex argument, "exec", as this test-only script.
  await writeFile(join(cwd, 'exec'), `
    let prompt=''; process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => prompt+=chunk);
    process.stdin.on('end', () => {
      const events = [
        {type:'item.completed',item:{type:'mcp_tool_call',server:'project_docs',tool:'search',status:'completed',arguments:{private:'not in logs'}}},
        {type:'item.completed',item:{type:'agent_message',text:'Working on the plan…'}},
        {type:'item.completed',item:{type:'agent_message',text:JSON.stringify({args:process.argv.slice(2),prompt})}},
        {type:'turn.completed',usage:{input_tokens:3,output_tokens:5}}
      ];
      process.stdout.write(events.map(e=>JSON.stringify(e)).join('\\n'));
    });
  `);
  const result = await execute({provider:'codex',command:process.execPath,model:'test-model',access:'read-only',
    reasoningEffort:'high',outputSchema:'plan schema.json',ephemeral:true,ignoreUserConfig:true,windowsSandbox:'elevated',subscriptionOnly:true}, {...context(),cwd});
  const answer = JSON.parse(result.text);
  assert.equal(answer.prompt, context().prompt);
  for (const flag of ['--ephemeral','--ignore-user-config','--output-schema']) assert.ok(answer.args.includes(flag));
  assert.equal(answer.args[answer.args.indexOf('--sandbox')+1], 'read-only');
  assert.equal(answer.args[answer.args.indexOf('--output-schema')+1], 'plan schema.json');
  assert.ok(answer.args.includes('model_reasoning_effort="high"'));
  assert.ok(answer.args.includes('windows.sandbox="elevated"'));assert.ok(answer.args.includes('prefer_mxc'));
  assert.ok(answer.args.includes('forced_login_method="chatgpt"'));assert.ok(answer.args.includes('model_provider="openai"'));
  assert.equal(answer.args.filter(a=>a==='--ignore-user-config').length,1);
  assert.equal(answer.args.at(-1), '-');
  assert.equal(result.usage.output_tokens,5);
  const progress=[];
  const extended=JSON.parse((await execute({provider:'codex',command:process.execPath,ignoreUserConfig:true},
    {...context(),cwd,onEvent:event=>progress.push(event),skills:[{id:'ux',text:'Keep focus visible'}],
      mcpServers:[{id:'project_docs',url:'http://127.0.0.1:3000/mcp',tools:['search']}]})).text);
  assert.ok(extended.args.includes('--ignore-user-config'));
  assert.ok(extended.args.includes('mcp_servers.project_docs.url="http://127.0.0.1:3000/mcp"'));
  assert.ok(extended.args.includes('mcp_servers.project_docs.enabled_tools=["search"]'));
  assert.match(extended.prompt,/Keep focus visible/);
  assert.deepEqual(progress.find(event=>event.kind==='mcp_tool_call'),
    {kind:'mcp_tool_call',message:'MCP: project_docs / search · виконано'});
});

test('Codex execution reports reject blocked work and checks that did not pass',async t=>{
  const cwd=await mkdtemp(join(tmpdir(),'orcestrator-report-'));t.after(()=>rm(cwd,{recursive:true,force:true}));
  await writeFile(join(cwd,'exec'),`let data='';process.stdin.on('data',c=>data+=c);process.stdin.on('end',()=>{
    for(const event of [{type:'item.started',item:{type:'command_execution',command:'node --test'}},
      {type:'item.completed',item:{type:'agent_message',text:data}},{type:'turn.completed',usage:{input_tokens:2,output_tokens:3}}])
      process.stdout.write(JSON.stringify(event)+'\\n');
  });`);
  const agent={provider:'codex',command:process.execPath,executionReport:true};
  for(const status of ['blocked','failed']) {
    await assert.rejects(execute(agent,{...context(),cwd,prompt:JSON.stringify({status,summary:'Work was not done',files:[],checks:[]})}),error=>{
      assert.match(error.message,new RegExp(status));assert.equal(error.report.status,status);
      assert.equal(error.code,status==='blocked'?'AGENT_BLOCKED':'WORKER_FAILED');assert.equal(error.usage.output_tokens,3);return true;
    });
  }
  await assert.rejects(execute(agent,{...context(),cwd,prompt:JSON.stringify({status:'completed',summary:'No tests',files:[],checks:[{command:'node --test',status:'not_run',details:'permission denied'}]})}),/blocked/);
  const progress=[];
  const result=await execute(agent,{...context(),cwd,onEvent:e=>progress.push(e),prompt:JSON.stringify({status:'completed',summary:'Implemented',files:['a.mjs'],checks:[{command:'node --test',status:'passed',details:'2 passed'}]})});
  assert.equal(result.report.status,'completed');assert.equal(result.usage.output_tokens,3);
  assert.ok(progress.some(e=>e.kind==='command_execution'&&e.message.includes('node --test')));
  const diagnostic=await execute(agent,{...context(),cwd,prompt:JSON.stringify({status:'completed',summary:'Required tests passed; optional Git unavailable',files:[],checks:[
    {command:'node --test',status:'passed',required:true,details:'passed'},
    {command:'git status',status:'failed',required:false,details:'not a Git workspace'}]})});
  assert.equal(diagnostic.report.status,'completed');
  const negative=await execute(agent,{...context(),cwd,prompt:JSON.stringify({status:'completed',summary:'Ready for development; commerce remains off',files:[],checks:[
    {command:'node check-ready.mjs --require-ready',status:'failed',required:true,details:'Expected refusal while stock is empty',kind:'exit_code',expectedExitCode:1,actualExitCode:1}]})});
  assert.equal(negative.report.checks[0].status,'passed');
  await assert.rejects(execute(agent,{...context(),cwd,prompt:JSON.stringify({status:'completed',summary:'Model claimed success',files:[],checks:[
    {command:'node broken-test.mjs',status:'passed',required:true,details:'Unexpected failure',kind:'exit_code',expectedExitCode:0,actualExitCode:1}]})}),error=>{
      assert.equal(error.code,'WORKER_FAILED');assert.match(error.message,/node broken-test.mjs/);return true;
    });
});

test('Codex execution schema requires every property, including nested subagent assignments',async()=>{
  const schema=JSON.parse(await readFile(new URL('../scripts/schemas/execution.json',import.meta.url),'utf8'));
  function strict(node){
    if(node.type==='object'){
      assert.equal(node.additionalProperties,false);
      assert.deepEqual([...node.required].sort(),Object.keys(node.properties).sort());
      Object.values(node.properties).forEach(strict);
    }
    if(node.items)strict(node.items);
  }
  strict(schema);assert.ok(schema.required.includes('subtasks'));
});

test('Codex nonzero exit exposes the final structured failure without leaking stdout or credentials',async t=>{
  const cwd=await mkdtemp(join(tmpdir(),'orcestrator-error-'));t.after(()=>rm(cwd,{recursive:true,force:true}));
  await writeFile(join(cwd,'exec'),`process.stdin.resume();process.stdin.on('end',()=>{
    for(const event of [
      {type:'item.completed',item:{type:'agent_message',text:'Private response must not become an error'}},
      {type:'error',message:'Retrying connection'},
      {type:'turn.failed',error:{message:JSON.stringify({error:{code:'invalid_json_schema',message:'Invalid schema: missing subtasks. api_key=fixture-secret Bearer fixture-bearer'}})}}
    ])process.stdout.write(JSON.stringify(event)+'\\n');
    process.exitCode=1;
  });`);
  await assert.rejects(execute({provider:'codex',command:process.execPath},{...context(),cwd}),error=>{
    assert.match(error.message,/Invalid schema: missing subtasks/);
    assert.doesNotMatch(error.message,/Private response|fixture-secret|fixture-bearer|Retrying/);
    assert.equal(error.exitCode,1);assert.equal(error.code,'EXECUTION_SCHEMA_INVALID');assert.equal(error.stdout,undefined);return true;
  });
});

test('Codex usage exhaustion is an access block eligible for a fresh entitlement check',async t=>{
  const cwd=await mkdtemp(join(tmpdir(),'orcestrator-quota-'));t.after(()=>rm(cwd,{recursive:true,force:true}));
  await writeFile(join(cwd,'exec'),`process.stdin.resume();process.stdin.on('end',()=>{
    console.log(JSON.stringify({type:'turn.failed',error:{message:'You’ve hit your usage limit. Visit billing to purchase credits.'}}));
    process.exitCode=1;
  });`);
  await assert.rejects(execute({provider:'codex',command:process.execPath},{...context(),cwd}),error=>
    error.code==='MODEL_ACCESS_BLOCKED'&&error.decisionCode==='quota_exhausted'&&!error.message.includes('purchase'));
});
