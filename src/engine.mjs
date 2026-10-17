import { randomUUID } from 'node:crypto';
import { hashPolicy, hashCanonical, evaluateCandidate } from './domain/governor.mjs';
import { divDecimal, mulDecimal, parseDecimal, formatDecimal, roundDownToStep } from './domain/money.mjs';
import { createLedger, ledgerSummary, prepareIntent, markSubmitting, markOpen, markUnknown,
  requestStop, markCancelPending, recordFill, markTerminal, reconcileIntent } from './domain/ledger.mjs';
import { createTaskId, verifyAuditChain } from './audit/commitments.mjs';
import {PolicyPlanner} from './planner.mjs';
import {WorkflowDrafts} from './workflow-drafts.mjs';
import {demoPolicyConfiguration,demoPolicyScope,makeDemoPolicy} from './demo-policy.mjs';
import {prepareCampaignTask} from './domain/campaign-task.mjs';

const failure = (message, status=409) => Object.assign(new Error(message), { status });
const active = state => state.ledger.intents.find(intent => !intent.settled);
const queueClosed = state => Boolean(state.approvalRequest && (state.queue?.state!=='RUNNING'
  || !Number.isSafeInteger(state.queue.expiresAtMs) || Date.now()>=state.queue.expiresAtMs));

/** First source slice executes ONLY a clearly labelled local fixture. */
export class Engine {
  constructor(store, planner, {isExecutionAuthorized=()=>true,extractor=null,executionMode='fixture',demoPolicy=null}={}) {
    this.store=store; this.planner=new PolicyPlanner(planner);this.isExecutionAuthorized=isExecutionAuthorized;
    if(!['fixture','demo-prepared'].includes(executionMode) || executionMode==='demo-prepared' && !['openai','ollama'].includes(planner.kind))
      throw failure('Yürütme modu ve model yapılandırması uyuşmuyor.');
    this.executionMode=executionMode;
    const configuration=executionMode==='demo-prepared'?demoPolicyConfiguration(demoPolicy):null;
    this.drafts=new WorkflowDrafts(store,{extractor,isOwnerActive:ownerId=>isExecutionAuthorized({ownerId}),
      capturePolicyContext:()=>configuration?demoPolicyScope(store,configuration):{executionMode:'fixture'},
      makePolicy:(fields,context)=>this.draftPolicy(fields,context)});
  }
  recover() {
    for (const saved of this.store.list()) {
      if (saved.busy || active(saved)) this.store.update(saved.id, state => {
        state.busy=false;
        const intent=active(state);
        // Only this known fixture protocol establishes a no-send boundary. Legacy
        // records, a restored DB, and future exchange adapters remain UNKNOWN.
        const localAbort=!this.store.recoveryRequired() && intent && state.mode==='fixture' && intent.localSubmissionProtocol==='FIXTURE_PERSIST_BEFORE_SEND_V1'
          && intent.state==='PREPARED' && intent.submissionAttempted===false && intent.fills.length===0;
        if(localAbort) {
          state.ledger=markTerminal(state.ledger,intent.id,{state:'REJECTED',expectedFillQty:'0'});
          state.ledger=reconcileIntent(state.ledger,intent.id,{fillsComplete:true,feesComplete:true});
        } else if(intent) state.ledger=markUnknown(state.ledger,intent.id);
        const held=active(state);
        state.ledger.phase=state.ledger.stopRequested?(held?'STOP_REQUESTED':'STOPPED'):'WAITING';
        return { decision:{ kind:held?'RESTART_RECONCILIATION_REQUIRED':localAbort?'RESTART_LOCAL_ATTEMPT_CLOSED':'RESTART_PROPOSAL_INTERRUPTED',
          mode:'fixture', message:held?'Önceki emir sonucu kontrol edilmeden yeni emir gönderilmeyecek.':localAbort?
            'Gönderilmemiş yerel örnek deneme kapandı. Yeni deneme için yeni görev onayı gerekir.':'Öneri hazırlığı kesildi. Kayıtlı açık emir yok; görev otomatik devam etmedi.' } };
      });
    }
  }
  draft(input, ownerId='local-operator') {
    this.store.assertNewWorkAllowed();
    // Legacy numeric form explicitly uses its existing ten-minute preset.
    // Text drafts never receive that default: absent duration remains missing.
    return this.drafts.create(ownerId,this.executionMode!=='fixture' || Object.hasOwn(input,'text')?input:{durationSeconds:'600',...input});
  }
  draftPolicy(input,context) {
    const {id,policyId,ownerId,workflowId,revision,createdAtMs,nowMs,policyContext}=context;
    if((policyContext?.executionMode??'fixture')!==this.executionMode)throw failure('Taslağın yürütme modu değiştirilemez.');
    if(this.executionMode==='demo-prepared')return makeDemoPolicy(this.store,input,context);
    const policy={
      id:policyId, taskId:id,workflowId,draftRevision:revision,accountId:ownerId==='local-operator'?'isolated-fixture-account':'fixture-'+ownerId, environment:'demo',
      executionMode:'fixture', instrument:'AVAX-USDT', side:'buy', tdMode:'cash', ordType:'limit',
      budget:input.budget, singleOrderNotionalMax:input.singleOrderNotionalMax,
      maxPrice:input.maxPrice, maxShare:divDecimal(input.maxSharePercent,'100'),
      quoteFeeRateMax:'0', quoteFeeFixedMax:'0.01', baseFeeRateMax:'0',
      approvedAtMs:nowMs, expiresAtMs:createdAtMs+Number(input.durationSeconds)*1000, orderLifetimeMs:30000,
      snapshotMaxAgeMs:5000, snapshotMaxSkewMs:2000
    };
    if (parseDecimal(policy.budget)<parseDecimal('25') || parseDecimal(policy.budget)>parseDecimal('1000'))
      throw failure('Örnek hesapta bütçe 25–1000 USDT aralığında olmalı.',400);
    hashPolicy(policy);return policy;
  }
  approve({ draftId, policyHash, acknowledgement }, ownerId='local-operator') {
    if(this.executionMode!=='fixture')throw failure('Demo onayı tek approve-and-enqueue yolunu kullanmalı.');
    this.store.assertNewWorkAllowed();
    const draft=this.drafts.get(ownerId,draftId);
    if (!draft.ready || draft.policy.executionMode!=='fixture' || draft.taskId || Date.now()>=Math.min(draft.validUntilMs,draft.policy.expiresAtMs) || draft.policyHash!==policyHash || acknowledgement!==true)
      throw failure('Tam politika onayı geçersiz veya süresi doldu.',400);
    if (this.store.list(ownerId).some(state => active(state) || ['RUNNING','STOP_REQUESTED'].includes(state.ledger.phase)))
      throw failure('Önce mevcut örnek görevi durdur ve açık emir kayıtlarını eşleştir.');
    if (this.store.list(ownerId).length>=10) throw failure('Bu oturumun 10 görev sınırına ulaşıldı.',429);
    const state={ id:draft.id, ownerId, auditTaskId:createTaskId(draft.id), policy:draft.policy,
      approvedPolicyHash:policyHash, plannerKind:this.planner.kind, mode:'fixture', busy:false,
      attempts:0, lastRejection:null, createdAtMs:Date.now(),
      ledger:createLedger({ taskId:draft.id, accountId:draft.policy.accountId, budget:draft.policy.budget, spent:'0' }) };
    const saved=this.store.create(state);return this.view(saved.id);
  }
  approveAndEnqueue(input,ownerId='local-operator') {
    if(!this.isExecutionAuthorized({ownerId}))throw failure('Oturum yetkisi sona erdi.',401);
    return this.store.approveAndEnqueue(input,ownerId,draft=>{
      if(draft.policy.executionMode!==this.executionMode)throw failure('Taslağın yürütme modu değişti.');
      if(this.executionMode==='demo-prepared')return {...prepareCampaignTask({policy:draft.policy,
        approvedPolicyHash:draft.policyHash,campaign:this.store.campaign(draft.policy.campaignId),ownerId,nowMs:Date.now()}),
        plannerKind:this.planner.kind};
      return {id:draft.id,ownerId,auditTaskId:createTaskId(draft.id),policy:draft.policy,
        approvedPolicyHash:draft.policyHash,plannerKind:this.planner.kind,mode:'fixture',busy:false,
        attempts:0,lastRejection:null,createdAtMs:Date.now(),
        ledger:createLedger({taskId:draft.id,accountId:draft.policy.accountId,budget:draft.policy.budget,spent:'0'})};
    });
  }
  snapshot(state) {
    if(state.mode!=='fixture') throw failure('Bu görev için doğrulanmış demo hesap bağlantısı henüz hazır değil.');
    const now=Date.now();
    return { accountId:state.policy.accountId, environment:'demo', instrument:'AVAX-USDT',
      baseBalance:'1.61290322', quoteBalance:'460', availableQuote:'460', referencePrice:'24.80',
      marketAtMs:now, balanceAtMs:now, ordersAtMs:now, tickSize:'0.01', lotSize:'0.00000001',
      minSize:'0.01', foreignActivity:false, openOrderCount:0, source:'controlled-fixture' };
  }
  view(id) {
    const state=this.store.get(id); if (!state) throw failure('Görev bulunamadı.',404);
    const receipts=this.store.receipts(id);
    return { ...state, summary:ledgerSummary(state.ledger), receipts, observations:this.store.observations(id),
      observationBlocked:this.store.hasUnappliedObservations(),
      auditVerified:verifyAuditChain({ policyCommitment:state.auditPolicy, receipts, expectedHead:state.auditHead }), chainState:'LOCAL_ONLY' };
  }
  async advance(id) {
    this.store.update(id,state => {
      if(state.mode!=='fixture') throw failure('Bu görev için demo yürütme bağlantısı henüz hazır değil.');
      if(state.campaignId && this.store.campaign(state.campaignId)?.paused)
        throw failure('Kampanya duraklatıldı. Yeni öneri veya emir başlatılmayacak.');
      if (state.busy || state.ledger.phase!=='RUNNING' || state.ledger.stopRequested || active(state) || queueClosed(state)) throw failure('Görev yeni öneriye açık değil.');
      if(this.store.hasUnappliedObservations() || ledgerSummary(state.ledger).violation)
        throw failure('Gerçekleşme kaydı kontrol bekliyor. Yeni öneri ve gönderim kapalı; operatör incelemesi gerekli.');
      if (!this.isExecutionAuthorized(state)) {
        state.ledger=requestStop(state.ledger);state.ledger.phase='STOPPED';
        return {decision:{kind:'OWNER_SESSION_ENDED',message:'Oturum yetkisi sona erdi; yeni öneri başlamadı.'}};
      }
      if (state.attempts>=3 || Date.now()>=state.policy.expiresAtMs) { state.ledger.phase='WAITING'; return {decision:{kind:'WAIT',message:'Çağrı veya süre sınırına ulaşıldı.'}}; }
      state.busy=true; return {};
    });
    const before=this.store.get(id); if (!before.busy) return this.view(id);
    let proposal;
    try { proposal=await this.planner.propose({ownerId:before.ownerId,approvedPolicyHash:before.approvedPolicyHash,
      policy:before.policy, snapshot:this.snapshot(before), ledgerSummary:ledgerSummary(before.ledger), attempt:before.attempts, rejection:before.lastRejection }); }
    catch (error) {
      this.store.update(id,state => {
        state.busy=false;
        if (!state.ledger.stopRequested) state.ledger.phase='WAITING';
        return {decision:error?.code==='MODEL_CALL_LIMIT'
          ?{kind:'MODEL_CALL_LIMIT',message:'Sunucu model kullanım sınırına ulaştı. Yeni emir oluşturulmadı.'}
          :{kind:'PLANNER_UNAVAILABLE',message:'Model yanıtı alınamadı. Yeni emir oluşturulmadı.'}};
      }); return this.view(id);
    }
    this.store.update(id,state => {
      state.busy=false;
      if(this.store.globalSafetyStatus().paused) {
        if(!state.ledger.stopRequested)state.ledger.phase='WAITING';
        return {decision:{kind:'GLOBAL_PAUSE_PROPOSAL_DISCARDED',message:'Sistem duraklatıldığı için dönen öneri uygulanmadı.'}};
      }
      if (!this.isExecutionAuthorized(state)) {
        state.ledger=requestStop(state.ledger);state.ledger.phase='STOPPED';
        return {decision:{kind:'OWNER_SESSION_ENDED',message:'Model yanıtından sonra oturum yetkisi sona erdi. Yeni intent yok.'}};
      }
      // A stop during model generation is permanent and wins over the returned proposal.
      if (state.ledger.phase!=='RUNNING' || state.ledger.stopRequested) return {decision:{kind:'LATE_PROPOSAL_DISCARDED'}};
      if(queueClosed(state)) {state.ledger.phase='WAITING';return {decision:{kind:'QUEUE_DEADLINE_PROPOSAL_DISCARDED'}};}
      state.attempts+=1;
      if (proposal.action==='wait') { state.ledger.phase='WAITING'; return {decision:{kind:'WAIT',reasonSource:'model',message:proposal.reason}}; }
      const snapshot=this.snapshot(state);
      const candidate={ instrument:'AVAX-USDT', side:'buy', tdMode:'cash', ordType:'limit', price:proposal.price, size:proposal.size };
      const decision=evaluateCandidate({ policy:state.policy, approvedPolicyHash:state.approvedPolicyHash,
        snapshot, candidate, ledgerSummary:ledgerSummary(state.ledger), nowMs:Date.now() });
      state.lastRejection=decision.ok?null:{code:decision.code,evidence:decision.evidence};
      if (!decision.ok) {
        if (state.attempts>=3 || !['POST_FILL_SHARE_CAP','PRICE_CAP','SINGLE_NOTIONAL_CAP'].includes(decision.code)) state.ledger.phase='WAITING';
        return {decision:{kind:'VETO',planner:state.plannerKind,proposal,governor:decision,snapshot}};
      }
      const intentId=randomUUID(), clOrdId=randomUUID().replaceAll('-','');
      state.admissionSnapshot=snapshot;
      state.ledger=prepareIntent(state.ledger,{id:intentId,clOrdId,decision,createdAtMs:Date.now()});
      active(state).localSubmissionProtocol='FIXTURE_PERSIST_BEFORE_SEND_V1';
      return {decision:{kind:'ACCEPTED_AND_RESERVED',planner:state.plannerKind,proposal,governor:decision,snapshot,intentId}};
    });
    // Separate durable boundaries: reserve, attempted submission, observed fixture state.
    const prepared=active(this.store.get(id));
    if (prepared?.state==='PREPARED') {
      this.store.update(id,state => {
        const intent=active(state);
        const summary=ledgerSummary(state.ledger);
        // The sole PREPARED reservation is excluded only to recheck that same intent.
        if (!intent || intent.state!=='PREPARED' || intent.fills.length || summary.activeIntentCount!==1) throw failure('Gönderim kaydı uyuşmuyor.');
        // Refresh at the final synchronous fixture boundary; do not re-label the
        // previously admitted snapshot as fresh. A future async ATK provider must
        // obtain its observation BEFORE this transaction and recheck its age here.
        const finalSnapshot=this.snapshot(state);
        const checked=evaluateCandidate({policy:state.policy,approvedPolicyHash:state.approvedPolicyHash,
          snapshot:finalSnapshot,nowMs:Date.now(),
          candidate:{instrument:intent.payload.instId,side:intent.payload.side,tdMode:intent.payload.tdMode,
            ordType:intent.payload.ordType,price:intent.payload.px,size:intent.payload.sz},
          ledgerSummary:{...summary,reserved:'0',localReserved:'0',activeIntentCount:0}});
        if (this.store.globalSafetyStatus().paused || this.store.hasUnappliedObservations() || !this.isExecutionAuthorized(state) || queueClosed(state) || !checked.ok || checked.payloadHash!==intent.payloadHash || hashCanonical(intent.payload)!==intent.payloadHash
          || checked.reserve!==intent.initialReserve || hashCanonical(state.admissionSnapshot)!==intent.snapshotHash) {
          state.ledger=markTerminal(state.ledger,intent.id,{state:'REJECTED',expectedFillQty:'0'});
          state.ledger=reconcileIntent(state.ledger,intent.id,{fillsComplete:true,feesComplete:true});state.ledger.phase='WAITING';
          return {decision:{kind:'PRE_SUBMIT_BLOCKED',code:checked.code,message:'Son gönderim kapısı geçilmedi. Gönderim başlamadı.'}};
        }
        state.preSubmissionSnapshot=finalSnapshot;
        state.preSubmissionSnapshotHash=hashCanonical(finalSnapshot);
        state.ledger=markSubmitting(state.ledger,intent.id);
        return {decision:{kind:'FIXTURE_SUBMISSION_ATTEMPT',intentId:intent.id,payload:intent.payload,snapshotHash:state.preSubmissionSnapshotHash}};
      });
      this.store.update(id,state => {
        const intent=active(state);
        if (!intent || intent.state!=='SUBMITTING') return {};
        state.ledger=markOpen(state.ledger,intent.id,{ordId:'fixture-'+intent.clOrdId});
        return {decision:{kind:'FIXTURE_ORDER_OPEN',intentId:intent.id,message:'Yerel senaryoda emir açık. Borsaya gönderilmedi.'}};
      });
    }
    return this.view(id);
  }
  async run(id) {
    for (let round=0;round<3;round++) {
      const state=this.store.get(id);
      if (!state || state.busy || state.ledger.phase!=='RUNNING' || state.ledger.stopRequested || active(state)) break;
      await this.advance(id);
    }
    return this.view(id);
  }
  stop(id) {
    const previous=this.store.get(id),previousIntent=previous && active(previous);
    if (previous?.ledger.stopRequested && (!previousIntent || previousIntent.state==='CANCEL_PENDING')) return this.view(id);
    this.store.update(id,state => {
      state.ledger=requestStop(state.ledger);
      const intent=active(state);
      if (intent && state.mode==='fixture') state.ledger=markCancelPending(state.ledger,intent.id);
      else if(!intent) state.ledger.phase='STOPPED';
      // Demo UNKNOWN/SUBMITTING/OPEN remain exchange-observed states. Only the
      // dedicated durable cancel boundary may mark a demo cancellation attempt.
      return {decision:{kind:'STOP_REQUESTED',message:intent
        ?state.mode==='fixture'?'Yeni öneriler kapalı; örnek iptal sonucu bekleniyor.':'Yeni işlemler durduruldu; emrin sorgu ve iptal sonucu ayrıca takip ediliyor.'
        :'Görev durduruldu; açık emir kaydı yok.'}};
    }); return this.view(id);
  }
  observeFill(id,intentId,fill) {
    const target=this.store.get(id);
    if(target?.mode!=='fixture' || target.policy.executionMode!=='fixture')
      throw failure('Simülasyon dolumu demo göreve uygulanamaz.');
    // Persist evidence independently before a projection can reject it. This is
    // used by the fixture today; it is not a live ATK observation endpoint.
    const observationId=this.store.captureObservation({taskId:id,intentId,source:'fixture-fill',payload:fill});
    try {
      this.store.update(id,state=>{
        state.ledger=recordFill(state.ledger,intentId,fill);
        const violation=ledgerSummary(state.ledger).violation;
        return {decision:{kind:violation?'OBSERVATION_QUARANTINED':'FIXTURE_PARTIAL_FILL',observationId,fill,
          message:violation?'Gerçekleşme örneği sınırlarla uyuşmuyor. Maliyet kaydı korundu; yeni gönderim kapalı.':'Aynı gerçekleşme bütçeden iki kez düşülmez.'}};
      },{observationId});
    } catch {
      // Audit corruption can block state mutation. The independent observation
      // remains pending/quarantined and blocks new execution globally, not reads.
      this.store.quarantineObservation(observationId);
      try {this.store.update(id,state=>{
        state.ledger.phase=state.ledger.stopRequested?'STOP_REQUESTED':'WAITING';
        return {decision:{kind:'OBSERVATION_QUARANTINED',observationId,
          message:'Gerçekleşme gözlemi saklandı; harcama özetiyle eşleştirilemedi. Yeni gönderim kapalı, operatör kontrolü gerekiyor.'}};
      });} catch {/* The observation gate still holds. No automatic audit repair. */}
    }
    return this.view(id);
  }
  scenario(id,kind) {
    const target=this.store.get(id);
    if(target?.mode!=='fixture' || target.policy.executionMode!=='fixture')
      throw failure('Simülasyon komutları yalnız fixture görevlerde kullanılabilir.');
    if(kind==='partial') {
      const state=this.store.get(id),intent=state && active(state);
      if(!intent || !['OPEN','PARTIAL'].includes(intent.state))throw failure('Bu durumda yeni dolum simüle edilemez.');
      const qty=roundDownToStep(divDecimal(intent.payload.sz,'2'),'0.00000001');
      return this.observeFill(id,intent.id,{tradeId:'fixture-partial-'+intent.id,baseQty:qty,
        quoteNotional:mulDecimal(qty,intent.payload.px,'up'),feeQuote:'0.005',feeBase:'0',feesComplete:true});
    }
    this.store.update(id,state => {
      const intent=active(state); if (!intent) throw failure('Açık örnek intent yok.');
      if (kind==='unknown') {
        state.ledger=markUnknown(state.ledger,intent.id); state.ledger.phase='WAITING';
        return {decision:{kind:'FIXTURE_UNKNOWN',message:'Sonuç belirsiz. Rezerv tutuluyor; yeniden gönderim yok.'}};
      }
      if (kind==='confirm-cancel') {
        if (intent.state!=='CANCEL_PENDING' || !state.ledger.stopRequested) throw failure('Önce durdurma/iptal isteği oluştur.');
        const quantity=formatDecimal(intent.fills.reduce((sum,fill)=>sum+parseDecimal(fill.baseQty),0n));
        state.ledger=markTerminal(state.ledger,intent.id,{state:'CANCELLED',expectedFillQty:quantity});
        state.ledger=reconcileIntent(state.ledger,intent.id,{fillsComplete:true,feesComplete:true}); state.ledger.phase='STOPPED';
        return {decision:{kind:'FIXTURE_CANCEL_RECONCILED',message:'Örnek terminal durum, dolum ve ücret kaydı uzlaştırıldı.'}};
      }
      throw failure('Bilinmeyen senaryo.',400);
    }); return this.view(id);
  }
  expireOrders() {
    for (const saved of this.store.listRuntime()) {
      const intent=active(saved), now=Date.now();
      if (!saved.ledger.stopRequested && (now>=saved.policy.expiresAtMs || intent && now>=intent.createdAtMs+saved.policy.orderLifetimeMs)) this.stop(saved.id);
    }
  }
}
