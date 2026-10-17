import {randomUUID} from 'node:crypto';
import {evaluateCandidate,hashPolicy} from './domain/governor.mjs';
import {PolicyPlanner} from './planner.mjs';
import {ledgerSummary,prepareIntent} from './domain/ledger.mjs';
import {prepareDemoWireBody} from './adapters/prepared-wire-body.mjs';
import {createHistoryScan} from './adapters/atk-history-pages.mjs';
import {correlateDemoOrder} from './adapters/demo-order-correlation.mjs';
import {demoReadRequest} from './adapters/atk-spot-contract.mjs';
import {planDemoSafety} from './domain/demo-safety.mjs';

const fail=code=>{throw Object.assign(new Error(code),{code,status:409});};

/** One application execution lane. Network work is explicit and bounded; only
 * the branded client can commit/deliver. This class is not instantiated by default. */
export class DemoExecutor {
  #store;#client;#busy=false;#closing=false;#active=null;#planner;
  constructor(store,client,{planner=null}={}) {
    this.#store=store;this.#client=client;
    this.#planner=planner && ['openai','ollama'].includes(planner.kind)?new PolicyPlanner(planner):null;
  }
  async #exclusive(operation) {
    if(this.#busy || this.#closing)fail('DEMO_EXECUTOR_BUSY');
    this.#busy=true;
    try {this.#active=operation();return await this.#active;}
    finally {this.#active=null;this.#busy=false;}
  }
  async #read(tool,args={},owner={taskId:null,intentId:null}) {
    if(this.#closing)fail('DEMO_EXECUTOR_CLOSING');
    const receipt=await this.#client.callJournalledRead(tool,args,owner);
    return this.#store.atkToolObservation(receipt.observationId).record;
  }
  async #identity() {
    const record=await this.#read('account_get_config');
    this.#store.attachDemoRuntime(this.#client);
    this.#store.acknowledgeDemoIdentity();
    return record;
  }
  async initialize() {return this.#exclusive(()=>this.#identity()).then(()=>({connected:true}));}
  canStartQueuedWork() {return !this.#busy && !this.#closing && !!this.#planner;}
  async #scan(kind,{beginMs,endMs,knownOrderId,owner={taskId:null,intentId:null}}) {
    const binding=this.#client.journalContext();
    const scan=createHistoryScan({kind,binding,nowMs:endMs,beginMs,endMs,pageSize:100,maxPages:100,
      ...(knownOrderId?{knownOrderId}:{})});
    const ids=[];
    while(scan.request()) {
      const request=scan.request(),record=await this.#read(request.tool,request.args,owner);
      ids.push(record.context.observationId);
      const appended=scan.append(record);if(!appended.ok)fail(appended.code);
    }
    if(!scan.view().scanExhausted)fail('DEMO_HISTORY_INCOMPLETE');
    return ids;
  }
  async #accountEvidence(campaign,baseline=false) {
    const endMs=Date.now(),beginMs=baseline?Math.max(0,endMs-3600000):campaign.balanceBaseline?.atMs;
    if(!Number.isSafeInteger(beginMs) || beginMs>=endMs || endMs-beginMs>86400000)fail('FINAL_HISTORY_WINDOW');
    const e={endMs};
    const read=async(key,tool,args={})=>{e[key]=(await this.#read(tool,args)).context.observationId;};
    await read('configStartId','account_get_config');
    await read('balanceStartId','account_get_balance');
    await read('instrumentId','market_get_instruments',{instType:'SPOT',instId:'AVAX-USDT',demo:true});
    await read('tickerId','market_get_ticker',{instId:'AVAX-USDT',demo:true});
    await read('feeId','account_get_trade_fee',{instType:'SPOT',instId:'AVAX-USDT'});
    await read('openStartId','spot_get_orders',{status:'open',limit:100});
    e.algoIds=[];
    for(const ordType of ['conditional','oco','move_order_stop'])
      e.algoIds.push((await this.#read('spot_get_algo_orders',{status:'pending',ordType,limit:100})).context.observationId);
    e.orderIds=await this.#scan('SPOT_ORDER_HISTORY',{beginMs,endMs});
    e.fillIds=await this.#scan('SPOT_FILLS',{beginMs,endMs});
    await read('openEndId','spot_get_orders',{status:'open',limit:100});
    await read('configId','account_get_config');
    await read('balanceId','account_get_balance');
    return e;
  }
  baseline(campaignId) {
    return this.#exclusive(async()=>{
      await this.#identity();
      const campaign=this.#store.campaign(campaignId);if(!campaign)fail('DEMO_CAMPAIGN_MISSING');
      const evidence=await this.#accountEvidence(campaign,true);
      return this.#store.establishDemoBaseline(campaignId,evidence);
    });
  }
  #checkQueuedTask(taskId) {
    const task=this.#store.get(taskId),now=Date.now();
    if(!task || task.mode!=='demo-prepared' || !task.approvalRequest || task.queue?.state!=='RUNNING'
        || task.ledger.stopRequested || task.ledger.phase!=='WAITING' || task.submission || task.ledger.intents.length
        || !this.#store.ownerSessionActive(task.ownerId,now)
        || now>=Math.min(task.queue.expiresAtMs,task.policy.expiresAtMs))fail('DEMO_QUEUE_BLOCKED');
    this.#store.assertNewWorkAllowed();return task;
  }
  // Hold the executor across model -> fresh evidence -> final submission. The
  // public operator proposal path still never automatically submits a result.
  run(taskId) {
    return this.#exclusive(async()=>{
      for(let revision=0;revision<3;revision++) {
        const task=this.#checkQueuedTask(taskId);
        if((this.#store.modelWorkflowUsage(task.policy.workflowId)?.total??3)>=3) return {code:'MODEL_CALL_LIMIT'};
        const result=await this.#propose(taskId);
        this.#checkQueuedTask(taskId);
        if(result.code==='DEMO_MODEL_PROPOSAL')return this.#submit(taskId,result.candidate);
        if(result.code!=='DEMO_MODEL_VETO' || !['POST_FILL_SHARE_CAP','PRICE_CAP','SINGLE_NOTIONAL_CAP'].includes(result.governorCode))return result;
      }
      return {code:'MODEL_CALL_LIMIT'};
    });
  }
  propose(taskId) {return this.#exclusive(()=>this.#propose(taskId));}
  async #propose(taskId) {
      if(!this.#planner)fail('DEMO_MODEL_NOT_CONFIGURED');
      this.#store.assertNewWorkAllowed();
      let task=this.#store.get(taskId);
      if(task?.approvalRequest)this.#checkQueuedTask(taskId);
      if(!task || task.mode!=='demo-prepared' || task.submission || task.ledger.intents.length || task.ledger.stopRequested
          || !this.#store.verifySafetyTask(task) || !this.#store.ownerSessionActive(task.ownerId,Date.now()))fail('DEMO_PROPOSAL_BLOCKED');
      const attempt=task.demoModelAttempts??0;
      if(attempt>=3 || Date.now()>=task.policy.expiresAtMs)fail('MODEL_CALL_LIMIT');
      await this.#identity();
      const evidence=await this.#accountEvidence(this.#store.campaign(task.campaignId));
      const snapshot=this.#store.acknowledgeDemoSnapshot(taskId,evidence);
      if(task.approvalRequest)this.#checkQueuedTask(taskId);
      this.#store.update(taskId,state=>{
        if(state.ledger.stopRequested || state.submission || state.ledger.intents.length
            || (state.demoModelAttempts??0)!==attempt)fail('DEMO_PROPOSAL_CHANGED');
        state.demoModelAttempts=attempt+1;
        return {decision:{kind:'DEMO_MODEL_ATTEMPT',attempt:attempt+1}};
      });
      task=this.#store.get(taskId);
      // Neither model nor returned proposal holds a submit capability. A later
      // explicit admission still acquires fresh evidence and rechecks everything.
      const proposal=await this.#planner.propose({policy:task.policy,approvedPolicyHash:task.approvedPolicyHash,
        ownerId:task.ownerId,snapshot,ledgerSummary:ledgerSummary(task.ledger),attempt,rejection:task.demoModelRejection??null});
      this.#store.assertNewWorkAllowed();
      const current=this.#store.get(taskId);
      if(current?.approvalRequest)this.#checkQueuedTask(taskId);
      if(!current || current.revision!==task.revision || current.ledger.stopRequested
          || !this.#store.ownerSessionActive(current.ownerId,Date.now()) || Date.now()>=current.policy.expiresAtMs
          || hashPolicy(current.policy)!==task.approvedPolicyHash)fail('DEMO_LATE_PROPOSAL_DISCARDED');
      if(proposal.action==='wait')return {code:'DEMO_MODEL_WAIT',proposal,dispatchAllowed:false};
      const freshEvidence=await this.#accountEvidence(this.#store.campaign(task.campaignId));
      const fresh=this.#store.acknowledgeDemoSnapshot(taskId,freshEvidence);
      const candidate={instrument:'AVAX-USDT',side:'buy',tdMode:'cash',ordType:'limit',price:proposal.price,size:proposal.size};
      let decision;
      this.#store.update(taskId,state=>{
        this.#store.assertNewWorkAllowed();
        if(state.revision!==task.revision || state.ledger.stopRequested || state.submission
            || !this.#store.ownerSessionActive(state.ownerId,Date.now()))fail('DEMO_LATE_PROPOSAL_DISCARDED');
        decision=evaluateCandidate({policy:state.policy,approvedPolicyHash:state.approvedPolicyHash,snapshot:fresh,candidate,
          ledgerSummary:{...ledgerSummary(state.ledger),phase:'RUNNING'},nowMs:Date.now()});
        state.demoModelRejection=decision.ok?null:{code:decision.code,evidence:decision.evidence};
        return {decision:{kind:decision.ok?'DEMO_MODEL_PROPOSAL_CHECKED':'DEMO_MODEL_VETO',code:decision.code,attempt:attempt+1}};
      });
      return {code:decision.ok?'DEMO_MODEL_PROPOSAL':'DEMO_MODEL_VETO',candidate,proposal,governorCode:decision.code,dispatchAllowed:false};
  }
  submit(taskId,candidate) {return this.#exclusive(()=>this.#submit(taskId,candidate));}
  async #submit(taskId,candidate) {
      if(this.#store.get(taskId)?.approvalRequest)this.#checkQueuedTask(taskId);
      this.#store.assertNewWorkAllowed();await this.#identity();
      let task=this.#store.get(taskId);
      if(!task || task.mode!=='demo-prepared' || task.attempts!==0 || task.ledger.intents.length)fail('FINAL_TASK_STATE');
      const evidence=await this.#accountEvidence(this.#store.campaign(task.campaignId));
      const snapshot=this.#store.acknowledgeDemoSnapshot(taskId,evidence),nowMs=Date.now();
      task=this.#store.get(taskId);
      const decision=evaluateCandidate({policy:task.policy,approvedPolicyHash:task.approvedPolicyHash,snapshot,candidate,
        ledgerSummary:{...ledgerSummary(task.ledger),phase:'RUNNING'},nowMs});
      if(!decision.ok)fail('FINAL_'+decision.code);
      const id=randomUUID(),clOrdId='PW'+randomUUID().replaceAll('-','').slice(0,30);
      const intent=prepareIntent({...task.ledger,phase:'RUNNING'},{id,clOrdId,decision,createdAtMs:nowMs}).intents[0];
      const context=this.#store.demoRuntimeContext(nowMs);
      const prepared=prepareDemoWireBody({manifest:context.manifest,policy:task.policy,
        approvedPolicyHash:task.approvedPolicyHash,intent,nowMs});
      if(!prepared.ok)fail(prepared.code);
      const result=await this.#client.submitDemo({taskId,expectedRevision:task.revision,
        manifest:context.manifest,intent,prepared,snapshot});
      if(result.observationId) {
        // An ACK is not a fill or terminal state. Failed envelopes remain pending.
        try {this.#consume(taskId,result.observationId);} catch {this.#store.pauseGlobal('SAFETY_PROCESSING_FAILED');}
      }
      return result;
  }
  #consume(taskId,observationId,fillObservationIds=[],scanEndMs=Date.now()) {
    const input={observationId,fillObservationIds,scanEndMs,expectedBinding:this.#client.journalContext(),nowMs:Date.now(),pageSize:100};
    const review=this.#store.previewDemoObservation(taskId,input);
    if(!review.correlation.ok)fail(review.code);
    this.#store.consumeDemoObservation(taskId,{...input,expectedPreviewHash:review.previewHash});
    return input;
  }
  async #cancelIfNeeded(taskId) {
    const task=this.#store.get(taskId),intent=task.ledger.intents.find(i=>!i.settled);
    const campaign=this.#store.campaign(task.campaignId);
    if(!intent)return;
    const plan=planDemoSafety({task,intent,nowMs:Date.now(),globalPaused:this.#store.globalSafetyStatus().paused,
      campaignPaused:!campaign || campaign.paused || !!campaign.supersededBy,
      ownerActive:this.#store.ownerSessionActive(task.ownerId,Date.now())});
    if(plan.cancel && !task.demoCancelAttempt) {
      try {const receipt=await this.#client.cancelDemo(taskId);this.#consume(taskId,receipt.observationId);}
      catch {this.#store.pauseGlobal('SAFETY_PROCESSING_FAILED');}
    }
  }
  async #poll(taskId) {
    const nowMs=Date.now();let task=this.#store.get(taskId);
    if(!task || task.mode!=='demo-prepared' || !task.submission || !task.ledger.intents.some(i=>!i.settled))return {code:'DEMO_NO_OPEN_INTENT'};
    const prior=task.demoPoll;
    if(prior?.attempts>=120)return {code:'DEMO_OPERATOR_REVIEW_REQUIRED',retryAllowed:false};
    if(prior && (nowMs<prior.atMs || nowMs-prior.atMs<2000))return {code:'DEMO_POLL_THROTTLED'};
    // Persist the request budget before any IO, so restart cannot reset it.
    this.#store.update(taskId,state=>{state.demoPoll={attempts:(state.demoPoll?.attempts??0)+1,atMs:nowMs};
      return {decision:{kind:'DEMO_RECONCILIATION_ATTEMPT',attempt:state.demoPoll.attempts}};});
    // The final bounded pass is a safety pass, not silent abandonment of an open
    // order. A known order gets its one cancel opportunity; unknown stays held.
    if((prior?.attempts??0)>=119)this.#store.pauseGlobal('SAFETY_PROCESSING_FAILED');
    await this.#identity();task=this.#store.get(taskId);
    await this.#cancelIfNeeded(taskId);
    // Re-read after asynchronous cancellation and query using the original IDs.
    task=this.#store.get(taskId);
    const current=task.ledger.intents.find(i=>!i.settled),owner={taskId,intentId:current.id};
    const request=demoReadRequest('order',{clOrdId:current.clOrdId,...(current.ordId?{ordId:current.ordId}:{})});
    const record=await this.#read(request.tool,request.args,owner);
    const correlation=correlateDemoOrder({task,record,expectedBinding:this.#client.journalContext(),nowMs:Date.now()});
    if(!correlation.ok) return {code:'DEMO_ORDER_UNRESOLVED',retryAllowed:false};
    const scanEndMs=Date.now();
    const fillIds=await this.#scan('OWNED_INTENT_FILLS',{beginMs:current.createdAtMs,endMs:scanEndMs,
      knownOrderId:correlation.normalized.ordId,owner});
    const input=this.#consume(taskId,record.context.observationId,fillIds,scanEndMs);
    if(!correlation.normalized.terminal) {
      // A lost ACK can reveal ordId on this query. Do not wait for another poll
      // (which may exceed the budget) before considering a requested stop.
      await this.#cancelIfNeeded(taskId);
      return {code:'DEMO_ORDER_OBSERVED',settled:false};
    }
    task=this.#store.get(taskId);
    if(task.ledger.intents[0].quarantined)return {code:'DEMO_OPERATOR_REVIEW_REQUIRED',settled:false};
    input.nowMs=Date.now();
    if(!this.#store.previewDemoObservation(taskId,input).arithmeticReady)return {code:'DEMO_FILL_FEE_PENDING',settled:false};
    const confirmArgs=demoReadRequest('order',{clOrdId:current.clOrdId,ordId:correlation.normalized.ordId}).args;
    const confirm=await this.#read('spot_get_order',confirmArgs,owner);
    const config=await this.#read('account_get_config'),balance=await this.#read('account_get_balance');
    input.nowMs=Date.now();
    const review=this.#store.previewDemoObservation(taskId,input);
    if(!review.arithmeticReady)return {code:'DEMO_FILL_FEE_PENDING',settled:false};
    this.#store.settleDemoObservation(taskId,{...input,expectedPreviewHash:review.previewHash,
      coverage:{confirmId:confirm.context.observationId,configId:config.context.observationId,balanceId:balance.context.observationId}});
    return {code:'DEMO_INTENT_RECONCILED',settled:true,retryAllowed:false};
  }
  poll(taskId) {return this.#exclusive(()=>this.#poll(taskId));}
  async tick() {
    if(this.#busy || this.#closing)return;
    try {
      const task=this.#store.listRuntime().find(s=>s.mode==='demo-prepared' && s.submission && s.ledger.intents.some(i=>!i.settled));
      if(!task)return;
      return await this.poll(task.id);
    } catch {this.#store.pauseGlobal('SAFETY_PROCESSING_FAILED');return {code:'DEMO_RECONCILIATION_PAUSED'};}
  }
  async close() {this.#closing=true;try {await this.#active;} catch {} }
}
