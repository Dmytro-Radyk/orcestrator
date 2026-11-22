import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {renameSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {replaceWithRetry} from '../src/store.js';

test('atomic replacement survives transient Windows file locks without losing either JSON snapshot',async t=>{
  const root=resolve('.orchestrator/tests');await mkdir(root,{recursive:true});const dir=await mkdtemp(join(root,'store-lock-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));const target=join(dir,'state.json'),source=target+'.tmp';
  await writeFile(target,JSON.stringify({revision:1}));await writeFile(source,JSON.stringify({revision:2}));
  let attempts=0;const waits=[];
  replaceWithRetry(source,target,{rename:(a,b)=>{if(++attempts<=3)throw Object.assign(Error('sharing violation'),{code:['EPERM','EACCES','EBUSY'][attempts-1]});renameSync(a,b);},wait:ms=>waits.push(ms)});
  assert.equal(attempts,4);assert.deepEqual(waits,[10,20,40]);assert.deepEqual(JSON.parse(await readFile(target,'utf8')),{revision:2});
});

test('persistent locks are bounded and unrelated storage failures fail immediately',()=>{
  for(const code of ['EPERM','EIO']){
    let attempts=0,waits=0;const error=Object.assign(Error('storage unavailable'),{code});
    assert.throws(()=>replaceWithRetry('source','target',{rename:()=>{attempts++;throw error;},wait:()=>waits++}),e=>e===error);
    assert.equal(attempts,code==='EPERM'?8:1);assert.equal(waits,code==='EPERM'?7:0);
  }
});
