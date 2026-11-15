export async function* readEventStream(body) {
  const reader=body.getReader(),decoder=new TextDecoder();let pending='',event='message',id='',data=[];
  function line(value){if(value===''){const frame=data.length?{event,id,data:data.join('\n')}:null;event='message';data=[];return frame;}
    if(value.startsWith(':'))return null;const split=value.indexOf(':'),field=split<0?value:value.slice(0,split),raw=split<0?'':value.slice(split+1).replace(/^ /,'');
    if(field==='event')event=raw;else if(field==='id'&&!raw.includes('\0'))id=raw;else if(field==='data')data.push(raw);return null;}
  try{while(true){const result=await reader.read();pending+=decoder.decode(result.value??new Uint8Array(),{stream:!result.done});
    let end;while((end=pending.indexOf('\n'))>=0){const frame=line(pending.slice(0,end).replace(/\r$/,''));pending=pending.slice(end+1);if(frame)yield frame;}
    if(result.done)break;}
  }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}

export function applyRunFrame(run,frame) {
  const value=typeof frame.data==='string'?JSON.parse(frame.data):frame.data;
  if(frame.event==='snapshot'||frame.event==='finished')return {run:value.run,cursor:value.cursor,finished:frame.event==='finished'};
  if(frame.event!=='change'||!run)return {run,cursor:null};
  const next={...run,...value.run,tasks:value.tasks??[...run.tasks],events:[...run.events]};
  if(value.task){const index=next.tasks.findIndex(t=>t.id===value.task.id);if(index<0)next.tasks.push(value.task);else next.tasks[index]=value.task;}
  if(!next.events.some((event,index)=>(event.id??index+1)===value.cursor))next.events.push(value.event);
  return {run:next,cursor:value.cursor};
}
