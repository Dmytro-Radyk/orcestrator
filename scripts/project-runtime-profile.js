import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import semver from 'semver';
import { parse } from 'yaml';

const defaults={node:'24',postgres:'17'};
const official=/^(?:(?:docker\.io\/)?library\/)?(?:node|postgres)(?::|@|$)/;
const supportedNode='>=20 <100';
const pinVersion=/^v?\d{1,2}(?:\.\d{1,3}){0,2}$/;
const postgresVersion=/^(?:1[3-9]|[2-9]\d)(?:\.\d{1,3})?$/;
const nodeAlias=/^(?:node|stable|lts(?:\/(?:\*|[a-z]+))?)$/i;

const profileError=(message,conflict=false)=>Object.assign(Error(message),{
  code:conflict?'PROJECT_RUNTIME_CONFLICT':'PROJECT_RUNTIME_UNAVAILABLE'
});

async function projectFile(cwd,file){
  const path=join(cwd,file);
  const info=await lstat(path).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
  if(!info)return null;
  if(!info.isFile()||info.size>256*1024)throw profileError(`Не вдалося прочитати файл вимог ${file}.`);
  return (await readFile(path,'utf8')).replace(/^\uFEFF/,'');
}

function json(source,file){
  if(source===null)return {};
  try{
    const value=JSON.parse(source);
    if(value&&typeof value==='object'&&!Array.isArray(value))return value;
  }catch{ /* The invalid manifest is reported below. */ }
  throw profileError(`Некоректний JSON у ${file}.`,true);
}

function imagePin(image,name){
  const withDefault=image.replace(/\$\{[A-Z_][A-Z_0-9]*:-(\d+(?:\.\d+){0,2})\}/gi,'$1');
  if(!official.test(withDefault))return null;
  const match=new RegExp(`^(?:(?:docker\\.io\\/)?library\\/)?${name}:(\\d+(?:\\.\\d+){0,2})(?=[-@]|$)`).exec(withDefault);
  return match?.[1]??null;
}

let versionCatalog, versionsUntil=0;
async function availableNodes(){
  if(Date.now()<versionsUntil)return versionCatalog;
  versionCatalog??=(async()=>{
    try{
      const response=await fetch('https://nodejs.org/dist/index.json',{
        redirect:'error',signal:AbortSignal.timeout(10000)
      });
      if(!response.ok)throw Error('Не вдалося отримати каталог версій Node.js.');
      const releases=await response.json();
      const versions=releases.filter(release=>semver.valid(release.version));
      versionsUntil=Date.now()+3600000;
      return versions;
    }catch(error){
      throw profileError(`Не вдалося звірити діапазон Node.js з офіційним каталогом: ${error.message}`);
    }
  })();
  try{return await versionCatalog;}
  finally{if(Date.now()>=versionsUntil)versionCatalog=undefined;}
}

async function chooseNode(ranges,getVersions){
  if(!ranges.length)return defaults.node;
  const aliases=ranges.filter(({source,value})=>
    ['.nvmrc','.node-version'].includes(source)&&typeof value==='string'&&nodeAlias.test(value));
  const constraints=ranges.filter(range=>!aliases.includes(range));
  for(const {source,value} of constraints){
    if(typeof value!=='string'||value.length>150||!semver.validRange(value))
      throw profileError(`Некоректна вимога Node.js у ${source}.`,true);
  }
  if(!constraints.every(({value})=>semver.intersects(value,supportedNode)))
    throw profileError(`Вимоги Node.js виходять за підтримуваний діапазон ${supportedNode}.`);
  if(constraints.some(({value},i)=>constraints.slice(i+1).some(other=>!semver.intersects(value,other.value))))
    throw profileError('Суперечливі вимоги Node.js: '+ranges.map(({source,value})=>`${source} (${value})`).join(', ')+'.',true);
  const accepts=version=>constraints.every(({value})=>semver.satisfies(version,value));
  const exact=constraints.find(({value})=>pinVersion.test(value)&&value.split('.').length===3);
  if(!aliases.length&&exact&&accepts(exact.value)){
    if(!semver.satisfies(exact.value,supportedNode))throw profileError(`Node.js ${exact.value} поза підтримуваним діапазоном ${supportedNode}.`);
    return semver.valid(exact.value);
  }
  const preferredMajor=Number(defaults.node);
  const majors=[preferredMajor,...Array.from({length:80},(_,i)=>20+i).filter(major=>major!==preferredMajor)];
  const fullMajor=majors.find(major=>constraints.every(({value})=>semver.subset(`${major}.x`,value)));
  if(!aliases.length&&fullMajor!==undefined)return String(fullMajor);
  const versions=(await getVersions()).map(release=>typeof release==='string'?{version:release}:release);
  const latest=semver.rsort(versions.filter(({version,lts})=>
    semver.satisfies(version,supportedNode)&&accepts(version)&&aliases.every(({value})=>{
      const [kind,name]=value.toLowerCase().split('/');
      return kind!=='lts'||typeof lts==='string'&&(!name||name==='*'||lts.toLowerCase()===name);
    })).map(({version})=>semver.valid(version)))[0];
  if(latest)return latest;
  throw profileError('Не знайдено сумісну версію Node.js для вимог: '+ranges.map(({source,value})=>`${source} (${value})`).join(', ')+'.',true);
}

