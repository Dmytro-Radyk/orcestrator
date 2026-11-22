import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir,lstat,realpath,writeFile,readdir,mkdtemp,rm } from 'node:fs/promises';
import { resolve,relative,isAbsolute,join,sep } from 'node:path';
import { randomUUID } from 'node:crypto';

const exec=promisify(execFile);
const inside=(root,path)=>{const rel=relative(root,path);return Boolean(rel)&&rel!=='..'&&!rel.startsWith(`..${sep}`)&&!isAbsolute(rel);};
const forbidden=p=>p.split(/[\\/]/).some(n=>/^(?:\.env(?:\..*)?|\.aws|\.codex|\.gemini|\.agents|node_modules)$/i.test(n))||/\.(?:pem|key|p12|pfx|sqlite(?:3|-wal|-shm)?|db)$/i.test(p);
export class WorkspaceConflict extends Error { constructor(message,candidateCommit){super(message);this.code='WORKSPACE_CONFLICT';if(candidateCommit)this.candidateCommit=candidateCommit;} }

export class WorkspaceManager {
  constructor(root,{allowedRoot,projectLocation}={}) {this.root=resolve(root);this.allowedRoot=allowedRoot&&resolve(allowedRoot);this.projectLocation=projectLocation;this.locks=new Map();}
  async locked(key,fn) {
    const previous=this.locks.get(key)??Promise.resolve();let release;const next=new Promise(r=>{release=r;});
    this.locks.set(key,next);await previous.catch(()=>{});
    try{return await fn();}finally{release();if(this.locks.get(key)===next)this.locks.delete(key);}
  }
  async git(cwd,args,{signal,input,index,literalPathspecs=false}={}) {
    const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^GIT_/i.test(key)));
    Object.assign(env,{GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null',GIT_TERMINAL_PROMPT:'0'});
    if(index) env.GIT_INDEX_FILE=index;
    const prefix=['-c','user.name=Orcestrator','-c','user.email=orcestrator@localhost','-c','commit.gpgsign=false',
      '-c',`core.hooksPath=${join(this.root,'empty-hooks')}`,...(literalPathspecs?['--literal-pathspecs']:[]),'-C',cwd];
    const child=exec('git',[...prefix,...args],{env,windowsHide:true,signal,maxBuffer:4*1024*1024,encoding:'utf8'});
    if(input!==undefined)child.child.stdin.end(input);
    return (await child).stdout.trim();
  }
  async assertBase(path, projectId) {
    const base=await realpath(path);
    const chosen=this.projectLocation?.(projectId);
    if(chosen){if(base!==chosen)throw Error('Робочу папку проєкту переміщено або замінено');return base;}
    if(this.allowedRoot){await mkdir(this.allowedRoot,{recursive:true});const root=await realpath(this.allowedRoot);if(!inside(root,base))throw Error('Workspace виходить за межі керованих проєктів');}
    return base;
  }
  async safeTree(cwd) {
    const walk=async dir=>{for(const entry of await readdir(dir,{withFileTypes:true})) {
      if(entry.isSymbolicLink())throw Error('Symlink не допускається в результаті ізольованого виконавця');
      if(entry.name==='.git'||entry.name==='node_modules'||/^\.env(?:\..*)?$/i.test(entry.name))continue;
      const path=join(dir,entry.name);
      if(entry.isDirectory())await walk(path);
    }};await walk(cwd);
  }
  async removeWorktree(repo,cwd,branch) {
    if(!repo||!cwd||cwd===repo)return;
    await this.locked(repo,async()=>{
      try {
        const root=await realpath(this.root);
        const actual=await realpath(cwd).catch(()=>null);
        if(actual&&inside(root,actual))await this.git(repo,['worktree','remove','--force',actual]).catch(()=>{});
        if(branch&&branch.startsWith('codex/run-'))await this.git(repo,['branch','-D',branch]).catch(()=>{});
      } catch { /* best-effort cleanup after accepted integration */ }
    });
  }
  async prepare(run,task) {
    await mkdir(this.root,{recursive:true});await mkdir(join(this.root,'empty-hooks'),{recursive:true});
    const base=await this.assertBase(run.project.workspace,run.project.uiProjectId);
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
  async resume(run,candidate,{committed=false}={}) {
    const base=await this.assertBase(run.project.workspace,run.project.uiProjectId),root=await realpath(this.root),cwd=await realpath(candidate.path);
    if(!inside(root,cwd))throw new WorkspaceConflict('Папка чернетки виходить за межі керованих worktree');
    return this.locked(base,async()=>{
      if(resolve(await this.git(base,['rev-parse','--show-toplevel']))!==base||await this.git(base,['status','--porcelain']))throw new WorkspaceConflict('Прийнята папка змінилася перед уточненням');
      const common=resolve(cwd,await this.git(cwd,['rev-parse','--git-common-dir']));
      const head=await this.git(cwd,['rev-parse','HEAD']);
      if(common!==await realpath(join(base,'.git'))||resolve(await this.git(cwd,['rev-parse','--show-toplevel']))!==cwd||
        await this.git(cwd,['branch','--show-current'])!==candidate.branch)throw new WorkspaceConflict('Чернетка не відповідає збереженій worktree');
      if(committed){
        if(await this.git(cwd,['status','--porcelain']))throw new WorkspaceConflict('Збережений результат змінено після конфлікту');
        if(candidate.candidateCommit){if(head!==candidate.candidateCommit)throw new WorkspaceConflict('Commit чернетки змінився після конфлікту');}
        else if(await this.git(cwd,['show','-s','--format=%P',head])!==candidate.baseCommit||await this.git(cwd,['show','-s','--format=%s',head])!=='Complete isolated task')throw new WorkspaceConflict('Не підтверджено commit старої чернетки');
      }else if(head!==candidate.baseCommit)throw new WorkspaceConflict('Чернетка не відповідає збереженій worktree');
      await this.safeTree(cwd);
      return {id:randomUUID(),cwd,repo:base,target:base,branch:candidate.branch,baseCommit:head,conflicts:candidate.conflicts};
    });
  }
  async resolveDraft(run,candidate,taskId) {
    const draft=await this.resume(run,candidate,{committed:true});
    if(await this.git(draft.cwd,['merge-base',candidate.baseCommit,draft.baseCommit])!==candidate.baseCommit)throw new WorkspaceConflict('Чернетка не походить від збереженої основи');
    const lease=await this.prepare(run,{id:taskId});
    try{await this.git(lease.cwd,['merge','--no-commit','--no-ff',draft.baseCommit]);}
    catch(error){
      const conflicts=await this.git(lease.cwd,['diff','--name-only','--diff-filter=U','-z']);
      if(!conflicts)throw error;
      lease.conflicts=conflicts.split('\0').filter(Boolean);
    }
    await this.safeTree(lease.cwd);
    lease.resolvedFrom=draft.cwd;
    return lease;
  }
  async fork(parent,agentId) {return this.locked(parent.repo,()=>this.create(parent.repo,parent.cwd,parent.id,agentId,parent.baseCommit));}
  async inspectIndex(cwd,{signal,index}={}) {
    const staged=await this.git(cwd,['ls-files','--stage','-z'],{signal,index});
    for(const entry of staged.split('\0').filter(Boolean)) {
      const tab=entry.indexOf('\t');
      if(tab<0)continue;
      const mode=entry.slice(0,entry.indexOf(' ')),path=entry.slice(tab+1);
      if(mode==='120000')throw Error('Symlink не допускається в результаті ізольованого виконавця');
      if(forbidden(path))throw Error('Результат містить заборонений файл');
    }
  }
  async stageCandidate(lease,{signal,index,allowAhead=false}={}) {
    signal?.throwIfAborted();await this.safeTree(lease.cwd);
    if(!allowAhead&&lease.baseCommit){
      const head=await this.git(lease.cwd,['rev-parse','HEAD'],{signal});
      if(head!==lease.baseCommit)throw new WorkspaceConflict('Виконавець створив некерований commit у робочій папці');
    }
    const changed=await this.git(lease.cwd,['ls-files','-z','--others','--exclude-standard'],{signal});
    const modified=await this.git(lease.cwd,['diff','--name-only','-z','HEAD'],{signal});
    for(const path of [changed,modified].join('\0').split('\0').filter(Boolean))if(forbidden(path))throw Error('Результат містить заборонений файл');
    await this.git(lease.cwd,['add','--all'],{signal,index});
    if(lease.files?.length){
      const safeFiles=[];
      for(const path of lease.files) {
        if(typeof path!=='string'||!path||forbidden(path)||path.split(/[\\/]/).some(n=>!n||n==='.'||n==='..'||n==='.git')||isAbsolute(path))throw Error('Недопустимий файл у звіті виконавця');
        const target=resolve(lease.cwd,path);
        if(!inside(lease.cwd,target))throw Error('Недопустимий файл у звіті виконавця');
        const info=await lstat(target).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
        if(info){
          if(info.isSymbolicLink())throw Error('Symlink не допускається в результаті ізольованого виконавця');
          if(!info.isFile())throw Error('Звіт виконавця може вказувати лише звичайні файли');
        }
        safeFiles.push(path);
      }
      if(safeFiles.length)await this.git(lease.cwd,['add','--force','--all','--', ...safeFiles],{signal,index,literalPathspecs:true});
    }
    await this.inspectIndex(lease.cwd,{signal,index});
  }
  async candidateTree(lease,signal,{checkMerge=false,allowAhead=false}={}) {
    const directory=await mkdtemp(join(this.root,'verification-index-'));
    const index=join(directory,'index');
    try {
      await this.git(lease.cwd,['read-tree','HEAD'],{signal,index});
      await this.stageCandidate(lease,{signal,index,allowAhead});
      if(checkMerge){
        try{await this.git(lease.cwd,['-c','core.whitespace=-blank-at-eol,-blank-at-eof,-space-before-tab','diff','--cached','--check'],{signal,index});}
        catch(error){signal?.throwIfAborted();throw Object.assign(new Error('У чернетці залишилися маркери конфлікту інтеграції; узгодьте файли та повторіть перевірки'),{code:'WORKSPACE_CHECK_FAILED'});}
      }
      return await this.git(lease.cwd,['write-tree'],{signal,index});
    } finally {
      await rm(directory,{recursive:true,force:true}).catch(()=>{});
    }
  }
  async verifyTree(lease,tree,verify,signal) {
    const root=await realpath(this.root);
    const path=join(root,`verification-${randomUUID()}`);
    const snapshot=await this.locked(lease.repo,async()=>{
      const commit=await this.git(lease.repo,['commit-tree',tree,'-p',lease.baseCommit,'-m','Snapshot for host verification'],{signal});
      await this.git(lease.repo,['worktree','add','--detach',path,commit],{signal});
      return commit;
    });
    let primaryError;
    try {
      const result=await verify(path);
      if(await this.candidateTree({...lease,cwd:path,baseCommit:snapshot,files:[]},signal)!==tree)
        throw new WorkspaceConflict('Локальна перевірка змінила файли перевіреної версії');
      return result;
    } catch(error) {
      primaryError=error;
      throw error;
    } finally {
      try {
        const actual=await realpath(path);
        if(actual!==path||!inside(root,actual))throw new WorkspaceConflict('Робоча папка перевірки змінила шлях');
        await this.locked(lease.repo,()=>this.git(lease.repo,['worktree','remove','--force',actual]));
      } catch(cleanupError) {
        if(!primaryError&&cleanupError.code==='WORKSPACE_CONFLICT')throw cleanupError;
        await this.locked(lease.repo,()=>this.git(lease.repo,['worktree','prune']).catch(()=>{}));
      }
    }
  }
  async publish(lease,signal,{verifiedTree,cleanup=true}={}) {
    const merging=Boolean(lease.conflicts?.length||await this.git(lease.cwd,['rev-parse','--verify','-q','MERGE_HEAD']).catch(()=>null));
    // Validate tree, forbidden files, symlinks and conflict markers in a temporary index before touching the live index.
    const checkedTree=await this.candidateTree(lease,signal,{checkMerge:merging});
    if(verifiedTree&&checkedTree!==verifiedTree)
      throw new WorkspaceConflict('Вміст чернетки змінився після локальної перевірки');
    signal?.throwIfAborted();
    await this.stageCandidate(lease,{signal});
    const hasStaged=Boolean(await this.git(lease.cwd,['diff','--cached','--name-only'],{signal}));
    const hasMergeHead=Boolean(await this.git(lease.cwd,['rev-parse','--verify','-q','MERGE_HEAD']).catch(()=>null));
    if(hasStaged||hasMergeHead)await this.git(lease.cwd,['commit',...(hasMergeHead&&!hasStaged?['--allow-empty']:[]),'-m','Complete isolated task'],{signal});
    const candidate=await this.git(lease.cwd,['rev-parse','HEAD']);
    const result=await this.locked(lease.target,async()=>{
      signal?.throwIfAborted();
      if(await this.git(lease.target,['status','--porcelain']))throw new WorkspaceConflict('Папка інтеграції змінилася під час виконання',candidate);
      const current=await this.git(lease.target,['rev-parse','HEAD']);if(current===candidate)return {commit:current,changed:false};
      let tree;
      try{tree=(await this.git(lease.repo,['merge-tree','--write-tree',current,candidate],{signal})).split('\n')[0];}
      catch(error){
        if(signal?.aborted)throw signal.reason;
        if(error.code===1)throw new WorkspaceConflict(`Конфлікт інтеграції; результат збережено у ${lease.cwd}`,candidate);
        throw error;
      }
      if(!/^[a-f0-9]{40,64}$/.test(tree))throw Error('Некоректний результат merge-tree');
      const commit=await this.git(lease.repo,['commit-tree',tree,'-p',current,'-p',candidate,'-m','Integrate verified task'],{signal});
      signal?.throwIfAborted();
      // Do not interrupt the final fast-forward checkout mid-write to avoid leaving .git/index.lock.
      await this.git(lease.target,['merge','--ff-only','--no-overwrite-ignore',commit]);
      return {commit,changed:true};
    });
    if(cleanup)await this.removeWorktree(lease.repo,lease.cwd,lease.branch);
    return result;
  }
}
