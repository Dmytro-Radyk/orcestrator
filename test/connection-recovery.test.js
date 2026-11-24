import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,realpath,rm,writeFile } from 'node:fs/promises';
import { join,relative,sep } from 'node:path';
import { tmpdir } from 'node:os';
import { createConnectionRecovery,serviceLauncher } from '../scripts/connection-recovery.js';
import { createTaskExtensions } from '../scripts/task-extensions.js';

test('registered local MCPs start once and are admitted only after a successful handshake',async()=>{
  let online=false,starts=0;
  const ensure=createConnectionRecovery({
    request:async(_url,options)=>{
      assert.equal(JSON.parse(options.body).method,'initialize');
      if(!online)throw Error('connection refused');
      return new Response('data: {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18"}}\n\n',
        {headers:{'Content-Type':'text/event-stream'}});
    },
    start:async()=>{starts++;online=true;},
    sleep:async()=>{}
  });
  const entry={url:'http://127.0.0.1:9000/mcp',kind:'mcp',start:{executable:process.execPath}};
  assert.deepEqual(await Promise.all([ensure(entry),ensure(entry)]),[
    {state:'ready',started:true},{state:'ready',started:true}
  ]);
  assert.deepEqual(await ensure(entry),{state:'ready'});
  assert.equal(starts,1);
  assert.throws(()=>serviceLauncher(entry.start,'https://example.com/mcp'));
});

test('an API retries a transient failure, with no retries on authentication failures',async()=>{
  let count=0;
  const ensure=createConnectionRecovery({
    request:async(_url,options)=>{
      assert.equal(options.method,'GET');
      return new Response(null,{status:[503,200,401][count++]});
    },
    sleep:async()=>{}
  });
  assert.deepEqual(await ensure({url:'https://example.com/health',kind:'api'}),{state:'ready'});
  assert.deepEqual(await ensure({url:'https://example.com/private-health',kind:'api'}),{state:'auth'});
  assert.equal(count,3);
});

test('a registered MCP fallback keeps its own identity and only the original tool permissions',async t=>{
  const base=await realpath(tmpdir());
  const root=await mkdtemp(join(base,'orcestrator-connection-'));
  t.after(async()=>{
    const target=await realpath(root),rel=relative(base,target);
    assert.ok(rel.startsWith('orcestrator-connection-')&&!rel.includes(sep));
    await rm(target,{recursive:true,force:true});
  });
  const policy=join(root,'extensions.json');
  await writeFile(policy,JSON.stringify({skills:[],mcpServers:[
    {id:'primary',terms:['checkout'],url:'http://127.0.0.1:8001/mcp',tools:['read'],fallback:['insufficient','backup']},
    {id:'insufficient',terms:['unrelated'],url:'http://127.0.0.1:8002/mcp',tools:['write']},
    {id:'backup',terms:['backup'],url:'http://127.0.0.1:8003/mcp',tools:['read','write']}
  ]}));
  const checked=[];
  const extensions=createTaskExtensions(policy,{ensureConnection:async entry=>{
    checked.push(entry.id);
    return {state:entry.id==='primary'?'offline':'ready'};
  }});
  const result=await extensions({title:'Checkout'},{provider:'codex'});
  assert.deepEqual(checked,['primary','backup']);
  assert.deepEqual(result.mcpServers,[{id:'backup',url:'http://127.0.0.1:8003/mcp',tools:['read']}]);
  assert.equal(result.connections[0].replacement,'backup');
});
