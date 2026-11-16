import {catalogAgent} from './agent-library.js';
import {validatePlan,validateAssignments} from './planning.js';

export function plannerChoices(catalog,now=Date.now()) {
  return (catalog?.routes??[]).filter(route=>route.decision?.allowed===true&&Date.parse(route.expiresAt)>now&&
    (route.capabilities?.structuredOutput===true||route.capabilities?.jsonOutput==='prompt_validated'));
}

export function draftRoutingInput(draft) {
  validatePlan(draft.plan);
  return {name:draft.name,description:draft.idea?.summary??draft.description,plan:draft.plan,
    ...(draft.managerRouteId?{managerRouteId:draft.managerRouteId}:{}),priority:draft.priority==='cost'?'economy':draft.priority,
    maxAgentsPerTask:draft.maxAgentsPerTask??1,requirements:Object.fromEntries(draft.plan.tasks.map(task=>[task.id,{
      workspaceWrite:draft.requirements?.[task.id]!=='text',...(draft.freeWorkers?{billing:'free_tier'}:{})}]))};
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
  return {profiles:profiles.filter(p=>team.includes(p.id)),project:{id,name:draft.name,description:draft.idea?.summary??draft.description,icon:'layers',team,tasks,
    concurrency:3,maxCalls:50,revision:1,status:'idle',events:[],artifacts:[],
    planning:{mode:draft.mode,originalBrief:draft.description,priority:draft.priority,managerRouteId:draft.managerRouteId||null,
      idea:draft.idea,plan:draft.plan,routing,ideaSource:draft.ideaSource,planSource:draft.planSource,teamSource:draft.teamSource}}};
}
