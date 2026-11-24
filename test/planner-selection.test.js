import test from 'node:test';
import assert from 'node:assert/strict';
import {createDirector} from '../scripts/director-service.js';
import {routeDecision} from '../src/model-policy.js';

const route=(id,extra={})=>({id:`opencode:${id}`,backend:'opencode',model:id,name:id,connectionId:'opencode',
  billing:'free_tier',freeConfirmed:true,billingBoundary:'included_only',runtimeSupported:true,availability:'ready',
  checkedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+300000).toISOString(),
  capabilities:{jsonOutput:'prompt_validated'},...extra});
function fixture(provider){
  const routes=[route('general',{isDefault:true,description:'General reasoning'}),route('design',{description:'Interface design and product exploration'}),
    route('architecture',{description:'Architecture and dependency analysis'}),route('metered',{billing:'metered'})];
  const registry={snapshot:()=>({routes}),scan:async()=>registry.snapshot(),requireRoute:async id=>{
    const selected=routes.find(r=>r.id===id);assert.equal(routeDecision(selected).allowed,true);return {...selected,command:'fixture-only'};
  }};
  return {routes,director:createDirector({registry,provider,preferredId:'opencode:architecture'})};
}
const input={name:'Dashboard',description:'Create an interactive UI for dashboards',priority:'quality'};

test('project and stage change automatic planner selection; the provider default only bootstraps the decision',async()=>{
  const seen=[];
  const f=fixture(async(agent,ctx)=>{
    assert.equal(agent.model,'general');assert.equal(agent.access,'read-only');assert.ok(!ctx.prompt.includes('opencode:metered'));
    const brief=JSON.parse(ctx.prompt.split('PlannerSelectionBrief: ')[1]);seen.push(brief);
    const selected=brief.stage==='idea'&&brief.description.includes('interactive UI')?'design':'architecture';
    return{text:JSON.stringify({routeId:`opencode:${selected}`,reason:`Matches the ${brief.stage} requirements; specialization is not benchmarked`,command:'ignored'}),usage:{input_tokens:8,output_tokens:5}};
  });
  const idea=await f.director.selectPlanner({kind:'idea',input},AbortSignal.timeout(3000));
  const plan=await f.director.selectPlanner({kind:'plan',input:{...input,idea:{summary:'Accepted UI concept'},feedback:'Include API contracts'}},AbortSignal.timeout(3000));
  const other=await f.director.selectPlanner({kind:'idea',input:{...input,description:'Design a backend service architecture'}},AbortSignal.timeout(3000));
  assert.equal(idea.routeId,'opencode:design');assert.equal(plan.routeId,'opencode:architecture');assert.equal(other.routeId,'opencode:architecture');
  assert.equal(plan.selection.stage,'plan');assert.equal(plan.selection.usage.input_tokens,8);assert.equal(seen[1].feedback,'Include API contracts');
  assert.equal(seen[1].idea.summary,'Accepted UI concept');assert.equal(plan.agent.command,undefined);assert.equal(plan.selection.selector.model,'general');
});

test('a fabricated or forbidden automatic planner is rejected without default-model fallback',async()=>{
  for(const routeId of ['opencode:invented','opencode:metered']){
    const f=fixture(async()=>({text:JSON.stringify({routeId,reason:'Fabricated selection'})}));
    await assert.rejects(f.director.selectPlanner({kind:'plan',input},AbortSignal.timeout(3000)),/невідому модель/);
  }
});

test('planner access is rechecked after AI selection and a changed tariff stops the request',async()=>{
  const f=fixture(async()=>{f.routes[1].billing='metered';return{text:JSON.stringify({routeId:'opencode:design',reason:'UI project'})};});
  await assert.rejects(f.director.selectPlanner({kind:'idea',input},AbortSignal.timeout(3000)),/стала недоступною/);
});

test('only one permitted model needs no extra AI selection call; unavailable catalogs never invoke a selector',async()=>{
  let calls=0;const f=fixture(async()=>{calls++;throw Error('must not run');});f.routes.splice(1);
  const chosen=await f.director.selectPlanner({kind:'plan',input},AbortSignal.timeout(3000));
  assert.equal(chosen.routeId,'opencode:general');assert.equal(chosen.selection.selector,null);assert.equal(calls,0);
  f.routes[0].availability='quota_exhausted';await assert.rejects(f.director.selectPlanner({kind:'plan',input},AbortSignal.timeout(3000)),/Немає підтверджених/);
  assert.equal(calls,0);
});

test('economy chooses a verified free planner without a selector call',async()=>{
  let calls=0;
  const f=fixture(async()=>{calls++;throw Error('Unexpected inference');});
  const chosen=await f.director.selectPlanner({kind:'plan',input:{...input,priority:'economy'}});
  assert.equal(chosen.routeId,'opencode:general');
  assert.equal(chosen.selection.selector,null);
  assert.equal(calls,0);
});

test('an aborted automatic selection cannot start model work',async()=>{
  let calls=0;const f=fixture(async()=>{calls++;}),controller=new AbortController();controller.abort();
  await assert.rejects(f.director.selectPlanner({kind:'idea',input},controller.signal),error=>error.name==='AbortError');assert.equal(calls,0);
});
