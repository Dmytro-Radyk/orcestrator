import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
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
