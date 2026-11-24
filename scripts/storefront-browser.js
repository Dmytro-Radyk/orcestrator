import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { terminate } from '../src/providers.js';

export function storefrontBrowser(env=process.env) {
  return [env.ORCHESTRATOR_STOREFRONT_BROWSER,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome','/usr/bin/chromium','/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  ].find(path=>path&&isAbsolute(path)&&existsSync(path));
}

async function connectBrowser(command, directory, origin, signal) {
  const child=spawn(command,['--headless=new','--remote-debugging-address=127.0.0.1','--remote-debugging-port=0',
    '--disable-background-networking','--disable-extensions','--no-first-run',
    '--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1',
    '--proxy-server=http://127.0.0.1:1',`--proxy-bypass-list=<-loopback>;${new URL(origin).host}`,
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    `--user-data-dir=${directory}`,'about:blank'],{stdio:'ignore',windowsHide:true});
  let processError, socket, sequence=0, stopped=false;
  const pending=new Map();
  child.once('error',error=>{processError=error;});
  async function stop() {
    if(stopped)return;
    stopped=true;
    try{socket?.close();}catch{}
    terminate(child);
    if(child.exitCode===null&&child.signalCode===null){
      await Promise.race([once(child,'close'),delay(1500)]).catch(()=>{});
    }
  }
  try {
    let port;
    for(let n=0;n<80&&!port;n++){
      signal.throwIfAborted();
      if(processError||child.exitCode!==null)throw Error('Chromium завершився під час запуску');
      port=(await readFile(join(directory,'DevToolsActivePort'),'utf8').catch(()=>'' )).split(/\r?\n/)[0];
      if(!port)await delay(100,undefined,{signal});
    }
    if(!/^\d+$/.test(port??''))throw Error('Chromium не відкрив DevTools');
    const targets=await (await fetch(`http://127.0.0.1:${port}/json/list`,{signal})).json();
    const endpoint=URL.parse(targets.find(target=>target.type==='page')?.webSocketDebuggerUrl??'');
    if(!endpoint||endpoint.origin!==`ws://127.0.0.1:${port}`||!endpoint.pathname.startsWith('/devtools/page/'))
      throw Error('Неочікувана адреса DevTools');
    socket=new WebSocket(endpoint);
    await once(socket,'open',{signal});
    function call(method,params={}) {
      signal.throwIfAborted();
      return new Promise((resolve,reject)=>{
        const id=++sequence;
        const finish=()=>{clearTimeout(timer);pending.delete(id);signal.removeEventListener('abort',abort);};
        const abort=()=>{finish();reject(signal.reason);};
        const timer=setTimeout(()=>{finish();reject(Error(`Chromium не відповів на ${method}`));},5000);
        pending.set(id,result=>{finish();if(result.error)reject(Error(`Chromium: ${method}`));else resolve(result.result);});
        signal.addEventListener('abort',abort,{once:true});
        try{socket.send(JSON.stringify({id,method,params}));}catch(error){finish();reject(error);}
      });
    }
    return {call,socket,stop,pending};
  }catch(error){await stop();throw error;}
}

const models='[data-product-model]';
const visible = element => element && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden';

function bindLocalBrowser(connection,origin){
  const {call,socket}=connection;
  socket.addEventListener('message',({data})=>{
    const event=JSON.parse(data);
    if(event.id)return connection.pending.get(event.id)?.(event);
    if(event.method!=='Fetch.requestPaused')return;
    const {requestId,request}=event.params;
    const target=URL.parse(request.url);
    const allowed=target?.origin===origin||['data:','blob:'].includes(target?.protocol);
    void Promise.resolve().then(()=>call(allowed?'Fetch.continueRequest':'Fetch.failRequest',
      allowed?{requestId}:{requestId,errorReason:'BlockedByClient'})).catch(()=>{});
  });
}

