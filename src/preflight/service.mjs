import {randomUUID} from 'node:crypto';
import {hashCanonical} from '../domain/governor.mjs';
import {normalizeDemoInstrument,normalizeDemoTicker} from '../adapters/atk-market-account.mjs';
import {createPolicy,approvePolicy,normalizePolicyInput,normalizeCandidate,evaluatePreflight,
  verifyReport,hashPreflightCandidate,hashPreflightEvidence} from './domain.mjs';
import {REPLAY_EXAMPLES,runReplayExample} from './examples.mjs';
import {parseDecimal} from '../domain/money.mjs';

const TICKER_ARGS=Object.freeze({instId:'AVAX-USDT',demo:true});
const INSTRUMENT_ARGS=Object.freeze({instType:'SPOT',instId:'AVAX-USDT',demo:true});
const ARGUMENTS=Object.freeze({market_get_ticker:TICKER_ARGS,market_get_instruments:INSTRUMENT_ARGS});
const fail=(message,status=400,code='PREFLIGHT_INPUT_INVALID')=>Object.assign(new Error(message),{status,code});
const exact=(value,keys)=>value && typeof value==='object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',')===[...keys].sort().join(',');
const POLICY_RECORD_KEYS=['id','policy','policyHash','status','createdAtMs','validFromMs','expiresAtMs'];
const domainPolicyRecord=record=>Object.fromEntries(POLICY_RECORD_KEYS.map(key=>[key,record[key]]));
const FAILURE_CODES=new Set(['PREFLIGHT_PLAN_LIMIT','PREFLIGHT_PLAN_UNAVAILABLE','PREFLIGHT_PLAN_INVALID',
  'PREFLIGHT_AGENT_LIMIT','PREFLIGHT_AGENT_UNAVAILABLE','PREFLIGHT_AGENT_INVALID',
  'PREFLIGHT_LIVE_UNAVAILABLE','PREFLIGHT_EVIDENCE_MISSING','PREFLIGHT_EVIDENCE_REJECTED',
  'PREFLIGHT_CAPTURE_FAILED','PREFLIGHT_PROCESS_RESTARTED','PREFLIGHT_INTERNAL_FAILURE']);
function liveStoreReady(store) {
  try {return store?.readOnlySafetyStatus()?.allowed===true;}catch{return false;}
}

function reportOrThrow(input) {
  const report=evaluatePreflight(input),verified=verifyReport(report);
  if(!verified?.ok)throw fail('Preflight raporu doğrulanamadı.',503,'PREFLIGHT_REPORT_INVALID');
  return report;
}
function evidenceInput(item,binding,action) {
  return {observationId:item.receipt.observationId,expectedBinding:binding,expectedTool:item.tool,
    expectedArgs:ARGUMENTS[item.tool],expectedPayloadHash:item.saved.record.payloadHash,action};
}

