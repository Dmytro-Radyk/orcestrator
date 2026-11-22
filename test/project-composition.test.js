import test from 'node:test';
import assert from 'node:assert/strict';
import {plannerChoices,draftRoutingInput,proposalTeam,composeProject} from '../apps/web/src/project-composition.js';
import {demoPlan,demoAssignments} from '../apps/web/src/planning.js';
import {seed} from '../apps/web/src/state.js';

const draft=()=>({name:'Project',description:'Original brief',priority:'economy',managerRouteId:'codex:manager',
  maxAgentsPerTask:2,freeWorkers:true,plan:demoPlan({name:'Project',description:'Original brief'}),idea:{summary:'Accepted concept'},requirements:{review:'text'}});
const proposal=d=>({id:'server-proposal',routes:[{id:'opencode:free',backend:'opencode',model:'free'}],
  assignments:d.plan.tasks.map(t=>({taskId:t.id,routeIds:['opencode:free'],reason:'Verified task-specific selection'}))});

test('draft request preserves manager, worker billing and read-only requirements independently',()=>{
  const d=draft(),input=draftRoutingInput(d);assert.equal(input.description,'Accepted concept');assert.equal(input.managerRouteId,'codex:manager');
  assert.equal(input.requirements.review.workspaceWrite,false);assert.equal(input.requirements.backend.workspaceWrite,true);
  assert.ok(Object.values(input.requirements).every(r=>r.billing==='free_tier'));assert.equal(input.maxAgentsPerTask,2);
  d.freeWorkers=false;d.managerRouteId='';assert.equal(draftRoutingInput(d).managerRouteId,undefined);assert.equal(draftRoutingInput(d).requirements.review.billing,undefined);
});

test('the automatically selected plan model directs the team while an explicit override still wins',()=>{
  const d=draft();d.managerRouteId='';d.planSource={mode:'ai',routeId:'codex:auto-planner'};
  assert.equal(draftRoutingInput(d).managerRouteId,'codex:auto-planner');
  assert.equal(draftRoutingInput(d).allowManagerFallback,true);
  d.managerRouteId='codex:manual';assert.equal(draftRoutingInput(d).managerRouteId,'codex:manual');assert.equal(draftRoutingInput(d).allowManagerFallback,undefined);
  d.managerRouteId='';d.planSource={mode:'demo',routeId:'not-a-real-model'};assert.equal(draftRoutingInput(d).managerRouteId,undefined);
});

test('composition materializes the exact selected model once and preserves editable task IDs and provenance',()=>{
  const d=draft();d.proposal=proposal(d);d.teamSource={mode:'ai',routeId:'codex:manager'};const before=structuredClone(d);
  const {project,profiles}=composeProject(d,seed().agents,'new-project');assert.deepEqual(d,before);assert.equal(profiles.length,1);
  assert.equal(project.team[0],profiles[0].id);assert.equal(profiles[0].routeId,'opencode:free');assert.equal(profiles[0].model,'free');
  assert.deepEqual(project.tasks.map(t=>t.id),d.plan.tasks.map(t=>t.id));assert.equal(project.planning.teamSource.routeId,'codex:manager');
  assert.equal(project.description,'Accepted concept');assert.ok(project.tasks.every(t=>t.status==='pending'&&t.agentIds[0]===profiles[0].id));
  const bad=structuredClone(d.proposal);bad.assignments[0].routeIds=['invented'];assert.throws(()=>proposalTeam(bad,d.plan),/відсутня/);
  bad.assignments=[];assert.throws(()=>proposalTeam(bad,d.plan),/кожної задачі/);
});

test('explicit demo remains a role-based project without a real model proposal',()=>{
  const d=draft(),profiles=seed().agents;d.routing=demoAssignments(d.plan,profiles);d.teamSource={mode:'demo'};
  const composed=composeProject(d,profiles,'demo-project');assert.equal(composed.project.planning.teamSource.mode,'demo');
  assert.ok(composed.project.team.every(id=>profiles.some(p=>p.id===id)));
});

test('manager choices exclude expired, blocked and non-structured routes',()=>{
  const now=Date.now(),route={id:'valid',expiresAt:new Date(now+10000).toISOString(),decision:{allowed:true},capabilities:{jsonOutput:'prompt_validated'}};
  assert.deepEqual(plannerChoices({routes:[route,{...route,id:'expired',expiresAt:new Date(now-1).toISOString()},
    {...route,id:'blocked',decision:{allowed:false}},{...route,id:'plain',capabilities:{}}]},now).map(r=>r.id),['valid']);
});
