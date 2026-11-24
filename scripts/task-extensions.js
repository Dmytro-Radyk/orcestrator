import { lstat, readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { loopback,serviceLauncher } from './connection-recovery.js';

const idPattern = /^[a-z][a-z0-9_-]{0,63}$/;
const toolPattern = /^[A-Za-z0-9_.-]{1,100}$/;
const defaultSkills = [{
  id: 'ui-ux-pro-max',
  terms: ['frontend', 'ui', 'ux', 'accessibility', 'інтерфейс', 'дизайн', 'адаптивність', 'доступність', 'вітрина']
}];

const tokens = value => String(value ?? '').normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
const searchable = values => values.map(value => ` ${tokens(value).join(' ')} `);
const validTerms = terms => Array.isArray(terms) && terms.length > 0 && terms.length <= 30 &&
  terms.every(term => typeof term === 'string' && term.length <= 100 && tokens(term).length);
function matchScore(terms, fields) {
  return terms.reduce((score, term) => {
    const query = ` ${tokens(term).join(' ')} `;
    return score + (fields.some(field => field.includes(query)) ? query.trim().split(' ').length : 0);
  }, 0);
}

async function readSmallFile(path, limit) {
  const info = await lstat(path);
  if (!info.isFile() || info.size > limit) throw Error('Неприпустимий файл розширення');
  const content = await readFile(path, 'utf8');
  if (Buffer.byteLength(content) > limit) throw Error('Завеликий файл розширення');
  return content.replace(/^\uFEFF/, '');
}

const samePath=(a,b)=>process.platform==='win32'?String(a).toLowerCase()===String(b).toLowerCase():a===b;
function contained(base, path) {
  const a = process.platform === 'win32' ? resolve(base).toLowerCase() : resolve(base);
  const b = process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
  const child = relative(a, b);
  return child && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

function connectionUrl(value) {
  const url=typeof value==='string'&&value.length<=512?URL.parse(value):null;
  if(!url||url.username||url.password||url.search||url.hash||
    (url.protocol!=='https:'&&(url.protocol!=='http:'||!loopback(url))))throw Error('Потрібна HTTPS або локальна HTTP-адреса без облікових даних.');
  return url.href;
}

function readServer(entry) {
  if (typeof entry?.id !== 'string' || !idPattern.test(entry.id) || !validTerms(entry.terms) ||
    !Array.isArray(entry.tools) || !entry.tools.length || entry.tools.length > 20 ||
    !entry.tools.every(tool => typeof tool === 'string' && toolPattern.test(tool))) {
    throw Error('Для кожного MCP-сервера потрібні id, terms і список дозволених tools');
  }
  const url=connectionUrl(entry.url);
  const fallback=entry.fallback??[];
  if(!Array.isArray(fallback)||fallback.length>4||!fallback.every(id=>typeof id==='string'&&idPattern.test(id)&&id!==entry.id))
    throw Error('fallback має містити ідентифікатори налаштованих MCP-серверів.');
  return {id:entry.id,terms:entry.terms,url,tools:[...new Set(entry.tools)],kind:'mcp',
    ...(fallback.length?{fallback}:{}),start:serviceLauncher(entry.start,url)};
}

function readService(entry) {
  if(typeof entry?.id!=='string'||!idPattern.test(entry.id)||!validTerms(entry.terms))
    throw Error('Для API потрібні ідентифікатор, умови підбору та адреса перевірки.');
  const url=connectionUrl(entry.healthUrl);
  return {id:entry.id,terms:entry.terms,url,kind:'api',start:serviceLauncher(entry.start,url)};
}

async function workspaceChecks(cwd, task) {
  if (!cwd) return [];
  const manifest = await readSmallFile(join(cwd,'package.json'),65536).then(JSON.parse).catch(()=>null);
  if (!manifest?.scripts || typeof manifest.scripts !== 'object') return [];
  const manager = /^(npm|pnpm|yarn|bun)@/.exec(manifest.packageManager ?? '')?.[1] ?? 'npm';
  const words = new Set(tokens([task.title,...(task.skills??[])].join(' ')));
  const checks = Object.keys(manifest.scripts).filter(name =>
    /^[a-zA-Z][a-zA-Z0-9_:-]{0,63}$/.test(name) && /^(test|check|lint|build|verify|typecheck)(?::|$)/i.test(name)
  ).map(name=>({name,score:tokens(name).filter(word=>words.has(word)).length + Number(!name.includes(':'))}))
    .sort((a,b)=>b.score-a.score).slice(0,6);
  return checks.length ? [{id:'workspace-checks',text:'Наявні команди проєкту: '+checks.map(({name})=>`${manager} run ${name}`).join(', ')+
    '. Запускай лише доречні до задачі команди, перевір їхній вміст перед виконанням. Якщо середовище блокує обов’язкову перевірку, збережи результат і поверни точну команду та причину для локального верифікатора.'}] : [];
}

export function createTaskExtensions(configPath, { codexHome = process.env.CODEX_HOME || join(homedir(), '.codex'),ensureConnection } = {}) {
  const home = resolve(codexHome);
  const roots = [join(home, 'skills'), join(home, 'plugins', 'cache')];
  async function settings() {
    const config = await readSmallFile(configPath, 32768).then(JSON.parse).catch(error => {
      if (error.code === 'ENOENT') return {};
      throw error;
    });
    const skills = config.skills ?? defaultSkills;
    const servers = config.mcpServers ?? [];
    const services = config.services ?? [];
    if (!Array.isArray(skills) || skills.length > 32 || !Array.isArray(servers) || servers.length > 12||
      !Array.isArray(services)||services.length>12) {
      throw Error('Некоректний список скілів або MCP-серверів');
    }
    for (const entry of skills) {
      if (typeof entry?.id !== 'string' || !idPattern.test(entry.id) || !validTerms(entry.terms) ||
        (entry.path !== undefined && (typeof entry.path !== 'string' || !entry.path || isAbsolute(entry.path)))) {
        throw Error('Для скіла потрібні id та terms, шлях має бути відносним до CODEX_HOME');
      }
    }
    const mcp = servers.map(readServer);
    const apis=services.map(readService);
    if (new Set(skills.map(skill => skill.id)).size !== skills.length ||
      new Set(mcp.map(server => server.id)).size !== mcp.length||new Set(apis.map(entry=>entry.id)).size!==apis.length) {
      throw Error('Ідентифікатори розширень мають бути унікальними');
    }
    return { skills, mcp, apis };
  }

  async function skillText(entry, limit) {
    const requested = resolve(home, entry.path ?? join('skills', entry.id, 'SKILL.md'));
    const root = roots.find(candidate => contained(candidate, requested));
    if (!root || basename(requested) !== 'SKILL.md') return '';
    const [path, realRoot] = await Promise.all([realpath(requested), realpath(root)]);
    if (!samePath(realRoot, root) || !samePath(path, requested) || !contained(realRoot, path)) return '';
    const text = (await readSmallFile(path, 65536)).replace(/^---\s*\r?\n[\s\S]*?\r?\n---\s*\r?\n/, '').trim();
    if (text.length <= limit) return text;
    const end = text.lastIndexOf('\n', limit);
    return text.slice(0, end > 0 ? end : limit).trim();
  }

  return async (task, agent, {cwd,signal}={}) => {
    if (!['codex', 'antigravity', 'opencode'].includes(agent.provider)) return {};
    const [hooks, config] = await Promise.all([workspaceChecks(cwd,task), settings().catch(()=>null)]);
    signal?.throwIfAborted();
    if(!config)return {...(hooks.length?{hooks}:{}), warning:'Некоректний task-extensions.json. Скіли та MCP для цього виклику вимкнено.'};
    const fields = searchable([task.title, ...(task.skills ?? []), String(task.prompt ?? '').slice(0, 1800)]);
    const ranked = entries => entries.map(entry => ({entry, score:matchScore(entry.terms, fields)}))
      .filter(({score}) => score > 0).sort((a,b) => b.score - a.score);
    const skills = [];
    const limit = agent.fileWorker ? 1600 : 4600;
    for (const {entry} of ranked(config.skills)) {
      const text = await skillText(entry, limit).catch(() => '');
      if (text) skills.push({id:entry.id, text});
      if (skills.length === 1) break;
    }
    // File workers continue using their existing text-only protocol.
    const selected=agent.provider==='codex'?ranked(config.mcp).slice(0,2):[];
    const mcpServers=[],connections=[];
    if(!ensureConnection){
      for(const {entry:{id,url,tools}} of selected)mcpServers.push({id,url,tools});
    }else{
      const prepared=await Promise.all(selected.map(async({entry})=>{
        const first=await ensureConnection(entry);
        if(first.state==='ready')return {entry,result:first};
        for(const id of entry.fallback??[]){
          const fallback=config.mcp.find(server=>server.id===id&&entry.tools.every(tool=>server.tools.includes(tool)));
          if(!fallback)continue;
          const result=await ensureConnection(fallback);
          if(result.state==='ready')return {entry:{...entry,url:fallback.url},result,replacement:id};
        }
        return {entry,result:first};
      }));
      for(const {entry,result,replacement} of prepared){
        const {id,url,tools}=entry;
        if(['ready','auth'].includes(result.state)&&!mcpServers.some(server=>server.url===url))
          mcpServers.push({id:replacement??id,url,tools});
        if(replacement||result.started||result.state!=='ready')
          connections.push({id,kind:'mcp',state:result.state,started:result.started===true,replacement});
        if(replacement||result.started||result.state!=='ready')hooks.push({id:`connection-${id}`,text:
          replacement?`MCP ${id} відновлено через налаштований резерв ${replacement}.`:
            result.started&&result.state==='ready'?`MCP ${id} запущено локально.`:
            result.state==='auth'?`MCP ${id} потребує штатної авторизації клієнта.`:`MCP ${id} недоступний. Працюй із доступними інструментами.`});
      }
      signal?.throwIfAborted();
      const apis=await Promise.all(ranked(config.apis).slice(0,3).map(async({entry})=>({entry,result:await ensureConnection(entry)})));
      for(const {entry,result} of apis){
        if(result.started||result.state!=='ready')connections.push({id:entry.id,kind:'api',state:result.state,started:result.started===true});
        hooks.push({id:`service-${entry.id}`,text:result.state==='ready'?
          `API ${entry.id} відповідає за адресою перевірки ${entry.url}.`:
          `API ${entry.id}: ${result.state==='auth'?'потрібна авторизація':'сервіс недоступний після перевірки'}.`});
      }
    }
    return {skills,mcpServers,...(hooks.length?{hooks}:{}),...(connections.length?{connections}:{})};
  };
}
