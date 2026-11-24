import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,realpath,rm,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,relative,sep } from 'node:path';
import { resolveProjectRuntime } from '../scripts/project-runtime-profile.js';
import { createDockerReadiness } from '../scripts/project-test-runtime.js';

test('concurrent checks share a Docker restart and wait for its API to become ready',async()=>{
  let starts=0, afterStart=0;
  const waits=[];
  const ensure=createDockerReadiness(async()=>{
    if(!starts||++afterStart<3)throw Error('failed to connect to the docker API');
  },async()=>{starts++;},{sleep:async ms=>{waits.push(ms);}});
  await Promise.all([ensure(),ensure()]);
  assert.equal(starts,1);
  assert.deepEqual(waits,[500,1500]);
});

async function fixture(t,files){
  const base=await realpath(tmpdir());
  const root=await mkdtemp(join(base,'orcestrator-versions-'));
  t.after(async()=>{
    const target=await realpath(root),rel=relative(base,target);
    assert.ok(rel.startsWith('orcestrator-versions-')&&!rel.includes(sep));
    await rm(target,{recursive:true,force:true});
  });
  await Promise.all(Object.entries(files).map(([file,value])=>writeFile(join(root,file),value)));
  return root;
}

test('an older Node and PostgreSQL project gets its declared versions',async t=>{
  const root=await fixture(t,{
    'package.json':'{"engines":{"node":">=22 <23"}}',
    'Dockerfile':'ARG NODE_VERSION=22\nFROM node:${NODE_VERSION}-bookworm-slim\n',
    'compose.yaml':'services:\n  db:\n    image: postgres:${PG_VERSION:-16}-bookworm'
  });
  const profile=await resolveProjectRuntime(root,{includePostgres:true,getVersions:()=>assert.fail('No lookup is required for these versions')});
  assert.deepEqual(profile,{node:'22',postgres:'16'});
});

test('an exact version pin wins and bounded ranges select an actual compatible release',async t=>{
  const root=await fixture(t,{
    'package.json':'{"engines":{"node":">=22.10 <22.15"}}',
    'compose.yml':'services: {db: {image: docker.io/library/postgres:16.6-bookworm}}'
  });
  const getVersions=async()=>['22.14.0','24.0.0','22.15.0','22.10.0'];
  assert.deepEqual(await resolveProjectRuntime(root,{includePostgres:true,getVersions}),{node:'22.14.0',postgres:'16.6'});
  await writeFile(join(root,'.nvmrc'),'v22.10.0\n');
  assert.deepEqual(await resolveProjectRuntime(root,{getVersions:()=>assert.fail('Exact pin already supplied')}),{node:'22.10.0'});
});

test('conflicting requirements are reported without silently choosing a declared alternative',async t=>{
  const root=await fixture(t,{'package.json':'{"engines":{"node":">=24"}}','.node-version':'22'});
  await assert.rejects(resolveProjectRuntime(root,{getVersions:()=>assert.fail('Conflict can be detected offline')}),
    {code:'PROJECT_RUNTIME_CONFLICT'});
});

test('an LTS alias is resolved against released versions and the project engine range',async t=>{
  const root=await fixture(t,{'.nvmrc':'lts/*','package.json':'{"engines":{"node":">=22 <24"}}'});
  const getVersions=async()=>[
    {version:'24.1.0',lts:'Krypton'},{version:'23.11.0',lts:false},{version:'22.17.0',lts:'Jod'}
  ];
  assert.deepEqual(await resolveProjectRuntime(root,{getVersions}),{node:'22.17.0'});
});

test('managed PostgreSQL profiles only accept explicit versions for ambiguous images',async t=>{
  const root=await fixture(t,{'compose.yaml':'services: {db: {image: postgres:latest}}'});
  await assert.rejects(resolveProjectRuntime(root,{includePostgres:true}),{code:'PROJECT_RUNTIME_CONFLICT'});
  await writeFile(join(root,'.orcestrator-runtime.json'),'{"node":"22","postgres":"16"}');
  assert.deepEqual(await resolveProjectRuntime(root,{includePostgres:true}),{node:'22',postgres:'16'});
});
