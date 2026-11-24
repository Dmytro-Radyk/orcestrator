import { createHash } from 'node:crypto';
import { mkdir, realpath, readdir, readFile, stat } from 'node:fs/promises';
import { resolve, relative, isAbsolute, join, sep, dirname } from 'node:path';
import { unsafePathSegment } from '../../src/workspaces.js';

export const samePath = (a, b) => process.platform === 'win32'
  ? String(a).toLowerCase() === String(b).toLowerCase()
  : a === b;

export const inside = (root, path) => {
  const a = process.platform === 'win32' ? resolve(root).toLowerCase() : resolve(root);
  const b = process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
  const rel = relative(a, b);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

export const excluded = part => {
  const name = part.replace(/[. ]+$/, '');
  return unsafePathSegment(part) ||
    /^(?:\.git|\.env(?:\..*)?|node_modules|\.codex|\.gemini|\.agents|\.aws)$/i.test(name) ||
    /\.(?:pem|key|p12|pfx|db|sqlite(?:3|-wal|-shm)?)$/i.test(name);
};

export function executorConfig(env = process.env) {
  const model = env.ORCHESTRATOR_EXECUTOR_MODEL ?? 'gpt-6.1-sol';
  const optionalTimeout = key => {
    if (env[key] === undefined || env[key] === '') return null;
    const value = Number(env[key]);
    if (!Number.isInteger(value) || value < 10 || value > 3600000) throw Error(`${key}: очікується від 10 до 3600000 мс`);
    return value;
  };
  return {
    model,
    command: env.ORCHESTRATOR_EXECUTOR_COMMAND ?? env.ORCHESTRATOR_PLANNER_COMMAND ?? 'codex',
    reasoningEffort: env.ORCHESTRATOR_EXECUTOR_REASONING ?? 'auto',
    timeoutMs: optionalTimeout('ORCHESTRATOR_EXECUTOR_TIMEOUT_MS'),
    recoveryTimeoutMs: optionalTimeout('ORCHESTRATOR_RECOVERY_TIMEOUT_MS')
  };
}

export async function workspaceFiles(directory) {
  const result = [];
  let truncated = false;
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (excluded(entry.name) || entry.isSymbolicLink()) continue;
      if (result.length >= 2000) { truncated = true; return; }
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) {
        const info = await stat(path);
        const hash = info.size <= 1024 * 1024 ? createHash('sha256').update(await readFile(path)).digest('hex') : null;
        result.push({ path: relative(directory, path).replaceAll('\\', '/'), size: info.size, hash });
      }
    }
  }
  await walk(directory);
  if (truncated) Object.defineProperty(result, 'truncated', { value: true, enumerable: false });
  return result;
}

export async function localDirectory(path) {
  if (typeof path !== 'string' || path.length > 1024 || /[\x00-\x1f]/.test(path) ||
      !isAbsolute(path) || (process.platform === 'win32' && (!/^[A-Za-z]:[\\/]/.test(path) || path.slice(2).includes(':')))) {
    throw Error('Вкажіть абсолютний шлях до локальної папки');
  }
  const actual = await realpath(path);
  if (!(await stat(actual)).isDirectory()) throw Error('Шлях має вказувати на папку');
  return actual;
}

export async function listFolders(path) {
  if (!path) {
    const roots = process.platform === 'win32' ? Array.from('ABCDEFGHIJKLMNOPQRSTUVWXYZ', letter => letter + ':\\') : ['/'];
    const found = await Promise.all(roots.map(root => localDirectory(root).then(p => ({ name: root, path: p })).catch(() => null)));
    return { path: null, parent: null, folders: found.filter(Boolean) };
  }
  const actual = await localDirectory(path), entries = await readdir(actual, { withFileTypes: true });
  return {
    path: actual,
    parent: dirname(actual) === actual ? null : dirname(actual),
    folders: entries
      .filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && !excluded(entry.name) && !entry.name.startsWith('.'))
      .sort((a, b) => a.name.localeCompare(b.name, 'uk'))
      .map(entry => ({ name: entry.name, path: join(actual, entry.name) }))
  };
}

export async function resolveProjectWorkspacePath({ key, projectLocation, workspaces, workspaceManager }) {
  const chosen = projectLocation(key);
  if (chosen) return workspaceManager.assertBase(chosen, key);
  await mkdir(workspaces, { recursive: true });
  const base = await realpath(workspaces);
  const path = join(base, createHash('sha256').update(key).digest('hex').slice(0, 24));
  await mkdir(path, { recursive: true });
  const actual = await realpath(path);
  if (!inside(base, actual)) throw new Error('Робоча папка виходить за межі каталогу проєктів');
  return workspaceManager.assertBase(actual, key);
}

export async function readRunArtifactFile(workspaceManager, run, path) {
  if (!path || (process.platform === 'win32' && path.includes(':')) || path.split(/[\\/]/).some(excluded)) {
    throw new Error('Недоступний файл');
  }
  const base = await workspaceManager.assertBase(run.project.workspace, run.project.uiProjectId);
  let actual;
  try { actual = await realpath(resolve(base, path)); } catch { throw new Error('Файл не знайдено'); }
  if (!inside(base, actual)) throw new Error('Файл виходить за межі проєкту');
  if (relative(base, actual).split(/[\\/]/).some(excluded)) throw new Error('Недоступний файл');
  const info = await stat(actual);
  if (!info.isFile() || info.size > 1024 * 1024) throw new Error('Файл не є текстовим артефактом до 1 MB');
  const bytes = await readFile(actual);
  if (bytes.includes(0)) throw new Error('Бінарний файл: відкрийте у робочій папці');
  return { path, text: bytes.toString('utf8') };
}
