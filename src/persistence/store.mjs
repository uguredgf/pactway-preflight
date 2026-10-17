import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, openSync, closeSync, unlinkSync, writeFileSync, existsSync, fsyncSync } from 'node:fs';
import { join } from 'node:path';
import { createPolicyCommitment, createDecisionReceipt, verifyDecisionReceipt, verifyAuditChain } from '../audit/commitments.mjs';
import { createCampaign, projectCampaign } from '../domain/campaign.mjs';
import {parseDecimal} from '../domain/money.mjs';
import {ledgerSummary,recordFill,prepareIntent,markSubmitting,markUnknown,markCancelPending} from '../domain/ledger.mjs';
import {planDemoSafety} from '../domain/demo-safety.mjs';
import {assessFinalSubmission} from '../domain/final-submission.mjs';
import {previewDemoLifecycle} from '../domain/demo-lifecycle.mjs';
import {assessDemoSettlement} from '../domain/demo-settlement.mjs';
import {validateATKObservationRecord} from '../adapters/atk-observation-journal.mjs';
import {hashPolicy,hashCanonical} from '../domain/governor.mjs';
import {prepareCampaignTask} from '../domain/campaign-task.mjs';
import {approvalRequest,checkApprovalDraft} from '../domain/task-approval.mjs';
import {createBalanceCheckpoint,reconcileCampaignBalances} from '../domain/campaign-reconciliation.mjs';
import {RECOVERY_TABLES,encodeRecoverySnapshot,decodeRecoverySnapshot} from './recovery-format.mjs';
import {captureBinding,captureBindingMatches} from './atk-capture-binding.mjs';
import {inspectDemoRuntime} from '../adapters/atk.mjs';
import {deriveDemoSnapshot,evidenceIds,durableRecord,verifyDemoLimits,verifySettlementEvidence} from '../domain/demo-evidence.mjs';
import {hashPreflightPolicy,hashPreflightCandidate,verifyReport} from '../preflight/domain.mjs';
import {REPLAY_EXAMPLES,runReplayExample} from '../preflight/examples.mjs';

const observationFailure = code => Object.assign(new Error(code),{code});
const REPLAY_CONTEXT=Symbol('internal-fixture-replay');
const DEMO_CONSUME_CONTEXT=Symbol('internal-demo-consume');
const DEMO_CANCEL_CONTEXT=Symbol('internal-demo-cancel');
const APPROVAL_CONTEXT=Symbol('internal-approve-and-enqueue');
const DEMO_QUEUE_CONTEXT=Symbol('internal-demo-queue-start');

