import {validateIdea,validatePlan} from './planning.js';
import {needsInterview,validateInterview} from './project-interview.js';
const key='orcestrator.project-draft.v1';

const validSource = source => !source || (typeof source === 'object' && ['ai', 'demo'].includes(source.mode));

export function saveProjectDraft(storage,draft){
  try{
    if(!draft.name&&!draft.description&&!draft.idea&&!draft.plan){storage.removeItem(key);return true;}
    storage.setItem(key,JSON.stringify({version:1,draft}));return true;
  }catch{return false;}
}
export function clearProjectDraft(storage){try{storage.removeItem(key);}catch{}}
export function restoreProjectDraft(storage){
  try{
    const saved=JSON.parse(storage.getItem(key));if(saved?.version!==1||!saved.draft)return null;
    const draft=saved.draft;
    if(typeof draft.name!=='string'||draft.name.length>80||typeof draft.description!=='string'||draft.description.length>12000||!['auto','idea','ready'].includes(draft.mode))return null;
    if(!validSource(draft.ideaSource)||!validSource(draft.planSource)||!validSource(draft.interviewSource))return null;
    if(draft.idea)validateIdea(draft.idea);if(draft.plan)validatePlan(draft.plan);
    if(draft.interview!==undefined)validateInterview(draft.interview,{answers:true});
    draft.routing=null;draft.proposal=null;delete draft.teamSource;delete draft.error;
    if(draft.interviewDescription!==undefined&&draft.interviewDescription!==draft.description)return {draft,step:1};
    const inInterview=Boolean(draft.description)&&needsInterview(draft)&&draft.interviewDescription===draft.description;
    return {draft,step:draft.plan?3:(draft.idea||inInterview?2:1)};
  }catch{return null;}
}
