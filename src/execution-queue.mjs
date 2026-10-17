const unresolved=state=>state.busy || state.ledger.intents.some(intent=>!intent.settled);
const fail=message=>Object.assign(new Error(message),{status:409});

/** Durable single lane; demo work never falls through to the fixture executor. */
export class ExecutionQueue {
  constructor(store,engine,{demoExecutor=()=>null}={}){this.store=store;this.engine=engine;this.demoExecutor=demoExecutor;this.pumping=false;this.closing=false;this.drainWaiters=[];}
  recover() {
    for(const saved of this.store.list())if(['QUEUED','RUNNING'].includes(saved.queue?.state))this.store.update(saved.id,state=>{
      const held=unresolved(state);
      state.queue={...state.queue,state:held?'BLOCKED':'CANCELLED'};
      if(!state.ledger.stopRequested)state.ledger.phase='WAITING';
      return {decision:{kind:'QUEUE_RECOVERY_PAUSED',message:'Yeniden başlatma sonrası görev otomatik yürütülmedi.'}};
    });
  }
  enqueue(id) {
    const recorded=this.store.get(id);
    if(recorded?.approvalRequest) return this.view(id); // A consumed approval never requeues.
    this.store.assertNewWorkAllowed();
    if(this.closing)throw fail('Yürütücü kapanıyor; yeni iş kabul edilmiyor.');
    if(this.store.hasUnappliedObservations())throw fail('Gerçekleşme kaydı operatör kontrolü bekliyor. Yeni görev sıraya alınmadı.');
    const current=this.store.get(id);
    if(current?.mode!=='fixture')throw fail('Bu görev için doğrulanmış demo yürütücüsü henüz hazır değil.');
    if(['QUEUED','RUNNING','BLOCKED'].includes(current?.queue?.state))return this.view(id);
    if(this.store.listQueued().length>=3)throw Object.assign(fail('Üç bekleyen görev kapasitesi dolu.'),{code:'QUEUE_CAPACITY_EXCEEDED'});
    if(this.store.listRuntime().some(state=>state.ledger.intents.some(intent=>!intent.settled && ['UNKNOWN','CANCEL_PENDING'].includes(intent.state))))
      throw fail('Belirsiz işlem veya bekleyen iptal uzlaştırılmadan yeni görev sıraya alınamaz.');
    this.store.update(id,state=>{
      if(state.ledger.phase!=='RUNNING' || state.ledger.stopRequested || unresolved(state))throw fail('Görev kuyruğa alınamaz.');
      if(!this.engine.isExecutionAuthorized(state))throw fail('Oturum yetkisi sona erdi.');
      const now=Date.now();state.queue={state:'QUEUED',enqueuedAtMs:now,expiresAtMs:Math.min(now+120000,state.policy.expiresAtMs)};
      return {decision:{kind:'QUEUE_ENTERED',message:'Görev tek yürütücünün sırasına alındı.'}};
    });return this.view(id);
  }
  waiting() {
    return this.store.listQueued()
      .sort((a,b)=>a.queue.enqueuedAtMs-b.queue.enqueuedAtMs || a.id.localeCompare(b.id));
  }
  view(id) {
    const task=this.engine.view(id),index=this.waiting().findIndex(state=>state.id===id);
    const waitingForReconciliation=this.store.listRuntime().some(state=>state.ledger.intents.some(intent=>!intent.settled && ['UNKNOWN','CANCEL_PENDING'].includes(intent.state)));
    return {...task,queueInfo:{state:task.queue?.state || 'NOT_QUEUED',position:index<0?null:index+1,waitingForReconciliation}};
  }
  cancelWaiting(id) {
    if(this.store.get(id)?.queue?.state==='QUEUED')this.store.update(id,state=>{
      state.queue.state='CANCELLED';return {decision:{kind:'QUEUE_CANCELLED',message:'Bekleyen görev sıradan çıkarıldı.'}};
    });
  }
  async pump() {
    if(this.pumping || this.closing)return;this.pumping=true;
    try {
      // UNKNOWN / pending cancellation / incomplete fee reconciliation all hold the lane.
      for(const saved of this.store.listRuntime())if(['RUNNING','BLOCKED'].includes(saved.queue?.state) && !unresolved(saved))this.store.update(saved.id,state=>{
        state.queue.state='RELEASED';return {decision:{kind:'QUEUE_RELEASED',message:'Açık intent kalmadı; yürütücü serbest.'}};
      });
      if(this.store.globalSafetyStatus().paused || this.store.hasUnappliedObservations() || this.store.listRuntime().some(unresolved))return;
      const next=this.waiting()[0];if(!next)return;
      const demo=next.mode==='demo-prepared',executor=demo?this.demoExecutor():this.engine;
      if(next.ledger.stopRequested || next.ledger.phase!==(demo?'WAITING':'RUNNING') || Date.now()>=Math.min(next.queue.expiresAtMs || next.policy.expiresAtMs,next.policy.expiresAtMs)) {
        this.engine.stop(next.id);this.cancelWaiting(next.id);return;
      }
      if(!executor)return; // Finite queue deadline still applies; no fixture fallback.
      if(demo && executor.canStartQueuedWork && !executor.canStartQueuedWork())return;
      try {
        if(!this.engine.isExecutionAuthorized(next))throw fail('Oturum yetkisi sona erdi.');
        if(demo)this.store.startDemoQueue(next.id);
        else this.store.update(next.id,state=>{
          state.queue.state='RUNNING';return {decision:{kind:'QUEUE_STARTED',message:'Yerel senaryo yürütücüsü görevi aldı.'}};
        });
        const result=await executor.run(next.id);
        this.store.update(next.id,state=>{
          state.queue.state=unresolved(state)?'BLOCKED':'RELEASED';
          if(!unresolved(state) && !state.ledger.stopRequested)state.ledger.phase='WAITING';
          return {decision:{kind:unresolved(state)?'QUEUE_RECONCILIATION_REQUIRED':'QUEUE_RELEASED',
            executionCode:typeof result?.code==='string' && /^[A-Z_]{1,64}$/.test(result.code)?result.code:null,
            message:'Yeni gönderim tekrarı yok; açık intent varsa sıra korunuyor.'}};
        });
      }
      catch {
        this.store.update(next.id,state=>{
          if(!unresolved(state) && !state.ledger.stopRequested)state.ledger.phase='WAITING';
          state.queue.state=unresolved(state)?'BLOCKED':'RELEASED';
          return {decision:{kind:'QUEUE_EXECUTION_PAUSED',message:'Yürütme durdu. Otomatik tekrar gönderim yok.'}};
        });
      }
    } finally {this.pumping=false;for(const resolve of this.drainWaiters.splice(0))resolve();}
  }
  close(){this.closing=true;return this.pumping?new Promise(resolve=>this.drainWaiters.push(resolve)):Promise.resolve();}
}
