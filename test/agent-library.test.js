import test from 'node:test';
import assert from 'node:assert/strict';
import {agentLibraryItems,agentLibraryGroups,reasoningChoices,resolveReasoningChoice,catalogAgent,filterAgentLibrary,addCatalogAgentToProject,renderAgentLibrary,preferredAgentRuntime} from '../apps/web/src/agent-library.js';
const now=Date.now();
const route=(id='antigravity:gemini-4-hydrogen-high',change={})=>({id,backend:id.split(':')[0],model:id.slice(id.indexOf(':')+1),name:'Gemini Hydrogen High',billing:'subscription_included',billingBoundary:'included_only',availability:'ready',runtimeSupported:true,checkedAt:new Date(now-1000).toISOString(),expiresAt:new Date(now+60000).toISOString(),decision:{allowed:true,reason:'Verified subscription'},capabilities:{code:true,workspaceWrite:true,tools:false},...change});
const state=()=>({agents:[{id:'architect',name:'Role',skills:['architecture']}],projects:[{id:'p',name:'Project',team:['architect'],revision:1,status:'idle'}]});
const h=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const helpers={h,icon:()=>'',avatar:()=>'<span>AI</span>',button:(a,text,_icon,_class='',extra='')=>`<button data-action="${a}" ${extra}>${text}</button>`,renderProfile:p=>`<article>${h(p.name)}</article>`};

test('agent library derives all live model routes, deduplicates IDs and retains unavailable saved profiles',()=>{
  const a=route(),b=route('opencode:opencode/free',{name:'Free model',billing:'free_tier'}),saved=catalogAgent(a);
  assert.equal(catalogAgent(a).id,saved.id);
  const items=agentLibraryItems({routes:[a,b,a]},[saved],now);
  assert.equal(items.length,2);assert.ok(items.every(i=>i.available));assert.equal(items[0].profile.id,saved.id);
  const orphan=agentLibraryItems({routes:[b]},[saved],now).find(i=>i.id===a.id);
  assert.equal(orphan.available,false);assert.match(orphan.reason,/відсутня/);
  assert.equal(agentLibraryItems(null,[],now).length,0);
});
test('cached decisions never make expired, unknown or denied models available',()=>{
  for(const r of [route(undefined,{expiresAt:new Date(now-1).toISOString()}),route(undefined,{checkedAt:new Date(now+120000).toISOString()}),route(undefined,{decision:{allowed:false,reason:'Quota exhausted'}}),route(undefined,{decision:undefined})]){
    const [item]=agentLibraryItems({routes:[r]},[],now);assert.equal(item.available,false);
  }
  const items=agentLibraryItems({routes:[route(),route('opencode:opencode/free',{name:'DeepSeek Free',billing:'free_tier'}),route('codex:model',{decision:{allowed:false,reason:'quota'}})]},[],now);
  assert.equal(filterAgentLibrary(items,{query:'HYDROGEN',backend:'antigravity',billing:'subscription_included',status:'available'}).length,1);
  assert.equal(filterAgentLibrary(items,{billing:'free_tier'}).length,1);
  assert.equal(filterAgentLibrary(items,{status:'blocked'}).length,1);
  assert.equal(filterAgentLibrary(items,{query:'missing'}).length,0);
});
test('adding a catalog agent preserves real route identity, updates only selected team and is idempotent',()=>{
  const s=state(),r=route(),catalog={routes:[r]};s.projects.push({...s.projects[0],id:'other',team:['architect']});
  const result=addCatalogAgentToProject(s,catalog,r.id,'other',{now});
  assert.equal(result.profile.routeId,r.id);assert.equal(result.profile.model,r.model);assert.equal(result.profile.backend,'antigravity');
  assert.equal(s.agents.length,2);assert.equal(s.projects[0].revision,1);assert.equal(s.projects[0].team.length,1);
  assert.equal(s.projects[1].revision,2);assert.ok(s.projects[1].team.includes(result.profile.id));
  assert.equal(addCatalogAgentToProject(s,catalog,r.id,'other',{now}).changed,false);assert.equal(s.agents.length,2);assert.equal(s.projects[1].revision,2);
});
test('unavailable routes, active projects and profile limits cannot mutate a team',()=>{
  const r=route();
  for(const status of ['running','paused']){const s=state();s.projects[0].status=status;const before=structuredClone(s);assert.throws(()=>addCatalogAgentToProject(s,{routes:[r]},r.id,'p',{now}),/Завершіть/);assert.deepEqual(s,before);}
  const s=state(),before=structuredClone(s);
  assert.throws(()=>addCatalogAgentToProject(s,{routes:[route(undefined,{decision:{allowed:false,reason:'Quota blocked'}})]},r.id,'p',{now}),/Quota blocked/);
  assert.throws(()=>addCatalogAgentToProject(s,{routes:[r]},r.id,'missing',{now}),/Оберіть/);assert.deepEqual(s,before);
  s.agents=Array.from({length:100},(_,i)=>({id:String(i)}));assert.throws(()=>addCatalogAgentToProject(s,{routes:[r]},r.id,'p',{now}),/100/);assert.equal(s.projects[0].team.length,1);
});
test('manual launch selects the exact catalog route rather than another model or a blocked default',()=>{
  const r=route(),profile=catalogAgent(r),rt=[{id:'wrong#write',routeId:'other',allowed:true,access:'workspace-write'},
    {id:'exact#read',routeId:r.id,allowed:true,access:'read-only'},{id:'exact#write',routeId:r.id,allowed:true,access:'workspace-write'}];
  assert.equal(preferredAgentRuntime(profile,rt),'exact#write');
  assert.equal(preferredAgentRuntime(profile,rt.map(x=>({...x,allowed:x.routeId!=='antigravity:gemini-4-hydrogen-high'}))),null);
  assert.equal(preferredAgentRuntime({id:'reviewer'},rt),'exact#read');
});
test('library renders accessible filters, live cards, block reasons and helpful empty results with escaped content',()=>{
  const r=route(undefined,{name:'<img src=x onerror=alert(1)>',decision:{allowed:false,reason:'<blocked>'}});
  const html=renderAgentLibrary({routes:[r]},state().agents,{status:'all'},helpers);
  assert.match(html,/role="search"/);assert.match(html,/data-agent-filter="query"/);assert.match(html,/&lt;img/);assert.doesNotMatch(html,/<img src=x/);
  assert.match(html,/&lt;blocked&gt;/);assert.match(html,/data-action="catalog-agent-add"[^>]*disabled/);
  assert.match(html,/Рольові та власні профілі \(1\)/);
  const empty=renderAgentLibrary({routes:[r]},[],{query:'absent'},helpers);
  assert.match(empty,/Спробуйте іншу назву/);assert.match(empty,/agent-library-reset/);
});