export async function inspectLocalPreview(url,width,parentSignal){
  const target=URL.parse(url), browser=storefrontBrowser();
  if(!target||target.protocol!=='http:'||target.hostname!=='127.0.0.1'||!target.port||!browser)
    throw Error('Локальний перегляд або Chromium недоступний.');
  const signal=AbortSignal.any([parentSignal,AbortSignal.timeout(22000)]);
  const profile=await mkdtemp(join(tmpdir(),'orcestrator-preview-'));
  let connection;
  try{
    connection=await connectBrowser(browser,profile,target.origin,signal);
    bindLocalBrowser(connection,target.origin);
    const {call}=connection;
    await call('Fetch.enable',{patterns:[{urlPattern:'*'}]});
    await call('Emulation.setDeviceMetricsOverride',{width,height:850,deviceScaleFactor:1,mobile:false});
    const navigation=await call('Page.navigate',{url:target.href});
    if(navigation.errorText)throw Error('Chromium не відкрив сторінку проєкту.');
    for(let attempt=0;attempt<30;attempt++){
      const {result}=await call('Runtime.evaluate',{returnByValue:true,expression:
        `location.origin===${JSON.stringify(target.origin)} && document.readyState==='complete' && ({
          path:location.pathname, title:document.title, heading:document.querySelector('h1')?.innerText??'',
          horizontalOverflow:document.documentElement.scrollWidth>document.documentElement.clientWidth,
          brokenImages:[...document.images].filter(img=>img.complete&&!img.naturalWidth).slice(0,12).map(img=>img.alt),
          visibleText:document.body.innerText.slice(0,1800)
        })`}).catch(error=>{signal.throwIfAborted();if(error.message==='Chromium: Runtime.evaluate')return {};throw error;});
      if(result?.value){
        const image=await call('Page.captureScreenshot',{format:'jpeg',quality:55});
        return {page:result.value,image:image.data};
      }
      await delay(180,undefined,{signal});
    }
    throw Error('Сторінка проєкту не завершила завантаження.');
  }finally{
    await connection?.stop();
    await rm(profile,{recursive:true,force:true,maxRetries:5,retryDelay:150}).catch(()=>{});
  }
}

