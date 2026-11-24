import test from 'node:test';
import assert from 'node:assert/strict';
import {saveProjectDraft,restoreProjectDraft,clearProjectDraft} from '../apps/web/src/project-draft.js';
import {demoIdea,demoPlan} from '../apps/web/src/planning.js';
import {answeredInterview,needsInterview} from '../apps/web/src/project-interview.js';
const storage=()=>{const data=new Map();return{getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v),removeItem:k=>data.delete(k)};};
const brief={name:'Shop',description:'A local shop',mode:'idea'};

test('wizard restores unanswered questions and typed replies before generating a concept',()=>{
  const memory=storage();
  const interview=[{topic:'audience',question:'Who shops here?',answer:' Readers '},{topic:'design',question:'What style?'}];
  const draft={...brief,mode:'auto',interviewDescription:brief.description,interview};
  saveProjectDraft(memory,draft);
  const restored=restoreProjectDraft(memory);
  assert.equal(restored.step,2);
  assert.deepEqual(restored.draft.interview,interview);
  assert.deepEqual(answeredInterview(interview),[{...interview[0],answer:'Readers'}]);
  assert.equal(needsInterview({...draft,mode:'ready'}),false);
  saveProjectDraft(memory,{...draft,description:'A different brief'});
  assert.equal(restoreProjectDraft(memory).step,1);
});

test('wizard preserves the accepted concept and plan across reload while discarding an expired server proposal',()=>{
  const memory=storage(),draft={...brief,idea:demoIdea(brief),plan:demoPlan(brief),planSource:{mode:'ai',routeId:'codex:planner'},
    routing:{assignments:[]},proposal:{id:'old-server-proposal'},teamSource:{mode:'ai'},error:'Old error'};
  assert.equal(saveProjectDraft(memory,draft),true);const restored=restoreProjectDraft(memory);
  assert.equal(restored.step,3);assert.deepEqual(restored.draft.plan,draft.plan);assert.deepEqual(restored.draft.idea,draft.idea);
  assert.equal(restored.draft.planSource.routeId,'codex:planner');assert.equal(restored.draft.proposal,null);assert.equal(restored.draft.routing,null);
  assert.equal(restored.draft.teamSource,undefined);assert.equal(restored.draft.error,undefined);
  assert.equal(draft.proposal.id,'old-server-proposal');clearProjectDraft(memory);assert.equal(restoreProjectDraft(memory),null);
});
test('unfinished briefs restore without fabricated content and storage failures do not break the wizard',()=>{
  const memory=storage();saveProjectDraft(memory,brief);assert.equal(restoreProjectDraft(memory).step,1);
  saveProjectDraft(memory,{...brief,idea:demoIdea(brief)});assert.equal(restoreProjectDraft(memory).step,2);
  saveProjectDraft(memory,{...brief,plan:{tasks:[]}});assert.equal(restoreProjectDraft(memory),null);
  const denied={setItem(){throw Error('Unavailable');},getItem(){throw Error('Unavailable');},removeItem(){throw Error('Unavailable');}};
  assert.equal(saveProjectDraft(denied,brief),false);assert.equal(restoreProjectDraft(denied),null);clearProjectDraft(denied);
});
