import { readdir,lstat,readFile,mkdir,writeFile,unlink,realpath,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve,relative,isAbsolute,join,dirname,sep } from 'node:path';
import { createHash,randomUUID } from 'node:crypto';
import { runProcess } from '../src/providers.js';
import { skillGuidance } from '../src/execution-context.js';
import { unsafePathSegment } from '../src/workspaces.js';
import { executeOpenCode,OPENCODE_HOME } from './opencode-service.js';
import { ANTIGRAVITY_HOME } from './antigravity-service.js';

const hash=b=>createHash('sha256').update(b).digest('hex');
const sourceRoots=['src','app','apps','lib','tests','test','config'];
const workerPromptBytes=48*1024;
const denied=part=>{
  const n=part.replace(/[. ]+$/,'');
  return unsafePathSegment(part)||/^(?:\.git|\.env(?:\..*)?|\.aws|\.codex|\.gemini|\.agents|node_modules)$/i.test(n)||/\.(?:pem|key|p12|pfx|db|sqlite(?:3|-wal|-shm)?|exe|dll)$/i.test(n);
};
export function workerPath(root,path) {
  if(typeof path!=='string'||!path||path.length>240||/[\\\x00-\x1f:]/.test(path)||isAbsolute(path)||path.split('/').some(n=>!n||n==='.'||n==='..'||n.startsWith('-')||denied(n)))throw Error('Недопустимий шлях зміни');
  const actual=resolve(root,path),rel=relative(root,actual);if(!rel||rel==='..'||rel.startsWith(`..${sep}`)||isAbsolute(rel))throw Error('Файл виходить за межі worktree');return actual;
}
async function safeParents(root,path) {
  let current=resolve(root);
  const parts=relative(root,path).split(/[\\/]/);
  for(let i=0;i<parts.length;i++) {
    current=join(current,parts[i]);const info=await lstat(current).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
    if(info?.isSymbolicLink())throw Error('Symlink у шляху зміни заборонено');
    if(i<parts.length-1&&info&&!info.isDirectory())throw Error('Батьківський шлях не є каталогом');
  }
}
export async function workerContext(root) {
  const files=[];let bytes=0;
  async function walk(dir) {
    const entries=await readdir(dir,{withFileTypes:true});
    if(dir===root)entries.sort((a,b)=>Number(sourceRoots.includes(b.name))-Number(sourceRoots.includes(a.name)));
    for(const entry of entries) {
    if(denied(entry.name)||entry.isSymbolicLink())continue;const path=join(dir,entry.name);
    if(entry.isDirectory()){if(files.length<150&&!['.runtime','dist','coverage','.cache'].includes(entry.name))await walk(path);continue;}
    if(!entry.isFile()||files.length>=150)continue;
    const info=await lstat(path);if(info.size>128*1024||bytes+info.size>256*1024)continue;
    const value=await readFile(path);if(value.includes(0))continue;bytes+=value.length;
    files.push({path:relative(root,path).replaceAll('\\','/'),baseHash:hash(value),content:value.toString('utf8')});
  }}await walk(root);return files;
}
export async function applyWorkerChanges(root,changes) {
  if(!Array.isArray(changes)||changes.length>40)throw Error('Ліміт змін файлів перевищено');
  const seen=new Set(),normPaths=[],operations=[];let bytes=0;
  for(const item of changes) {
    if(!item||typeof item!=='object'||Array.isArray(item))throw Error('Некоректний елемент зміни');
    if(item.delete!==undefined&&typeof item.delete!=='boolean')throw Error('Поле delete має бути булевим');
    const path=workerPath(root,item.path);
    const key=process.platform==='win32'?path.toLowerCase():path;
    if(seen.has(key))throw Error('Повторна зміна файлу');seen.add(key);
    normPaths.push(process.platform==='win32'?item.path.toLowerCase():item.path);
    await safeParents(root,path);const info=await lstat(path).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
    if(info&&!info.isFile())throw Error('Змінювати можна лише звичайні файли');
    const before=info?hash(await readFile(path)):null;
    if(item.baseHash!==before)throw Error('baseHash файлу змінився або не підтверджений');
    if(item.delete===true){if(!info)throw Error('Видалення неіснуючого файлу');}
    else if(typeof item.content!=='string'||item.content.includes('\0')||(bytes+=Buffer.byteLength(item.content))>1024*1024)throw Error('Некоректний або завеликий вміст зміни');
    operations.push({path,item});
  }
  for(let i=0;i<normPaths.length;i++)for(let j=0;j<normPaths.length;j++){
    if(i!==j&&normPaths[j].startsWith(`${normPaths[i]}/`))throw Error('Конфлікт файлу та каталогу в одному наборі змін');
  }
  for(const {path,item} of operations){if(item.delete===true)await unlink(path);else{await mkdir(dirname(path),{recursive:true});await writeFile(path,item.content);}}
  return changes.map(c=>c.path);
}

