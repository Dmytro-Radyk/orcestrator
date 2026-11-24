import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTaskExtensions } from '../scripts/task-extensions.js';

const frontend = {title:'Переробити дизайн каталогу', skills:['frontend'], prompt:'Реалізувати каталог'};
const codex = {provider:'codex'};

test('selects an installed skill by task and limits file-worker context', async t=>{
  const home = await realpath(await mkdtemp(join(tmpdir(),'orcestrator-extensions-')));
  t.after(()=>rm(home,{recursive:true,force:true}));
  const skill = join(home,'skills','ui-ux-pro-max');
  await mkdir(skill,{recursive:true});
  await writeFile(join(skill,'SKILL.md'), '---\nname: ui-ux-pro-max\n---\n# Доступність\n'+'Keep keyboard focus visible.\n'.repeat(210));
  const select = createTaskExtensions(join(home,'absent.json'),{codexHome:home});
  const ui = await select(frontend,codex);
  assert.equal(ui.skills[0].id,'ui-ux-pro-max');
  assert.match(ui.skills[0].text,/^# Доступність/);
  assert.ok(ui.skills[0].text.length <= 4600);
  assert.deepEqual((await select({title:'Build output'},codex)).skills,[]);
  assert.deepEqual((await select({title:'Design build',skills:['build']},codex)).skills,[]);
  assert.ok((await select(frontend,{provider:'antigravity',fileWorker:true})).skills[0].text.length <= 1600);
});

test('allows only matching configured MCP tools on Codex and refuses skill links', async t=>{
  const home = await realpath(await mkdtemp(join(tmpdir(),'orcestrator-extensions-')));
  t.after(()=>rm(home,{recursive:true,force:true}));
  const configPath = join(home,'extensions.json');
  const target = join(home,'elsewhere');
  await mkdir(target);
  await writeFile(join(target,'SKILL.md'),'PRIVATE');
  await mkdir(join(home,'skills'));
  await symlink(target,join(home,'skills','linked'),process.platform==='win32'?'junction':'dir');
  const server = {id:'docs',terms:['frontend'],url:'http://127.0.0.1:3000/mcp',tools:['search']};
  const config = {skills:[{id:'linked',terms:['frontend']}],mcpServers:[server]};
  const save = () => writeFile(configPath,JSON.stringify(config));
  const select = createTaskExtensions(configPath,{codexHome:home});
  await save();
  assert.deepEqual(await select(frontend,codex),{skills:[],mcpServers:[{id:'docs',url:server.url,tools:['search']}]});
  assert.deepEqual((await select(frontend,{provider:'opencode',fileWorker:true})).mcpServers,[]);
  assert.deepEqual((await select({title:'Database schema',skills:['backend']},codex)).mcpServers,[]);
  server.url='http://user:pass@127.0.0.1:3000/mcp';
  await save();
  assert.match((await select(frontend,codex)).warning,/Некоректний/);
});

test('workspace hook offers relevant check names and keeps raw shell definitions out of the prompt',async t=>{
  const root=await mkdtemp(join(tmpdir(),'orcestrator-hooks-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  await writeFile(join(root,'package.json'),JSON.stringify({packageManager:'pnpm@10.0.0',scripts:{
    build:'private definition',test:'private definition','check:frontend':'private definition','deploy':'private definition','test&&other':'private definition'
  }}));
  const select=createTaskExtensions(join(root,'absent.json'),{codexHome:root});
  const {hooks}=await select(frontend,codex,{cwd:root});
  assert.equal(hooks[0].id,'workspace-checks');
  assert.match(hooks[0].text,/pnpm run check:frontend/);
  assert.doesNotMatch(hooks[0].text,/private definition|deploy|&&/);
});