/** One-process bounded coordinator. It never submits, cancels or mutates orders. */
export class PreflightService {
  #repository;#runtime;#clock;#busy=false;#closing=false;#active=Promise.resolve();#failed=new Set();
  constructor({repository,getRuntime,clock=()=>Date.now()}) {
    if(!repository || typeof getRuntime!=='function' || typeof clock!=='function')
      throw new TypeError('PREFLIGHT_SERVICE_CONFIGURATION');
    this.#repository=repository;this.#runtime=getRuntime;this.#clock=clock;
    this.#recoverInterrupted();
  }
  status({plannerKind,atkState,scope,limits,agentAvailable=false,agentVersion=1}) {
    const runtime=this.#runtime(),evidenceClear=runtime?.store && !runtime.store.hasUnappliedObservations();
    return Object.freeze({version:1,liveAvailable:Boolean(runtime?.client && runtime?.planner && evidenceClear
        && liveStoreReady(runtime.store)),plannerKind,
      atkState,scope,limits,agentAvailable:Boolean(agentAvailable),agentVersion,
      orderSubmissionEnabled:false,publication:'LOCAL_ONLY'});
  }
  createPolicy(ownerId,input) {
    const policy=normalizePolicyInput(input),record=createPolicy(policy,randomUUID(),this.#clock());
    return this.#repository.createPolicy(ownerId,record);
  }
  approvePolicy(ownerId,id,input) {
    if(!exact(input,['policyHash','acknowledgement']) || input.acknowledgement!==true || typeof input.policyHash!=='string')
      throw fail('Politika hash ve açık onay gerekli.');
    return this.#repository.approvePolicy(ownerId,id,input.policyHash,approvePolicy,this.#clock());
  }
  policy(ownerId,id) {
    const {ownerId:ignored,...record}=this.#repository.policy(ownerId,id);return record;
  }
  history(ownerId){return this.#repository.history(ownerId);}
  check(ownerId,id){this.#repository.check(ownerId,id);this.#assertHealthy(id);return this.#repository.viewCheck(ownerId,id);}
  report(ownerId,id){this.#repository.check(ownerId,id);this.#assertHealthy(id);return this.#repository.report(ownerId,id);}
  createCheck(ownerId,input) {
    if(this.#closing)throw fail('Sunucu kapanıyor; yeni kontrol başlamadı.',503,'PREFLIGHT_CLOSING');
    if(!exact(input,['policyId','policyHash','candidate','clientRequestId']))throw fail('Kontrol isteği alanları geçersiz.');
    const candidate=normalizeCandidate(input.candidate),policyRecord=this.#repository.policy(ownerId,input.policyId);
    const boundPolicy=domainPolicyRecord(policyRecord);
    const idempotencyInput={policyId:policyRecord.id,policyHash:input.policyHash,candidate,
      clientRequestId:input.clientRequestId};
    const persistedInput={policyId:policyRecord.id,policyHash:input.policyHash,candidate,
      clientRequestId:input.clientRequestId,policyRecord:boundPolicy};
    const existing=this.#repository.checkByRequest(ownerId,input.clientRequestId);
    if(existing) {
      const expected=hashCanonical(idempotencyInput);
      if(existing.inputHash!==expected)throw fail('Aynı istek kimliği farklı içerikle kullanılamaz.',409,'PREFLIGHT_IDEMPOTENCY_CONFLICT');
      return this.check(ownerId,existing.id);
    }
    if(policyRecord.status!=='APPROVED' || policyRecord.policyHash!==input.policyHash)
      throw fail('Onaylanmış politika ve hash eşleşmiyor.',409,'PREFLIGHT_POLICY_NOT_APPROVED');
    const nowMs=this.#clock();
    if(nowMs<policyRecord.validFromMs || nowMs>=policyRecord.expiresAtMs)
      throw fail('Politikanın süresi geçerli değil; yeni politika oluştur.',409,'PREFLIGHT_POLICY_NOT_CURRENT');
    if(this.#busy)throw fail('Başka bir canlı kontrol sürüyor. Sonucunu bekleyip tekrar dene.',429,'PREFLIGHT_BUSY');
    const created=this.#repository.createCheck(ownerId,persistedInput,{mode:'LIVE_READ_ONLY',idempotencyInput});
    this.#busy=true;
    this.#active=Promise.resolve().then(()=>this.#run(ownerId,created.record.id))
      .catch(()=>{this.#failed.add(created.record.id);}).finally(()=>{this.#busy=false;});
    return this.#repository.viewCheck(ownerId,created.record.id);
  }
  createAgentCheck(ownerId,input) {
    if(this.#closing)throw fail('Sunucu kapanıyor; yeni kontrol başlamadı.',503,'PREFLIGHT_CLOSING');
    if(!exact(input,['policyId','policyHash','candidate','clientRequestId']))throw fail('Kontrol isteği alanları geçersiz.');
    const candidate=normalizeCandidate(input.candidate),policyRecord=this.#repository.policy(ownerId,input.policyId);
    const boundPolicy=domainPolicyRecord(policyRecord),idempotencyInput={policyId:policyRecord.id,
      policyHash:input.policyHash,candidate,clientRequestId:input.clientRequestId,source:'AGENT'};
    const existing=this.#repository.checkByRequest(ownerId,input.clientRequestId);
    if(existing) {
      if(existing.inputHash!==hashCanonical(idempotencyInput) || existing.source!=='AGENT')
        throw fail('Aynı istek kimliği farklı içerikle kullanılamaz.',409,'PREFLIGHT_IDEMPOTENCY_CONFLICT');
      return this.check(ownerId,existing.id);
    }
    if(policyRecord.status!=='APPROVED' || policyRecord.policyHash!==input.policyHash)
      throw fail('Onaylanmış politika ve hash eşleşmiyor.',409,'PREFLIGHT_POLICY_NOT_APPROVED');
    const nowMs=this.#clock();
    if(nowMs<policyRecord.validFromMs || nowMs>=policyRecord.expiresAtMs)
      throw fail('Politikanın süresi geçerli değil; yeni politika oluştur.',409,'PREFLIGHT_POLICY_NOT_CURRENT');
    if(this.#busy)throw fail('Başka bir canlı kontrol sürüyor. Sonucunu bekleyip tekrar dene.',429,'PREFLIGHT_BUSY');
    const created=this.#repository.createCheck(ownerId,{...idempotencyInput,policyRecord:boundPolicy},
      {mode:'LIVE_READ_ONLY',source:'AGENT',idempotencyInput});
    this.#busy=true;
    this.#active=Promise.resolve().then(()=>this.#runAgent(ownerId,created.record.id))
      .catch(()=>{this.#failed.add(created.record.id);}).finally(()=>{this.#busy=false;});
    return this.#repository.viewCheck(ownerId,created.record.id);
  }
  runExample(ownerId,name,input) {
    if(this.#closing)throw fail('Sunucu kapanıyor; yeni kontrol başlamadı.',503,'PREFLIGHT_CLOSING');
    if(!exact(input,['clientRequestId']) || !REPLAY_EXAMPLES.includes(name))throw fail('Kayıtlı örnek geçersiz.',404,'PREFLIGHT_EXAMPLE_NOT_FOUND');
    const persistedInput={clientRequestId:input.clientRequestId,name};
    const created=this.#repository.createCheck(ownerId,persistedInput,{mode:'REPLAY'});
    if(!created.replayed || created.record.state!=='COMPLETED') {
      const report=runReplayExample(name);
      if(!verifyReport(report)?.ok)throw fail('Kayıtlı örnek raporu doğrulanamadı.',503,'PREFLIGHT_REPORT_INVALID');
      this.#repository.complete(ownerId,created.record.id,report);
    }
    return this.#repository.viewCheck(ownerId,created.record.id);
  }
  close(){this.#closing=true;return this.#active;}
  #assertHealthy(id) {
    if(this.#failed.has(id))throw fail('Kontrol sonucu kalıcı olarak kaydedilemedi. Süreci yeniden başlatıp aynı istek kimliğiyle durumu kontrol et.',
      503,'PREFLIGHT_STORAGE_UNCERTAIN');
  }
  #recoverInterrupted() {
    for(const check of this.#repository.incomplete()) {
      const report=check.mode==='REPLAY' && REPLAY_EXAMPLES.includes(check.exampleName)
        ?runReplayExample(check.exampleName)
        :reportOrThrow({mode:'LIVE_READ_ONLY',policyRecord:check.policyRecord,candidate:check.candidate,
          evidence:null,agentTrace:{plannerKind:'ollama',plan:{tools:[]},modelCallCount:check.modelCallCount,
            failureCode:'PREFLIGHT_PROCESS_RESTARTED'},checkedAtMs:this.#clock()});
      if(!verifyReport(report)?.ok)throw fail('Kesintiye uğrayan rapor doğrulanamadı.',503,'PREFLIGHT_REPORT_INVALID');
      this.#repository.complete(check.ownerId,check.id,report);
    }
  }
  #assertAgentCurrent(ownerId,check,runtime,{allowPending=false}={}) {
    const now=this.#clock(),policy=this.#repository.policy(ownerId,check.policyId);
    if(!runtime?.store || !liveStoreReady(runtime.store) || !allowPending && runtime.store.hasUnappliedObservations()
        || !runtime.store.ownerSessionActive(ownerId,now))
      throw fail('Canlı salt-okuma oturumu hazır değil.',401,'PREFLIGHT_LIVE_UNAVAILABLE');
    if(policy.status!=='APPROVED' || policy.policyHash!==check.policyHash || now<policy.validFromMs || now>=policy.expiresAtMs)
      throw fail('Politika artık geçerli değil.',409,'PREFLIGHT_POLICY_NOT_CURRENT');
  }
  async #captureAgentEvidence(ownerId,check,runtime) {
    const captured=[];
    try {
      this.#assertAgentCurrent(ownerId,check,runtime);
      for(const tool of ['market_get_ticker','market_get_instruments']) {
        let receipt;
        try {receipt=await runtime.client.callJournalledRead(tool,ARGUMENTS[tool]);}
        catch {throw fail('ATK okuması tamamlanamadı.',409,'PREFLIGHT_CAPTURE_FAILED');}
        const saved=runtime.store.atkToolObservation(receipt.observationId);
        if(!saved)throw fail('ATK kanıt kaydı bulunamadı.',503,'PREFLIGHT_EVIDENCE_MISSING');
        captured.push({tool,receipt,saved});
      }
      const binding=runtime.client.journalContext(),nowMs=this.#clock();
      const tickerItem=captured[0],instrumentItem=captured[1];
      const ticker=normalizeDemoTicker(tickerItem.saved.record,{expectedBinding:binding,nowMs,maxAgeMs:10000,maxSkewMs:5000});
      const instrument=normalizeDemoInstrument(instrumentItem.saved.record,{expectedBinding:binding,nowMs,maxAgeMs:10000,maxSkewMs:5000});
      if(!ticker.ok || !instrument.ok || hashCanonical(ticker.binding)!==hashCanonical(instrument.binding)
          || Math.abs(ticker.timing.receivedAtMs-instrument.timing.receivedAtMs)>5000)
        throw fail('ATK kanıtı taze ve tutarlı değil.',409,'PREFLIGHT_EVIDENCE_REJECTED');
      this.#assertAgentCurrent(ownerId,check,runtime,{allowPending:true});
      runtime.store.consumeReadOnlyEvidenceBatch([
        evidenceInput(tickerItem,binding,'PREFLIGHT_TICKER_ACCEPTED'),
        evidenceInput(instrumentItem,binding,'PREFLIGHT_INSTRUMENT_ACCEPTED')]);
      captured.length=0;
      return {evidence:{ticker:{sourceObservationId:ticker.sourceObservationId,sourcePayloadHash:ticker.sourcePayloadHash,
        binding:ticker.binding,observedAtMs:ticker.timing.receivedAtMs,exchangeTimestampMs:ticker.ticker.exchangeTimestampMs,
        referencePrice:ticker.ticker.referencePrice,reference:ticker.ticker.reference},instrument:{sourceObservationId:instrument.sourceObservationId,
        sourcePayloadHash:instrument.sourcePayloadHash,binding:instrument.binding,observedAtMs:instrument.timing.receivedAtMs,
        instrument:{instId:instrument.instrument.instId,instType:instrument.instrument.instType,baseCcy:instrument.instrument.baseCcy,
          quoteCcy:instrument.instrument.quoteCcy,state:instrument.instrument.state,tickSz:instrument.instrument.tickSz,
          lotSz:instrument.instrument.lotSz,minSz:instrument.instrument.minSz,maxLmtSz:instrument.instrument.maxLmtSz}}},
        freshness:{tickerObservedAtMs:ticker.timing.receivedAtMs,instrumentObservedAtMs:instrument.timing.receivedAtMs,
          checkedAtMs:nowMs,verified:true}};
    } catch(error) {
      if(captured.length)try {
        const binding=runtime.client.journalContext();
        runtime.store.consumeReadOnlyEvidenceBatch(captured.map(item=>evidenceInput(item,binding,
          item.tool==='market_get_ticker'?'PREFLIGHT_TICKER_REJECTED':'PREFLIGHT_INSTRUMENT_REJECTED')));
      } catch {}
      throw error;
    }
  }
  async #runAgent(ownerId,id) {
    const check=this.#repository.markRunning(ownerId,id),runtime=this.#runtime();
    const tools=['market_get_ticker','market_get_instruments'],attempts=[];
    let current=check.candidate,lastEvidence=null,lastFreshness=null,failureCode=null,finalGovernorRead=null;
    try {
      if(!runtime?.client || !runtime?.agentReviewer || !runtime?.store)
        throw fail('Canlı agent bağlantısı hazır değil.',409,'PREFLIGHT_LIVE_UNAVAILABLE');
      for(let attempt=1;attempt<=2;attempt++) {
        const capture=await this.#captureAgentEvidence(ownerId,check,runtime);
        lastEvidence=capture.evidence;lastFreshness=capture.freshness;
        const preliminary=reportOrThrow({mode:'LIVE_READ_ONLY',policyRecord:check.policyRecord,candidate:current,
          evidence:lastEvidence,agentTrace:{plannerKind:'ollama',plan:{tools},modelCallCount:1,failureCode:null},checkedAtMs:this.#clock()});
        let review;
        try {review=await runtime.agentReviewer.review({checkId:id,ownerId,policyRecord:check.policyRecord,
          initialCandidate:check.candidate,currentCandidate:current,report:preliminary,attempt});}
        catch(error) {
          failureCode=['PREFLIGHT_AGENT_LIMIT','PREFLIGHT_AGENT_UNAVAILABLE','PREFLIGHT_AGENT_INVALID'].includes(error?.code)
            ?error.code:'PREFLIGHT_AGENT_UNAVAILABLE';
          break;
        }
        this.#assertAgentCurrent(ownerId,check,runtime);
        if(!exact(review,['action','candidate','reasonCode']) || !['ACCEPT','REVISE','WAIT'].includes(review.action))
          throw fail('Agent inceleme sonucu geçersiz.',409,'PREFLIGHT_AGENT_INVALID');
        if(review.action==='ACCEPT' && (review.candidate!==null || review.reasonCode!=='WITHIN_LIMITS' || preliminary.verdict!=='ALLOW'))
          throw fail('Agent yalnız governor ALLOW sonucunu kabul edebilir.',409,'PREFLIGHT_AGENT_INVALID');
        if(review.action==='WAIT' && (review.candidate!==null
            || !['NO_FEASIBLE_CANDIDATE','INSUFFICIENT_EVIDENCE','UNSUPPORTED_REQUEST'].includes(review.reasonCode)))
          throw fail('Agent bekleme sonucu geçersiz.',409,'PREFLIGHT_AGENT_INVALID');
        if(review.action==='WAIT' && (preliminary.verdict==='ALLOW'
            || review.reasonCode==='INSUFFICIENT_EVIDENCE' && preliminary.verdict!=='INSUFFICIENT_DATA'
            || review.reasonCode==='NO_FEASIBLE_CANDIDATE' && preliminary.verdict!=='BLOCK'))
          throw fail('Agent bekleme nedeni governor sonucuyla uyuşmuyor.',409,'PREFLIGHT_AGENT_INVALID');
        attempts.push({attempt,candidate:current,candidateHash:hashPreflightCandidate(current),readFreshness:lastFreshness,
          reviewedReportHash:preliminary.reportHash,reviewedEvidenceHash:preliminary.evidenceHash,
          reviewedVerdict:preliminary.verdict,decisionAtMs:this.#clock(),action:review.action,reasonCode:review.reasonCode});
        if(review.action!=='REVISE')break;
        if(attempt!==1 || !exact(review.candidate,['price','size']) || review.reasonCode!=='NORMALIZE_TO_RULES')
          throw fail('Agent düzeltmesi geçersiz.',409,'PREFLIGHT_AGENT_INVALID');
        const revised=normalizeCandidate({...current,price:review.candidate.price,size:review.candidate.size});
        if(parseDecimal(revised.price)>parseDecimal(check.candidate.price) || parseDecimal(revised.size)>parseDecimal(check.candidate.size)
            || hashPreflightCandidate(revised)===hashPreflightCandidate(current))
          throw fail('Agent düzeltmesi başlangıç sınırlarını aşamaz.',409,'PREFLIGHT_AGENT_INVALID');
        current=revised;
      }
      if(attempts.at(-1)?.action==='ACCEPT') {
        const finalCapture=await this.#captureAgentEvidence(ownerId,check,runtime);
        lastEvidence=finalCapture.evidence;
        finalGovernorRead={evidenceHash:hashPreflightEvidence(lastEvidence),tickerObservedAtMs:finalCapture.freshness.tickerObservedAtMs,
          instrumentObservedAtMs:finalCapture.freshness.instrumentObservedAtMs,checkedAtMs:finalCapture.freshness.checkedAtMs};
      }
      const stored=this.#repository.check(ownerId,id),trace={version:1,plannerKind:'agent',plan:{tools},
        modelCallCount:stored.modelCallCount,failureCode,reviewerKind:'bounded',attempts,finalGovernorRead};
      let report=reportOrThrow({mode:'LIVE_READ_ONLY',policyRecord:check.policyRecord,candidate:current,evidence:lastEvidence,
        agentTrace:trace,checkedAtMs:this.#clock()});
      this.#repository.complete(ownerId,id,report);
    } catch(error) {
      const currentRecord=this.#repository.check(ownerId,id),code=FAILURE_CODES.has(error?.code)?error.code:'PREFLIGHT_INTERNAL_FAILURE';
      const canTrace=lastEvidence && attempts.length>0 && attempts.at(-1).action!=='REVISE'
        && attempts.length===currentRecord.modelCallCount;
      const agentTrace=canTrace?{version:1,plannerKind:'agent',plan:{tools},modelCallCount:currentRecord.modelCallCount,
        failureCode:code,reviewerKind:'bounded',attempts,finalGovernorRead}
        :{plannerKind:'unavailable',plan:{tools:[]},modelCallCount:currentRecord.modelCallCount,failureCode:code};
      const report=reportOrThrow({mode:'LIVE_READ_ONLY',policyRecord:currentRecord.policyRecord,
        candidate:canTrace?current:currentRecord.candidate,
        evidence:canTrace?lastEvidence:null,agentTrace,checkedAtMs:this.#clock()});
      this.#repository.complete(ownerId,id,report);
    }
  }
  async #run(ownerId,id) {
    const check=this.#repository.markRunning(ownerId,id),runtime=this.#runtime();
    const plannerKind=runtime?.planner?.kind??'unavailable';
    let plan=null,captured=[],stage='runtime';
    try {
      if(!runtime?.client || !runtime?.planner || !liveStoreReady(runtime.store))
        throw fail('Canlı salt-okuma bağlantısı hazır değil.',409,'PREFLIGHT_LIVE_UNAVAILABLE');
      if(runtime.store.hasUnappliedObservations())
        throw fail('Bekleyen kanıt kaydı operatör incelemesi gerektiriyor.',409,'PREFLIGHT_EVIDENCE_REJECTED');
      stage='planner';
      plan=await runtime.planner.createPlan({checkId:id,ownerId,policyHash:check.policyHash,
        candidateHash:hashPreflightCandidate(check.candidate)});
      if(!exact(plan,['tools']) || !Array.isArray(plan.tools) || plan.tools.length!==2
          || new Set(plan.tools).size!==2 || plan.tools.some(tool=>!Object.hasOwn(ARGUMENTS,tool)))
        throw fail('Model araç planı geçersiz.',409,'PREFLIGHT_PLAN_INVALID');
      if(!liveStoreReady(runtime.store) || !runtime.store.ownerSessionActive(ownerId,this.#clock()))
        throw fail('Oturum model çağrısı sırasında sona erdi.',401,'PREFLIGHT_LIVE_UNAVAILABLE');
      stage='capture';
      for(const tool of plan.tools) {
        let receipt;
        try{receipt=await runtime.client.callJournalledRead(tool,ARGUMENTS[tool]);}
        catch{throw fail('ATK okuması tamamlanamadı.',409,'PREFLIGHT_CAPTURE_FAILED');}
        const saved=runtime.store.atkToolObservation(receipt.observationId);
        if(!saved)throw fail('ATK kanıt kaydı bulunamadı.',503,'PREFLIGHT_EVIDENCE_MISSING');
        captured.push({tool,receipt,saved});
      }
      stage='evidence';
      const binding=runtime.client.journalContext(),nowMs=this.#clock();
      const tickerItem=captured.find(item=>item.tool==='market_get_ticker');
      const instrumentItem=captured.find(item=>item.tool==='market_get_instruments');
      const ticker=normalizeDemoTicker(tickerItem?.saved.record,{expectedBinding:binding,nowMs,maxAgeMs:10000,maxSkewMs:5000});
      const instrument=normalizeDemoInstrument(instrumentItem?.saved.record,{expectedBinding:binding,nowMs,maxAgeMs:10000,maxSkewMs:5000});
      if(!ticker.ok || !instrument.ok || hashCanonical(ticker.binding)!==hashCanonical(instrument.binding)
          || Math.abs(ticker.timing.receivedAtMs-instrument.timing.receivedAtMs)>5000)
        throw fail('ATK kanıtı taze ve tutarlı değil.',409,'PREFLIGHT_EVIDENCE_REJECTED');
      if(!liveStoreReady(runtime.store) || !runtime.store.ownerSessionActive(ownerId,this.#clock()))
        throw fail('Oturum kanıt okuması sırasında sona erdi.',401,'PREFLIGHT_LIVE_UNAVAILABLE');
      runtime.store.consumeReadOnlyEvidenceBatch([
        evidenceInput(tickerItem,binding,'PREFLIGHT_TICKER_ACCEPTED'),
        evidenceInput(instrumentItem,binding,'PREFLIGHT_INSTRUMENT_ACCEPTED')
      ]);
      captured=[];
      const evidence={
        ticker:{sourceObservationId:ticker.sourceObservationId,sourcePayloadHash:ticker.sourcePayloadHash,
          binding:ticker.binding,observedAtMs:ticker.timing.receivedAtMs,
          exchangeTimestampMs:ticker.ticker.exchangeTimestampMs,referencePrice:ticker.ticker.referencePrice,
          reference:ticker.ticker.reference},
        instrument:{sourceObservationId:instrument.sourceObservationId,sourcePayloadHash:instrument.sourcePayloadHash,
          binding:instrument.binding,observedAtMs:instrument.timing.receivedAtMs,
          instrument:{instId:instrument.instrument.instId,instType:instrument.instrument.instType,
            baseCcy:instrument.instrument.baseCcy,quoteCcy:instrument.instrument.quoteCcy,state:instrument.instrument.state,
            tickSz:instrument.instrument.tickSz,lotSz:instrument.instrument.lotSz,minSz:instrument.instrument.minSz,
            maxLmtSz:instrument.instrument.maxLmtSz}}
      };
      const report=reportOrThrow({mode:'LIVE_READ_ONLY',policyRecord:check.policyRecord,candidate:check.candidate,evidence,
        agentTrace:{plannerKind,plan,modelCallCount:1,failureCode:null},checkedAtMs:this.#clock()});
      this.#repository.complete(ownerId,id,report);
    } catch(error) {
      if(captured.length) {
        try {
          const binding=runtime?.client?.journalContext();
          runtime.store.consumeReadOnlyEvidenceBatch(captured.map(item=>evidenceInput(item,binding,
            item.tool==='market_get_ticker'?'PREFLIGHT_TICKER_REJECTED':'PREFLIGHT_INSTRUMENT_REJECTED')));
        } catch {}
      }
      const current=this.#repository.check(ownerId,id);
      const failureCode=FAILURE_CODES.has(error?.code)?error.code:
        stage==='capture'?'PREFLIGHT_CAPTURE_FAILED':'PREFLIGHT_INTERNAL_FAILURE';
      const report=reportOrThrow({mode:'LIVE_READ_ONLY',policyRecord:current.policyRecord,candidate:current.candidate,
        evidence:null,agentTrace:{plannerKind,plan:plan??{tools:[]},modelCallCount:current.modelCallCount,failureCode},
        checkedAtMs:this.#clock()});
      this.#repository.complete(ownerId,id,report);
    }
  }
}
