import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { planningHandler } from '../scripts/planning-service.js';
import { demoPlan } from '../apps/web/src/planning.js';

test('planning HTTP enforces same-origin/token and returns validated AI output',async t=>{
  let calls=0;
  const brief={name:'Local test',description:'A test project'};
  const server=createServer(planningHandler({configured:true,label:'fake-model',provider:'responses',agent:{}},async()=>{calls++;return{text:JSON.stringify(demoPlan(brief))};}));
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});
  const base=`http://127.0.0.1:${server.address().port}`;
  const status=await (await fetch(base+'/api/planning/status')).json();
  assert.equal(status.configured,true); assert.equal(status.model,'fake-model');
  assert.equal((await fetch(base+'/api/planning/status',{headers:{Origin:'https://example.com'}})).status,403);
  const request={method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({kind:'plan',input:brief})};
  assert.equal((await fetch(base+'/api/planning',request)).status,403); assert.equal(calls,0);
  request.headers['X-Planning-Token']=status.token;
  const response=await fetch(base+'/api/planning',request);assert.equal(response.status,200);
  const result=await response.json();assert.equal(result.provenance.mode,'ai');assert.equal(result.value.tasks.length,5);assert.equal(calls,1);
});
