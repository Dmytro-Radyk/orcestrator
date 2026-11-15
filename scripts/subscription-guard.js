import { setTimeout as delay } from 'node:timers/promises';
import { routeDecision,modelAccessError } from '../src/model-policy.js';

// One included-subscription invocation at a time per registry, shared by director and workers.
export class SubscriptionGuard {
  constructor({intervalMs=5000}={}) {this.intervalMs=intervalMs;this.busy=false;this.waiters=[];}
  async acquire(signal) {
    signal.throwIfAborted();
    if(this.busy)await new Promise((resolve,reject)=>{
      const waiter={resolve:()=>{signal.removeEventListener('abort',abort);resolve();}};
      const abort=()=>{this.waiters=this.waiters.filter(w=>w!==waiter);reject(signal.reason);};
      this.waiters.push(waiter);signal.addEventListener('abort',abort,{once:true});
    });
    this.busy=true;
    return()=>{const next=this.waiters.shift();if(next)next.resolve();else this.busy=false;};
  }
  async run({authorize,invoke,signal,onEvent}) {
    const release=await this.acquire(signal),controller=new AbortController();
    const combined=AbortSignal.any([signal,controller.signal]);
    const check=async()=>{let route;try{route=await authorize();}catch(error){combined.throwIfAborted();throw error.code==='MODEL_ACCESS_BLOCKED'?error:modelAccessError({code:'subscription_check_failed',reason:error.message});}combined.throwIfAborted();
      const decision=routeDecision(route);
      if(!decision.allowed||route.billingBoundary!=='subscription_quota_guarded')throw modelAccessError(decision.allowed?{code:'subscription_mode_changed',reason:'Режим підписки змінився'}:decision);
      return route;
    };
    try {
      const route=await check();
      void(async()=>{try{while(!combined.aborted){await delay(this.intervalMs,undefined,{signal:combined});await check();}}
        catch(error){if(combined.aborted)return;const blocked=error.code==='MODEL_ACCESS_BLOCKED'?error:modelAccessError({code:'subscription_check_failed',reason:error.message});controller.abort(blocked);try{onEvent?.({kind:'subscription.guard',message:'Виклик зупинено: '+blocked.message});}catch{ /* The provider still receives the abort. */ }}})();
      const result=await invoke(route,combined);combined.throwIfAborted();return result;
    }finally{controller.abort();release();}
  }
}
