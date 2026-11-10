import test from 'node:test';
import assert from 'node:assert/strict';
import { seed } from '../apps/web/src/state.js';
import { demoIdea, demoPlan, demoAssignments, validateIdea, validatePlan, validateAssignments } from '../apps/web/src/planning.js';
import { plannerConfig, generatePlanning } from '../scripts/planning-service.js';

const brief={name:'Portal',description:'Кабінет користувача з API та інтерфейсом.'};
const config={configured:true,label:'test-model',provider:'responses',agent:{provider:'responses',model:'test-model'}};
test('planning examples have criteria, parallel branches and task-specific assignments',()=>{
  validateIdea(demoIdea(brief)); const plan=validatePlan(demoPlan(brief)), agents=seed().agents;
  const routing=validateAssignments(demoAssignments(plan,agents),plan,agents);
  assert.deepEqual(plan.tasks.find(t=>t.id==='backend').dependsOn,['requirements']);
  assert.deepEqual(plan.tasks.find(t=>t.id==='frontend').dependsOn,['requirements']);
  assert.equal(routing.assignments.find(a=>a.taskId==='review').agentIds[0],'reviewer');
  assert.equal(routing.assignments.find(a=>a.taskId==='integrate').agentIds.length,2);
});
test('AI output cannot introduce cycles, unknown agents or missing task assignments',()=>{
  const plan=demoPlan(brief), agents=seed().agents;
  plan.tasks[0].dependsOn=['review']; assert.throws(()=>validatePlan(plan),/цикл/); plan.tasks[0].dependsOn=[];
  const routing=demoAssignments(plan,agents); routing.assignments[0].agentIds=['invented'];
  assert.throws(()=>validateAssignments(routing,plan,agents),/поза каталогом/);
  routing.assignments.pop(); assert.throws(()=>validateAssignments(routing,plan,agents),/кожної/);
  plan.tasks[0].acceptanceCriteria=[]; assert.throws(()=>validatePlan(plan),/критерії/);
});
test('planner stays unavailable without an explicit model and credentials',()=>{
  assert.equal(plannerConfig({}).configured,false);
  assert.equal(plannerConfig({ORCHESTRATOR_PLANNER_MODEL:'x'}).configured,false);
  assert.equal(plannerConfig({ORCHESTRATOR_PLANNER_MODEL:'x',OPENAI_API_KEY:'test'}).configured,true);
  assert.equal(plannerConfig({ORCHESTRATOR_PLANNER_PROVIDER:'codex',ORCHESTRATOR_PLANNER_MODEL:'x'}).configured,true);
});
test('AI plan and routing use the configured model and preserve provenance',async()=>{
  let captured;
  const result=await generatePlanning('plan',brief,config,async(a,ctx)=>{captured={a,ctx};return{text:JSON.stringify(demoPlan(brief)),usage:{total_tokens:10}};});
  assert.equal(captured.a.model,'test-model'); assert.match(captured.ctx.prompt,/критерії/);
  assert.equal(result.provenance.mode,'ai'); assert.equal(result.provenance.usage.total_tokens,10);
  const agents=seed().agents;
  const team=await generatePlanning('team',{...brief,plan:result.value,agents},config,async()=>({text:JSON.stringify(demoAssignments(result.value,agents))}));
  assert.equal(team.value.assignments.length,result.value.tasks.length);
});
test('unconfigured or malformed AI responses fail without silent demo fallback',async()=>{
  await assert.rejects(generatePlanning('plan',brief,{configured:false}),/налаштуйте/);
  await assert.rejects(generatePlanning('plan',brief,config,async()=>({text:'not JSON'})),SyntaxError);
});
