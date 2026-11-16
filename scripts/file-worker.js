import { readdir,lstat,readFile,mkdir,writeFile,unlink,realpath } from 'node:fs/promises';
import { resolve,relative,isAbsolute,join,dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { runProcess } from '../src/providers.js';
import { executeOpenCode,OPENCODE_HOME } from './opencode-service.js';

const hash=b=>createHash('sha256').update(b).digest('hex');
const denied=n=>/^(?:\.git|\.env(?:\..*)?|\.aws|\.codex|\.gemini|\.agents|node_modules)$/i.test(n)||/\.(?:pem|key|p12|pfx|db|sqlite|exe|dll)$/i.test(n);
export function workerPath(root,path) {
  if(typeof path!=='string'||!path||path.length>240||/[\\\x00-\x1f:]/.test(path)||isAbsolute(path)||path.split('/').some(n=>!n||n==='.'||n==='..'||denied(n)))throw Error('Недопустимий шлях зміни');
  const actual=resolve(root,path),rel=relative(root,actual);if(!rel||rel.startsWith('..')||isAbsolute(rel))throw Error('Файл виходить за межі worktree');return actual;
}
async function safeParents(root,path) {
  let current=resolve(root);for(const part of relative(root,path).split(/[\\/]/)) {
    current=join(current,part);const info=await lstat(current).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
    if(info?.isSymbolicLink())throw Error('Symlink у шляху зміни заборонено');
  }
}
export async function workerContext(root) {
  const files=[];let bytes=0;
  async function walk(dir) {for(const entry of await readdir(dir,{withFileTypes:true})) {
    if(denied(entry.name)||entry.isSymbolicLink())continue;const path=join(dir,entry.name);
    if(entry.isDirectory()){if(files.length<150)await walk(path);continue;}
    if(!entry.isFile()||files.length>=150)continue;
    const info=await lstat(path);if(info.size>128*1024||bytes+info.size>256*1024)continue;
    const value=await readFile(path);if(value.includes(0))continue;bytes+=value.length;
    files.push({path:relative(root,path).replaceAll('\\','/'),baseHash:hash(value),content:value.toString('utf8')});
  }}await walk(root);return files;
}
export async function applyWorkerChanges(root,changes) {
  if(!Array.isArray(changes)||changes.length>40)throw Error('Ліміт змін файлів перевищено');
  const seen=new Set(),operations=[];let bytes=0;
  for(const item of changes) {
    const path=workerPath(root,item.path);if(seen.has(path))throw Error('Повторна зміна файлу');seen.add(path);
    await safeParents(root,path);const info=await lstat(path).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
    if(info&&!info.isFile())throw Error('Змінювати можна лише звичайні файли');
    const before=info?hash(await readFile(path)):null;
    if(item.baseHash!==before)throw Error('baseHash файлу змінився або не підтверджений');
    if(item.delete===true){if(!info)throw Error('Видалення неіснуючого файлу');}
    else if(typeof item.content!=='string'||item.content.includes('\0')||(bytes+=Buffer.byteLength(item.content))>1024*1024)throw Error('Некоректний або завеликий вміст зміни');
    operations.push({path,item});
  }
  for(const {path,item} of operations){if(item.delete)await unlink(path);else{await mkdir(dirname(path),{recursive:true});await writeFile(path,item.content);}}
  return changes.map(c=>c.path);
}

export async function sandboxChecks(cwd,testFiles,{signal,access='workspace-write',command=process.env.ORCHESTRATOR_SANDBOX_COMMAND??process.env.ORCHESTRATOR_EXECUTOR_COMMAND??process.env.ORCHESTRATOR_PLANNER_COMMAND??'codex',run=runProcess}={}) {
  const root=await realpath(cwd);const tests=[];
  for(const path of testFiles){const actual=workerPath(root,path);await safeParents(root,actual);if(!/\.(?:[cm]?js|ts)$/.test(path)||!(await lstat(actual)).isFile())throw Error('Недопустимий файл перевірки');tests.push(path);}
  const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>/^(?:path|pathext|systemroot|windir|comspec|temp|tmp|localappdata|appdata|programfiles|programfiles\(x86\)|programdata|userprofile|lang|lc_all)$/i.test(key)));
  const writable=access==='workspace-write';
  const profile=`permissions.orcestrator_check={extends=":${writable?'workspace':'read-only'}",filesystem={":root"="deny",":minimal"="read",":workspace_roots"={"."="${writable?'write':'read'}"}},network={enabled=false}}`;
  const args=['sandbox','-P','orcestrator_check','-C',root,'--include-managed-config','-c',profile,
    ...(process.platform==='win32'?['--enable','prefer_mxc','-c','windows.sandbox="elevated"']:[]),'--',process.execPath,
    '--permission',`--allow-fs-read=${root}`,...(writable?[`--allow-fs-write=${root}`]:[]),'--preserve-symlinks','--preserve-symlinks-main','--test-isolation=none','--test-reporter=tap','--test',...tests];
  try{const result=await run(command,args,{cwd:root,env,prompt:'',signal});return {command:`node --test ${tests.join(' ')}`,status:'passed',required:true,details:result.slice(-10000)};}
  catch(error){return {command:`node --test ${tests.join(' ')}`,status:/# fail\s+[1-9]/.test(error.stdout??'')?'failed':'not_run',required:true,details:((error.stdout??'')+'\n'+error.message).slice(-10000)};}
}

export async function executeFileWorker(agent,context,{model=executeOpenCode,checks=sandboxChecks}={}) {
  const root=await realpath(context.cwd),files=await workerContext(root);
  const instruction=`Ти виконавець у керованій ізольованій папці. Інструментів у моделі немає. Сервер застосує лише підтверджені зміни та сам виконає тести.
Поверни ТІЛЬКИ JSON: {"status":"completed|blocked|failed|delegated","summary":"...","changes":[{"path":"relative/file.mjs","baseHash":null,"content":"повний вміст"}],"testFiles":["file.test.mjs"],"subtasks":[]}.
Для наявних файлів baseHash має точно збігатися з контекстом; для нового — null. Для видалення використовуй delete:true замість content. До 40 змін і 1 MB загалом. .git, секрети й зовнішні файли заборонені.
Для JS/TS коду потрібні реальні тести. testFiles — шляхи до Node.js тестів, команди не приймаються. Результати тестів не вигадуй: сервер запустить їх.
Не викликай жодних інструментів, навіть для читання файлів або запуску тестів: файли вже наведені нижче як дані; командами керує сервер. Поверни один завершений текстовий JSON.
${context.canDelegate?'Можна status=delegated і subtasks:[{title,prompt,skills,agentIds:[]}]; тоді changes і testFiles мають бути порожніми.':'Делегування заборонене: status=delegated не допускається.'}
Поточні файли: ${JSON.stringify(files)}
Задача: ${context.prompt}`;
  const output=await model({...agent,access:'read-only'},{...context,prompt:instruction},{home:join(OPENCODE_HOME,'jobs',hash(root).slice(0,24))});
  try {
  const value=JSON.parse(output.text.trim().replace(/^```(?:json)?\s*|\s*```$/g,''));
  if(typeof value.summary!=='string'||!value.summary.trim()||!['completed','blocked','failed','delegated'].includes(value.status))throw Error('Некоректний звіт файлового виконавця');
  if(value.status==='delegated') {
    if(!context.canDelegate||!Array.isArray(value.subtasks)||!value.subtasks.length||value.subtasks.length>10||value.changes?.length||value.testFiles?.length)throw Error('Недопустимий запит делегування');
    return {text:output.text,delegation:value.subtasks,usage:output.usage};
  }
  if(value.status!=='completed'){const error=new Error(value.summary);error.code=value.status==='blocked'?'WORKER_BLOCKED':'WORKER_FAILED';throw error;}
  if(agent.access!=='workspace-write'&&value.changes?.length)throw Error('Read-only виконавець не може змінювати файли');
  if(!Array.isArray(value.testFiles)||value.testFiles.length>30||value.testFiles.some(p=>typeof p!=='string'))throw Error('Некоректний список перевірок');
  const changed=await applyWorkerChanges(root,value.changes??[]);context.signal.throwIfAborted();
  const current=await workerContext(root),discovered=current.filter(f=>/\.(?:test|spec)\.[cm]?js$/.test(f.path)).map(f=>f.path);
  const needsTests=changed.some(p=>/\.(?:[cm]?js|ts)$/.test(p))||(agent.access==='read-only'&&discovered.length>0);
  const testFiles=value.testFiles.length?value.testFiles:needsTests?discovered:[];
  const results=testFiles.length?[await checks(root,testFiles,{signal:context.signal,access:agent.access})]:[];
  if((needsTests&&!testFiles.length)||results.some(c=>c.status!=='passed')) {
    const error=new Error(needsTests&&!testFiles.length?'Для змін коду не надано тестів':results[0].details);error.code=results.some(c=>c.status==='failed')?'WORKER_FAILED':'CHECKS_BLOCKED';error.usage=output.usage;throw error;
  }
  const report={status:'completed',summary:value.summary,files:changed,checks:results};
  return {text:`${report.summary}\n\nФайли: ${changed.join(', ')||'без змін'}\n${results.map(c=>`${c.command}: ${c.status}\n${c.details}`).join('\n')}`,report,usage:output.usage};
  }catch(error){error.usage??=output.usage;throw error;}
}