export async function sandboxChecks(cwd,testFiles,{signal,command=process.env.ORCHESTRATOR_SANDBOX_COMMAND??process.env.ORCHESTRATOR_EXECUTOR_COMMAND??process.env.ORCHESTRATOR_PLANNER_COMMAND??'codex',run=runProcess}={}) {
  const root=await realpath(cwd);const tests=[];
  const tempRoot=await realpath(tmpdir()).catch(()=>resolve(tmpdir()));
  for(const path of testFiles){const actual=workerPath(root,path);await safeParents(root,actual);if(!/\.(?:[cm]?js|ts)$/.test(path)||!(await lstat(actual)).isFile())throw Error('Недопустимий файл перевірки');tests.push(path);}
  const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>/^(?:path|pathext|systemroot|windir|comspec|temp|tmp|localappdata|appdata|programfiles|programfiles\(x86\)|programdata|userprofile|lang|lc_all)$/i.test(key)));
  const profile=`permissions.orcestrator_check={extends=":read-only",filesystem={":root"="deny",":minimal"="read",":workspace_roots"={"."="read"}},network={enabled=false}}`;
  const args=['sandbox','-P','orcestrator_check','-C',root,'--include-managed-config','-c',profile,
    ...(process.platform==='win32'?['--enable','prefer_mxc','-c','windows.sandbox="elevated"']:[]),'--',process.execPath,
    '--permission',`--allow-fs-read=${root}`,`--allow-fs-read=${tempRoot}`,`--allow-fs-write=${tempRoot}`,'--preserve-symlinks','--preserve-symlinks-main','--test-reporter=tap','--test','--', ...tests];
  try{
    const result=await run(command,args,{cwd:root,env,prompt:'',signal});
    const testsMatch=/^# tests\s+(\d+)/m.exec(result??'');
    const failMatch=/^# fail\s+(\d+)/m.exec(result??'');
    const cancelMatch=/^# cancelled\s+(\d+)/m.exec(result??'');
    if(testsMatch&&(Number(testsMatch[1])===0||Number(failMatch?.[1]??0)>0||Number(cancelMatch?.[1]??0)>0)){
      return {command:`node --test ${tests.join(' ')}`,status:'failed',required:true,details:(result||'Не виконано жодного тесту').slice(-10000)};
    }
    return {command:`node --test ${tests.join(' ')}`,status:'passed',required:true,details:result.slice(-10000)};
  }catch(error){
    if(signal?.aborted)throw signal.reason??error;
    return {command:`node --test ${tests.join(' ')}`,status:/# fail\s+[1-9]/.test(error.stdout??'')?'failed':'not_run',required:true,details:((error.stdout??'')+'\n'+error.message).slice(-10000)};
  }
}

