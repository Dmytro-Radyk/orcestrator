import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { normalizeReportChecks } from './execution-report.js';
import { skillGuidance } from './execution-context.js';

const OUTPUT_LIMIT = 4 * 1024 * 1024;
export const codexUsageLimitMessage=message=>/^(?:Codex:\s*)?You[’']ve hit your usage limit\b/i.test(message??'');

export function redactSecrets(text, limit = 2000) {
  return String(text ?? '')
    .replace(/\b(?:sk-(?:proj-|ant-)?[\w-]{8,}|gh[pousr]_[\w]+|github_pat_[\w]+|glpat-[\w-]{12,}|npm_[\w]{16,}|AIza[\w-]{20,}|AKIA[0-9A-Z]{16}|eyJ[\w-]+\.[\w-]+\.[\w-]+)\b/g, '[redacted]')
    .replace(/\b(Bearer\s+)\S+/gi, '$1[redacted]')
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:)[^@\s/]+@/gi, '$1[redacted]@')
    .replace(/(["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|secret)["']?\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi, '$1[redacted]')
    .slice(0, limit);
}

function codexFailure(text) {
  const events=text.split(/\r?\n/).flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}});
  const failed=events.findLast(e=>e.type==='turn.failed')??events.findLast(e=>e.type==='error');
  if(!failed)return null;
  let message=failed.error?.message??failed.message??'turn failed',code=failed.error?.code;
  // Some CLI versions encode the provider error as JSON inside the message.
  try{const nested=JSON.parse(message);message=nested.error?.message??nested.message??message;code=nested.error?.code??code;}catch{/* plain diagnostic */}
  const safe=redactSecrets(message, 2000);
  if(code==='usage_limit_reached'||codexUsageLimitMessage(message)){
    return Object.assign(new Error('Codex повідомив про вичерпання квоти підписки'),{
      code:'MODEL_ACCESS_BLOCKED',decisionCode:'quota_exhausted'
    });
  }
  return Object.assign(new Error(`Codex: ${safe}`),code==='invalid_json_schema'?{code:'EXECUTION_SCHEMA_INVALID'}:{});
}

export function subscriptionEnvironment(env=process.env) {
  return Object.fromEntries(Object.entries(env).filter(([key])=>/^(?:path|pathext|systemroot|windir|comspec|temp|tmp|localappdata|appdata|programfiles|programfiles\(x86\)|programdata|userprofile|home|codex_home|lang|lc_all)$/i.test(key)));
}

export function terminate(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    killer.on('error', () => { try { child.kill(); } catch {} });
    killer.on('exit', code => { if (code !== 0) { try { child.kill(); } catch {} } });
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
  }
}

