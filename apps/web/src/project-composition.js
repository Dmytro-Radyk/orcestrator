import {catalogAgent} from './agent-library.js';
import {validatePlan,validateAssignments} from './planning.js';
import {recommendedCalls} from './call-budget.js';
import {answeredInterview} from './project-interview.js';

export function plannerChoices(catalog,now=Date.now()) {
  return (catalog?.routes??[]).filter(route=>route.decision?.allowed===true&&Date.parse(route.expiresAt)>now&&
    (route.capabilities?.structuredOutput===true||route.capabilities?.jsonOutput==='prompt_validated'));
}

export function draftRoutingInput(draft) {
  validatePlan(draft.plan);
  const managerRouteId=draft.managerRouteId||(draft.planSource?.mode==='ai'?draft.planSource.routeId:null);
  return {name:draft.name,description:draft.idea?.summary??draft.description,plan:draft.plan,
    ...(managerRouteId?{managerRouteId}:{}),...(!draft.managerRouteId&&managerRouteId?{allowManagerFallback:true}:{}),priority:draft.priority==='cost'?'economy':draft.priority,
    maxAgentsPerTask:draft.maxAgentsPerTask??1,requirements:Object.fromEntries(draft.plan.tasks.map(task=>[task.id,{
      workspaceWrite:draft.requirements?.[task.id]!=='text',...(draft.freeWorkers?{billing:'free_tier'}:{}),
      ...(draft.workerRouteIds?.length?{allowedRouteIds:draft.workerRouteIds}:{})}]))};
}

export function proposalTeam(proposal,plan) {
  if(!proposal||!Array.isArray(proposal.routes)||!Array.isArray(proposal.assignments))throw Error('Потрібен точний підбір моделей');
  const profiles=proposal.routes.map(route=>catalogAgent(route));
  if(new Set(profiles.map(p=>p.id)).size!==profiles.length)throw Error('Повторні маршрути моделей');
  const byRoute=new Map(profiles.map(p=>[p.routeId,p.id]));
  const routing={assignments:proposal.assignments.map(a=>{
    if(!Array.isArray(a.routeIds)||a.routeIds.some(id=>!byRoute.has(id)))throw Error('Модель відсутня у підтвердженому підборі');
    return {taskId:a.taskId,agentIds:a.routeIds.map(id=>byRoute.get(id)),reason:a.reason};
  })};
  validateAssignments(routing,plan,profiles);
  return {profiles,routing};
}

export function composeProject(draft,existingProfiles=[],id=crypto.randomUUID()) {
  validatePlan(draft.plan);
  const {profiles,routing}=draft.teamSource?.mode==='ai'?proposalTeam(draft.proposal,draft.plan):{profiles:existingProfiles,routing:validateAssignments(draft.routing,draft.plan,existingProfiles)};
  const tasks=draft.plan.tasks.map(t=>({...structuredClone(t),status:'pending',agentIds:routing.assignments.find(a=>a.taskId===t.id).agentIds}));
  const team=[...new Set(tasks.flatMap(t=>t.agentIds))];
  const interview=answeredInterview(draft.interview);
  return {profiles:profiles.filter(p=>team.includes(p.id)),project:{id,name:draft.name,description:draft.idea?.summary??draft.description,icon:'layers',team,tasks,
    concurrency:3,maxCalls:Math.max(50,recommendedCalls(tasks)),revision:1,status:'idle',events:[],artifacts:[],
    ...(draft.priority==='economy'?{allowDelegation:false}:{}),
    planning:{mode:draft.mode,originalBrief:draft.description,priority:draft.priority,...(draft.freeWorkers?{freeWorkers:true}:{}),managerRouteId:draft.managerRouteId||draft.proposal?.managerRouteId||(draft.planSource?.mode==='ai'?draft.planSource.routeId:null)||null,
      ...(interview.length?{interview}:{}),idea:draft.idea,plan:draft.plan,routing,ideaSource:draft.ideaSource,planSource:draft.planSource,teamSource:draft.teamSource}}};
}
