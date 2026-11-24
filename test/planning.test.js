import test from 'node:test';
import assert from 'node:assert/strict';
import { seed } from '../apps/web/src/state.js';
import { demoIdea, demoPlan, demoAssignments, validateIdea, validatePlan, validateAssignments } from '../apps/web/src/planning.js';
import { plannerConfig, generatePlanning } from '../scripts/planning-service.js';
import {planningErrorMessage} from '../apps/web/src/planning-errors.js';

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
test('storefront planning adds browser acceptance and working product media from the start',async()=>{
  const shop={name:'Магазин',description:'Інтернет-магазин смартфонів із порівнянням'};
  const plan=demoPlan(shop);
  const {value}=await generatePlanning('plan',shop,config,async(_agent,{prompt})=>{
    assert.match(prompt,/шести різних моделей/);
    assert.match(prompt,/локальними URL/);
    return {text:JSON.stringify(plan)};
  });
  const gate=value.tasks.at(-1);
  assert.equal(gate.id,'storefront-acceptance');
  assert.deepEqual(gate.dependsOn,['integrate']);
  assert.match(gate.prompt,/Оркестратор сам відкриє локальну збірку у Chromium на 1280 і 390 px/);
  assert.match(gate.prompt,/data-product-model/);
  assert.equal(value.tasks.length,plan.tasks.length);
  assert.match(gate.prompt,/Перевірити результати за критеріями/);
  assert.match(value.tasks.find(task=>task.id==='frontend').acceptanceCriteria.join(' '),/зображення товарів, які завантажуються/);
});
test('a brief bookstore request includes browser acceptance and does not imply a server stack',async()=>{
  const config={configured:true,label:'fixture',provider:'opencode',agent:{}};
  const plan=demoPlan({name:'Книгарня',description:'Книгарня'});
  for(const description of ['Книгарня','Книгарня PostgreSQL']){
    const {value}=await generatePlanning('plan',{name:'Книгарня',description},config,async(_agent,{prompt})=>{
      assert.equal(prompt.includes('пріоритет має компактний статичний прототип'),description==='Книгарня');
      return {text:JSON.stringify(plan)};
    });
    assert.equal(value.tasks.at(-1).id,'storefront-acceptance');
  }
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

test('planning errors explain interrupted discovery and timeout without changing other failures',()=>{
  assert.match(planningErrorMessage(Error('Discovery завершено')),/перевірити доступ до Codex/);
  assert.match(planningErrorMessage(Object.assign(Error('Internal deadline'),{code:'METADATA_TIMEOUT'})),/квота не підтверджена/);
  assert.match(planningErrorMessage(new DOMException('Deadline','TimeoutError'),'plan'),/Планування не завершилося/);
  assert.equal(planningErrorMessage(Error('Quota unavailable')),'Quota unavailable');
});

test('cancelled planning never invokes a provider after metadata selection',async()=>{
  const controller=new AbortController();controller.abort();let calls=0;
  await assert.rejects(generatePlanning('plan',brief,config,async()=>{calls++;},controller.signal),error=>error.name==='AbortError');
  assert.equal(calls,0);
});

test('Codex planner uses server-owned schemas, isolated cwd and reasoning provenance',async()=>{
  const cli=plannerConfig({ORCHESTRATOR_PLANNER_PROVIDER:'codex',ORCHESTRATOR_PLANNER_MODEL:'test-model'});
  const result=await generatePlanning('idea',{...brief,outputSchema:'untrusted.json'},cli,async(agent,ctx)=>{
    assert.match(agent.outputSchema,/[\\/]scripts[\\/]schemas[\\/]idea\.json$/);
    assert.match(ctx.cwd,/[\\/]\.orchestrator[\\/]planner[\\/]?$/);
    assert.equal(agent.access,'read-only'); assert.equal(agent.reasoningEffort,'high');
    assert.equal(agent.ephemeral,true); assert.equal(agent.ignoreUserConfig,true);
    return {text:JSON.stringify(demoIdea(brief))};
  });
  assert.equal(result.provenance.reasoningEffort,'high');
  assert.equal(cli.agent.outputSchema,undefined);
  assert.throws(()=>plannerConfig({ORCHESTRATOR_PLANNER_REASONING:'unknown'}),/REASONING/);
});
