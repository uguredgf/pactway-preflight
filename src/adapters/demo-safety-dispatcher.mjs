import {hashCanonical} from '../domain/governor.mjs';
import {planDemoSafety} from '../domain/demo-safety.mjs';
import {prepareATKObservation,validateATKObservationRecord} from './atk-observation-journal.mjs';
import {randomUUID} from 'node:crypto';

/** Trusted INTERNAL integration dependencies, not browser callbacks. The actual
 * transport is not supplied by Server yet. authorize must independently verify
 * runtime/catalog/account/route and current session before EACH call. Returning
 * a truthy value is insufficient: it must return the bound request hash.
 * No place method exists. A future transport MUST disable retries/redirects.
 */
export class DemoSafetyDispatcher {
  #store;#transport;#authorize;#binding;#clock;#busy=false;#last=new Map();#interval;
  constructor({store,transport,authorize,binding,clock=Date.now,minIntervalMs=2000}) {
    if(typeof transport!=='function' || typeof authorize!=='function' || typeof clock!=='function'
        || !Number.isSafeInteger(minIntervalMs) || minIntervalMs<1000 || minIntervalMs>60000)
      throw new TypeError('Safety dependencies required');
    this.#store=store;this.#transport=transport;this.#authorize=authorize;
    this.#binding=Object.freeze({...binding});this.#clock=clock;this.#interval=minIntervalMs;
  }
  #current(taskId,intentId) {
    const task=this.#store.get(taskId);
    if(!task || task.mode!=='demo-prepared' || !this.#store.verifySafetyTask(task))throw new Error('SAFETY_AUDIT');
    const intent=task.ledger.intents.find(item=>item.id===intentId);
    if(!intent || intent.settled || task.policy.accountId!==this.#binding.accountId
        || task.submission?.prepared.commitment.connectionHash!==this.#binding.connectionHash)throw new Error('SAFETY_IDENTITY');
    const nowMs=this.#clock();
    const campaign=task.campaignId?this.#store.campaign(task.campaignId):null;
    const plan=planDemoSafety({task,intent,nowMs,globalPaused:this.#store.globalSafetyStatus().paused,
      campaignPaused:!!task.campaignId && (!campaign || campaign.paused || !!campaign.supersededBy),
      ownerActive:this.#store.ownerSessionActive(task.ownerId,nowMs)});
    // Do not keep issuing cancellation while a prior response is waiting for
    // consumption. Queries remain available under pending/quarantine/pause.
    if(task.demoCancelAttempt || this.#store.hasUnappliedObservations())plan.cancel=null;
    return {task,intent,plan,nowMs};
  }
  async #call(taskId,intentId,kind) {
    const {task,plan,nowMs}=this.#current(taskId,intentId);
    const request=kind==='cancel'?plan.cancel:plan.query;
    if(!request)return null;
    const bound={taskId,intentId,taskRevision:task.revision,request,binding:this.#binding,atMs:nowMs};
    const expected=hashCanonical(bound);
    // Synchronous internal authority check. No network/model wait between this
    // check and invoking transport; promise/thenable authority cannot pass.
    if(this.#authorize(bound)!==expected)throw new Error('SAFETY_TRANSPORT_NOT_VERIFIED');
    if(kind==='cancel')this.#store.recordDemoCancelAttempt(bound);
    const raw=await this.#transport(request);
    const receivedAtMs=this.#clock();
    const prepared=prepareATKObservation({schemaVersion:1,...this.#binding,taskId,intentId,tool:request.tool,args:request.args,
      observationId:randomUUID(),callId:randomUUID(),requestedAtMs:nowMs,receivedAtMs},raw);
    if(!prepared.ok || !validateATKObservationRecord(prepared.record).ok)throw new Error('SAFETY_RESPONSE_INVALID');
    // Persist even error/non-projectable envelopes; never infer terminal success.
    return this.#store.captureATKToolObservation(prepared.record);
  }
  async run(taskId,intentId) {
    if(this.#busy)return {ok:false,code:'SAFETY_DISPATCH_BUSY',resubmitAllowed:false};
    const key=JSON.stringify([taskId,intentId]),now=this.#clock(),last=this.#last.get(key);
    if(!Number.isSafeInteger(now) || now<0 || last!==undefined && (now<last || now-last<this.#interval))
      return {ok:false,code:'SAFETY_DISPATCH_THROTTLED',resubmitAllowed:false};
    // Bounded cache, no unbounded per-visitor identity accumulation.
    if(!this.#last.has(key) && this.#last.size>=1024)this.#last.delete(this.#last.keys().next().value);
    this.#last.set(key,now);this.#busy=true;
    const observations=[],failures=[];
    try {
      const {plan}=this.#current(taskId,intentId);
      if(plan.cancel) {
        try {const saved=await this.#call(taskId,intentId,'cancel');if(saved)observations.push(saved.observationId);}
        catch {failures.push('CANCEL_UNCONFIRMED');this.#store.pauseGlobal('SAFETY_PROCESSING_FAILED');}
      }
      // Re-read task/authority after async cancellation. Cancellation failure or
      // timeout still leads to original-ID query, never place or reserve release.
      try {const saved=await this.#call(taskId,intentId,'query');if(saved)observations.push(saved.observationId);}
      catch {failures.push('QUERY_UNCONFIRMED');this.#store.pauseGlobal('SAFETY_PROCESSING_FAILED');}
      return {ok:failures.length===0,observations,failures,resubmitAllowed:false,settlementConfirmed:false};
    } catch {
      this.#store.pauseGlobal('SAFETY_PROCESSING_FAILED');
      return {ok:false,code:'SAFETY_DISPATCH_BLOCKED',resubmitAllowed:false};
    } finally {this.#busy=false;}
  }
}
