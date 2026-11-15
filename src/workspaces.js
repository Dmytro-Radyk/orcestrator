import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir,lstat,realpath,writeFile,readdir } from 'node:fs/promises';
import { resolve,relative,isAbsolute,join } from 'node:path';
import { randomUUID } from 'node:crypto';

const exec=promisify(execFile);
const inside=(root,path)=>{const rel=relative(root,path);return Boolean(rel)&&!rel.startsWith('..')&&!isAbsolute(rel);};
const forbidden=p=>p.split(/[\\/]/).some(n=>/^(?:\.env(?:\..*)?|\.aws|\.codex|\.agents|node_modules)$/i.test(n))||/\.(?:pem|key|p12|pfx|sqlite|db)$/i.test(p);
export class WorkspaceConflict extends Error { constructor(message){super(message);this.code='WORKSPACE_CONFLICT';} }

export class WorkspaceManager {
  constructor(root,{allowedRoot}={}) {this.root=resolve(root);this.allowedRoot=allowedRoot&&resolve(allowedRoot);this.locks=new Map();}
  async locked(key,fn) {
    const previous=this.locks.get(key)??Promise.resolve();let release;const next=new Promise(r=>{release=r;});
    this.locks.set(key,next);await previous.catch(()=>{});
    try{return await fn();}finally{release();if(this.locks.get(key)===next)this.locks.delete(key);}
  }
  async git(cwd,args,{signal,input}={}) {
    const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^GIT_/i.test(key)));
    Object.assign(env,{GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null',GIT_TERMINAL_PROMPT:'0'});
    const child=exec('git',['-c','user.name=Orcestrator','-c','user.email=orcestrator@localhost','-c','commit.gpgsign=false',
      '-c',`core.hooksPath=${join(this.root,'empty-hooks')}`,'-C',cwd,...args],{env,windowsHide:true,signal,maxBuffer:4*1024*1024,encoding:'utf8'});
    if(input!==undefined)child.child.stdin.end(input);
    return (await child).stdout.trim();
  }
  async assertBase(path) {
    const base=await realpath(path);
    if(this.allowedRoot){await mkdir(this.allowedRoot,{recursive:true});const root=await realpath(this.allowedRoot);if(!inside(root,base))throw Error('Workspace виходить за межі керованих проєктів');}
    return base;
  }
  async safeTree(cwd) {
    const walk=async dir=>{for(const entry of await readdir(dir,{withFileTypes:true})) {
      if(entry.name==='.git'||entry.name==='node_modules'||entry.name.startsWith('.env'))continue;
      const path=join(dir,entry.name);if(entry.isSymbolicLink())throw Error('Symlink не допускається в результаті ізольованого виконавця');
      if(entry.isDirectory())await walk(path);
    }};await walk(cwd);
  }
  async prepare(run,task) {
    await mkdir(this.root,{recursive:true});await mkdir(join(this.root,'empty-hooks'),{recursive:true});
    const base=await this.assertBase(run.project.workspace);
    return this.locked(base,async()=>{
      const gitPath=join(base,'.git');
      const info=await lstat(gitPath).catch(()=>null);
      if(!info){await this.git(base,['init','--initial-branch=main']);
        await writeFile(join(base,'.git','info','exclude'),'\n.env*\nnode_modules/\n.codex/\n.aws/\n.agents/\n*.key\n*.pem\n*.p12\n*.pfx\n*.db\n*.sqlite*\n');
        await this.safeTree(base);await this.git(base,['add','--all']);await this.git(base,['commit','--allow-empty','-m','Initialize managed project']);
      }
      if(await this.git(base,['rev-parse','--show-toplevel']).then(p=>resolve(p))!==resolve(base))throw Error('Некоректний корінь Git workspace');
      if(await this.git(base,['status','--porcelain']))throw new WorkspaceConflict('Керована папка містить зміни поза запуском; збережіть їх перед виконанням');
      return this.create(base,base,run.id,task.id);
    });
  }
  async create(repo,target,runId,taskId,baseCommit) {
    const id=randomUUID(),path=join(this.root,`${runId.slice(0,8)}-${taskId.slice(0,8).replace(/[^a-z0-9_-]/gi,'_')}-${id}`);
    if(!inside(this.root,path))throw Error('Некоректний шлях worktree');
    const head=baseCommit??await this.git(target,['rev-parse','HEAD']),branch=`codex/run-${runId.slice(0,8)}-${id}`;
    await this.git(repo,['worktree','add','-b',branch,path,head]);
    return {id,cwd:await realpath(path),repo,target,branch,baseCommit:head};
  }
  async fork(parent,agentId) {return this.locked(parent.repo,()=>this.create(parent.repo,parent.cwd,parent.id,agentId,parent.baseCommit));}
  async publish(lease,signal) {
    signal?.throwIfAborted();await this.safeTree(lease.cwd);
    const changed=await this.git(lease.cwd,['ls-files','-z','--others','--exclude-standard']);
    const modified=await this.git(lease.cwd,['diff','--name-only','-z','HEAD']);
    for(const path of [changed,modified].join('\0').split('\0').filter(Boolean))if(forbidden(path))throw Error('Результат містить заборонений файл');
    await this.git(lease.cwd,['add','--all'],{signal});
    if(lease.files?.length){for(const path of lease.files) {
      const target=resolve(lease.cwd,path);if(typeof path!=='string'||forbidden(path)||path.split(/[\\/]/).some(n=>n==='..'||n==='.git')||isAbsolute(path)||!inside(lease.cwd,target))throw Error('Недопустимий файл у звіті виконавця');
    }await this.git(lease.cwd,['add','--force','--all','--',...lease.files],{signal});}
    if(await this.git(lease.cwd,['diff','--cached','--name-only'],{signal}))await this.git(lease.cwd,['commit','-m','Complete isolated task'],{signal});
    const candidate=await this.git(lease.cwd,['rev-parse','HEAD']);
    return this.locked(lease.target,async()=>{
      signal?.throwIfAborted();
      if(await this.git(lease.target,['status','--porcelain']))throw new WorkspaceConflict('Папка інтеграції змінилася під час виконання');
      const current=await this.git(lease.target,['rev-parse','HEAD']);if(current===candidate)return {commit:current,changed:false};
      let tree;
      try{tree=(await this.git(lease.repo,['merge-tree','--write-tree',current,candidate],{signal})).split('\n')[0];}
      catch(error){if(signal?.aborted)throw signal.reason;throw new WorkspaceConflict(`Конфлікт інтеграції; результат збережено у ${lease.cwd}`);}
      if(!/^[a-f0-9]{40,64}$/.test(tree))throw Error('Некоректний результат merge-tree');
      const commit=await this.git(lease.repo,['commit-tree',tree,'-p',current,'-p',candidate,'-m','Integrate verified task'],{signal});
      signal?.throwIfAborted();await this.git(lease.target,['merge','--ff-only','--no-overwrite-ignore',commit],{signal});
      return {commit,changed:true};
    });
  }
}
