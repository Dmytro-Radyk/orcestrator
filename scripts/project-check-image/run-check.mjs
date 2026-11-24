import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { readdirSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const [mode,file,app] = process.argv.slice(2);
const run = (program,args,env=process.env) => execFileSync(program,args,{env,stdio:'inherit',timeout:25000});
const env={...process.env,HOME:'/tmp',XDG_CACHE_HOME:'/tmp',XDG_CONFIG_HOME:'/tmp',
  CHROME_PATH:'/usr/local/bin/project-chromium'};
let postgres, appProcess;
try {
  if(mode==='postgres'){
    const toolRoot='/usr/lib/postgresql';
    const version=readdirSync(toolRoot).find(value=>/^\d+$/.test(value));
    const bin=join(toolRoot,version,'bin');
    const data=mkdtempSync('/tmp/project-pg-');
    Object.assign(env,{PATH:bin+':'+env.PATH,PGHOST:'127.0.0.1',PGPORT:'5432',
      PGUSER:'orchestrator',PGDATABASE:'orchestrator',PGCLIENTENCODING:'UTF8',PGCONNECT_TIMEOUT:'5'});
    run(join(bin,'initdb'),['-D',data,'-A','trust','-U',env.PGUSER,'-E','UTF8','--locale=C'],env);
    run(join(bin,'pg_ctl'),['-D',data,'-l',join(data,'server.log'),'-o','-h 127.0.0.1 -k /tmp -p 5432','-w','-t','12','start'],env);
    postgres={bin,data};
    run(join(bin,'createdb'),['--maintenance-db=postgres',env.PGDATABASE],env);
  }
  if(app){
    const url='http://127.0.0.1:3000';
    Object.assign(env,{PORT:'3000',HOST:'127.0.0.1',COVER_DIR:'/tmp/project-covers',STOREFRONT_URL:url,TEST_BASE_URL:url});
    appProcess=spawn(process.execPath,[resolve(app)],{env,stdio:'inherit'});
    let ready=false;
    for(let i=0;i<60;i++){
      if(appProcess.exitCode!==null)break;
      const response=await fetch(url+'/healthz',{signal:AbortSignal.timeout(500)}).catch(()=>null);
      if(response){await response.body?.cancel();if(response.ok){ready=true;break;}}
      await delay(200);
    }
    if(!ready)throw Error('Тестовий сервер не відкрив /healthz.');
  }
  const check=spawn(process.execPath,[resolve(file)],{env,stdio:'inherit'});
  const [code]=await once(check,'exit');
  process.exitCode=code??1;
}catch(error){
  console.error(error.message);
  process.exitCode=2;
}finally{
  if(appProcess&&appProcess.exitCode===null){
    appProcess.kill();
    await Promise.race([once(appProcess,'exit'),delay(1500)]).catch(()=>{});
    if(appProcess.exitCode===null)try{appProcess.kill('SIGKILL');}catch{}
  }
  if(postgres){
    try{run(join(postgres.bin,'pg_ctl'),['-D',postgres.data,'-m','fast','-w','-t','8','stop'],env);}
    catch(error){console.error(error.message);process.exitCode=2;}
  }
}
