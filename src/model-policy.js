export const DEFAULT_MODEL_POLICY=Object.freeze({noAdditionalCharges:true,allowFree:true,allowSubscriptions:true});
export const CATALOG_TTL_MS=5*60*1000;
export const SUBSCRIPTION_QUOTA_CEILING=90;
export function modelAccessError(decision) {
  return Object.assign(new Error(decision.reason),{code:'MODEL_ACCESS_BLOCKED',decisionCode:decision.code});
}

export function routeDecision(route,{now=Date.now(),policy=DEFAULT_MODEL_POLICY}={}) {
  const deny=(code,reason)=>({allowed:false,code,reason});
  if(!route)return deny('not_found','Маршрут моделі не знайдено');
  const checked=Date.parse(route.checkedAt),expires=Date.parse(route.expiresAt);
  if(!Number.isFinite(checked)||checked>now+60000||!Number.isFinite(expires)||expires<=now)return deny('stale','Оновіть перевірку доступу та тарифу');
  if(route.availability!=='ready')return deny(route.availability??'unknown','Доступ або квота моделі не підтверджені');
  if(route.billing==='metered')return deny('metered','Оплата за токени або запити виключена');
  if(!['free_tier','subscription_included'].includes(route.billing))return deny('billing_unknown','Допустимий тариф не підтверджено');
  if(route.billing==='free_tier'&&(!policy.allowFree||route.freeConfirmed!==true))return deny('free_unconfirmed','Безкоштовний тариф не підтверджено');
  if(route.billing==='subscription_included'&&(!policy.allowSubscriptions||route.subscriptionConfirmed!==true||route.includedAccessConfirmed!==true))return deny('subscription_unconfirmed','Включений доступ активної підписки не підтверджено');
  if(route.backend==='codex'&&route.billing==='subscription_included'&&route.subscriptionGuard?.autoReloadDisabled===false)return deny('credit_reload_unknown','Підписку підтверджено. Потрібне підтвердження вимкненого Automatic reload кредитів');
  if(route.billingBoundary==='subscription_quota_guarded') {
    const guard=route.subscriptionGuard,windows=[route.quota?.primary,route.quota?.secondary].filter(Boolean);
    if(route.backend!=='codex'||route.billing!=='subscription_included'||guard?.authType!=='chatgpt')return deny('subscription_auth','Для підписки потрібен штатний вхід ChatGPT');
    if(guard.autoReloadDisabled!==true)return deny('credit_reload_unknown','Підтвердьте, що автоматичне поповнення кредитів вимкнене');
    if(guard.paidCreditsAbsent!==true)return deny('paid_credits_available','Додаткові кредити доступні або їхній стан невідомий');
    if(!windows.length||windows.some(w=>!Number.isFinite(w.usedPercent)||w.usedPercent<0))return deny('quota_unknown','Включена квота підписки не підтверджена');
    if(windows.some(w=>w.usedPercent>=SUBSCRIPTION_QUOTA_CEILING))return deny('quota_reserve',`Квота підписки досягла порога ${SUBSCRIPTION_QUOTA_CEILING}%; дочекайтеся відновлення або оберіть безкоштовну модель`);
  }else if(route.billingBoundary!=='included_only')return deny('billing_boundary_unknown','Не підтверджено зупинку перед додатковими списаннями');
  if(route.runtimeSupported!==true)return deny('runtime_unsupported','Виконання через цей конектор ще не підключене');
  return {allowed:true,code:'allowed',reason:route.billing==='free_tier'?'Підтверджений безкоштовний маршрут':route.billingBoundary==='subscription_quota_guarded'?'Підписка ChatGPT · контроль квоти, без API-ключа':'Включено у підтверджену підписку'};
}

export function chooseManager(routes,{preferredId,now=Date.now()}={}) {
  const candidates=routes.filter(r=>routeDecision(r,{now}).allowed&&(r.capabilities?.structuredOutput===true||r.capabilities?.jsonOutput==='prompt_validated'));
  if(preferredId)return candidates.find(r=>r.id===preferredId)??null;
  // A provider default is evidence of its default, not an invented quality ranking.
  return candidates.find(r=>r.isDefault)??candidates[0]??null;
}