export async function resolveProjectRuntime(cwd,{includePostgres=false,getVersions=availableNodes}={}){
  const [packageText,runtimeText,nvm,nodeVersion,dockerfile]=await Promise.all(
    ['package.json','.orcestrator-runtime.json','.nvmrc','.node-version','Dockerfile'].map(file=>projectFile(cwd,file)));
  const manifest=json(packageText,'package.json'), runtime=json(runtimeText,'.orcestrator-runtime.json');
  const dockerText=dockerfile??'';
  const buildArgs=new Map([...dockerText.split(/^\s*FROM\s+/im,1)[0].matchAll(
    /^\s*ARG\s+([A-Z_][A-Z_0-9]*)=(\d+(?:\.\d+){0,2})\s*$/gim)].map(([,key,value])=>[key,value]));
  const dockerPins=[...new Set([...dockerText.matchAll(/^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)/gim)]
    .map(([,image])=>imagePin(image.replace(/\$\{([A-Z_][A-Z_0-9]*)\}|\$([A-Z_][A-Z_0-9]*)/gi,
      (ref,braced,bare)=>buildArgs.get(braced??bare)??ref),'node')).filter(Boolean))];
  const nodeRanges=[
    {source:'.orcestrator-runtime.json',value:runtime.node},
    {source:'.nvmrc',value:nvm?.split(/\r?\n/).map(line=>line.replace(/#.*/,'').trim()).find(Boolean)},
    {source:'.node-version',value:nodeVersion?.trim()},
    {source:'package.json volta.node',value:manifest.volta?.node},
    {source:'Dockerfile',value:dockerPins.length===1?dockerPins[0]:undefined},
    {source:'package.json engines.node',value:manifest.engines?.node}
  ].filter(({value})=>value!==undefined);
  const node=await chooseNode(nodeRanges,getVersions);
  if(!includePostgres)return {node};
  let postgres=runtime.postgres;
  if(postgres===undefined){
    for(const file of ['compose.yaml','compose.yml','docker-compose.yaml','docker-compose.yml']){
      const content=await projectFile(cwd,file);
      if(content===null)continue;
      let compose;
      try{compose=parse(content,{maxAliasCount:20});}
      catch{throw profileError(`Не вдалося прочитати версію PostgreSQL у ${file}.`,true);}
      const images=Object.values(compose?.services??{}).map(service=>service?.image).filter(image=>typeof image==='string'&&
        /^(?:(?:docker\.io\/)?library\/)?postgres(?::|@|$)/.test(image));
      const versions=[...new Set(images.map(image=>imagePin(image,'postgres')))];
      if(versions.length>1||versions.includes(null))
        throw profileError(`У ${file} немає однозначної версії PostgreSQL для локального тестування.`,true);
      postgres=versions[0];
      break;
    }
  }
  if(postgres===undefined)postgres=defaults.postgres;
  if(typeof postgres!=='string'||!postgresVersion.test(postgres))throw profileError(`Версія PostgreSQL ${postgres} недоступна для цього середовища.`);
  return {node,postgres};
}
