export function streamRun(engine,run,req,res,{present=async r=>r,onClose=()=>{},hostChecking=()=>false}={}) {
  const raw=new URL(req.url,'http://localhost').searchParams.get('after')??req.headers['last-event-id']??'0';
  if(!/^\d+$/.test(String(raw))||!Number.isSafeInteger(Number(raw))||Number(raw)>run.events.length)throw Error('Некоректний курсор подій');
  const after=Number(raw);let closed=false,finishing=false,unsubscribe=()=>{};
  res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-store','Connection':'keep-alive','X-Accel-Buffering':'no'});res.flushHeaders();
  const close=()=>{if(closed)return;closed=true;clearInterval(heartbeat);unsubscribe();onClose();res.end();};
  function send(type,data,id) {
    if(closed)return;
    if(res.writableLength>2*1024*1024){close();return;}
    res.write(`${id!==undefined?`id: ${id}\n`:''}event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  }
  const meta=()=>({id:run.id,status:run.status,calls:run.calls,finishedAt:run.finishedAt,recovery:run.recovery,hostChecking:hostChecking(),draining:Boolean(engine.controls.get(run.id)?.active.size||engine.controls.get(run.id)?.recovering)&&!['running','paused'].includes(run.status)});
  async function finish() {
    if(closed||finishing||hostChecking()||['running','paused'].includes(run.status)||engine.controls.get(run.id)?.active.size||engine.controls.get(run.id)?.recovering)return;
    finishing=true;
    try{
      const presented=await present(run);
      if(closed||hostChecking()||['running','paused'].includes(run.status)||engine.controls.get(run.id)?.active.size||engine.controls.get(run.id)?.recovering){finishing=false;return;}
      send('finished',{run:presented,cursor:run.events.length},run.events.length);
      close();
    }catch{send('stream-error',{message:'Не вдалося підготувати фінальний звіт'});close();}
  }
  const heartbeat=setInterval(()=>{if(!closed)res.write(': heartbeat\n\n');},15000);heartbeat.unref?.();
  req.on('aborted',close);res.on('close',close);
  unsubscribe=engine.subscribe((changed,event)=>{
    if(changed.id!==run.id)return;
    send('change',{event,run:{...meta(),...(event.type==='recovery.applied'?{project:run.project}:{})},task:event.taskId?run.tasks.find(t=>t.id===event.taskId):null,
      ...(['task.delegated','recovery.applied','task.host_verified'].includes(event.type)?{tasks:run.tasks}:{}),cursor:event.id},event.id);
    void finish();
  });
  send('snapshot',{run:{...run,...meta()},cursor:run.events.length},run.events.length);
  if(after>0)for(let i=after;i<run.events.length&&!closed;i++)send('replay',{event:run.events[i],cursor:i+1},i+1);
  void finish();return close;
}
