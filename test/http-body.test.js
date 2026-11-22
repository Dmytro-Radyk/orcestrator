import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {readJsonBody} from '../src/http-body.js';

test('JSON request parsing preserves Ukrainian text and emoji at every byte boundary',async()=>{
  const value={acceptanceCriteria:['Жодного надлишкового продажу, підтверджені залишки. 🪐'],answer:'Готовий до запуску, без фактичного запуску'};
  const bytes=Buffer.from(JSON.stringify(value));
  for(let split=1;split<bytes.length;split++)assert.deepEqual(await readJsonBody(Readable.from([bytes.subarray(0,split),bytes.subarray(split)])),value,`byte ${split}`);
});

test('large workspace bodies remain exact across 64 KiB chunks',async()=>{
  const value={projects:[{description:'Продукт '.repeat(10000),tasks:[{acceptanceCriteria:['Жодного надлишкового продажу 🛰️']}]}]};
  const bytes=Buffer.from(JSON.stringify(value)),chunks=[];
  for(let i=0;i<bytes.length;i+=65536)chunks.push(bytes.subarray(i,i+65536));
  assert.deepEqual(await readJsonBody(Readable.from(chunks)),value);
});

test('JSON body limits count bytes and invalid UTF-8 cannot silently corrupt a plan',async()=>{
  await assert.rejects(readJsonBody(Readable.from([Buffer.from('"юю"')]),{maxBytes:4}),/too large/);
  await assert.rejects(readJsonBody(Readable.from([Buffer.from([0x22,0xd1,0x22])])),/encoded|encoding/i);
  assert.deepEqual(await readJsonBody(Readable.from([])),{});
});
