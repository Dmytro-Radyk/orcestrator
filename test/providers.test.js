import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
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
        {type:'item.completed',item:{type:'agent_message',text:'Working on the plan…'}},
        {type:'item.completed',item:{type:'agent_message',text:JSON.stringify({args:process.argv.slice(2),prompt})}},
        {type:'turn.completed',usage:{input_tokens:3,output_tokens:5}}
      ];
      process.stdout.write(events.map(e=>JSON.stringify(e)).join('\\n'));
    });
  `);
  const result = await execute({provider:'codex',command:process.execPath,model:'test-model',access:'read-only',
    reasoningEffort:'high',outputSchema:'plan schema.json',ephemeral:true,ignoreUserConfig:true,windowsSandbox:'elevated'}, {...context(),cwd});
  const answer = JSON.parse(result.text);
  assert.equal(answer.prompt, context().prompt);
  for (const flag of ['--ephemeral','--ignore-user-config','--output-schema']) assert.ok(answer.args.includes(flag));
  assert.equal(answer.args[answer.args.indexOf('--sandbox')+1], 'read-only');
  assert.equal(answer.args[answer.args.indexOf('--output-schema')+1], 'plan schema.json');
  assert.ok(answer.args.includes('model_reasoning_effort="high"'));
  assert.ok(answer.args.includes('windows.sandbox="elevated"'));assert.ok(answer.args.includes('prefer_mxc'));
  assert.equal(answer.args.at(-1), '-');
  assert.equal(result.usage.output_tokens,5);
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
    await assert.rejects(execute(agent,{...context(),cwd,prompt:JSON.stringify({status,summary:'Work was not done',files:[],checks:[]})}),new RegExp(status));
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
});
