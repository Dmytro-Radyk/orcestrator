import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const OUTPUT_LIMIT = 4 * 1024 * 1024;

function terminate(child) {
  if (process.platform === 'win32') {
    const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    killer.on('error', () => child.kill());
    killer.on('exit', code => { if (code !== 0) child.kill(); });
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
  }
}

export function runProcess(command, args, { prompt, cwd, signal }) {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    // No shell interpolation. On Windows use native .exe or node.exe + script, not .cmd wrappers.
    const child = spawn(command, args, { cwd, shell: false, windowsHide: true,
      detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', failure;
    const abort = () => { failure = signal.reason ?? new Error('Cancelled'); if (child.pid) terminate(child); };
    signal.addEventListener('abort', abort, { once: true });
    const capture = target => chunk => {
      if (target === 'out') stdout += chunk; else stderr += chunk;
      if (stdout.length + stderr.length > OUTPUT_LIMIT && !failure) {
        failure = new Error('CLI output limit exceeded'); terminate(child);
      }
    };
    child.stdout.setEncoding('utf8').on('data', capture('out'));
    child.stderr.setEncoding('utf8').on('data', capture('err'));
    child.on('error', error => { failure = error; });
    child.stdin.on('error', () => {});
    child.on('close', code => {
      signal.removeEventListener('abort', abort);
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`CLI exited with code ${code}: ${stderr.slice(-2000)}`));
      else resolve(stdout.trim());
    });
    child.stdin.end(prompt);
  });
}

async function api(agent, prompt, signal, maxOutputTokens) {
  const responses = agent.provider === 'responses';
  const key = agent.apiKeyEnv ? process.env[agent.apiKeyEnv] : undefined;
  if (agent.apiKeyEnv && !key) throw new Error(`Missing environment variable: ${agent.apiKeyEnv}`);
  const url = `${agent.baseUrl.replace(/\/$/, '')}/${responses ? 'responses' : 'chat/completions'}`;
  const body = responses ? { model: agent.model, input: prompt, max_output_tokens: maxOutputTokens, store: false }
    : { model: agent.model, messages: [{ role: 'user', content: prompt }], max_tokens: maxOutputTokens, stream: false };
  const response = await fetch(url, { method: 'POST', signal, redirect: 'error',
    headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`Provider HTTP ${response.status}`);
  let raw = '';
  const decoder = new TextDecoder();
  for await (const chunk of response.body) {
    raw += decoder.decode(chunk, { stream: true });
    if (raw.length > OUTPUT_LIMIT) throw new Error('API output limit exceeded');
  }
  raw += decoder.decode();
  const data = JSON.parse(raw);
  if (data.error || data.status === 'failed' || data.status === 'incomplete') throw new Error(`Provider response ${data.status ?? 'error'}`);
  const text = responses ? (data.output ?? []).flatMap(x => x.content ?? []).filter(x => x.type === 'output_text').map(x => x.text).join('\n')
    : data.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || !text.trim()) throw new Error('Provider returned no text');
  return { text, usage: data.usage ?? null };
}

export async function execute(agent, { prompt, cwd, signal, maxOutputTokens }) {
  if (agent.provider === 'demo') {
    await delay(30, undefined, { signal });
    return { text: `[DEMO — no model called] ${agent.name ?? agent.id}: ${prompt.slice(0, 180)}`, usage: null };
  }
  if (['responses', 'chat'].includes(agent.provider)) return api(agent, prompt, signal, maxOutputTokens);
  let command, args;
  if (agent.provider === 'codex') {
    command = agent.command ?? 'codex';
    args = ['exec', '--json', '--sandbox', agent.access ?? 'read-only', '--skip-git-repo-check', '--color', 'never', ...(agent.model ? ['--model', agent.model] : []), '-'];
  } else if (agent.provider === 'claude') {
    command = agent.command ?? 'claude';
    args = ['-p', '--output-format', 'json', '--tools', agent.access === 'workspace-write' ? 'Read,Glob,Grep,Edit,Write' : 'Read,Glob,Grep',
      '--allowedTools', agent.access === 'workspace-write' ? 'Read,Glob,Grep,Edit,Write' : 'Read,Glob,Grep', ...(agent.model ? ['--model', agent.model] : [])];
  } else { command = agent.command; args = agent.args; }
  const text = await runProcess(command, args, { prompt, cwd, signal });
  if (agent.provider === 'codex') {
    const events = text.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
    if (events.some(e => e.type === 'turn.failed' || e.type === 'error')) throw new Error('Codex turn failed');
    const answer = events.filter(e => e.type === 'item.completed' && e.item?.type === 'agent_message').map(e => e.item.text).join('\n');
    if (!answer) throw new Error('Codex returned no agent message');
    return { text: answer, usage: events.findLast(e => e.type === 'turn.completed')?.usage ?? null };
  }
  if (agent.provider === 'claude') {
    const result = JSON.parse(text);
    if (result.is_error || !result.result) throw new Error('Claude returned an error or empty result');
    return { text: result.result, usage: result.usage ?? null };
  }
  if (!text) throw new Error('CLI returned no output');
  return { text, usage: null };
}
