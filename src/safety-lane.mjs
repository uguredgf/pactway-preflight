import {requestStop} from './domain/ledger.mjs';
import {SafetyEvidenceCache} from './safety-evidence-cache.mjs';
import {planDemoSafety} from './domain/demo-safety.mjs';

/** Local safety scheduling, independent of the async model worker. QUERY/CANCEL
 * entries are requirements only: no exchange adapter or authority is supplied.
 * UNKNOWN/SUBMITTING keep their original states and reservations until evidence.
 */
export class SafetyLane {
  #running=false;
  #evidence=new SafetyEvidenceCache();
  constructor(store,{isOwnerActive=()=>true}={}) {this.store=store;this.isOwnerActive=isOwnerActive;}
  recoveryView() {
    return {work:this.#evidence.recoveryWork(),transportConnected:false,
      evidenceScope:'PROCESS_LOCAL_PRE_FAILURE_ONLY',executionResumed:false};
  }
  sweep(nowMs) {
    if(!Number.isSafeInteger(nowMs) || nowMs<0)throw new TypeError('Explicit safety time required');
    if(this.#running)return {ok:false,code:'SAFETY_SWEEP_BUSY',transportConnected:false};
    this.#running=true;
    const work=[],failures=[];
    try {
      const global=this.store.globalSafetyStatus();
      for(const saved of this.store.listRuntime()) {
        try {
          if(!this.store.verifySafetyTask(saved))throw new Error('Safety audit evidence unavailable');
          this.#evidence.rememberVerifiedTask(saved);
          const active=saved.ledger.intents.filter(intent=>!intent.settled);
          const campaignPaused=Boolean(saved.campaignId && this.store.campaign(saved.campaignId)?.paused);
          const ownerActive=this.isOwnerActive(saved,nowMs);
          const invalidDemoDeadline=saved.mode==='demo-prepared' && active.some(i=>
            !Number.isSafeInteger(i.createdAtMs) || !Number.isSafeInteger(saved.policy.orderLifetimeMs)
            || saved.policy.orderLifetimeMs<1 || !Number.isSafeInteger(i.createdAtMs+saved.policy.orderLifetimeMs));
          const deadline=nowMs>=saved.policy.expiresAtMs || active.some(i=>Number.isSafeInteger(saved.policy.orderLifetimeMs)
            && nowMs>=i.createdAtMs+saved.policy.orderLifetimeMs);
          const queueExpired=saved.queue?.state==='QUEUED' && nowMs>=Math.min(saved.queue.expiresAtMs ?? saved.policy.expiresAtMs,saved.policy.expiresAtMs);
          const mustStop=global.paused || campaignPaused || invalidDemoDeadline || deadline || queueExpired || !ownerActive;
          if(mustStop && (!saved.ledger.stopRequested || saved.queue?.state==='QUEUED')) {
            this.store.update(saved.id,state=>{
              state.ledger=requestStop(state.ledger);
              if(!state.ledger.intents.some(i=>!i.settled))state.ledger.phase='STOPPED';
              if(state.queue?.state==='QUEUED')state.queue.state='CANCELLED';
              // Do not clear busy: a model call can still be in flight. It must
              // return into the stop/pause gate, rather than free another slot.
              return {decision:{kind:'SAFETY_STOP_REQUESTED',message:'Yeni işlemler durduruldu; varsa açık emir sonucu takip ediliyor.'}};
            });
          }
          const stopped=mustStop || saved.ledger.stopRequested;
          for(const intent of active) {
            const demoPlan=saved.mode==='demo-prepared'?planDemoSafety({task:saved,intent,nowMs,
              globalPaused:global.paused,campaignPaused,ownerActive}):null;
            const uncertain=['UNKNOWN','SUBMITTING'].includes(intent.state);
            const cancel=stopped && ['OPEN','PARTIAL','CANCEL_PENDING'].includes(intent.state);
            work.push(Object.freeze({taskId:saved.id,intentId:intent.id,accountId:saved.policy.accountId,
              connectionVersion:saved.policy.connectionVersion ?? null,clOrdId:intent.clOrdId,ordId:intent.ordId,
              action:demoPlan?.action ?? (uncertain?'QUERY':cancel?'CANCEL_THEN_QUERY':'QUERY'),
              priority:demoPlan?.priority ?? (uncertain?0:cancel?1:2),...(demoPlan?{plan:demoPlan}:{}),
              dispatchAllowed:false,reason:'VERIFIED_SAFETY_TRANSPORT_NOT_CONNECTED'}));
          }
        } catch {failures.push(saved.id);}
      }
      if(failures.length)this.store.pauseGlobal('SAFETY_PROCESSING_FAILED');
      const combined=new Map(work.map(item=>[JSON.stringify([item.taskId,item.intentId]),item]));
      if(failures.length)for(const item of this.#evidence.recoveryWork())combined.set(JSON.stringify([item.taskId,item.intentId]),item);
      return {ok:failures.length===0,failures,work:[...combined.values()].sort((a,b)=>a.priority-b.priority || a.taskId.localeCompare(b.taskId)),
        transportConnected:false};
    } catch {
      this.store.pauseGlobal('SAFETY_PROCESSING_FAILED');
      return {ok:false,failures,work:this.#evidence.recoveryWork(),code:'SAFETY_PROCESSING_FAILED',transportConnected:false};
    } finally {this.#running=false;}
  }
}