/** Local-only single owner. A crash leaves the lock for deliberate recovery. */
export class Store {
  #safetyLatched=false;
  #readOnlySafetyFault=false;
  #freshDatabase=false;
  #recoveryRequired=false;
  #captureSessions=new Map();
  #demoRuntime=null;
  constructor(directory) {
    mkdirSync(directory, { recursive:true });
    this.lockPath = join(directory, 'owner.lock');
    this.lockFd = openSync(this.lockPath, 'wx');
    try {
      writeFileSync(this.lockFd, JSON.stringify({ pid:process.pid, acquiredAt:new Date().toISOString() }));
      const databasePath=join(directory,'mandateguard.db'),marker=join(directory,'pactway.initialized');
      const existing=existsSync(databasePath);
      if(!existing && (existsSync(marker) || existsSync(databasePath+'-wal') || existsSync(databasePath+'-shm')))
        throw new Error('Recovery required: database missing; existing state was not reset');
      this.#freshDatabase=!existing;
      this.db = new DatabaseSync(databasePath);
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, state TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY, task_id TEXT NOT NULL,
          sequence INTEGER NOT NULL, receipt TEXT NOT NULL, UNIQUE(task_id, sequence));
        CREATE TABLE IF NOT EXISTS receipt_outbox(task_id TEXT NOT NULL, sequence INTEGER NOT NULL,
          status TEXT NOT NULL DEFAULT 'LOCAL_ONLY', transaction_hash TEXT,
          PRIMARY KEY(task_id, sequence));
        CREATE TABLE IF NOT EXISTS visitor_sessions(token_hash TEXT PRIMARY KEY, owner_id TEXT NOT NULL,
          csrf TEXT NOT NULL, expires_at_ms INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS model_call_budget(provider TEXT PRIMARY KEY,
          used INTEGER NOT NULL CHECK(used>=0));
        CREATE TABLE IF NOT EXISTS observations(id INTEGER PRIMARY KEY, task_id TEXT NOT NULL,
          intent_id TEXT NOT NULL, observed_at_ms INTEGER NOT NULL, source TEXT NOT NULL,
          payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'PENDING');
        CREATE INDEX IF NOT EXISTS observations_task ON observations(task_id,id);
        CREATE INDEX IF NOT EXISTS observations_status ON observations(status);
        CREATE TABLE IF NOT EXISTS observation_replays(kind TEXT NOT NULL, observation_id TEXT NOT NULL,
          review_hash TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY(kind,observation_id,review_hash));
        CREATE TABLE IF NOT EXISTS observation_review_actions(kind TEXT NOT NULL, observation_id TEXT NOT NULL,
          review_hash TEXT NOT NULL, action TEXT NOT NULL, at_ms INTEGER NOT NULL,
          PRIMARY KEY(kind,observation_id,review_hash,action));
        CREATE TABLE IF NOT EXISTS atk_tool_observations(
          observation_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, call_id TEXT NOT NULL,
          connection_hash TEXT NOT NULL, catalog_hash TEXT NOT NULL, entry_hash TEXT NOT NULL,
          account_id TEXT NOT NULL, task_id TEXT, intent_id TEXT, tool TEXT NOT NULL,
          received_at_ms INTEGER NOT NULL, payload_hash TEXT NOT NULL, record TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','QUARANTINED','APPLIED')),
          UNIQUE(session_id,call_id));
        CREATE INDEX IF NOT EXISTS atk_observations_pending ON atk_tool_observations(status);
        CREATE TABLE IF NOT EXISTS atk_capture_sessions(session_id TEXT PRIMARY KEY,
          binding TEXT NOT NULL, binding_hash TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS atk_capture_receipts(observation_id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL, payload_hash TEXT NOT NULL, binding_hash TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS atk_observations_connection ON atk_tool_observations(connection_hash,received_at_ms);
        CREATE TABLE IF NOT EXISTS campaigns(id TEXT PRIMARY KEY, state TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS campaign_events(id INTEGER PRIMARY KEY, campaign_id TEXT NOT NULL,
          kind TEXT NOT NULL, at_ms INTEGER NOT NULL, record TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS global_safety(id INTEGER PRIMARY KEY CHECK(id=1),
          paused INTEGER NOT NULL CHECK(paused IN (0,1)), reason TEXT NOT NULL, revision INTEGER NOT NULL);
        INSERT OR IGNORE INTO global_safety(id,paused,reason,revision) VALUES(1,0,'NONE',0);
        INSERT OR IGNORE INTO model_call_budget(provider,used) VALUES('openai',0);
        INSERT OR IGNORE INTO model_call_budget(provider,used) VALUES('openai-extraction',0);
        INSERT OR IGNORE INTO model_call_budget(provider,used) VALUES('preflight-ollama',0);
        CREATE TABLE IF NOT EXISTS model_workflows(id TEXT PRIMARY KEY,
          total INTEGER NOT NULL DEFAULT 0, extraction INTEGER NOT NULL DEFAULT 0,
          proposal INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS policy_workflows(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,
          task_id TEXT UNIQUE,draft TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS preflight_policies(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,
          created_at_ms INTEGER NOT NULL,record TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS preflight_policies_owner ON preflight_policies(owner_id,created_at_ms);
        CREATE TABLE IF NOT EXISTS preflight_checks(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,
          client_request_id TEXT NOT NULL,input_hash TEXT NOT NULL,state TEXT NOT NULL,
          mode TEXT NOT NULL,created_at_ms INTEGER NOT NULL,updated_at_ms INTEGER NOT NULL,
          model_calls INTEGER NOT NULL DEFAULT 0,record TEXT NOT NULL,
          UNIQUE(owner_id,client_request_id));
        CREATE INDEX IF NOT EXISTS preflight_checks_owner ON preflight_checks(owner_id,created_at_ms);
        CREATE INDEX IF NOT EXISTS tasks_owner ON tasks(COALESCE(json_extract(state,'$.ownerId'),'local-operator'));
        CREATE INDEX IF NOT EXISTS tasks_queue ON tasks(json_extract(state,'$.queue.state'));`);
      if(existing) {
        this.#recoveryRequired=true;
        this.#safetyLatched=true;
        const prior=this.db.prepare('SELECT paused,reason FROM global_safety WHERE id=1').get();
        const blocking=new Set(['OPERATOR_PAUSE','SAFETY_PROCESSING_FAILED','STORAGE_UNCERTAIN']);
        if(!prior || ![0,1].includes(prior.paused)
            || !['NONE','OPERATOR_PAUSE','SAFETY_PROCESSING_FAILED','STORAGE_UNCERTAIN',
              'RESTART_RECONCILIATION_REQUIRED','RESTORE_RECONCILIATION_REQUIRED'].includes(prior.reason))
          throw new Error('Global safety state invalid');
        if(prior.paused===1 && blocking.has(prior.reason))this.#readOnlySafetyFault=true;
        else this.db.prepare("UPDATE global_safety SET paused=1,reason='RESTART_RECONCILIATION_REQUIRED',revision=revision+1 WHERE id=1").run();
      }
      if(!existsSync(marker)) {
        const markerFd=openSync(marker,'wx');
        try{writeFileSync(markerFd,'Pactway recovery marker v1\n');fsyncSync(markerFd);}finally{closeSync(markerFd);}
      }
    } catch (error) {
      try {this.db?.close();}catch {}
      try {closeSync(this.lockFd);}catch {}
      try {unlinkSync(this.lockPath);}catch {}
      throw error;
    }
  }
  get(id) {
    const row = this.db.prepare('SELECT state FROM tasks WHERE id=?').get(id);
    return row ? JSON.parse(row.state) : null;
  }
  recoveryRequired() {return this.#recoveryRequired;}
  attachDemoRuntime(client) {
    inspectDemoRuntime(client,this,Date.now());
    if(this.#demoRuntime && this.#demoRuntime!==client)throw observationFailure('FINAL_RUNTIME_ALREADY_ATTACHED');
    this.#demoRuntime=client;
  }
  demoRuntimeContext(nowMs=Date.now()) {
    if(!this.#demoRuntime)throw observationFailure('FINAL_EVIDENCE_NOT_CONNECTED');
    return inspectDemoRuntime(this.#demoRuntime,this,nowMs);
  }
  #hasUnappliedExcept(ids=[]) {
    const allowed=new Set(ids);
    return !!this.db.prepare("SELECT 1 FROM observations WHERE status<>'APPLIED' LIMIT 1").get()
      || this.db.prepare("SELECT observation_id FROM atk_tool_observations WHERE status<>'APPLIED'").all()
        .some(row=>!allowed.has(row.observation_id));
  }
  #applyDemoReferences(ids,kind,nowMs) {
    for(const id of ids) {
      const saved=this.atkToolObservation(id);
      if(!saved || saved.status==='QUARANTINED')throw observationFailure('FINAL_SOURCE_STATUS');
      this.db.prepare("UPDATE atk_tool_observations SET status='APPLIED' WHERE observation_id=?").run(id);
      this.db.prepare('INSERT OR IGNORE INTO observation_review_actions(kind,observation_id,review_hash,action,at_ms) VALUES(?,?,?,?,?)')
        .run('atk',id,saved.record.payloadHash,kind,nowMs);
    }
  }
  acknowledgeDemoIdentity() {
    const nowMs=Date.now(),context=this.demoRuntimeContext(nowMs);
    const record=durableRecord(this,context.identityObservationId,context,{nowMs});
    if(record.context.tool!=='account_get_config' || record.context.taskId!==null)throw observationFailure('FINAL_ACCOUNT_IDENTITY');
    this.#beginTransaction('BEGIN IMMEDIATE');
    try {this.#applyDemoReferences([context.identityObservationId],'IDENTITY_CHECK',nowMs);this.db.exec('COMMIT');}
    catch(error){this.#rollbackTransaction(error);throw error;}
  }
  establishDemoBaseline(campaignId,evidence) {
    const nowMs=Date.now(),context=this.demoRuntimeContext(nowMs);
    return this.#campaignControl(campaignId,'DEMO_BALANCE_BASELINE',(campaign,states)=>{
      this.assertNewWorkAllowed();
      if(this.#recoveryRequired || campaign.balanceBaseline || campaign.config.accountId!==context.binding.accountId
          || campaign.config.connectionVersion!==context.manifest.config.connectionVersion)throw observationFailure('FINAL_BASELINE_REQUIRED');
      deriveDemoSnapshot({store:this,context,campaign,evidence,nowMs,baseline:true});
      campaign.balanceBaseline=createBalanceCheckpoint({campaign,states,balanceRecord:this.atkToolObservation(evidence.balanceId).record,
        options:{expectedBinding:context.binding,nowMs,maxAgeMs:15000,maxSkewMs:15000,
          accountConfigRecord:this.atkToolObservation(evidence.configId).record}});
      this.#applyDemoReferences(evidenceIds(evidence),'BASELINE_READ',nowMs);
      return {checkpointHash:campaign.balanceBaseline.checkpointHash,evidence};
    });
  }
  demoBaselineEvidence(campaign) {
    const events=this.db.prepare("SELECT record FROM campaign_events WHERE campaign_id=? AND kind='DEMO_BALANCE_BASELINE'")
      .all(campaign.config.id);
    if(events.length!==1)throw observationFailure('FINAL_BASELINE_SOURCE_REQUIRED');
    const saved=JSON.parse(events[0].record);
    if(saved.checkpointHash!==campaign.balanceBaseline?.checkpointHash)throw observationFailure('FINAL_BASELINE_CHANGED');
    return saved.evidence;
  }
  prepareDemoSnapshot(taskId,evidence,nowMs=Date.now()) {
    const task=this.get(taskId),context=this.demoRuntimeContext(nowMs);
    if(!task || !this.verifySafetyTask(task))throw observationFailure('FINAL_TASK_CHANGED');
    return deriveDemoSnapshot({store:this,context,task,campaign:this.campaign(task.campaignId),evidence,nowMs});
  }
  acknowledgeDemoSnapshot(taskId,evidence) {
    this.#beginTransaction('BEGIN IMMEDIATE');
    try {
      const nowMs=Date.now(),snapshot=this.prepareDemoSnapshot(taskId,evidence,nowMs);
      this.#applyDemoReferences(evidenceIds(evidence),'ACCOUNT_SNAPSHOT_CHECK',nowMs);
      this.db.exec('COMMIT');return snapshot;
    } catch(error){this.#rollbackTransaction(error);throw error;}
  }
  #verifyFinalDemoEvidence({task,data,nowMs}) {
    const context=this.demoRuntimeContext(nowMs);
    if(hashCanonical(context.manifest)!==hashCanonical(data.manifest))throw observationFailure('FINAL_RUNTIME_CHANGED');
    const snapshot=this.prepareDemoSnapshot(task.id,data.snapshot.evidence,nowMs);
    if(hashCanonical(snapshot)!==hashCanonical(data.snapshot))throw observationFailure('FINAL_SNAPSHOT_CHANGED');
    verifyDemoLimits(snapshot,task.policy,data.intent);
    const ids=evidenceIds(snapshot.evidence);
    if(this.#hasUnappliedExcept(ids))throw observationFailure('FINAL_RECONCILIATION_REQUIRED');
    return ids;
  }
  /** Dedicated admission boundary. Evidence is re-derived from durable captures
   * inside this transaction. Repeated calls never return a previous ticket. */
  commitDemoSubmission(input,clock=Date.now) {
    const text=JSON.stringify(input);
    if(typeof text!=='string' || Buffer.byteLength(text,'utf8')>131072)throw observationFailure('FINAL_INPUT');
    const data=JSON.parse(text);
    if(Object.keys(data).sort().join(',')!=='expectedRevision,intent,manifest,prepared,snapshot,taskId')
      throw observationFailure('FINAL_INPUT');
    let begun=false;
    try {
      this.#beginTransaction('BEGIN IMMEDIATE');begun=true;
      this.assertNewWorkAllowed();
      if(this.#recoveryRequired)throw observationFailure('FINAL_RECONCILIATION_REQUIRED');
      const task=this.get(data.taskId),nowMs=clock();
      if(!task || task.revision!==data.expectedRevision || !this.verifySafetyTask(task))throw observationFailure('FINAL_TASK_CHANGED');
      const session=this.db.prepare('SELECT MAX(expires_at_ms) AS expires FROM visitor_sessions WHERE owner_id=?').get(task.ownerId);
      if(!Number.isSafeInteger(session?.expires) || session.expires<=nowMs)throw observationFailure('FINAL_OWNER_INACTIVE');
      const peers=this.db.prepare('SELECT state FROM tasks WHERE id<>?').all(task.id).map(row=>JSON.parse(row.state));
      for(const peer of peers)if(peer.policy.accountId===task.policy.accountId && !this.verifySafetyTask(peer))
        throw observationFailure('FINAL_PEER_AUDIT');
      const assessment=assessFinalSubmission({...data,task,peers,campaign:this.campaign(task.campaignId),nowMs});
      if(!assessment.ok)throw observationFailure(assessment.code);
      const references=this.#verifyFinalDemoEvidence({task,data,nowMs});
      // The child delivery deadline covers the oldest source too, not only the
      // ticker/balance/open-order timestamps exposed in the governor snapshot.
      const validUntilMs=Math.min(assessment.validUntilMs,session.expires,
        ...references.map(id=>this.atkToolObservation(id).record.context.requestedAtMs+task.policy.snapshotMaxAgeMs),
        this.atkToolObservation(data.snapshot.evidence.configId).record.context.requestedAtMs+15000);
      const finalNowMs=clock();
      if(!Number.isSafeInteger(finalNowMs) || !Number.isSafeInteger(validUntilMs)
          || finalNowMs<nowMs || finalNowMs>=validUntilMs)throw observationFailure('FINAL_WINDOW_EXPIRED');
      this.assertNewWorkAllowed();
      const previous=JSON.parse(JSON.stringify(task));
      task.ledger=prepareIntent({...task.ledger,phase:'RUNNING'},{id:data.intent.id,clOrdId:data.intent.clOrdId,
        decision:assessment.decision,createdAtMs:data.intent.createdAtMs});
      task.ledger=markSubmitting(task.ledger,data.intent.id);
      task.attempts=1;
      if(task.queue)task.queue.state='RUNNING';
      task.submission={schemaVersion:1,status:'ATTEMPT_COMMITTED',intentId:data.intent.id,
        committedAtMs:finalNowMs,validUntilMs,prepared:data.prepared,snapshot:data.snapshot};
      // Intent, both budgets, immutable marker, receipt and outbox share COMMIT.
      this.projectTaskCampaign(task,previous);
      const sequence=Number(task.auditHead.sequence)+1;
      const receipt=createDecisionReceipt({taskId:task.auditTaskId,policyHash:task.auditPolicy.policyHash,
        sequence:String(sequence),previousHash:task.auditHead.receiptHash,
        decision:{kind:'DEMO_ATTEMPT_COMMITTED',atMs:finalNowMs,intentId:data.intent.id,
          commitmentHash:data.prepared.commitmentHash,bodySha256:data.prepared.commitment.bodySha256,
          snapshotHash:data.intent.snapshotHash,reserve:assessment.decision.reserve}});
      task.auditHead={sequence:receipt.sequence,receiptHash:receipt.receiptHash};task.revision++;
      this.db.prepare('INSERT INTO events(task_id,sequence,receipt) VALUES(?,?,?)').run(task.id,sequence,JSON.stringify(receipt));
      this.db.prepare('INSERT INTO receipt_outbox(task_id,sequence) VALUES(?,?)').run(task.id,sequence);
      this.db.prepare('UPDATE tasks SET state=? WHERE id=?').run(JSON.stringify(task),task.id);
      this.#applyDemoReferences(references,'FINAL_ADMISSION',finalNowMs);
      this.db.exec('COMMIT');begun=false;
      const c=data.prepared.commitment;
      return Object.freeze({taskId:task.id,commitmentHash:data.prepared.commitmentHash,checkedAtMs:finalNowMs,
        validUntilMs,apiOrigin:c.apiOrigin,path:c.path,bodyText:data.prepared.bodyText,bodySha256:c.bodySha256});
    } catch(error) {
      if(begun)try {this.db.exec('ROLLBACK');} catch {this.#safetyLatched=true;this.#readOnlySafetyFault=true;}
      // SQLite/commit failures are not permission to retry delivery.
      if(!error.code || !/^(FINAL_|GLOBAL_PAUSED)/.test(error.code))this.pauseGlobal('STORAGE_UNCERTAIN');
      throw error;
    }
  }
  markDemoSubmissionUnknown(taskId,commitmentHash) {
    return this.update(taskId,state=>{
      if(!state.submission || state.submission.prepared.commitmentHash!==commitmentHash)
        throw observationFailure('FINAL_MARKER_MISMATCH');
      state.ledger=markUnknown(state.ledger,state.submission.intentId);
      return {decision:{kind:'DEMO_DELIVERY_UNVERIFIED',commitmentHash}};
    });
  }
  captureDemoDeliveryResponse(taskId,commitmentHash,record) {
    const checked=validateATKObservationRecord(record),task=this.get(taskId);
    if(!checked.ok || !task?.submission || task.submission.prepared.commitmentHash!==commitmentHash
        || !this.verifySafetyTask(task))throw observationFailure('DELIVERY_JOURNAL_BINDING');
    const c=checked.record.context,commitment=task.submission.prepared.commitment;
    if(c.tool!=='spot_place_order' || c.taskId!==taskId || c.intentId!==task.submission.intentId
        || c.accountId!==commitment.accountId || c.connectionHash!==commitment.connectionHash
        || c.requestedAtMs<task.submission.committedAtMs)throw observationFailure('DELIVERY_JOURNAL_BINDING');
    return this.captureATKToolObservation(checked.record);
  }
  recordDemoCancelAttempt({taskId,intentId,taskRevision,request,binding,atMs}) {
    return this.update(taskId,state=>{
      if(state.revision!==taskRevision || state.mode!=='demo-prepared' || state.demoCancelAttempt
          || !this.verifySafetyTask(state) || state.policy.accountId!==binding.accountId
          || state.submission?.prepared.commitment.connectionHash!==binding.connectionHash)
        throw observationFailure('SAFETY_CANCEL_CHANGED');
      const intent=state.ledger.intents.find(item=>item.id===intentId);
      if(!intent || intent.settled)throw observationFailure('SAFETY_CANCEL_BLOCKED');
      const campaign=state.campaignId?this.campaign(state.campaignId):null;
      const plan=planDemoSafety({task:state,intent,nowMs:atMs,globalPaused:this.globalSafetyStatus().paused,
        campaignPaused:!!state.campaignId && (!campaign || campaign.paused || !!campaign.supersededBy),
        ownerActive:this.ownerSessionActive(state.ownerId,atMs)});
      if(!plan.cancel || hashCanonical(plan.cancel)!==hashCanonical(request))throw observationFailure('SAFETY_CANCEL_CHANGED');
      state.demoCancelAttempt={intentId,atMs,requestHash:hashCanonical(request),connectionHash:binding.connectionHash};
      state.ledger=markCancelPending(state.ledger,intentId);
      return {decision:{kind:'DEMO_CANCEL_ATTEMPT_COMMITTED',...state.demoCancelAttempt,cancellationConfirmed:false}};
    },{[DEMO_CANCEL_CONTEXT]:true});
  }
  previewDemoObservation(taskId,{observationId,fillObservationIds=[],expectedBinding,nowMs,pageSize=100,scanEndMs=nowMs}) {
    this.#beginTransaction('BEGIN');
    try {
      const result=this.#demoObservationReview(taskId,{observationId,fillObservationIds,expectedBinding,nowMs,pageSize,scanEndMs});
      this.db.exec('COMMIT');return result;
    } catch(error) {this.#rollbackTransaction(error);throw error;}
  }
  #demoObservationReview(taskId,{observationId,fillObservationIds=[],expectedBinding,nowMs,pageSize=100,scanEndMs=nowMs}) {
    if(!Array.isArray(fillObservationIds) || fillObservationIds.length>100
        || new Set([observationId,...fillObservationIds]).size!==fillObservationIds.length+1
        || ![observationId,...fillObservationIds].every(id=>typeof id==='string' && /^[A-Za-z0-9_-]{1,128}$/.test(id)))
      throw observationFailure('LIFECYCLE_INPUT');
      const task=this.get(taskId);
      if(!task || !this.verifySafetyTask(task))throw observationFailure('LIFECYCLE_AUDIT');
      const saved=[observationId,...fillObservationIds].map(id=>this.atkToolObservation(id));
      if(saved.some(item=>!item))throw observationFailure('LIFECYCLE_OBSERVATION_MISSING');
      const [record,...fillRecords]=saved.map(item=>item.record);
      const references=saved.map(item=>({id:item.record.context.observationId,payloadHash:item.record.payloadHash,status:item.status}));
      const preview=previewDemoLifecycle({task,record,fillRecords,expectedBinding,nowMs,pageSize,scanEndMs});
      // Bind ALL input records, even an invalid/ignored last page, and their status.
      const basis={taskId,taskRevision:task.revision,auditHead:task.auditHead,references,expectedBinding,nowMs,pageSize,scanEndMs,preview};
      return {...preview,expectedBinding,taskRevision:task.revision,auditHead:task.auditHead,references,previewHash:hashCanonical(basis)};
  }
  #verifyDemoConsumptionEvidence({state,review}) {
    if(!this.#demoRuntime)throw observationFailure('LIFECYCLE_PROVENANCE_NOT_CONNECTED');
    const nowMs=Date.now(),context=this.demoRuntimeContext(nowMs);
    if(hashCanonical(review.expectedBinding)!==hashCanonical(context.binding)
        || state.submission.prepared.commitment.connectionHash!==context.binding.connectionHash)throw observationFailure('LIFECYCLE_SOURCE_REQUIRED');
    for(const ref of review.references) {
      const record=durableRecord(this,ref.id,context,{nowMs});
      if(record.payloadHash!==ref.payloadHash || record.context.taskId!==state.id
          || record.context.intentId!==state.submission.intentId)throw observationFailure('LIFECYCLE_SOURCE_REQUIRED');
    }
  }
  #verifyDemoSettlementCoverage({state,review,input}) {
    const nowMs=Date.now(),context=this.demoRuntimeContext(nowMs);
    const ids=verifySettlementEvidence({store:this,context,state,review,input,nowMs});
    this.#applyDemoReferences(ids,'SETTLEMENT_COVERAGE',nowMs);
  }
  settleDemoObservation(taskId,input) {
    const allowed=['observationId','fillObservationIds','expectedBinding','nowMs','pageSize','expectedPreviewHash','scanEndMs','coverage'];
    if(!input || Object.keys(input).some(key=>!allowed.includes(key))
        || typeof input.expectedPreviewHash!=='string' || !/^[a-f0-9]{64}$/.test(input.expectedPreviewHash))
      throw observationFailure('SETTLEMENT_INPUT');
    return this.update(taskId,state=>{
      const review=this.#demoObservationReview(taskId,input);
      if(review.previewHash!==input.expectedPreviewHash)throw observationFailure('SETTLEMENT_REVIEW_CHANGED');
      const settlement=assessDemoSettlement(state,review);
      if(!settlement.ok)throw observationFailure(settlement.code);
      // Consumption provenance and interval coverage are separate obligations.
      this.#verifyDemoConsumptionEvidence({state,review});
      this.#verifyDemoSettlementCoverage({state,review,input});
      state.ledger=settlement.candidateLedger;
      if(state.queue)state.queue.state='RELEASED';
      return {decision:{kind:'DEMO_INTENT_RECONCILED',intentId:state.submission.intentId,
        reviewHash:review.previewHash,observationIds:review.references.map(ref=>ref.id),
        coverageObservationIds:Object.values(input.coverage),
        spent:settlement.after.spent,reservedBefore:settlement.before.reserved,reservedAfter:settlement.after.reserved}};
    });
  }
  consumeDemoObservation(taskId,input) {
    // Internal API. No caller-supplied ledger, normalized fills or complete flag.
    const allowed=['observationId','fillObservationIds','expectedBinding','nowMs','pageSize','expectedPreviewHash','scanEndMs'];
    if(!input || Object.keys(input).some(key=>!allowed.includes(key))
        || typeof input.expectedPreviewHash!=='string' || !/^[a-f0-9]{64}$/.test(input.expectedPreviewHash))
      throw observationFailure('LIFECYCLE_INPUT');
    const context={observationId:input.observationId,reviewHash:input.expectedPreviewHash,references:null};
    return this.update(taskId,state=>{
      const review=this.#demoObservationReview(taskId,input);
      if(review.previewHash!==input.expectedPreviewHash)throw observationFailure('LIFECYCLE_REVIEW_CHANGED');
      if(review.references.some(ref=>ref.status!=='PENDING'))throw observationFailure('LIFECYCLE_REPLAY_REQUIRED');
      // A wholly uncorrelated record cannot alter economics, even under pause.
      if(!review.correlation.ok || !review.candidateLedger)throw observationFailure('LIFECYCLE_CORRELATION_REQUIRED');
      this.#verifyDemoConsumptionEvidence({state,review});
      // Known costs can survive a later invalid page, but the whole batch then
      // stays quarantined. Completion is NOT inferred from arithmeticReady.
      state.ledger=review.candidateLedger;
      if(review.requiresReview) {
        state.ledger.stopRequested=true;state.ledger.phase='STOP_REQUESTED';
        const intent=state.ledger.intents.find(item=>item.id===state.submission.intentId);
        intent.quarantined=true;
        state.ledger.violations??=[];
        state.ledger.violations.push({code:'DEMO_OBSERVATION_REVIEW_REQUIRED',intentId:intent.id,tradeId:null});
      }
      context.references=review.references;
      context.status=review.requiresReview?'QUARANTINED':'APPLIED';
      return {decision:{kind:'DEMO_OBSERVATION_CONSUMED',reviewHash:review.previewHash,
        observationIds:review.references.map(ref=>ref.id),status:context.status,settlementAuthorized:false}};
    },{[DEMO_CONSUME_CONTEXT]:context});
  }
  verifySafetyTask(state) {
    const receipts=this.receipts(state.id),approved=receipts[0]?.source?.decision;
    if(state.approvalRequest || approved?.approvalRequest) {
      const request=state.approvalRequest;
      if(!request || hashCanonical(request)!==hashCanonical(approved?.approvalRequest??null)
          || approved.kind!=='POLICY_APPROVED_AND_QUEUED' || request.ownerId!==state.ownerId
          || request.draftId!==state.id || request.expectedRevision!==state.policy.draftRevision
          || request.protocol!=='APPROVE_AND_ENQUEUE_V1' || request.acknowledgement!==true
          || request.policyHash!==state.approvedPolicyHash || state.policy.workflowId!==state.id
          || !state.queue || state.queue.enqueuedAtMs!==approved.queue?.enqueuedAtMs
          || state.queue.expiresAtMs!==approved.queue?.expiresAtMs)return false;
    }
    return hashPolicy(state.policy)===state.approvedPolicyHash
      && hashCanonical(createPolicyCommitment({taskId:state.auditTaskId,policy:state.policy,nonce:state.auditPolicy.source.nonce}))===hashCanonical(state.auditPolicy)
      && verifyAuditChain({policyCommitment:state.auditPolicy,receipts,expectedHead:state.auditHead});
  }
  exportRecoverySnapshot(nowMs) {
    if(!Number.isSafeInteger(nowMs) || nowMs<0 || !this.globalSafetyStatus().durablePaused)
      throw new Error('Recovery export requires durable pause and explicit time');
    this.#beginTransaction('BEGIN');
    try {
      const tables={};let count=0,bytes=0;
      for(const [table,columns] of Object.entries(RECOVERY_TABLES)) {
        tables[table]=this.db.prepare(`SELECT ${columns.join(',')} FROM ${table} LIMIT 100001`).all();
        count+=tables[table].length;bytes+=Buffer.byteLength(JSON.stringify(tables[table]),'utf8');
        if(count>100000 || bytes>60*1024*1024)throw new Error('Recovery snapshot limit exceeded');
      }
      const text=encodeRecoverySnapshot(tables,nowMs);decodeRecoverySnapshot(text);
      this.db.exec('COMMIT');return text;
    } catch(error) {this.#rollbackTransaction(error);throw error;}
  }
  writeRecoveryBackup(path,nowMs) {
    const text=this.exportRecoverySnapshot(nowMs),fd=openSync(path,'wx');
    try{writeFileSync(fd,text,'utf8');fsyncSync(fd);}finally{closeSync(fd);}
    return {bytes:Buffer.byteLength(text,'utf8'),checksum:decodeRecoverySnapshot(text).checksum};
  }
  restoreRecoverySnapshot(text) {
    const snapshot=decodeRecoverySnapshot(text);
    if(!this.#freshDatabase)throw new Error('Restore requires a new empty database');
    // Establish a durable stop BEFORE importing. A failed import also stays paused.
    const paused=this.pauseGlobal('OPERATOR_PAUSE');
    if(!paused.durablePaused)throw new Error('Restore pause could not be persisted');
    this.#beginTransaction('BEGIN IMMEDIATE');
    try {
      for(const table of Object.keys(RECOVERY_TABLES)) {
        if(table==='model_call_budget')continue;
        if(this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n!==0)throw new Error('Restore target is not empty');
      }
      if(this.db.prepare('SELECT COUNT(*) AS n FROM visitor_sessions').get().n!==0
          || this.db.prepare('SELECT SUM(used) AS n FROM model_call_budget').get().n!==0)
        throw new Error('Restore target has prior usage');
      for(const [table,columns] of Object.entries(RECOVERY_TABLES)) {
        if(table==='model_call_budget')this.db.exec('DELETE FROM model_call_budget');
        const insert=this.db.prepare(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')})`);
        for(const row of snapshot.tables[table])insert.run(...columns.map(key=>row[key]));
      }
      for(const row of this.db.prepare('SELECT id,state FROM tasks').all()) {
        const task=JSON.parse(row.state);
        if(row.id!==task.id || task.id!==task.policy.taskId || task.id!==task.ledger.taskId || !this.verifySafetyTask(task))
          throw new Error('Restore audit verification failed');
      }
      for(const table of ['events','receipt_outbox','observations'])
        if(this.db.prepare(`SELECT COUNT(*) AS n FROM ${table} LEFT JOIN tasks ON tasks.id=${table}.task_id WHERE tasks.id IS NULL`).get().n)
          throw new Error('Restore orphan task reference');
      for(const row of this.db.prepare('SELECT task_id,intent_id,status FROM observations').all())
        if(!['PENDING','QUARANTINED','APPLIED'].includes(row.status)
            || !this.get(row.task_id).ledger.intents.some(intent=>intent.id===row.intent_id))throw new Error('Restore observation reference invalid');
      for(const row of this.db.prepare('SELECT total,extraction,proposal FROM model_workflows').all())
        if(![row.total,row.extraction,row.proposal].every(value=>Number.isSafeInteger(value) && value>=0)
            || row.total!==row.extraction+row.proposal || row.total>3 || row.extraction>1)throw new Error('Restore workflow quota invalid');
      for(const row of this.db.prepare('SELECT id,owner_id,task_id FROM policy_workflows').all()) {
        const draft=this.policyWorkflow(row.id,row.owner_id);
        if(!draft.usage || draft.policy && hashPolicy(draft.policy)!==draft.policyHash)throw new Error('Restore draft invalid');
        if(row.task_id) {
          const task=this.get(row.task_id);
          if(!task || task.ownerId!==row.owner_id || task.id!==row.id || task.policy.workflowId!==row.id
              || hashPolicy(task.policy)!==draft.policyHash)throw new Error('Restore workflow task invalid');
        }
      }
      for(const task of this.list())if(task.policy.workflowId) {
        const draft=this.policyWorkflow(task.policy.workflowId,task.ownerId);
        if(draft.taskId!==task.id)throw new Error('Restore task workflow missing');
      }
      for(const row of this.db.prepare('SELECT observation_id FROM atk_tool_observations').all())this.atkToolObservation(row.observation_id);
      for(const row of this.db.prepare('SELECT session_id FROM atk_capture_sessions').all())this.#captureSession(row.session_id);
      for(const row of this.db.prepare('SELECT observation_id FROM atk_capture_receipts').all()) {
        if(!this.atkToolObservation(row.observation_id))throw new Error('Restore orphan capture receipt');
        this.atkObservationSource(row.observation_id);
      }
      for(const row of this.db.prepare('SELECT id FROM campaigns').all()) {
        const campaign=projectCampaign(this.campaign(row.id),this.#campaignTasks(row.id));campaign.paused=true;
        this.db.prepare('UPDATE campaigns SET state=? WHERE id=?').run(JSON.stringify(campaign),row.id);
      }
      for(const row of this.db.prepare('SELECT id,owner_id,created_at_ms,record FROM preflight_policies').all()) {
        const record=JSON.parse(row.record);
        const hasApproval=Object.hasOwn(record,'approvedByUserAtMs');
        const domainRecord=Object.fromEntries(['id','policy','policyHash','status','createdAtMs','validFromMs','expiresAtMs']
          .map(key=>[key,record[key]]));
        if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(row.id)
            || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(row.owner_id)
            || record.id!==row.id || record.ownerId!==row.owner_id || record.createdAtMs!==row.created_at_ms
            || !['DRAFT','APPROVED'].includes(record.status) || hashPreflightPolicy(domainRecord)!==record.policyHash
            || record.status==='DRAFT' && hasApproval || record.status==='APPROVED' && !hasApproval
            || (hasApproval && (!Number.isSafeInteger(record.approvedByUserAtMs)
              || record.approvedByUserAtMs<record.validFromMs || record.approvedByUserAtMs>=record.expiresAtMs)))
          throw new Error('Restore preflight policy invalid');
      }
      for(const row of this.db.prepare(`SELECT id,owner_id,client_request_id,input_hash,state,mode,
          created_at_ms,updated_at_ms,model_calls,record FROM preflight_checks`).all()) {
        const record=JSON.parse(row.record);
        const source=record.source??'MANUAL';
        if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(row.id)
            || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(row.owner_id)
            || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(row.client_request_id)
            || record.id!==row.id || record.ownerId!==row.owner_id || record.clientRequestId!==row.client_request_id
            || record.inputHash!==row.input_hash || record.state!==row.state || record.mode!==row.mode
            || record.createdAtMs!==row.created_at_ms || record.updatedAtMs!==row.updated_at_ms
            || record.modelCallCount!==row.model_calls || !['QUEUED','RUNNING','COMPLETED'].includes(row.state)
            || !['LIVE_READ_ONLY','REPLAY'].includes(row.mode) || !['MANUAL','AGENT'].includes(source)
            || row.mode==='REPLAY' && source!=='MANUAL'
            || source==='MANUAL' && ![0,1].includes(row.model_calls) || source==='AGENT' && ![0,1,2].includes(row.model_calls)
            || (row.state==='COMPLETED')!==Boolean(record.report))throw new Error('Restore preflight check invalid');
        if(row.mode==='LIVE_READ_ONLY') {
          const policy=record.policyRecord;
          const durablePolicyRow=this.db.prepare('SELECT record FROM preflight_policies WHERE id=? AND owner_id=?')
            .get(record.policyId,record.ownerId);
          const durablePolicy=durablePolicyRow?JSON.parse(durablePolicyRow.record):null;
          const durableDomain=durablePolicy && Object.fromEntries(
            ['id','policy','policyHash','status','createdAtMs','validFromMs','expiresAtMs'].map(key=>[key,durablePolicy[key]]));
          if(!policy || policy.status!=='APPROVED' || !durablePolicy
              || hashCanonical(policy)!==hashCanonical(durableDomain)
              || policy.id!==record.policyId || policy.policyHash!==record.policyHash
              || hashPreflightPolicy(policy)!==record.policyHash
              || source==='MANUAL' && hashPreflightCandidate(record.candidate)!==hashPreflightCandidate(record.report?.candidate??record.candidate)
              || source==='AGENT' && record.report && (record.report.agentTrace?.version!==1
                || record.report.agentTrace.attempts?.[0]?.candidateHash!==hashPreflightCandidate(record.candidate)
                || record.report.agentTrace.attempts?.at(-1)?.candidateHash!==hashPreflightCandidate(record.report.candidate))
              || ![hashCanonical({policyId:record.policyId,policyHash:record.policyHash,candidate:record.candidate,
                clientRequestId:record.clientRequestId}),hashCanonical({policyId:record.policyId,policyHash:record.policyHash,candidate:record.candidate,
                clientRequestId:record.clientRequestId,source:record.source??'MANUAL'})].includes(record.inputHash)
              || record.report && (record.report.mode!=='LIVE_READ_ONLY' || !verifyReport(record.report).ok
                || record.report.policyHash!==record.policyHash))throw new Error('Restore live preflight check invalid');
        } else {
          if(!REPLAY_EXAMPLES.includes(record.exampleName)
              || hashCanonical({clientRequestId:record.clientRequestId,name:record.exampleName})!==record.inputHash
              || record.report && (record.report.mode!=='REPLAY' || !verifyReport(record.report).ok
                || hashCanonical(record.report)!==hashCanonical(runReplayExample(record.exampleName))))
            throw new Error('Restore replay preflight check invalid');
        }
      }
      if(snapshot.schemaVersion<4)this.db.prepare("INSERT OR IGNORE INTO model_call_budget(provider,used) VALUES('preflight-ollama',0)").run();
      for(const provider of ['openai','openai-extraction','preflight-ollama'])
        if(!this.db.prepare('SELECT used FROM model_call_budget WHERE provider=?').get(provider))throw new Error('Restore quota missing');
      this.db.prepare("UPDATE global_safety SET paused=1,reason='RESTORE_RECONCILIATION_REQUIRED',revision=revision+1 WHERE id=1").run();
      this.db.exec('COMMIT');this.#freshDatabase=false;this.#recoveryRequired=true;this.#readOnlySafetyFault=false;
      return {restored:true,checksum:snapshot.checksum,executionResumed:false,externalHistoryReconciliationRequired:true};
    } catch(error) {this.#rollbackTransaction(error);throw error;}
  }
  globalSafetyStatus() {
    try {
      const row=this.db.prepare('SELECT paused,reason,revision FROM global_safety WHERE id=1').get();
      if(!row || ![0,1].includes(row.paused) || !Number.isSafeInteger(row.revision) || row.revision<0
          || !['NONE','OPERATOR_PAUSE','SAFETY_PROCESSING_FAILED','STORAGE_UNCERTAIN','RESTART_RECONCILIATION_REQUIRED','RESTORE_RECONCILIATION_REQUIRED'].includes(row.reason))throw new Error();
      return {paused:this.#safetyLatched || row.paused===1,durablePaused:row.paused===1,
        reason:this.#safetyLatched && row.paused!==1?'STORAGE_UNCERTAIN':row.reason,revision:row.revision};
    } catch {
      this.#safetyLatched=true;this.#readOnlySafetyFault=true;
      return {paused:true,durablePaused:false,reason:'STORAGE_UNCERTAIN',revision:null};
    }
  }
  readOnlySafetyStatus() {
    const safety=this.globalSafetyStatus();
    const legacy=safety.durablePaused===true
      && ['RESTART_RECONCILIATION_REQUIRED','RESTORE_RECONCILIATION_REQUIRED'].includes(safety.reason);
    return Object.freeze({...safety,allowed:this.#readOnlySafetyFault===false
      && (safety.paused===false && safety.reason==='NONE' || legacy)});
  }
  pauseGlobal(reason='OPERATOR_PAUSE') {
    if(!['OPERATOR_PAUSE','SAFETY_PROCESSING_FAILED','STORAGE_UNCERTAIN'].includes(reason))throw new Error('Invalid pause reason');
    this.#safetyLatched=true;this.#readOnlySafetyFault=true; // Fail closed even when the independent commit fails.
    let begun=false;
    try {
      this.db.exec('BEGIN IMMEDIATE');begun=true;
      const changed=this.db.prepare('UPDATE global_safety SET paused=1,reason=?,revision=revision+1 WHERE id=1').run(reason);
      if(changed.changes!==1)throw new Error();
      this.db.exec('COMMIT');begun=false;
    } catch {
      if(begun)try{this.db.exec('ROLLBACK');}catch{}
    }
    return this.globalSafetyStatus();
  }
  assertNewWorkAllowed() {
    if(this.globalSafetyStatus().paused)throw Object.assign(new Error('Sistem duraklatıldı. Yeni görev ve işlem başlatılamıyor.'),{status:409,code:'GLOBAL_PAUSED'});
  }
  #storageFailure(error) {
    const sqliteCode=Number.isInteger(error?.errcode)?error.errcode & 255:null;
    if([10,11,13,14,26].includes(sqliteCode))this.pauseGlobal('STORAGE_UNCERTAIN');
  }
  #storageWrite(operation) {
    try{return operation();}catch(error){this.#storageFailure(error);throw error;}
  }
  #beginTransaction(statement) {
    this.#storageWrite(()=>this.db.exec(statement));
  }
  #rollbackTransaction(error) {
    let rollbackFailed=false;
    try {this.db.exec('ROLLBACK');}catch {rollbackFailed=true;}
    // SQLite FULL/IO errors can already have rolled the transaction back.
    // Preserve the initiating error and fail closed, even if durable pause fails.
    if(rollbackFailed)this.pauseGlobal('STORAGE_UNCERTAIN');
    else this.#storageFailure(error);
  }
  list(ownerId) {
    const rows = ownerId === undefined
      ? this.db.prepare('SELECT state FROM tasks ORDER BY rowid DESC').all()
      : this.db.prepare("SELECT state FROM tasks WHERE COALESCE(json_extract(state,'$.ownerId'),'local-operator')=? ORDER BY rowid DESC").all(ownerId);
    return rows
      .map(row => JSON.parse(row.state));
  }
  listRuntime() {
    return this.db.prepare(`SELECT state FROM tasks WHERE json_extract(state,'$.ledger.stopRequested')=0
      OR json_extract(state,'$.busy')=1 OR json_extract(state,'$.queue.state') IN ('QUEUED','RUNNING','BLOCKED')
      OR EXISTS(SELECT 1 FROM json_each(tasks.state,'$.ledger.intents') AS intent WHERE json_extract(intent.value,'$.settled')=0)`)
      .all().map(row=>JSON.parse(row.state));
  }
  listQueued() {
    return this.db.prepare("SELECT state FROM tasks WHERE json_extract(state,'$.queue.state')='QUEUED'")
      .all().map(row=>JSON.parse(row.state));
  }
  saveSession({tokenHash, ownerId, csrf, expiresAtMs}) {
    this.#storageWrite(()=>this.db.prepare('INSERT INTO visitor_sessions(token_hash,owner_id,csrf,expires_at_ms) VALUES(?,?,?,?)')
      .run(tokenHash,ownerId,csrf,expiresAtMs));
  }
  session(tokenHash) {
    const row=this.db.prepare('SELECT owner_id,csrf,expires_at_ms FROM visitor_sessions WHERE token_hash=?').get(tokenHash);
    return row ? {ownerId:row.owner_id,csrf:row.csrf,expiresAtMs:row.expires_at_ms} : null;
  }
  activeSessionCount(nowMs) {
    return this.db.prepare('SELECT COUNT(*) AS count FROM visitor_sessions WHERE expires_at_ms>?').get(nowMs).count;
  }
  ownerSessionActive(ownerId,nowMs) {
    return Boolean(this.db.prepare('SELECT 1 FROM visitor_sessions WHERE owner_id=? AND expires_at_ms>? LIMIT 1').get(ownerId,nowMs));
  }
  revokeSession(tokenHash) { this.#storageWrite(()=>this.db.prepare('DELETE FROM visitor_sessions WHERE token_hash=?').run(tokenHash)); }
  createPolicyWorkflow(draft) {
    this.assertNewWorkAllowed();
    if(!draft || !/^[a-f0-9-]{36}$/.test(draft.id) || typeof draft.ownerId!=='string'
        || draft.workflowId!==draft.id || draft.revision!==1)throw new Error('DRAFT_BINDING');
    this.#beginTransaction('BEGIN IMMEDIATE');
    try {
      const pending=this.db.prepare('SELECT draft FROM policy_workflows WHERE owner_id=? AND task_id IS NULL').all(draft.ownerId)
        .filter(row=>JSON.parse(row.draft).validUntilMs>Date.now());
      if(pending.length>=2)throw Object.assign(new Error('İki açık taslak sınırına ulaşıldı.'),{status:429});
      if(this.db.prepare('SELECT draft FROM policy_workflows WHERE task_id IS NULL').all()
        .filter(row=>JSON.parse(row.draft).validUntilMs>Date.now()).length>=50)
        throw Object.assign(new Error('Açık taslak kapasitesi dolu.'),{status:429});
      if(this.db.prepare('SELECT COUNT(*) AS n FROM policy_workflows').get().n>=5000)
        throw Object.assign(new Error('Kalıcı taslak kapasitesi dolu.'),{status:429});
      this.db.prepare('INSERT INTO policy_workflows(id,owner_id,task_id,draft) VALUES(?,?,NULL,?)')
        .run(draft.id,draft.ownerId,JSON.stringify(draft));
      this.db.prepare('INSERT INTO model_workflows(id,total,extraction,proposal) VALUES(?,0,0,0)').run(draft.id);
      const saved=this.policyWorkflow(draft.id,draft.ownerId);
      this.db.exec('COMMIT');return saved;
    } catch(error){this.#rollbackTransaction(error);throw error;}
  }
  listPolicyWorkflows(ownerId) {
    return this.db.prepare('SELECT id FROM policy_workflows WHERE owner_id=? AND task_id IS NULL ORDER BY rowid DESC LIMIT 50')
      .all(ownerId).map(row=>this.policyWorkflow(row.id,ownerId))
      .filter(draft=>draft.validUntilMs>Date.now())
      .map(({id,revision,ready,validUntilMs})=>({id,revision,ready,validUntilMs}));
  }
  policyWorkflow(id,ownerId) {
    const row=this.db.prepare('SELECT * FROM policy_workflows WHERE id=? AND owner_id=?').get(id,ownerId);
    if(!row)throw Object.assign(new Error('Taslak bulunamadı.'),{status:404,code:'DRAFT_NOT_FOUND'});
    const draft=JSON.parse(row.draft);
    if(draft.id!==row.id || draft.workflowId!==row.id || draft.ownerId!==row.owner_id
        || !Number.isSafeInteger(draft.revision) || draft.revision<1
        || !Number.isSafeInteger(draft.createdAtMs) || !Number.isSafeInteger(draft.validUntilMs)
        || draft.validUntilMs<=draft.createdAtMs || typeof draft.ready!=='boolean')throw new Error('DRAFT_BINDING');
    if(draft.ready && (!draft.policy || hashPolicy(draft.policy)!==draft.policyHash
        || draft.policy.workflowId!==row.id || draft.policy.taskId!==row.id || draft.policy.draftRevision!==draft.revision
        || draft.missing?.length!==0 || draft.unresolved?.length!==0))throw new Error('DRAFT_POLICY_BINDING');
    return {...draft,taskId:row.task_id,usage:this.modelWorkflowUsage(id)};
  }
  updatePolicyWorkflow(id,ownerId,expectedRevision,mutate) {
    this.assertNewWorkAllowed();this.#beginTransaction('BEGIN IMMEDIATE');
    try {
      const current=this.policyWorkflow(id,ownerId),{taskId,usage,...draft}=structuredClone(current);
      if(taskId || draft.revision!==expectedRevision || Date.now()>=draft.validUntilMs)
        throw Object.assign(new Error('Taslak değişti, kullanıldı veya süresi doldu.'),{status:409,code:'DRAFT_STALE'});
      mutate(draft);
      if(draft.id!==id || draft.workflowId!==id || draft.ownerId!==ownerId || draft.createdAtMs!==current.createdAtMs
          || draft.policyId!==current.policyId || draft.originalText!==current.originalText
          || hashCanonical(draft.policyContext??null)!==hashCanonical(current.policyContext??null)
          || draft.validUntilMs!==current.validUntilMs || draft.revision!==expectedRevision)throw new Error('DRAFT_BINDING');
      draft.revision++;
      this.db.prepare('UPDATE policy_workflows SET draft=? WHERE id=?').run(JSON.stringify(draft),id);
      // Validate the persisted projection while rollback can still undo it.
      // The detached draft above keeps nested edits out of the immutable baseline.
      const saved=this.policyWorkflow(id,ownerId);
      this.db.exec('COMMIT');return saved;
    } catch(error){this.#rollbackTransaction(error);throw error;}
  }
  reserveOwnedModelCall(limit,usage) {
    if(!usage || typeof usage.ownerId!=='string' || !usage.ownerId || !usage.workflowId)throw new Error('MODEL_OWNER_REQUIRED');
    const bound=this.db.prepare('SELECT 1 FROM policy_workflows WHERE id=?').get(usage.workflowId);
    const legacy=usage.taskId?this.get(usage.taskId):null;
    if(!bound && (usage.purpose!=='proposal' || legacy?.ownerId!==usage.ownerId
        || legacy.id!==usage.workflowId || legacy.policy.workflowId))throw new Error('MODEL_WORKFLOW_REQUIRED');
    if(usage.ownerId!=='local-operator' && !this.ownerSessionActive(usage.ownerId,Date.now()))throw new Error('MODEL_OWNER_INACTIVE');
    return this.reserveModelCall(limit,usage);
  }
  reserveModelCall(limit,{workflowId=null,purpose='proposal',ownerId=null,taskId=null,draftRevision=null}={}) {
    this.assertNewWorkAllowed();
    if (!Number.isSafeInteger(limit) || limit<1 || limit>1000) throw new Error('Model çağrı kotası geçersiz');
    if(workflowId!==null) {
      if(typeof workflowId!=='string' || !/^[a-f0-9-]{36}$/.test(workflowId) || !['proposal','extraction'].includes(purpose))
        throw new Error('Model iş akışı geçersiz');
      this.#beginTransaction('BEGIN IMMEDIATE');
      try {
        const binding=this.db.prepare('SELECT owner_id,task_id FROM policy_workflows WHERE id=?').get(workflowId);
        if(binding) {
          if(binding.owner_id!==ownerId)throw new Error('MODEL_WORKFLOW_OWNER');
          const draft=this.policyWorkflow(workflowId,ownerId);
          if(purpose==='extraction') {
            if(binding.task_id || draft.revision!==draftRevision || draft.extractionState!=='RUNNING'
                || Date.now()>=draft.validUntilMs)throw new Error('MODEL_DRAFT_CHANGED');
          } else {
            const task=taskId?this.get(taskId):null;
            if(binding.task_id!==taskId || !task || task.ownerId!==ownerId || task.policy.workflowId!==workflowId
                || hashPolicy(task.policy)!==draft.policyHash)throw new Error('MODEL_TASK_BINDING');
          }
        }
        // Seed older numeric tasks from already recorded attempts. No silent
        // refund of known calls; future extraction must reuse its workflow ID.
        const previous=this.get(workflowId);
        const known=previous?.attempts ?? 0;
        if(!Number.isSafeInteger(known) || known<0 || known>3)throw new Error('Model kullanım kaydı geçersiz');
        this.db.prepare('INSERT OR IGNORE INTO model_workflows(id,total,proposal) VALUES(?,?,?)').run(workflowId,known,known);
        const usage=this.db.prepare('SELECT total,extraction,proposal FROM model_workflows WHERE id=?').get(workflowId);
        const global=this.db.prepare("SELECT used FROM model_call_budget WHERE provider='openai'").get().used;
        const extraction=this.db.prepare("SELECT used FROM model_call_budget WHERE provider='openai-extraction'").get().used;
        if(![usage.total,usage.extraction,usage.proposal,global,extraction].every(n=>Number.isSafeInteger(n) && n>=0)
            || usage.total!==usage.extraction+usage.proposal || usage.total>3 || usage.extraction>1)throw new Error('MODEL_QUOTA_INVALID');
        if(usage.total>=3 || global>=limit || purpose==='extraction' && (usage.extraction>=1 || extraction>=40)) {
          this.db.exec('COMMIT');return false;
        }
        this.db.prepare('UPDATE model_workflows SET total=total+1,extraction=extraction+?,proposal=proposal+? WHERE id=?')
          .run(purpose==='extraction'?1:0,purpose==='proposal'?1:0,workflowId);
        this.db.prepare("UPDATE model_call_budget SET used=used+1 WHERE provider='openai'").run();
        if(purpose==='extraction')this.db.prepare("UPDATE model_call_budget SET used=used+1 WHERE provider='openai-extraction'").run();
        this.db.exec('COMMIT');return true;
      } catch(error) {this.#rollbackTransaction(error);throw error;}
    }
    // A single durable conditional update precedes dispatch. Failures/crashes do not refund slots.
    return this.#storageWrite(()=>this.db.prepare("UPDATE model_call_budget SET used=used+1 WHERE provider='openai' AND used<?")
      .run(limit).changes===1);
  }
  modelWorkflowUsage(id) {
    return this.db.prepare('SELECT total,extraction,proposal FROM model_workflows WHERE id=?').get(id) ?? null;
  }
  // Independent durable write BEFORE projection/audit mutation. Only bounded public
  // execution observations belong here, never raw HTTP headers or credentials.
  captureObservation({taskId,intentId,source,payload}) {
    const state=this.get(taskId);
    if(!state?.ledger.intents.some(intent=>intent.id===intentId))throw new Error('Observation intent missing');
    if(!['fixture-fill','normalized-atk-fill'].includes(source))throw new Error('Unsupported observation source');
    const encoded=JSON.stringify(payload);
    if(typeof encoded!=='string' || Buffer.byteLength(encoded,'utf8')>16384)throw new Error('Observation size exceeded');
    const result=this.#storageWrite(()=>this.db.prepare('INSERT INTO observations(task_id,intent_id,observed_at_ms,source,payload) VALUES(?,?,?,?,?)')
      .run(taskId,intentId,Date.now(),source,encoded));
    return Number(result.lastInsertRowid);
  }
  observations(id) {
    return this.db.prepare('SELECT id,intent_id,observed_at_ms,source,status FROM observations WHERE task_id=? ORDER BY id DESC LIMIT 100')
      .all(id).map(row=>({id:row.id,intentId:row.intent_id,atMs:row.observed_at_ms,source:row.source,status:row.status}));
  }
  observationPayload(id) {
    const row=this.db.prepare('SELECT payload FROM observations WHERE id=?').get(id);
    return row?JSON.parse(row.payload):null;
  }
  // Independent synchronous commit BEFORE business projection. Account-wide reads
  // need no existing task/intent. Context linkage is declared, not ownership proof.
  // Sanitized MCP envelopes only; no raw HTTP interface, ledger/audit mutation or APPLIED shortcut.
  // Trusted internal composition only. This closure records application capture
  // lineage, not exchange authenticity. Never expose registration over HTTP.
  openATKCaptureSession(input) {
    const binding=captureBinding(input),bindingHash=hashCanonical(binding),token={active:true};
    this.#storageWrite(()=>this.db.prepare('INSERT INTO atk_capture_sessions(session_id,binding,binding_hash) VALUES(?,?,?)')
      .run(binding.sessionId,JSON.stringify(binding),bindingHash));
    this.#captureSessions.set(binding.sessionId,token);
    return Object.freeze({
      capture:record=>{
        if(this.#captureSessions.get(binding.sessionId)!==token)throw observationFailure('ATK_CAPTURE_SESSION_CLOSED');
        return this.#captureATKObservation(record,{binding,bindingHash});
      },
      // Preserve late in-flight evidence after catalog drift, but revoke usability.
      invalidate:()=>{token.active=false;},
      close:()=>{if(this.#captureSessions.get(binding.sessionId)===token)this.#captureSessions.delete(binding.sessionId);},
    });
  }
  #captureSession(sessionId) {
    const row=this.db.prepare('SELECT binding,binding_hash FROM atk_capture_sessions WHERE session_id=?').get(sessionId);
    if(!row)throw observationFailure('ATK_CAPTURE_SOURCE_INVALID');
    const binding=captureBinding(JSON.parse(row.binding));
    if(binding.sessionId!==sessionId || hashCanonical(binding)!==row.binding_hash)throw observationFailure('ATK_CAPTURE_SOURCE_INVALID');
    return {binding,bindingHash:row.binding_hash};
  }
  atkObservationSource(observationId) {
    const saved=this.atkToolObservation(observationId);if(!saved)return null;
    const receipt=this.db.prepare('SELECT * FROM atk_capture_receipts WHERE observation_id=?').get(observationId);
    if(!receipt)return Object.freeze({source:'SUPPLIED_RECORD',activeSession:false,writeEnabled:false});
    const session=this.#captureSession(receipt.session_id);
    if(receipt.payload_hash!==saved.record.payloadHash || receipt.binding_hash!==session.bindingHash
        || !captureBindingMatches(session.binding,saved.record.context))throw observationFailure('ATK_CAPTURE_SOURCE_INVALID');
    return Object.freeze({source:'REGISTERED_STDIO_CAPTURE',activeSession:this.#captureSessions.get(receipt.session_id)?.active===true,
      writeEnabled:false,actualAccountVerified:false,routeVerified:false});
  }
  consumeReadOnlyEvidence(input) {
    return this.consumeReadOnlyEvidenceBatch([input])[0];
  }
  consumeReadOnlyEvidenceBatch(inputs) {
    const actions={
      READ_ONLY_IDENTITY_VERIFIED:{tool:'account_get_config',args:{}},
      READ_ONLY_MARKET_ACCEPTED:{tool:'market_get_ticker',args:{instId:'AVAX-USDT',demo:true}},
      READ_ONLY_MARKET_REJECTED:{tool:'market_get_ticker',args:{instId:'AVAX-USDT',demo:true}},
      PREFLIGHT_TICKER_ACCEPTED:{tool:'market_get_ticker',args:{instId:'AVAX-USDT',demo:true}},
      PREFLIGHT_TICKER_REJECTED:{tool:'market_get_ticker',args:{instId:'AVAX-USDT',demo:true}},
      PREFLIGHT_INSTRUMENT_ACCEPTED:{tool:'market_get_instruments',
        args:{instType:'SPOT',instId:'AVAX-USDT',demo:true}},
      PREFLIGHT_INSTRUMENT_REJECTED:{tool:'market_get_instruments',
        args:{instType:'SPOT',instId:'AVAX-USDT',demo:true}}
    };
    if(!Array.isArray(inputs) || inputs.length<1 || inputs.length>2)throw observationFailure('READONLY_EVIDENCE_INPUT');
    this.#beginTransaction('BEGIN IMMEDIATE');
    try {
      const prepared=inputs.map(input=>{
        if(!input || typeof input!=='object' || Array.isArray(input)
            || Object.keys(input).sort().join(',')!=='action,expectedArgs,expectedBinding,expectedPayloadHash,expectedTool,observationId'
            || typeof input.observationId!=='string' || !/^[A-Za-z0-9_-]{1,128}$/.test(input.observationId)
            || !Object.hasOwn(actions,input.action) || actions[input.action].tool!==input.expectedTool
            || hashCanonical(actions[input.action].args)!==hashCanonical(input.expectedArgs)
            || typeof input.expectedPayloadHash!=='string' || !/^[a-f0-9]{64}$/.test(input.expectedPayloadHash)
            || !input.expectedArgs || typeof input.expectedArgs!=='object' || Array.isArray(input.expectedArgs))
          throw observationFailure('READONLY_EVIDENCE_INPUT');
        const binding=captureBinding(input.expectedBinding),saved=this.atkToolObservation(input.observationId);
        const source=this.atkObservationSource(input.observationId),context=saved?.record.context;
        if(!saved || saved.status!=='PENDING' || saved.record.payloadHash!==input.expectedPayloadHash
            || source?.source!=='REGISTERED_STDIO_CAPTURE' || source.activeSession!==true || source.writeEnabled!==false
            || !context || context.taskId!==null || context.intentId!==null || context.tool!==input.expectedTool
            || !captureBindingMatches(binding,context) || hashCanonical(context.args)!==hashCanonical(input.expectedArgs))
          throw observationFailure('READONLY_EVIDENCE_SOURCE');
        const reviewHash=hashCanonical({kind:'readonly',observationId:input.observationId,
          payloadHash:input.expectedPayloadHash,tool:input.expectedTool,action:input.action,binding});
        return {input,binding,reviewHash};
      });
      if(new Set(prepared.map(item=>item.input.observationId)).size!==prepared.length)
        throw observationFailure('READONLY_EVIDENCE_INPUT');
      const accepting=prepared.some(item=>item.input.action==='READ_ONLY_MARKET_ACCEPTED'
        || item.input.action==='PREFLIGHT_TICKER_ACCEPTED' || item.input.action==='PREFLIGHT_INSTRUMENT_ACCEPTED');
      if(accepting && this.#hasUnappliedExcept(prepared.map(item=>item.input.observationId)))
        throw observationFailure('READONLY_EVIDENCE_PENDING');
      const results=[];
      for(const {input,reviewHash} of prepared) {
        const changed=this.db.prepare("UPDATE atk_tool_observations SET status='APPLIED' WHERE observation_id=? AND payload_hash=? AND status='PENDING'")
          .run(input.observationId,input.expectedPayloadHash);
        if(changed.changes!==1)throw observationFailure('READONLY_EVIDENCE_CHANGED');
        this.db.prepare("INSERT INTO observation_review_actions(kind,observation_id,review_hash,action,at_ms) VALUES('atk',?,?,?,?)")
          .run(input.observationId,reviewHash,input.action,Date.now());
        results.push(Object.freeze({observationId:input.observationId,payloadHash:input.expectedPayloadHash,
          status:'APPLIED',action:input.action,writeEnabled:false}));
      }
      this.db.exec('COMMIT');
      return Object.freeze(results);
    } catch(error) {this.#rollbackTransaction(error);throw error;}
  }
  captureATKToolObservation(input) {return this.#captureATKObservation(input,null);}
  #captureATKObservation(input,source) {
    const checked=validateATKObservationRecord(input);
    if(!checked.ok)throw observationFailure('ATK_OBSERVATION_RECORD_INVALID');
    const record=checked.record,c=record.context;
    if(source && !captureBindingMatches(source.binding,c))throw observationFailure('ATK_CAPTURE_BINDING_MISMATCH');
    let begun=false;
    try {
      this.#beginTransaction('BEGIN IMMEDIATE');begun=true;
      if(source && this.#captureSession(c.sessionId).bindingHash!==source.bindingHash)
        throw observationFailure('ATK_CAPTURE_SOURCE_INVALID');
      const prior=this.db.prepare(`SELECT observation_id,session_id,call_id,payload_hash,record,status
        FROM atk_tool_observations WHERE observation_id=? OR (session_id=? AND call_id=?)`)
        .all(c.observationId,c.sessionId,c.callId);
      if(prior.length) {
        if(prior.length!==1)throw observationFailure('ATK_OBSERVATION_CONFLICT');
        const row=prior[0];
        const existing=validateATKObservationRecord(JSON.parse(row.record));
        if(!existing.ok || existing.payloadHash!==row.payload_hash
          || existing.record.context.observationId!==row.observation_id
          || existing.record.context.sessionId!==row.session_id || existing.record.context.callId!==row.call_id)
          throw observationFailure('ATK_OBSERVATION_STORAGE_FAILED');
        if(row.observation_id!==c.observationId || row.payload_hash!==checked.payloadHash)
          throw observationFailure('ATK_OBSERVATION_CONFLICT');
        if(row.status!=='PENDING')throw observationFailure('ATK_OBSERVATION_REPLAY_REQUIRED');
        // Never upgrade a supplied or historical record through a duplicate call.
        if(source)throw observationFailure('ATK_OBSERVATION_CONFLICT');
        this.db.exec('COMMIT');begun=false;
        return Object.freeze({observationId:c.observationId,payloadHash:checked.payloadHash,status:'PENDING',duplicate:true});
      }
      this.db.prepare(`INSERT INTO atk_tool_observations(observation_id,session_id,call_id,
        connection_hash,catalog_hash,entry_hash,account_id,task_id,intent_id,tool,received_at_ms,payload_hash,record)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(c.observationId,c.sessionId,c.callId,
        c.connectionHash,c.catalogHash,c.isolatedEntrySha256,c.accountId,c.taskId,c.intentId,
        c.tool,c.receivedAtMs,checked.payloadHash,JSON.stringify(record));
      if(source)this.db.prepare(`INSERT INTO atk_capture_receipts(observation_id,session_id,payload_hash,binding_hash)
        VALUES(?,?,?,?)`).run(c.observationId,c.sessionId,checked.payloadHash,source.bindingHash);
      this.db.exec('COMMIT');begun=false;
      return Object.freeze({observationId:c.observationId,payloadHash:checked.payloadHash,status:'PENDING',duplicate:false});
    } catch(error) {
      if(begun)this.#rollbackTransaction(error);else this.#storageFailure(error);
      const code=['ATK_OBSERVATION_CONFLICT','ATK_OBSERVATION_REPLAY_REQUIRED'].includes(error?.code)
        ?error.code:'ATK_OBSERVATION_STORAGE_FAILED';
      throw observationFailure(code);
    }
  }
  // Operator/internal lookup only. No HTTP route or public evidence export exposes this record.
  atkToolObservation(observationId) {
    try {
      const row=this.db.prepare('SELECT record,payload_hash,status FROM atk_tool_observations WHERE observation_id=?').get(observationId);
      if(!row)return null;
      const checked=validateATKObservationRecord(JSON.parse(row.record));
      if(!checked.ok || checked.payloadHash!==row.payload_hash || checked.record.context.observationId!==observationId
        || !['PENDING','QUARANTINED','APPLIED'].includes(row.status))throw 0;
      return Object.freeze({record:checked.record,status:row.status});
    } catch {throw observationFailure('ATK_OBSERVATION_STORAGE_FAILED');}
  }
  hasUnappliedObservations() {
    return Boolean(this.db.prepare(`SELECT (EXISTS(SELECT 1 FROM observations WHERE status<>'APPLIED')
      OR EXISTS(SELECT 1 FROM atk_tool_observations WHERE status<>'APPLIED')) AS blocked`).get().blocked);
  }
  quarantineObservation(id) {
    this.#storageWrite(()=>this.db.prepare("UPDATE observations SET status='QUARANTINED' WHERE id=? AND status='PENDING'").run(id));
  }
  reviewObservation({kind,id}) {
    if(kind==='atk') {
      if(typeof id!=='string' || id.length<1 || id.length>128 || id.trim()!==id)throw observationFailure('OBSERVATION_REVIEW_INPUT');
      const saved=this.atkToolObservation(id);if(!saved)throw observationFailure('OBSERVATION_NOT_FOUND');
      const c=saved.record.context;
      const review={kind,id,status:saved.status,payloadHash:saved.record.payloadHash,taskId:c.taskId,intentId:c.intentId,
        tool:c.tool,accountId:c.accountId,connectionHash:c.connectionHash,
        replaySupported:false,reason:'ATK_ECONOMIC_CONSUMER_NOT_CONNECTED'};
      return {...review,reviewHash:hashCanonical(review)};
    }
    if(kind!=='fixture' || !Number.isSafeInteger(id) || id<1)throw observationFailure('OBSERVATION_REVIEW_INPUT');
    const row=this.db.prepare('SELECT * FROM observations WHERE id=?').get(id);
    if(!row)throw observationFailure('OBSERVATION_NOT_FOUND');
    const state=this.get(row.task_id);
    if(!state || !['PENDING','QUARANTINED','APPLIED'].includes(row.status))throw observationFailure('OBSERVATION_REVIEW_INVALID');
    const supported=row.source==='fixture-fill' && state.mode==='fixture' && state.policy.executionMode==='fixture';
    // Commit to the original stored text, not an edited replacement payload.
    const review={kind,id,taskId:row.task_id,intentId:row.intent_id,status:row.status,source:row.source,
      payloadHash:hashCanonical(row.payload),taskRevision:state.revision,auditHead:state.auditHead,
      policyHash:hashPolicy(state.policy),replaySupported:supported,
      reason:supported?'FIXTURE_FILL_REVIEW':'SOURCE_REPLAY_NOT_CONNECTED'};
    return {...review,reviewHash:hashCanonical(review)};
  }
  quarantineATKObservation({id,expectedReviewHash}) {
    this.#beginTransaction('BEGIN IMMEDIATE');
    try {
      const review=this.reviewObservation({kind:'atk',id});
      if(review.reviewHash!==expectedReviewHash || !['PENDING','QUARANTINED'].includes(review.status))
        throw observationFailure('OBSERVATION_REVIEW_STALE');
      this.db.prepare("UPDATE atk_tool_observations SET status='QUARANTINED' WHERE observation_id=?").run(id);
      this.db.prepare("INSERT OR IGNORE INTO observation_review_actions(kind,observation_id,review_hash,action,at_ms) VALUES('atk',?,?,'QUARANTINE',?)")
        .run(id,expectedReviewHash,Date.now());
      const result=this.reviewObservation({kind:'atk',id});
      this.db.exec('COMMIT');return result;
    } catch(error) {this.#rollbackTransaction(error);throw error;}
  }
  replayFixtureObservation({id,expectedReviewHash}) {
    if(!Number.isSafeInteger(id) || id<1 || typeof expectedReviewHash!=='string'
        || expectedReviewHash.length!==64 || !/^[a-f0-9]{64}$/.test(expectedReviewHash))
      throw observationFailure('OBSERVATION_REPLAY_INPUT');
    const saved=this.db.prepare("SELECT result FROM observation_replays WHERE kind='fixture' AND observation_id=? AND review_hash=?")
      .get(String(id),expectedReviewHash);
    if(saved) {
      const result=JSON.parse(saved.result),state=this.get(result.taskId);
      if(result.observationId!==id || result.reviewHash!==expectedReviewHash || result.executionResumed!==false
          || !['APPLIED','QUARANTINED'].includes(result.status) || !Number.isSafeInteger(result.taskRevision)
          || !state || state.revision<result.taskRevision
          || !verifyAuditChain({policyCommitment:state.auditPolicy,receipts:this.receipts(state.id),expectedHead:state.auditHead}))
        throw observationFailure('OBSERVATION_REPLAY_RECEIPT_INVALID');
      return {...result,duplicate:true};
    }
    if(!this.globalSafetyStatus().durablePaused)throw observationFailure('OBSERVATION_REPLAY_REQUIRES_PAUSE');
    const initial=this.reviewObservation({kind:'fixture',id});
    if(!initial.replaySupported || initial.reviewHash!==expectedReviewHash || initial.status==='APPLIED')
      throw observationFailure('OBSERVATION_REVIEW_STALE');
    const context={id,reviewHash:expectedReviewHash};
    this.update(initial.taskId,state=>{
      if(!this.globalSafetyStatus().durablePaused)throw observationFailure('OBSERVATION_REPLAY_REQUIRES_PAUSE');
      const current=this.reviewObservation({kind:'fixture',id});
      if(!current.replaySupported || current.reviewHash!==expectedReviewHash || !['PENDING','QUARANTINED'].includes(current.status))
        throw observationFailure('OBSERVATION_REVIEW_STALE');
      const intent=state.ledger.intents.find(item=>item.id===current.intentId);
      if(!intent || state.busy)throw observationFailure('OBSERVATION_REPLAY_TASK_BUSY');
      const payload=this.observationPayload(id);
      const keys=['tradeId','baseQty','quoteNotional','feeQuote','feeBase','feesComplete'];
      if(!payload || typeof payload!=='object' || Array.isArray(payload) || Object.keys(payload).some(key=>!keys.includes(key)))
        throw observationFailure('OBSERVATION_REPLAY_PAYLOAD');
      state.ledger=recordFill(state.ledger,current.intentId,payload);
      // Never clear violation/quarantine/stop flags, settle, release, or resend.
      return {decision:{kind:'OBSERVATION_REPLAYED',observationId:id,reviewHash:expectedReviewHash,
        payloadHash:current.payloadHash,reviewedTaskRevision:current.taskRevision,previousObservationStatus:current.status,
        message:'Saklanan gözlem yeniden işlendi. Duraklatma ve varsa ihlal kayıtları korunuyor.'}};
    },{observationId:id,[REPLAY_CONTEXT]:context});
    return {...JSON.parse(this.db.prepare("SELECT result FROM observation_replays WHERE kind='fixture' AND observation_id=? AND review_hash=?")
      .get(String(id),expectedReviewHash).result),duplicate:false};
  }
  createCampaign(config) {
    this.assertNewWorkAllowed();
    const campaign=createCampaign(config);
    this.#storageWrite(()=>this.db.prepare('INSERT INTO campaigns(id,state) VALUES(?,?)').run(config.id,JSON.stringify(campaign)));
    return campaign;
  }
  campaign(id) {
    const row=this.db.prepare('SELECT state FROM campaigns WHERE id=?').get(id);
    return row?JSON.parse(row.state):null;
  }
  #campaignTasks(id) {
    return this.db.prepare("SELECT state FROM tasks WHERE json_extract(state,'$.campaignId')=?")
      .all(id).map(row=>JSON.parse(row.state));
  }
  #pauseCampaignSuccessors(campaign) {
    const visited=new Set([campaign.config.id]);let nextId=campaign.supersededBy;
    while(nextId) {
      if(visited.has(nextId))throw new Error('Campaign successor cycle');
      visited.add(nextId);const next=this.campaign(nextId);
      if(!next)throw new Error('Campaign successor missing');
      next.paused=true;
      if(!next.violations.some(v=>v.code==='PREDECESSOR_ECONOMICS_CHANGED'))
        next.violations.push({code:'PREDECESSOR_ECONOMICS_CHANGED',campaignId:campaign.config.id});
      this.db.prepare('UPDATE campaigns SET state=? WHERE id=?').run(JSON.stringify(next),nextId);
      nextId=next.supersededBy;
    }
  }
  #campaignControl(id,kind,operation) {
    this.#beginTransaction('BEGIN IMMEDIATE');
    try {
      const saved=this.campaign(id);if(!saved)throw new Error('Campaign missing');
      const states=this.#campaignTasks(id),campaign=projectCampaign(saved,states);
      const detail=operation(campaign,states);
      this.db.prepare('UPDATE campaigns SET state=? WHERE id=?').run(JSON.stringify(campaign),id);
      this.db.prepare('INSERT INTO campaign_events(campaign_id,kind,at_ms,record) VALUES(?,?,?,?)')
        .run(id,kind,Date.now(),JSON.stringify(detail));
      this.db.exec('COMMIT');return {campaign,detail};
    } catch(error) {this.#rollbackTransaction(error);throw error;}
  }
  establishCampaignBalanceBaseline(id,{balanceRecord,options}) {
    return this.#campaignControl(id,'BALANCE_BASELINE',(campaign,states)=>{
      if(campaign.balanceBaseline)throw new Error('Balance baseline cannot be overwritten');
      campaign.balanceBaseline=createBalanceCheckpoint({campaign,states,balanceRecord,options});
      return {checkpointHash:campaign.balanceBaseline.checkpointHash,references:campaign.balanceBaseline.references};
    });
  }
  reconcileCampaignBalance(id,{balanceRecord,options}) {
    return this.#campaignControl(id,'BALANCE_RECONCILIATION',(campaign,states)=>{
      const result=reconcileCampaignBalances({campaign,states,baseline:campaign.balanceBaseline,balanceRecord,options});
      campaign.balanceReconciliation=result;
      if(result.requiresPause) {
        campaign.paused=true;
        const violation={code:'BALANCE_RECONCILIATION_REQUIRED'};
        if(!campaign.violations.some(item=>item.code===violation.code))campaign.violations.push(violation);
        this.#pauseCampaignSuccessors(campaign);
      }
      // MATCH never clears a prior pause, violation, baseline or pending observation.
      return result;
    });
  }
  pauseCampaign(id) {
    return this.#campaignControl(id,'CAMPAIGN_PAUSED',campaign=>{
      campaign.paused=true;return {paused:true};
    });
  }
  openCampaignForPreparation(id) {
    return this.#campaignControl(id,'CAMPAIGN_PREPARATION_OPENED',(campaign,states)=>{
      this.assertNewWorkAllowed();
      if(campaign.supersededBy || campaign.violations.length || this.hasUnappliedObservations()
          || states.some(s=>s.busy || ['QUEUED','RUNNING','BLOCKED'].includes(s.queue?.state)
            || s.ledger.intents.some(i=>!i.settled)))throw new Error('Campaign cannot be reopened');
      campaign.paused=false;
      return {preparationOnly:true,executionAuthorized:false};
    });
  }
  renewCampaign(id,{newId,budget,maxShare,expectedConfigHash}) {
    return this.#campaignControl(id,'CAMPAIGN_RENEWED',(campaign,states)=>{
      this.assertNewWorkAllowed();
      if(campaign.configHash!==expectedConfigHash || !campaign.paused || campaign.supersededBy
          || campaign.violations.length || this.hasUnappliedObservations()
          || states.some(s=>s.busy || ['QUEUED','RUNNING','BLOCKED'].includes(s.queue?.state)
            || s.ledger.intents.some(i=>!i.settled)))throw new Error('Campaign renewal is blocked');
      if(typeof newId!=='string' || !newId || newId===id)throw new Error('New campaign identity required');
      const next=createCampaign({...campaign.config,id:newId,version:campaign.config.version+1,budget,maxShare,
        carriedSpent:campaign.summary.spent});
      next.paused=true;next.predecessor={id,configHash:campaign.configHash};
      next.summary=projectCampaign(next,[]).summary;
      this.db.prepare('INSERT INTO campaigns(id,state) VALUES(?,?)').run(newId,JSON.stringify(next));
      campaign.supersededBy=newId;
      return {newId,configHash:next.configHash,carriedSpent:campaign.summary.spent,requiresNewApproval:true};
    });
  }
  // Called only INSIDE the task transaction. Real admission must additionally
  // bind a verified shared snapshot; this record does not connect fixture users.
  projectTaskCampaign(state,previous=null) {
    if(!state.campaignId) {
      if(previous?.campaignId)throw new Error('Approved campaign cannot be removed');
      return;
    }
    if(previous?.campaignId && previous.campaignId!==state.campaignId)throw new Error('Approved campaign cannot be changed');
    const campaign=this.campaign(state.campaignId);
    if(!campaign)throw new Error('Campaign missing');
    if(state.mode==='demo-prepared') {
      if(state.approvedPolicyHash!==hashPolicy(state.policy) || state.policy.executionMode!=='demo-prepared')
        throw new Error('Campaign approval mismatch');
      if(!previous && (campaign.paused || this.hasUnappliedObservations() || state.ledger.intents.length
          || state.ledger.phase!=='WAITING' || state.busy || state.attempts!==0))
        throw new Error('Campaign task preparation is blocked');
    }
    if(previous) {
      if(previous.mode!==state.mode || previous.ownerId!==state.ownerId
          || hashPolicy(previous.policy)!==hashPolicy(state.policy)
          || previous.approvedPolicyHash!==state.approvedPolicyHash)
        throw new Error('Approved task identity or policy cannot be changed');
      if(previous.ledger.intents.some(intent=>!state.ledger.intents.some(next=>next.id===intent.id
        && next.clOrdId===intent.clOrdId && next.payloadHash===intent.payloadHash
        && (!intent.submissionAttempted || next.submissionAttempted))))throw new Error('Recorded campaign intent cannot be removed or reset');
      if(parseDecimal(ledgerSummary(state.ledger).spent)<parseDecimal(ledgerSummary(previous.ledger).spent))
        throw new Error('Observed campaign spending cannot be silently reduced');
    }
    const others=this.db.prepare("SELECT state FROM tasks WHERE json_extract(state,'$.campaignId')=? AND id<>?")
      .all(state.campaignId,state.id).map(row=>JSON.parse(row.state));
    const projected=projectCampaign(campaign,[...others,state]);
    const addsAuthority=state.ledger.intents.some(intent=>{
      const prior=previous?.ledger.intents.find(item=>item.id===intent.id);
      return !prior || intent.submissionAttempted && !prior.submissionAttempted;
    });
    if(addsAuthority && (projected.paused || this.hasUnappliedObservations()))throw new Error('Campaign execution is blocked');
    if(campaign.supersededBy && (projected.summary.spent!==campaign.summary?.spent
        || projected.summary.reserved!==campaign.summary?.reserved || projected.violations.length>campaign.violations.length
        || previous && hashCanonical(previous.ledger)!==hashCanonical(state.ledger))) {
      // Late evidence stays in the old ledger; descendants must not keep using
      // a now-obsolete carried-spend figure. Never silently erase the late cost.
      this.#pauseCampaignSuccessors(campaign);
    }
    this.db.prepare('UPDATE campaigns SET state=? WHERE id=?').run(JSON.stringify(projected),state.campaignId);
  }
  // Internal source API, not an authenticated approve/enqueue HTTP endpoint.
  createPreparedCampaignTask(input) {
    const campaign=this.campaign(input.campaignId);
    if(!campaign)throw new Error('Campaign missing');
    const state=prepareCampaignTask({policy:input.policy,approvedPolicyHash:input.approvedPolicyHash,
      campaign,ownerId:input.ownerId,nowMs:input.nowMs});
    // create re-reads/project-checks campaign inside its BEGIN IMMEDIATE boundary.
    return this.create(state);
  }
  // Runs inside create/update's write transaction. Frontend queue checks alone
  // are not admission: all persisted callers must satisfy the same slot limits.
  validateTaskAdmission(state,previous=null,{cancel=false,approval=false,demoQueue=false}={}) {
    if(!previous?.approvalRequest && state.approvalRequest && !approval
        || previous?.approvalRequest && hashCanonical(state.approvalRequest)!==hashCanonical(previous.approvalRequest))
      throw new Error('Approval request requires immutable dedicated commit');
    if(previous?.approvalRequest) {
      if(state.ownerId!==previous.ownerId || state.mode!==previous.mode || hashPolicy(state.policy)!==hashPolicy(previous.policy)
          || state.approvedPolicyHash!==previous.approvedPolicyHash || !state.queue
          || state.queue.enqueuedAtMs!==previous.queue.enqueuedAtMs || state.queue.expiresAtMs!==previous.queue.expiresAtMs)
        throw new Error('Approved workflow scope and queue deadline are immutable');
      if(state.queue.state==='RUNNING' && !['QUEUED','RUNNING'].includes(previous.queue.state))
        throw new Error('Approved workflow cannot restart');
    }
    if(!previous?.demoCancelAttempt && state.demoCancelAttempt && !cancel
        || previous?.demoCancelAttempt && hashCanonical(state.demoCancelAttempt)!==hashCanonical(previous.demoCancelAttempt))
      throw new Error('Cancellation attempt requires immutable dedicated commit');
    if(!previous?.submission && state.submission)
      throw new Error('Submission marker requires the dedicated commit boundary');
    if(previous?.submission && hashCanonical(state.submission)!==hashCanonical(previous.submission))
      throw new Error('Durable submission marker cannot be changed or removed');
    if(previous && (state.id!==previous.id || state.auditTaskId!==previous.auditTaskId))
      throw new Error('Task identity cannot be changed');
    const additions=state.ledger.intents.filter(intent=>!previous?.ledger.intents.some(old=>old.id===intent.id));
    const submits=state.ledger.intents.some(intent=>intent.submissionAttempted
      && !previous?.ledger.intents.find(old=>old.id===intent.id)?.submissionAttempted);
    const enteringQueue=state.queue?.state==='QUEUED' && previous?.queue?.state!=='QUEUED';
    const starting=state.queue?.state==='RUNNING' && previous?.queue?.state!=='RUNNING';
    const proposing=state.busy===true && previous?.busy!==true;
    if(!additions.length && !submits && !enteringQueue && !starting && !proposing)return;
    this.assertNewWorkAllowed();
    if(previous?.approvalRequest && enteringQueue)throw new Error('Approved workflow cannot be requeued');
    if(state.mode==='demo-prepared' && !(approval && enteringQueue || demoQueue && starting)
        || state.mode==='demo-prepared' && (additions.length || submits || proposing))
      throw new Error('Verified demo execution requires dedicated admission');
    if(this.hasUnappliedObservations())throw new Error('Pending observations block admission');
    if(state.campaignId && this.campaign(state.campaignId)?.paused)throw new Error('Campaign execution is blocked');
    const peers=this.db.prepare('SELECT state FROM tasks WHERE id<>?').all(state.id).map(row=>JSON.parse(row.state));
    if(enteringQueue) {
      if(peers.filter(task=>task.queue?.state==='QUEUED').length>=3)
        throw Object.assign(new Error('Queue capacity exceeded'),{code:'QUEUE_CAPACITY_EXCEEDED'});
      if(peers.some(task=>task.ledger.intents.some(intent=>!intent.settled && ['UNKNOWN','CANCEL_PENDING'].includes(intent.state))))
        throw new Error('Unresolved execution blocks queue admission');
    }
    if(starting && peers.some(task=>task.busy || task.queue?.state==='RUNNING' || task.ledger.intents.some(intent=>!intent.settled)))
      throw new Error('Execution lane is occupied');
    if(additions.length || submits) {
      if(additions.length && (state.ledger.intents.length>1 || previous?.ledger.intents.length))
        throw new Error('Only one order attempt is allowed per task');
      if(ledgerSummary(state.ledger).violation)throw new Error('Task budget blocks admission');
      if(peers.some(task=>task.policy.accountId===state.policy.accountId
          && task.ledger.intents.some(intent=>!intent.settled)))throw new Error('Account intent slot is occupied');
    }
  }
  // No await/provider work between lookup and create. create rechecks the draft,
  // owner, capacity and blockers inside the single SQLite write transaction.
  approveAndEnqueue(input,ownerId,makeTask) {
    const request=approvalRequest(input,ownerId),draft=this.policyWorkflow(request.draftId,ownerId);
    if(ownerId!=='local-operator' && !this.ownerSessionActive(ownerId,Date.now()))throw new Error('APPROVAL_OWNER_INACTIVE');
    if(draft.taskId) {
      const task=this.get(draft.taskId),first=task && this.receipts(task.id)[0];
      if(!task || task.ownerId!==ownerId || hashCanonical(task.approvalRequest??null)!==hashCanonical(request)
          || hashCanonical(first?.source?.decision?.approvalRequest??null)!==hashCanonical(request)
          || !this.verifySafetyTask(task))throw Object.assign(new Error('APPROVAL_CONFLICT'),{status:409});
      // Read-only retry works after pause, expiry and queue completion. It neither
      // renews deadlines nor grants permission to enqueue or submit again.
      return {task,replayed:true};
    }
    this.assertNewWorkAllowed();checkApprovalDraft(request,draft,Date.now());
    const task=makeTask(draft),now=Date.now();
    task.approvalRequest=request;
    task.queue={state:'QUEUED',enqueuedAtMs:now,expiresAtMs:Math.min(now+120000,task.policy.expiresAtMs)};
    return {task:this.create(task,{[APPROVAL_CONTEXT]:request}),replayed:false};
  }
  startDemoQueue(id) {
    return this.update(id,state=>{
      const now=Date.now();
      if(state.mode!=='demo-prepared' || !state.approvalRequest || state.queue?.state!=='QUEUED'
          || state.ledger.phase!=='WAITING' || state.ledger.stopRequested || state.busy || state.attempts!==0
          || state.submission || state.ledger.intents.length || !this.ownerSessionActive(state.ownerId,now)
          || now>=Math.min(state.queue.expiresAtMs,state.policy.expiresAtMs))throw new Error('DEMO_QUEUE_BLOCKED');
      state.queue.state='RUNNING';
      return {decision:{kind:'QUEUE_STARTED',message:'Demo görevi tek yürütme sırasını aldı; gönderim için son kontrol zorunlu.'}};
    },{[DEMO_QUEUE_CONTEXT]:true});
  }
  create(state,{[APPROVAL_CONTEXT]:approval=null}={}) {
    this.assertNewWorkAllowed();
    state.revision=1;
    state.auditPolicy = createPolicyCommitment({ taskId:state.auditTaskId, policy:state.policy });
    const receipt = createDecisionReceipt({ taskId:state.auditTaskId, policyHash:state.auditPolicy.policyHash,
      sequence:'1', decision:{ kind:approval?'POLICY_APPROVED_AND_QUEUED':'POLICY_APPROVED', environment:state.mode==='demo-prepared'?'demo-prepared':'fixture', atMs:Date.now(), policy:state.policy,
        ...(approval?{approvalRequest:approval,queue:state.queue}:{}) } });
    state.auditHead={sequence:receipt.sequence,receiptHash:receipt.receiptHash};
    this.#beginTransaction('BEGIN IMMEDIATE');
    try {
      this.validateTaskAdmission(state,null,{approval:!!approval});
      this.assertNewWorkAllowed();
      if(approval) {
        if(state.id!==approval.draftId || state.ownerId!==approval.ownerId || state.approvedPolicyHash!==approval.policyHash
            || hashPolicy(state.policy)!==approval.policyHash || state.policy.workflowId!==state.id
            || !['fixture','demo-prepared'].includes(state.mode) || state.mode!==state.policy.executionMode
            || state.ledger.taskId!==state.id || state.ledger.accountId!==state.policy.accountId
            || state.ledger.phase!==(state.mode==='fixture'?'RUNNING':'WAITING')
            || state.busy || state.ledger.intents.length || state.attempts!==0 || state.ledger.stopRequested
            || state.queue?.state!=='QUEUED' || state.queue.expiresAtMs<=Date.now()
            || state.mode==='demo-prepared' && !this.ownerSessionActive(state.ownerId,Date.now())
            || state.ownerId!=='local-operator' && !this.ownerSessionActive(state.ownerId,Date.now()))throw new Error('APPROVAL_TASK_BINDING');
        const owned=this.list(state.ownerId);
        if(owned.length>=10 || owned.some(task=>task.busy || ['QUEUED','RUNNING','BLOCKED'].includes(task.queue?.state)
            || task.ledger.intents.some(intent=>!intent.settled) || ['RUNNING','STOP_REQUESTED'].includes(task.ledger.phase)))
          throw new Error('APPROVAL_OWNER_CAPACITY');
      }
      if(state.policy.workflowId) {
        const draft=this.policyWorkflow(state.policy.workflowId,state.ownerId);
        if(approval)checkApprovalDraft(approval,draft,Date.now());
        if(draft.taskId || state.id!==draft.id || !draft.ready || Date.now()>=Math.min(draft.validUntilMs,draft.policy?.expiresAtMs??0)
            || !draft.policy || hashPolicy(state.policy)!==draft.policyHash || hashPolicy(draft.policy)!==draft.policyHash)
          throw new Error('DRAFT_APPROVAL_CHANGED');
        this.db.prepare('UPDATE policy_workflows SET task_id=? WHERE id=? AND task_id IS NULL').run(state.id,draft.id);
      }
      this.projectTaskCampaign(state);
      this.db.prepare('INSERT INTO tasks(id,state) VALUES(?,?)').run(state.id, JSON.stringify(state));
      this.db.prepare('INSERT INTO events(task_id,sequence,receipt) VALUES(?,?,?)').run(state.id, 1, JSON.stringify(receipt));
      this.db.prepare('INSERT INTO receipt_outbox(task_id,sequence) VALUES(?,?)').run(state.id, 1);
      this.db.exec('COMMIT'); return this.get(state.id);
    } catch (error) { this.#rollbackTransaction(error); throw error; }
  }
  update(id, mutate, {observationId=null,[REPLAY_CONTEXT]:replay=null,[DEMO_CONSUME_CONTEXT]:consume=null,[DEMO_CANCEL_CONTEXT]:cancel=false,[DEMO_QUEUE_CONTEXT]:demoQueue=false}={}) {
    this.#beginTransaction('BEGIN IMMEDIATE');
    try {
      const state = this.get(id);
      if (!state) throw Object.assign(new Error('Görev bulunamadı'), { status:404 });
      if(state.approvalRequest && !this.verifySafetyTask(state))throw new Error('APPROVAL_AUDIT_CHANGED');
      const previous=JSON.parse(JSON.stringify(state));
      const tail=this.db.prepare('SELECT receipt FROM events WHERE task_id=? ORDER BY sequence DESC LIMIT 1').get(id);
      const last=tail?JSON.parse(tail.receipt):null;
      if(!last || !verifyDecisionReceipt(last) || state.auditHead?.sequence!==last.sequence || state.auditHead?.receiptHash!==last.receiptHash)
        throw Object.assign(new Error('Kayıt sonu referansla uyuşmuyor. Eksik kayıt otomatik yeniden yazılmadı; operatör incelemesi gerekli.'),{status:409});
      if(!verifyAuditChain({policyCommitment:state.auditPolicy,receipts:this.receipts(id),expectedHead:state.auditHead}))
        throw Object.assign(new Error('Karar kayıtları doğrulanamadı. Yeni yazım kapalı; operatör kontrolü gerekiyor.'),{status:409});
      const change = mutate(state) || {};
      this.validateTaskAdmission(state,previous,{cancel,demoQueue});
      this.projectTaskCampaign(state,previous);
      state.revision=(state.revision || 0)+1;
      if (change.decision) {
        const sequence = last ? Number(last.sequence) + 1 : 1;
        const receipt = createDecisionReceipt({
          taskId:state.auditTaskId, policyHash:state.auditPolicy.policyHash,
          sequence:String(sequence), ...(last ? { previousHash:last.receiptHash } : {}),
          decision:{ atMs:Date.now(), ...change.decision }
        });
        state.auditHead={sequence:receipt.sequence,receiptHash:receipt.receiptHash};
        this.db.prepare('INSERT INTO events(task_id,sequence,receipt) VALUES(?,?,?)')
          .run(id, sequence, JSON.stringify(receipt));
        this.db.prepare('INSERT INTO receipt_outbox(task_id,sequence) VALUES(?,?)').run(id, sequence);
      }
      this.db.prepare('UPDATE tasks SET state=? WHERE id=?').run(JSON.stringify(state), id);
      if(consume) {
        if(!consume.references?.length)throw observationFailure('LIFECYCLE_CONSUME_CONTEXT');
        for(const reference of consume.references) {
          const changed=this.db.prepare("UPDATE atk_tool_observations SET status=? WHERE observation_id=? AND payload_hash=? AND status='PENDING'")
            .run(consume.status,reference.id,reference.payloadHash);
          if(changed.changes!==1)throw observationFailure('LIFECYCLE_CONSUME_CONFLICT');
        }
        this.db.prepare('INSERT INTO observation_replays(kind,observation_id,review_hash,result) VALUES(?,?,?,?)')
          .run('atk-consume',consume.observationId,consume.reviewHash,JSON.stringify({taskId:id,taskRevision:state.revision,
            status:consume.status,settlementAuthorized:false,observationIds:consume.references.map(ref=>ref.id)}));
      }
      if(observationId!==null) {
        const observation=this.db.prepare('SELECT intent_id,status FROM observations WHERE id=? AND task_id=?').get(observationId,id);
        if(!observation || !(replay?['PENDING','QUARANTINED']:['PENDING']).includes(observation.status)
            || !state.ledger.intents.some(intent=>intent.id===observation.intent_id))
          throw new Error('Observation projection mismatch');
        const intent=state.ledger.intents.find(item=>item.id===observation.intent_id);
        this.db.prepare('UPDATE observations SET status=? WHERE id=?').run(intent.quarantined?'QUARANTINED':'APPLIED',observationId);
        if(replay) {
          if(replay.id!==observationId)throw observationFailure('OBSERVATION_REPLAY_INPUT');
          const result={observationId,taskId:id,taskRevision:state.revision,reviewHash:replay.reviewHash,
            status:intent.quarantined?'QUARANTINED':'APPLIED',executionResumed:false};
          this.db.prepare("INSERT INTO observation_replays(kind,observation_id,review_hash,result) VALUES('fixture',?,?,?)")
            .run(String(observationId),replay.reviewHash,JSON.stringify(result));
        }
      }
      this.db.exec('COMMIT');
      return this.get(id);
    } catch (error) { this.#rollbackTransaction(error); throw error; }
  }
  receipts(id) {
    return this.db.prepare('SELECT receipt FROM events WHERE task_id=? ORDER BY sequence').all(id)
      .map(row => JSON.parse(row.receipt));
  }
  close() {
    this.#demoRuntime=null;
    this.#captureSessions.clear();
    this.db.close(); closeSync(this.lockFd); unlinkSync(this.lockPath);
  }
}