export async function auditStorefront(url,{browser=storefrontBrowser(),minimum=12,output,signal:parentSignal}={}) {
  if(!browser)return {status:'unavailable',issues:['Не знайдено Chrome або Edge для незалежної перевірки.']};
  const target=URL.parse(url);
  if(!target||target.protocol!=='http:'||target.hostname!=='127.0.0.1'||!target.port)
    return {status:'unavailable',issues:['Незалежна перевірка працює лише з локальним переглядом оркестратора.']};
  const origin=target.origin;
  const deadline=AbortSignal.timeout(38000);
  const signal=parentSignal?AbortSignal.any([parentSignal,deadline]):deadline;
  const profile=await mkdtemp(join(tmpdir(),'orcestrator-storefront-'));
  let connection;
  try {
    connection=await connectBrowser(browser,profile,origin,signal);
    const {call}=connection;
    bindLocalBrowser(connection,origin);
    const evaluate=async(fn,...args)=>{
      const result=await call('Runtime.evaluate',{expression:`((visible)=>(${fn})(${args.map(arg=>JSON.stringify(arg)).join(',')}))(${visible})`,
        returnByValue:true,awaitPromise:true});
      return result.exceptionDetails?undefined:result.result?.value;
    };
    async function waitFor(fn,...args) {
      for(let index=0;index<20;index++){
        const value=await evaluate(fn,...args).catch(error=>{signal.throwIfAborted();if(error.message==='Chromium: Runtime.evaluate')return null;throw error;});
        if(value)return value;
        await delay(90,undefined,{signal});
      }
    }
    const shown=selector=>waitFor(selector=>Boolean(visible(document.querySelector(selector))),selector);
    const click=async selector=>{
      const point=await waitFor(selector=>{
        const control=document.querySelector(selector);
        if(!visible(control)||control.disabled||control.getAttribute('aria-disabled')==='true')return;
        control.scrollIntoView({block:'center',inline:'center',behavior:'instant'});
        const rect=control.getBoundingClientRect();
        return {x:rect.left+rect.width/2,y:rect.top+rect.height/2};
      },selector);
      if(!point)return false;
      for(const type of ['mousePressed','mouseReleased'])
        await call('Input.dispatchMouseEvent',{type,...point,button:'left',clickCount:1});
      return true;
    };
    await call('Page.enable');
    await call('Network.enable');
    await call('Network.setCacheDisabled',{cacheDisabled:true});
    await call('Network.setBypassServiceWorker',{bypass:true});
    await call('Fetch.enable',{patterns:[{urlPattern:'*'}]});
    const hasOverflow=width=>evaluate(width=>document.documentElement.scrollWidth>width+2, width);
    const issues=[], surfaces=[];
    for(const width of [1280,390]){
      await call('Emulation.setDeviceMetricsOverride',{width,height:844,deviceScaleFactor:1,mobile:width===390});
      const navigation=await call('Page.navigate',{url});
      await waitFor(url=>location.href===url&&document.readyState!=='loading',url);
      if(navigation.errorText){issues.push(`${width}px: каталог не відкрився.`);continue;}
      await shown(models);
      const cards=await evaluate(async selector=>{
        return Promise.all([...document.querySelectorAll(selector)].filter(visible).slice(0,200).map(async card=>{
          const img=card.querySelector('img');
          if(img?.loading==='lazy')img.loading='eager';
          if(img)await Promise.race([img.decode().catch(()=>{}),new Promise(done=>setTimeout(done,1200))]);
          return {id:card.getAttribute('data-product-model'),image:img?.currentSrc,width:img?.naturalWidth??0};
        }));
      },models)??[];
      const ids=[...new Set(cards.map(card=>card.id).filter(id=>/^[A-Za-z0-9_.-]{1,80}$/.test(id??'')))];
      const hashes=new Map();
      for(const image of new Set(cards.filter(card=>card.width>0).map(card=>card.image))){
        const target=URL.parse(image??'');
        if(target?.origin!==origin)continue;
        try{
          const response=await fetch(target,{signal,redirect:'error'});
          if(!response.ok||!response.headers.get('content-type')?.startsWith('image/')){await response.body?.cancel();continue;}
          const hash=createHash('sha256');
          for await(const chunk of response.body)hash.update(chunk);
          hashes.set(image,hash.digest('hex'));
        }catch{signal.throwIfAborted();}
      }
      const primaryImages=new Map();
      for(const card of cards){
        if(!primaryImages.has(card.id)&&hashes.has(card.image))primaryImages.set(card.id,hashes.get(card.image));
      }
      const uniqueImages=new Set(ids.map(id=>primaryImages.get(id)).filter(Boolean));
      const broken=cards.filter(card=>!card.width||!hashes.get(card.image)).length;
      if(ids.length<minimum)issues.push(`${width}px: ${ids.length} різних моделей, потрібно ${minimum}.`);
      if(uniqueImages.size<ids.length||broken)issues.push(`${width}px: ${uniqueImages.size} унікальних фото, ${broken} відсутніх або пошкоджених.`);
      if(await hasOverflow(width))issues.push(`${width}px: каталог виходить за ширину екрана.`);
      if(output){
        const {data}=await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
        await mkdir(output,{recursive:true});
        await writeFile(join(output,`${width}.png`),Buffer.from(data,'base64'));
      }
      if(ids.length>=2){
        const selector=id=>`[data-product-model=${JSON.stringify(id)}]`;
        if(!await click(selector(ids[0])+' [data-storefront-compare]')||
           !await click(selector(ids[1])+' [data-storefront-compare]')||!await click('[data-storefront-compare-open]')||
           !await waitFor(ids=>ids.every(id=>[...document.querySelectorAll('[data-compared-model]')].some(el=>visible(el)&&el.getAttribute('data-compared-model')===id)),ids.slice(0,2))||
           !await click('[data-storefront-differences]')||
           !await waitFor(ids=>{
             if(document.querySelector('[data-storefront-differences]')?.getAttribute('aria-pressed')!=='true'||
               [...document.querySelectorAll('[data-comparison-same]')].some(visible))return false;
             const first=document.querySelector(`[data-compared-model=${JSON.stringify(ids[0])}]`);
             const table=first?.closest('table, [role="table"], [role="grid"]');
             const rows=table?.querySelector(`[data-compared-model=${JSON.stringify(ids[1])}]`)
               ?table.querySelectorAll('tr, [role="row"]'):document.querySelectorAll('[data-comparison-different]');
             return [...rows].some(row=>{
               if(!visible(row)||row.querySelector('[data-compared-model]'))return false;
               const cells=[...row.querySelectorAll('td, [role="cell"], [role="gridcell"]')].filter(visible).map(cell=>cell.textContent.trim());
               return cells.length>=2&&cells.every(Boolean)&&new Set(cells).size>=2;
             });
           },ids.slice(0,2))){
          issues.push(`${width}px: не вдалося порівняти дві різні моделі та увімкнути режим відмінностей.`);
        }
        else if(await hasOverflow(width))issues.push(`${width}px: сторінка порівняння виходить за ширину екрана.`);
        await call('Page.navigate',{url});
        if(!await click(selector(ids[0])+' [data-storefront-add]')||!await click('[data-storefront-cart]')||
           !await shown(`[data-cart-model=${JSON.stringify(ids[0])}]`)||!await click('[data-storefront-checkout]')||
           !await shown('[data-checkout-form] input:not([type="hidden"]):not(:disabled), [data-checkout-form] select:not(:disabled)')){
          issues.push(`${width}px: не вдалося пройти від картки через кошик до форми оформлення.`);
        }
        else if(await hasOverflow(width))issues.push(`${width}px: оформлення виходить за ширину екрана.`);
      }
      surfaces.push({width,models:ids.length,uniqueImages:uniqueImages.size,brokenImages:broken});
    }
    const result={status:issues.length?'failed':'passed',issues,surfaces};
    if(output)await writeFile(join(output,'audit.json'),JSON.stringify(result,null,2));
    return result;
  }catch(error){
    parentSignal?.throwIfAborted();
    return {status:'unavailable',issues:[deadline.aborted?'Незалежна браузерна перевірка не завершилась за 38 секунд.':error.message]};
  }finally{
    await connection?.stop();
    await rm(profile,{recursive:true,force:true,maxRetries:5,retryDelay:150}).catch(()=>{});
  }
}