test('reasoning variants become one card per provider and base model without merging distinct model names',()=>{
  const rows=['low','medium','high'].map(level=>route(`antigravity:claude-opus-5-5-${level}`,{name:`Claude Opus 5.5 (${level[0].toUpperCase()+level.slice(1)})`}));
  rows.push(route('codex:claude-opus-5-5',{name:'Claude Opus 5.5'}),route('antigravity:gemini-pro-orchestrator-g1-pro',{name:'Orchestrator (Argon)'}));
  const catalog={routes:rows},groups=agentLibraryGroups(catalog,[],now);
  assert.equal(groups.length,3);assert.equal(groups[0].profile.name,'Claude Opus 5.5');assert.equal(groups[0].profile.model,'claude-opus-5-5');assert.equal(groups[0].variants.length,3);
  assert.deepEqual(reasoningChoices(groups[0]).map(c=>c.label),['Низький','Середній','Високий']);
  assert.equal(groups[2].profile.name,'Orchestrator (Argon)');
  const html=renderAgentLibrary(catalog,[],{status:'all'},helpers);
  assert.equal((html.match(/<h3>Claude Opus 5.5<\/h3>/g)??[]).length,2);
  assert.doesNotMatch(html,/Claude Opus 5.5 \((Low|Medium|High)\)/);
  const choice=resolveReasoningChoice(catalog,[],groups[0].id,rows[2].id,now);
  const s=state(),added=addCatalogAgentToProject(s,catalog,choice.item.id,'p',{now});
  assert.equal(added.profile.model,'claude-opus-5-5-high');assert.equal(added.profile.routeId,rows[2].id);
  assert.throws(()=>resolveReasoningChoice(catalog,[],groups[0].id,'unknown',now),/Оберіть/);
});

test('a model group remains available when one level is denied but cannot select the denied level',()=>{
  const low=route('antigravity:gemini-4-hydrogen-low',{name:'Gemini 4 Hydrogen (Low)'}),high=route('antigravity:gemini-4-hydrogen-high',{name:'Gemini 4 Hydrogen (High)',decision:{allowed:false,reason:'Quota unavailable'}});
  const c={routes:[high,low]},[g]=agentLibraryGroups(c,[],now);
  assert.equal(g.available,true);assert.equal(g.reason,'Verified subscription');
  assert.throws(()=>resolveReasoningChoice(c,[],g.id,high.id,now),/Quota unavailable/);
  assert.equal(resolveReasoningChoice(c,[],g.id,low.id,now).item.profile.model,low.model);
});

test('Codex reasoning choices come from metadata, persist independently and preselect the same runtime',()=>{
  const r=route('codex:model',{name:'Codex Model',reasoningEfforts:['low','high']}),c={routes:[r]},s=state();
  const [g]=agentLibraryGroups(c,[],now);assert.deepEqual(reasoningChoices(g).map(x=>x.value),['effort:low','effort:high']);
  for(const effort of ['low','high']) {
    const choice=resolveReasoningChoice(c,[],g.id,`effort:${effort}`,now);
    const {profile}=addCatalogAgentToProject(s,c,choice.item.id,'p',{now,reasoningEffort:choice.reasoningEffort});
    assert.equal(profile.reasoningEffort,effort);assert.equal(profile.routeId,r.id);
    assert.equal(preferredAgentRuntime(profile,[{id:'chosen',routeId:r.id,access:'workspace-write',allowed:true}]),'chosen');
  }
  assert.notEqual(s.agents[1].id,s.agents[2].id);assert.equal(s.projects[0].team.length,3);
  const before=structuredClone(s);assert.throws(()=>addCatalogAgentToProject(s,c,r.id,'p',{now,reasoningEffort:'ultra'}),/недоступний/);assert.deepEqual(s,before);
  assert.equal(agentLibraryGroups(c,s.agents,now).length,1);
});