export function runProcess(command, args, { prompt, cwd, signal, onLine, env }) {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    // No shell interpolation. On Windows use native .exe or node.exe + script, not .cmd wrappers.
    const child = spawn(command, args, { cwd, ...(env?{env}:{}), shell: false, windowsHide: true,
      detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', pending = '', failure, settled = false, closeGrace;
    const finish = code => {
      if (settled) return;
      settled = true;
      clearTimeout(closeGrace);
      signal?.removeEventListener('abort', abort);
      if (onLine && pending && !failure) { try { onLine(pending); } catch(error) { failure ??= error; } }
      if (failure) reject(failure);
      else if (code !== 0) {
        const error = new Error(`CLI exited with code ${code}: ${redactSecrets(stderr.slice(-8192), 2000)}`);
        error.stdout = stdout; error.exitCode = code; reject(error);
      } else resolve(stdout.trim());
    };
    const armGrace = (code = 1) => {
      if (settled || closeGrace) return;
      closeGrace = setTimeout(() => {
        child.stdout?.destroy(); child.stderr?.destroy(); child.stdin?.destroy();
        finish(code);
      }, 1500);
      closeGrace.unref?.();
    };
    const abort = () => { failure ??= signal.reason ?? new Error('Cancelled'); if (child.pid) terminate(child); armGrace(1); };
    signal?.addEventListener('abort', abort, { once: true });
    const capture = target => chunk => {
      if (failure || settled) return;
      if (target === 'out') {
        stdout += chunk;
        if (onLine) { pending += chunk; let end; while ((end=pending.indexOf('\n'))>=0) { const line=pending.slice(0,end); pending=pending.slice(end+1); try { onLine(line); } catch(error) { failure ??= error; terminate(child); armGrace(1); break; } } }
      } else stderr += chunk;
      if (stdout.length + stderr.length > OUTPUT_LIMIT && !failure) {
        failure = new Error('CLI output limit exceeded'); terminate(child); armGrace(1);
      }
    };
    child.stdout.setEncoding('utf8').on('data', capture('out'));
    child.stderr.setEncoding('utf8').on('data', capture('err'));
    child.on('error', error => { failure ??= error; finish(1); });
    child.stdin.on('error', () => {});
    child.on('exit', code => { armGrace(code ?? 1); });
    child.on('close', code => { finish(code ?? 1); });
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

export async function execute(agent, { prompt, cwd, signal, maxOutputTokens, onEvent,canDelegate,skills,hooks,mcpServers=[] }) {
  if (agent.provider === 'demo') {
    await delay(30, undefined, { signal });
    return { text: `[DEMO — no model called] ${agent.name ?? agent.id}: ${prompt.slice(0, 180)}`, usage: null };
  }
  if (['responses', 'chat'].includes(agent.provider)) return api(agent, prompt, signal, maxOutputTokens);
  let command, args;
  if (agent.provider === 'codex') {
    command = agent.command ?? 'codex';
    const extensions=mcpServers.flatMap(({id,url,tools,timeoutSeconds})=>{
      if(!/^[a-zA-Z0-9_-]{1,64}$/.test(id))throw new Error('Invalid MCP server identifier');
      return [
        '-c',`mcp_servers.${id}.url=${JSON.stringify(url)}`,
        '-c',`mcp_servers.${id}.enabled_tools=${JSON.stringify(tools)}`,
        ...(Number.isSafeInteger(timeoutSeconds)&&timeoutSeconds>0?['-c',`mcp_servers.${id}.tool_timeout_sec=${timeoutSeconds}`]:[])
      ];
    });
    args = ['exec', '--json', '--sandbox', agent.access ?? 'read-only', '--skip-git-repo-check', '--color', 'never',
      ...(agent.subscriptionOnly?['-c','forced_login_method="chatgpt"','-c','model_provider="openai"']:[]),
      ...(agent.model ? ['--model', agent.model] : []),
      ...(agent.reasoningEffort ? ['-c', `model_reasoning_effort=${JSON.stringify(agent.reasoningEffort)}`] : []),
      ...(agent.outputSchema ? ['--output-schema', agent.outputSchema] : []),
      ...(agent.ephemeral ? ['--ephemeral'] : []),
      ...(agent.ignoreUserConfig||agent.subscriptionOnly ? ['--ignore-user-config'] : []),
      ...(agent.windowsSandbox ? ['-c', `windows.sandbox=${JSON.stringify(agent.windowsSandbox)}`, '--enable', 'prefer_mxc'] : []), ...extensions, '-'];
    prompt+=skillGuidance(skills,hooks);
  } else if (agent.provider === 'claude') {
    command = agent.command ?? 'claude';
    args = ['-p', '--output-format', 'json', '--tools', agent.access === 'workspace-write' ? 'Read,Glob,Grep,Edit,Write' : 'Read,Glob,Grep',
      '--allowedTools', agent.access === 'workspace-write' ? 'Read,Glob,Grep,Edit,Write' : 'Read,Glob,Grep', ...(agent.model ? ['--model', agent.model] : [])];
  } else { command = agent.command; args = agent.args; }
  let progressCount = 0;
  const onLine = agent.provider === 'codex' && onEvent ? line => {
    let event; try { event=JSON.parse(line); } catch { return; }
    const item=event.item;
    if (!item || !['item.started','item.completed'].includes(event.type) || progressCount++ >= 100) return;
    let message;
    if(item.type==='command_execution') message=`${event.type==='item.started'?'Команда':'Результат команди'}: ${item.command}\n${item.aggregated_output??''}${item.exit_code!=null?`\nExit: ${item.exit_code}`:''}`;
    else if(item.type==='file_change') message=`Файли: ${JSON.stringify(item.changes??[])}`;
    else if(item.type==='mcp_tool_call'&&event.type==='item.completed') message=`MCP: ${item.server} / ${item.tool} · ${item.status==='completed'?'виконано':'помилка'}`;
    else if(item.type==='agent_message') message=item.text;
    if(message) onEvent({kind:item.type,message:redactSecrets(message, 8000)});
  } : undefined;
  let text;
  try {
    text=await runProcess(command, args, { prompt, cwd, signal, onLine,...(agent.provider==='codex'&&agent.subscriptionOnly?{env:subscriptionEnvironment()}:{} ) });
  } catch(error) {
    if(agent.provider==='codex'&&error.exitCode!==undefined) {
      const diagnostic=codexFailure(error.stdout??'');
      if(diagnostic){diagnostic.exitCode=error.exitCode;throw diagnostic;}
    }
    throw error;
  }
  if (agent.provider === 'codex') {
    const events = text.split(/\r?\n/).flatMap(line => { if (!line.trim()) return []; try { return [JSON.parse(line)]; } catch { return []; } });
    const failed = codexFailure(text);
    if (failed) throw failed;
    const answer = events.findLast(e => e.type === 'item.completed' && e.item?.type === 'agent_message')?.item.text;
    if (!answer) throw new Error('Codex returned no agent message');
    const usage = events.findLast(e => e.type === 'turn.completed')?.usage ?? null;
    if(agent.executionReport) {
      const report=JSON.parse(answer);
      if(report.status==='delegated') {
        if(!canDelegate||!Array.isArray(report.subtasks)||!report.subtasks.length||report.files?.length||report.checks?.length)throw new Error('Недопустимий звіт делегування');
        return {text:answer,delegation:report.subtasks,report,usage};
      }
      if(!['completed','blocked','failed'].includes(report.status)||typeof report.summary!=='string'||!Array.isArray(report.files)||!Array.isArray(report.checks))throw new Error('Codex повернув некоректний звіт виконання');
      report.checks=normalizeReportChecks(report.checks);
      if(report.status!=='completed'||report.checks.some(c=>c.required!==false&&c.status!=='passed')) {
        const failures=report.checks.filter(c=>c.required!==false&&c.status!=='passed');
        const detail=report.status==='completed'?`Не пройдено обов'язкову перевірку: ${failures.map(c=>`${c.command}: ${c.status} — ${c.details}`).join('\n')}`:report.summary;
        const error=new Error(`Codex ${report.status==='completed'?'blocked':report.status}: ${detail}`);
        error.code=report.status==='blocked'?'AGENT_BLOCKED':report.checks.some(c=>c.required!==false&&c.status==='not_run')?'CHECKS_BLOCKED':'WORKER_FAILED';
        error.report=report;error.usage=usage;throw error;
      }
      return {text:`${report.summary}\n\nФайли: ${report.files.join(', ')||'без змін'}\n${report.checks.map(c=>`${c.command}: ${c.status}\n${c.details}`).join('\n')}`,report,usage};
    }
    return { text: answer, usage };
  }
  if (agent.provider === 'claude') {
    const result = JSON.parse(text);
    if (result.is_error || !result.result) throw new Error('Claude returned an error or empty result');
    return { text: result.result, usage: result.usage ?? null };
  }
  if (!text) throw new Error('CLI returned no output');
  return { text, usage: null };
}
