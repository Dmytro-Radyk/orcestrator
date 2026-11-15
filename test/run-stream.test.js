import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp,mkdir,rm } from 'node:fs/promises';
import { resolve,join,relative,isAbsolute } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { createApi } from '../src/server.js';
import { readEventStream,applyRunFrame } from '../apps/web/src/event-stream.js';

async function until(fn){for(let n=0;n<300;n++){if(fn())return;await delay(10);}throw Error('Stream timed out');}
test('SSE authenticates, streams progress, replays a disconnected cursor and closes with the final run',async t=>{
  const root=resolve('.orchestrator/tests');await mkdir(root,{recursive:true});const dir=await mkdtemp(join(root,'stream-'));
  let finish;const engine=new Engine(new Store(dir),async(a,ctx)=>{ctx.onEvent({kind:'text',message:'live progress'});await new Promise(r=>{finish=r;});return{text:'done'};});
  const {server,token}=createApi(engine);server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{server.closeAllConnections();server.close();const rel=relative(root,dir);assert.ok(rel&&!rel.startsWith('..')&&!isAbsolute(rel));await rm(dir,{recursive:true,force:true});});
  const run=engine.start(engine.createProject({name:'stream',agents:[{id:'a',provider:'demo',skills:[]}],tasks:[{id:'t',title:'T',prompt:'test',agentIds:['a']}]}).id);
  const url=`http://127.0.0.1:${server.address().port}/runs/${run.id}/events`;
  assert.equal((await fetch(url,{headers:{Accept:'text/event-stream'}})).status,401);
  const controller=new AbortController(),response=await fetch(url,{headers:{Authorization:`Bearer ${token}`,Accept:'text/event-stream'},signal:controller.signal});
  assert.match(response.headers.get('content-type'),/text\/event-stream/);
  const stream=readEventStream(response.body),first=await stream.next(),snapshot=JSON.parse(first.value.data);
  assert.equal(first.value.event,'snapshot');assert.equal(snapshot.run.status,'running');const cursor=snapshot.cursor;
  controller.abort();await stream.return().catch(()=>{});await until(()=>engine.listeners.size===0);
  engine.event(run,'agent.progress',{taskId:'t',message:'while disconnected'});
  const restored=await fetch(url,{headers:{Authorization:`Bearer ${token}`,Accept:'text/event-stream','Last-Event-ID':String(cursor)},signal:AbortSignal.timeout(10000)});
  let replayed=false,completed=false;
  for await(const frame of readEventStream(restored.body)) {
    const data=JSON.parse(frame.data);
    if(frame.event==='replay'&&data.event.message==='while disconnected'){replayed=true;assert.ok(Number(frame.id)>cursor);finish();}
    if(frame.event==='finished'){assert.equal(data.run.status,'completed');assert.equal(data.run.tasks[0].result,'[a]\ndone');completed=true;}
  }
  assert.equal(replayed,true);assert.equal(completed,true);assert.equal(engine.listeners.size,0);
});

test('SSE parser handles split UTF-8, comments, CRLF and multiline data; reducer preserves project metadata and avoids duplicate events',async()=>{
  const bytes=new TextEncoder().encode(': heartbeat\r\nid: 7\r\nevent: change\r\ndata: {"message":\r\ndata: "привіт"}\r\n\r\n');
  const body=new ReadableStream({start(controller){for(let n=0;n<bytes.length;n+=3)controller.enqueue(bytes.slice(n,n+3));controller.close();}});
  const frames=[];for await(const frame of readEventStream(body))frames.push(frame);
  assert.equal(frames.length,1);assert.equal(JSON.parse(frames[0].data).message,'привіт');assert.equal(frames[0].id,'7');
  const run={project:{uiRevision:1},tasks:[{id:'t',status:'pending'}],events:[]};
  const frame={event:'change',data:{run:{status:'running'},task:{id:'t',status:'running'},event:{id:1,type:'task.started'},cursor:1}};
  const first=applyRunFrame(run,frame);const second=applyRunFrame(first.run,frame);
  assert.equal(second.run.events.length,1);assert.equal(second.run.project.uiRevision,1);assert.equal(second.run.tasks[0].status,'running');
});