export async function executeFileWorker(agent,context,{model=executeOpenCode,checks=sandboxChecks}={}) {
  const root=await realpath(context.cwd),files=await workerContext(root);
  const instruction=`Ти виконавець у керованій ізольованій папці. Інструментів у моделі немає. Сервер застосує лише підтверджені зміни та сам виконає тести.
Поверни ТІЛЬКИ JSON: {"status":"completed|blocked|failed|delegated","summary":"...","changes":[{"path":"relative/file.mjs","baseHash":null,"content":"повний вміст"}],"testFiles":["file.test.mjs"],"subtasks":[]}.
Для наявних файлів baseHash має точно збігатися з контекстом; для нового — null. Для видалення використовуй delete:true замість content. До 40 змін і 1 MB загалом. .git, секрети й зовнішні файли заборонені.
Для JS/TS коду потрібні реальні тести. testFiles — шляхи до Node.js тестів, команди не приймаються. Результати тестів не вигадуй: сервер запустить їх.
Не викликай інструментів. Нижче наведено вибрані файли. Відсутність вмісту файлу не означає, що файл можна створити заново. Якщо для задачі потрібен пропущений файл, назви його шлях у звіті. Поверни один завершений текстовий JSON.
${context.canDelegate?'Можна status=delegated і subtasks:[{title,prompt,skills,agentIds:[]}]; тоді changes і testFiles мають бути порожніми.':'Делегування заборонене: status=delegated не допускається.'}
${context.prompt}`;
  const taskInstruction=context.review?`${context.prompt}\nНижче надано доступний вміст файлів. Назви матеріали, яких бракує для висновку.`:instruction;
  const focus=(context.review?context.prompt:context.prompt.split('\nDependency results:\n')[0]).normalize('NFKC').toLowerCase();
  const words=new Set(focus.match(/[\p{L}\p{N}]{3,}/gu)??[]);
  const ranked=files.map(file=>{
    const path=file.path.normalize('NFKC').toLowerCase();
    const terms=new Set(path.match(/[\p{L}\p{N}]{3,}/gu)??[]);
    const score=(focus.includes(path)?100:0)+[...terms].filter(word=>words.has(word)).length+
      (path==='package.json'||path==='readme.md'?2:0);
    return {file,score};
  }).sort((a,b)=>b.score-a.score);
  // Count the prompt as an escaped JSON string, including room for the JSONL envelope.
  const paths=ranked.map(({file})=>file.path);
  const suffix='\nВиявлені шляхи у робочій папці: '+JSON.stringify(paths);
  const bytes=value=>Buffer.byteLength(JSON.stringify(value),'utf8')-2;
  const fileLabel='\n\nФайли з вмістом: ';
  const guidance=skillGuidance(context.skills,context.hooks);
  const baseSize=bytes(taskInstruction+fileLabel)+2+64;
  if(baseSize>workerPromptBytes)throw Object.assign(Error('Текст задачі перевищує бюджет контексту файлового виконавця'),{code:'WORKER_CONTEXT_TOO_LARGE'});
  const includedGuidance=baseSize+bytes(guidance)<=workerPromptBytes*0.8?guidance:'';
  const fixed=baseSize+bytes(includedGuidance);
  const index=fixed+bytes(suffix)<=workerPromptBytes?suffix:'';
  let available=workerPromptBytes-fixed-bytes(index);
  const selected=[];
  for(const {file} of ranked){
    const size=bytes(JSON.stringify(file))+(selected.length?1:0);
    if(size>available)continue;
    selected.push(file);
    available-=size;
  }
  const prompt=taskInstruction+includedGuidance+fileLabel+JSON.stringify(selected)+index;
  const baseHome=agent.provider==='antigravity'?ANTIGRAVITY_HOME:OPENCODE_HOME;
  const jobHome=join(baseHome,'jobs',randomUUID());
  let output;
  try {
    output=await model({...agent,access:'read-only'},{...context,prompt},{home:jobHome});
  } finally {
    await rm(jobHome,{recursive:true,force:true}).catch(()=>{});
  }
  if(context.review)return output;
  try {
  const value=JSON.parse(output.text.trim().replace(/^```(?:json)?\s*|\s*```$/g,''));
  if(typeof value.summary!=='string'||!value.summary.trim()||!['completed','blocked','failed','delegated'].includes(value.status))throw Error('Некоректний звіт файлового виконавця');
  if(value.status==='delegated') {
    if(!context.canDelegate||!Array.isArray(value.subtasks)||!value.subtasks.length||value.subtasks.length>10||value.changes?.length||value.testFiles?.length)throw Error('Недопустимий запит делегування');
    return {text:output.text,delegation:value.subtasks,usage:output.usage};
  }
  if(value.status!=='completed'){
    const error=new Error(value.summary);error.code=value.status==='blocked'?'AGENT_BLOCKED':'WORKER_FAILED';
    error.report={status:value.status,summary:value.summary,files:[],checks:[]};throw error;
  }
  if(agent.access!=='workspace-write'&&value.changes?.length)throw Error('Read-only виконавець не може змінювати файли');
  if(!Array.isArray(value.testFiles)||value.testFiles.length>30||value.testFiles.some(p=>typeof p!=='string'))throw Error('Некоректний список перевірок');
  const changed=await applyWorkerChanges(root,value.changes??[]);context.signal.throwIfAborted();
  const current=await workerContext(root),discovered=current.filter(f=>/\.(?:test|spec)\.(?:[cm]?js|ts)$/.test(f.path)).map(f=>f.path);
  const needsTests=changed.some(p=>/\.(?:[cm]?js|ts)$/.test(p))||(agent.access==='read-only'&&discovered.length>0);
  const testFiles=value.testFiles.length?value.testFiles:needsTests?discovered:[];
  const results=testFiles.length?[await checks(root,testFiles,{signal:context.signal,access:agent.access})]:[];
  if((needsTests&&!testFiles.length)||results.some(c=>c.status!=='passed')) {
    const error=new Error(needsTests&&!testFiles.length?'Для змін коду не надано тестів':results[0].details);
    error.code=results.some(c=>c.status==='failed')?'WORKER_FAILED':'CHECKS_BLOCKED';
    error.report={status:'blocked',summary:value.summary,files:changed,checks:results};error.usage=output.usage;throw error;
  }
  const report={status:'completed',summary:value.summary,files:changed,checks:results};
  return {text:`${report.summary}\n\nФайли: ${changed.join(', ')||'без змін'}\n${results.map(c=>`${c.command}: ${c.status}\n${c.details}`).join('\n')}`,report,usage:output.usage};
  }catch(error){error.usage??=output.usage;throw error;}
}
