import {randomUUID} from 'node:crypto';
import {hashCanonical} from '../domain/governor.mjs';
import {hashPreflightPolicy,verifyReport} from './domain.mjs';
import {hashPreflightCandidate} from './domain.mjs';
import {parseDecimal} from '../domain/money.mjs';

const POLICY_LIMIT=20;
const CHECK_LIMIT=12;
const OWNER_MODEL_LIMIT=12;
const HISTORY_LIMIT=25;
const fail=(message,status=400,code='PREFLIGHT_REPOSITORY')=>Object.assign(new Error(message),{status,code});

function owner(value) {
  if(typeof value!=='string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value))
    throw fail('Oturum sahibi geçersiz.',503,'PREFLIGHT_STORAGE_UNCERTAIN');
  return value;
}
function uuid(value,label='Kimlik') {
  if(typeof value!=='string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value))
    throw fail(label+' geçersiz.',400,'PREFLIGHT_INPUT_INVALID');
  return value;
}
function publicPolicy(record) {
  const {ownerId,...view}=record;return view;
}
function verifiedPolicy(record,{ownerId,id}={}) {
  const hasApproval=record && Object.hasOwn(record,'approvedByUserAtMs');
  if(!record || ownerId && record.ownerId!==ownerId || id && record.id!==id
      || !['DRAFT','APPROVED'].includes(record.status)
      || record.status==='DRAFT' && hasApproval || record.status==='APPROVED' && !hasApproval
      || (hasApproval && (!Number.isSafeInteger(record.approvedByUserAtMs)
        || record.approvedByUserAtMs<record.validFromMs || record.approvedByUserAtMs>=record.expiresAtMs)))
    throw fail('Kalıcı politika kaydı doğrulanamadı.',503,'PREFLIGHT_POLICY_INVALID');
  const domain=Object.fromEntries(['id','policy','policyHash','status','createdAtMs','validFromMs','expiresAtMs']
    .map(key=>[key,record[key]]));
  try {if(hashPreflightPolicy(domain)!==record.policyHash)throw new Error();}
  catch {throw fail('Kalıcı politika kaydı doğrulanamadı.',503,'PREFLIGHT_POLICY_INVALID');}
  return record;
}
function publicCheck(record) {
  if(record.state==='COMPLETED' && (!record.report || !verifyReport(record.report).ok))
    throw fail('Kalıcı kontrol raporu doğrulanamadı.',503,'PREFLIGHT_REPORT_INVALID');
  return Object.freeze({id:record.id,state:record.state,mode:record.mode,source:record.source??'MANUAL',createdAtMs:record.createdAtMs,report:record.report});
}

/** Preflight records share Store's one SQLite connection and filesystem lock. */
export class PreflightRepository {
  #modelCallLimit;
  constructor(store,{modelCallLimit=100}={}) {
    if(!store?.db)throw new TypeError('PREFLIGHT_STORE_REQUIRED');
    if(!Number.isSafeInteger(modelCallLimit) || modelCallLimit<1 || modelCallLimit>1000)
      throw new TypeError('PREFLIGHT_MODEL_LIMIT');
    this.store=store;this.db=store.db;this.#modelCallLimit=modelCallLimit;
  }
  #write(sql,args=[]) {
    try {return this.db.prepare(sql).run(...args);}
    catch {
      try{this.store.pauseGlobal('STORAGE_UNCERTAIN');}catch{}
      throw fail('Kalıcı preflight kaydı güvenle yazılamadı.',503,'PREFLIGHT_STORAGE_UNCERTAIN');
    }
  }
  #read(work) {
    try {return work();}
    catch {
      try{this.store.pauseGlobal('STORAGE_UNCERTAIN');}catch{}
      throw fail('Kalıcı preflight kaydı güvenle okunamadı.',503,'PREFLIGHT_STORAGE_UNCERTAIN');
    }
  }
  createPolicy(ownerId,record) {
    ownerId=owner(ownerId);
    if(this.#read(()=>this.db.prepare('SELECT COUNT(*) AS n FROM preflight_policies WHERE owner_id=?').get(ownerId).n)>=POLICY_LIMIT)
      throw fail('Bu oturum için politika sınırına ulaşıldı.',429,'PREFLIGHT_POLICY_LIMIT');
    const stored={...record,ownerId};
    this.#write('INSERT INTO preflight_policies(id,owner_id,created_at_ms,record) VALUES(?,?,?,?)',
      [record.id,ownerId,record.createdAtMs,JSON.stringify(stored)]);
    return publicPolicy(stored);
  }
  policy(ownerId,id) {
    ownerId=owner(ownerId);id=uuid(id,'Politika kimliği');
    const record=this.#read(()=>{const row=this.db.prepare('SELECT record FROM preflight_policies WHERE id=? AND owner_id=?')
      .get(id,ownerId);return row?JSON.parse(row.record):null;});
    if(!record)throw fail('Politika bulunamadı.',404,'PREFLIGHT_POLICY_NOT_FOUND');
    return verifiedPolicy(record,{ownerId,id});
  }
  approvePolicy(ownerId,id,policyHash,approve,nowMs) {
    const current=this.policy(ownerId,id),approved=approve(publicPolicy(current),policyHash,nowMs);
    const stored={...approved,ownerId:current.ownerId,approvedByUserAtMs:current.approvedByUserAtMs??nowMs};
    const changed=this.#write('UPDATE preflight_policies SET record=? WHERE id=? AND owner_id=?',
      [JSON.stringify(stored),id,ownerId]);
    if(changed.changes!==1)throw fail('Politika durumu değişti.',409,'PREFLIGHT_POLICY_NOT_FOUND');
    return publicPolicy(stored);
  }
  checkByRequest(ownerId,clientRequestId) {
    ownerId=owner(ownerId);clientRequestId=uuid(clientRequestId,'İstemci istek kimliği');
    return this.#read(()=>{const row=this.db.prepare('SELECT record FROM preflight_checks WHERE owner_id=? AND client_request_id=?')
      .get(ownerId,clientRequestId);return row?JSON.parse(row.record):null;});
  }
  createCheck(ownerId,input,{mode='LIVE_READ_ONLY',source='MANUAL',idempotencyInput=input}={}) {
    ownerId=owner(ownerId);const clientRequestId=uuid(input.clientRequestId,'İstemci istek kimliği');
    if(!['LIVE_READ_ONLY','REPLAY'].includes(mode))throw fail('Kontrol modu geçersiz.');
    const inputHash=hashCanonical(idempotencyInput),existing=this.checkByRequest(ownerId,clientRequestId);
    if(existing) {
      if(existing.inputHash!==inputHash || existing.mode!==mode || (existing.source??'MANUAL')!==source)
        throw fail('Aynı istek kimliği farklı içerikle kullanılamaz.',409,'PREFLIGHT_IDEMPOTENCY_CONFLICT');
      return {record:existing,replayed:true};
    }
    if(this.#read(()=>this.db.prepare('SELECT COUNT(*) AS n FROM preflight_checks WHERE owner_id=?').get(ownerId).n)>=CHECK_LIMIT)
      throw fail('Bu oturum için kontrol sınırına ulaşıldı.',429,'PREFLIGHT_CHECK_LIMIT');
    const nowMs=Date.now(),record={id:randomUUID(),ownerId,clientRequestId,inputHash,state:'QUEUED',mode,
      createdAtMs:nowMs,updatedAtMs:nowMs,policyId:input.policyId??null,policyHash:input.policyHash??null,
      policyRecord:input.policyRecord??null,candidate:input.candidate??null,exampleName:input.name??null,
      modelCallCount:0,source,agentTrace:null,report:null};
    this.#write(`INSERT INTO preflight_checks(id,owner_id,client_request_id,input_hash,state,mode,
      created_at_ms,updated_at_ms,model_calls,record) VALUES(?,?,?,?,?,?,?,?,0,?)`,
      [record.id,ownerId,clientRequestId,inputHash,record.state,mode,nowMs,nowMs,JSON.stringify(record)]);
    return {record,replayed:false};
  }
  markRunning(ownerId,id) {
    const record=this.check(ownerId,id);if(record.state!=='QUEUED')throw fail('Kontrol çalıştırılamadı.',409,'PREFLIGHT_CHECK_STATE');
    record.state='RUNNING';record.updatedAtMs=Date.now();
    const changed=this.#write("UPDATE preflight_checks SET state='RUNNING',updated_at_ms=?,record=? WHERE id=? AND owner_id=? AND state='QUEUED'",
      [record.updatedAtMs,JSON.stringify(record),id,ownerId]);
    if(changed.changes!==1)throw fail('Kontrol durumu değişti.',409,'PREFLIGHT_CHECK_STATE');
    return record;
  }
  reservePlanCall(ownerId,id) {
    ownerId=owner(ownerId);id=uuid(id,'Kontrol kimliği');
    let begun=false;
    try {
      this.db.exec('BEGIN IMMEDIATE');begun=true;
      const record=this.check(ownerId,id),budget=this.db.prepare("SELECT used FROM model_call_budget WHERE provider='preflight-ollama'").get();
      const ownerBudget=this.db.prepare('SELECT COALESCE(SUM(model_calls),0) AS used FROM preflight_checks WHERE owner_id=?').get(ownerId);
      if(!this.store.ownerSessionActive(ownerId,Date.now()))throw fail('Oturum sona erdi.',401,'PREFLIGHT_LIVE_UNAVAILABLE');
      if(record.state!=='RUNNING' || record.mode!=='LIVE_READ_ONLY' || (record.source??'MANUAL')!=='MANUAL' || record.modelCallCount!==0
          || !budget || !Number.isSafeInteger(budget.used) || budget.used<0 || budget.used>=this.#modelCallLimit
          || !Number.isSafeInteger(ownerBudget?.used) || ownerBudget.used<0 || ownerBudget.used>=OWNER_MODEL_LIMIT)
        throw fail('Bu kontrol için model çağrısı kullanılamıyor.',409,'PREFLIGHT_PLAN_LIMIT');
      record.modelCallCount=1;record.updatedAtMs=Date.now();
      const global=this.db.prepare("UPDATE model_call_budget SET used=used+1 WHERE provider='preflight-ollama' AND used=?")
        .run(budget.used);
      const changed=this.db.prepare(`UPDATE preflight_checks SET model_calls=1,updated_at_ms=?,record=?
        WHERE id=? AND owner_id=? AND state='RUNNING' AND model_calls=0`)
        .run(record.updatedAtMs,JSON.stringify(record),id,ownerId);
      if(global.changes!==1 || changed.changes!==1)throw fail('Model çağrı kotası değişti.',409,'PREFLIGHT_PLAN_LIMIT');
      this.db.exec('COMMIT');begun=false;return true;
    } catch(error) {
      if(begun)try{this.db.exec('ROLLBACK');}catch{try{this.store.pauseGlobal('STORAGE_UNCERTAIN');}catch{}}
      if(!error?.status)try{this.store.pauseGlobal('STORAGE_UNCERTAIN');}catch{}
      throw error;
    }
  }
  reserveAgentCall(ownerId,id) {
    ownerId=owner(ownerId);id=uuid(id,'Kontrol kimliği');
    let begun=false;
    try {
      this.db.exec('BEGIN IMMEDIATE');begun=true;
      const record=this.check(ownerId,id),budget=this.db.prepare("SELECT used FROM model_call_budget WHERE provider='preflight-ollama'").get();
      const ownerBudget=this.db.prepare('SELECT COALESCE(SUM(model_calls),0) AS used FROM preflight_checks WHERE owner_id=?').get(ownerId);
      if(!this.store.ownerSessionActive(ownerId,Date.now()))throw fail('Oturum sona erdi.',401,'PREFLIGHT_LIVE_UNAVAILABLE');
      if(record.state!=='RUNNING' || record.mode!=='LIVE_READ_ONLY' || record.source!=='AGENT' || ![0,1].includes(record.modelCallCount)
          || !budget || !Number.isSafeInteger(budget.used) || budget.used<0 || budget.used>=this.#modelCallLimit
          || !Number.isSafeInteger(ownerBudget?.used) || ownerBudget.used<0 || ownerBudget.used>=OWNER_MODEL_LIMIT)
        throw fail('Bu kontrol için model çağrısı kullanılamıyor.',409,'PREFLIGHT_PLAN_LIMIT');
      const previous=record.modelCallCount;record.modelCallCount=previous+1;record.updatedAtMs=Date.now();
      const global=this.db.prepare("UPDATE model_call_budget SET used=used+1 WHERE provider='preflight-ollama' AND used=?").run(budget.used);
      const changed=this.db.prepare(`UPDATE preflight_checks SET model_calls=?,updated_at_ms=?,record=?
        WHERE id=? AND owner_id=? AND state='RUNNING' AND model_calls=?`).run(record.modelCallCount,record.updatedAtMs,JSON.stringify(record),id,ownerId,previous);
      if(global.changes!==1 || changed.changes!==1)throw fail('Model çağrı kotası değişti.',409,'PREFLIGHT_PLAN_LIMIT');
      this.db.exec('COMMIT');begun=false;return true;
    } catch(error) {
      if(begun)try{this.db.exec('ROLLBACK');}catch{try{this.store.pauseGlobal('STORAGE_UNCERTAIN');}catch{}}
      if(!error?.status)try{this.store.pauseGlobal('STORAGE_UNCERTAIN');}catch{}
      throw error;
    }
  }
  complete(ownerId,id,report) {
    if(!verifyReport(report)?.ok)throw fail('Kontrol raporu doğrulanamadı.',503,'PREFLIGHT_REPORT_INVALID');
    const record=this.check(ownerId,id);
    if(record.state==='COMPLETED')return record;
    if(!['QUEUED','RUNNING'].includes(record.state))throw fail('Kontrol tamamlanamadı.',409,'PREFLIGHT_CHECK_STATE');
    if(report.mode!==record.mode || record.mode==='LIVE_READ_ONLY' && report.policyHash!==record.policyHash)
      throw fail('Kontrol raporu kalıcı girdiye bağlı değil.',503,'PREFLIGHT_REPORT_INVALID');
    if(record.mode==='LIVE_READ_ONLY' && (record.source??'MANUAL')==='MANUAL'
        && hashPreflightCandidate(report.candidate)!==hashPreflightCandidate(record.candidate))
      throw fail('Kontrol raporu kalıcı adaya bağlı değil.',503,'PREFLIGHT_REPORT_INVALID');
    if(record.source==='AGENT') {
      const trace=report.agentTrace;
      if(trace.modelCallCount!==record.modelCallCount)
        throw fail('Agent raporu kalıcı kotaya bağlı değil.',503,'PREFLIGHT_REPORT_INVALID');
      if(trace.version===1) {
        const first=trace.attempts[0],last=trace.attempts.at(-1);
        if(first.candidateHash!==hashPreflightCandidate(record.candidate)
            || last.candidateHash!==hashPreflightCandidate(report.candidate)
            || parseDecimal(report.candidate.price)>parseDecimal(record.candidate.price)
            || parseDecimal(report.candidate.size)>parseDecimal(record.candidate.size))
          throw fail('Agent raporu başlangıç adayına bağlı değil.',503,'PREFLIGHT_REPORT_INVALID');
      } else if(report.verdict==='ALLOW')
        throw fail('Agent izi olmadan olumlu rapor tamamlanamaz.',503,'PREFLIGHT_REPORT_INVALID');
    }
    record.state='COMPLETED';record.updatedAtMs=Date.now();record.report=report;
    const changed=this.#write(`UPDATE preflight_checks SET state='COMPLETED',updated_at_ms=?,record=?
      WHERE id=? AND owner_id=? AND state IN ('QUEUED','RUNNING')`,
      [record.updatedAtMs,JSON.stringify(record),id,ownerId]);
    if(changed.changes!==1)throw fail('Kontrol durumu değişti.',409,'PREFLIGHT_CHECK_STATE');
    return record;
  }
  check(ownerId,id) {
    ownerId=owner(ownerId);id=uuid(id,'Kontrol kimliği');
    const record=this.#read(()=>{const row=this.db.prepare('SELECT record FROM preflight_checks WHERE id=? AND owner_id=?')
      .get(id,ownerId);return row?JSON.parse(row.record):null;});
    if(!record)throw fail('Kontrol bulunamadı.',404,'PREFLIGHT_CHECK_NOT_FOUND');
    return record;
  }
  viewCheck(ownerId,id){return publicCheck(this.check(ownerId,id));}
  report(ownerId,id) {
    const record=this.check(ownerId,id);
    if(record.state!=='COMPLETED' || !record.report)throw fail('Rapor henüz tamamlanmadı.',409,'PREFLIGHT_REPORT_PENDING');
    if(!verifyReport(record.report).ok)throw fail('Kalıcı kontrol raporu doğrulanamadı.',503,'PREFLIGHT_REPORT_INVALID');
    return record.report;
  }
  history(ownerId) {
    ownerId=owner(ownerId);
    const policies=this.#read(()=>this.db.prepare('SELECT record FROM preflight_policies WHERE owner_id=? ORDER BY created_at_ms DESC LIMIT ?')
      .all(ownerId,HISTORY_LIMIT).map(row=>publicPolicy(verifiedPolicy(JSON.parse(row.record),{ownerId}))));
    const checks=this.#read(()=>this.db.prepare('SELECT record FROM preflight_checks WHERE owner_id=? ORDER BY created_at_ms DESC LIMIT ?')
      .all(ownerId,HISTORY_LIMIT).map(row=>publicCheck(JSON.parse(row.record))));
    return {policies,checks};
  }
  incomplete() {
    return this.#read(()=>this.db.prepare("SELECT record FROM preflight_checks WHERE state IN ('QUEUED','RUNNING') ORDER BY created_at_ms")
      .all().map(row=>JSON.parse(row.record)));
  }
  static limits(){return Object.freeze({policiesPerSession:POLICY_LIMIT,checksPerSession:CHECK_LIMIT,
    concurrentLiveChecks:1,modelPlanCallsPerCheck:1,modelCallsPerAgentCheck:2,
    modelPlanCallsPerSession:OWNER_MODEL_LIMIT,historyItems:HISTORY_LIMIT});}
  limits(){return Object.freeze({...PreflightRepository.limits(),modelPlanCallsGlobal:this.#modelCallLimit});}
}
