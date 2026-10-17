import {canonicalJson,hashCanonical} from '../domain/governor.mjs';
import {DECIMAL_SCALE,formatDecimal,parseDecimal} from '../domain/money.mjs';

const POLICY_KEYS=['instrument','side','tdMode','ordType','maxNotional','maxPrice','durationSeconds'];
const CANDIDATE_KEYS=['instrument','side','tdMode','ordType','price','size'];
const RECORD_KEYS=['id','policy','policyHash','status','createdAtMs','validFromMs','expiresAtMs'];
const BINDING_KEYS=['accountId','catalogHash','connectionHash','isolatedEntrySha256','sessionId'];
const TICKER_KEYS=['sourceObservationId','sourcePayloadHash','binding','observedAtMs','exchangeTimestampMs','referencePrice','reference'];
const TICKER_PUBLIC_KEYS=['sourceObservationId','sourcePayloadHash','bindingHash','observedAtMs','exchangeTimestampMs','referencePrice','reference'];
const INSTRUMENT_KEYS=['sourceObservationId','sourcePayloadHash','binding','observedAtMs','instrument'];
const INSTRUMENT_PUBLIC_KEYS=['sourceObservationId','sourcePayloadHash','bindingHash','observedAtMs','instrument'];
const INSTRUMENT_VALUE_KEYS=['instId','instType','baseCcy','quoteCcy','state','tickSz','lotSz','minSz','maxLmtSz'];
const REPORT_KEYS=['schemaVersion','mode','publication','policy','policyHash','candidate','candidateHash','verdict','reasonCodes','checks','sanitizedEvidence','evidenceHash','agentTrace','checkedAtMs','notChecked','disclosure','reportHash'];
const HASH=/^[0-9a-f]{64}$/;
const ID=/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const AMOUNT=/^(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,8})?$/;
const ALLOWED_TOOLS=['market_get_ticker','market_get_instruments'];
const PLAN_FAILURES=new Set(['PREFLIGHT_PLAN_LIMIT','PREFLIGHT_PLAN_UNAVAILABLE','PREFLIGHT_PLAN_INVALID']);
const EVIDENCE_FAILURES=new Set(['PREFLIGHT_LIVE_UNAVAILABLE','PREFLIGHT_EVIDENCE_MISSING','PREFLIGHT_EVIDENCE_REJECTED',
  'PREFLIGHT_CAPTURE_FAILED','PREFLIGHT_PROCESS_RESTARTED','PREFLIGHT_INTERNAL_FAILURE']);
const AGENT_FAILURES=new Set(['PREFLIGHT_AGENT_LIMIT','PREFLIGHT_AGENT_UNAVAILABLE','PREFLIGHT_AGENT_INVALID']);
const FAILURE_CODES=new Set([...PLAN_FAILURES,...EVIDENCE_FAILURES,...AGENT_FAILURES]);
const REVIEW_REASONS=new Set(['WITHIN_LIMITS','NORMALIZE_TO_RULES','NO_FEASIBLE_CANDIDATE','INSUFFICIENT_EVIDENCE','UNSUPPORTED_REQUEST']);
const MAX_AGE_MS=10000;
const MAX_SKEW_MS=5000;

export const PREFLIGHT_SCOPE=Object.freeze({instrument:'AVAX-USDT',side:'buy',tdMode:'cash',ordType:'limit'});
export const PREFLIGHT_LIMITS=Object.freeze({amountWholeDigits:12,amountFractionDigits:8,durationSecondsMin:60,
  durationSecondsMax:3600,evidenceMaxAgeMs:MAX_AGE_MS,evidenceMaxSkewMs:MAX_SKEW_MS});
export const PREFLIGHT_DISCLOSURE='Bu rapor yalnız belirtilen kontrollerin yerel sonucudur. Piyasa verisi güncel bir referanstır; likidite, kayma, adil fiyat veya borsanın emri kabul edeceği anlamına gelmez. Rapor alım tavsiyesi, emir yürütme engeli, bakiye yeterliliği, gerçekleşme, kâr veya güvenlik garantisi değildir. Hash yerel bütünlük kontrolüdür; imza, bağımsız zaman damgası veya zincir yayını değildir.';
export const PREFLIGHT_NOT_CHECKED=deepFreeze([
  {code:'ACCOUNT_BALANCE',label:'Hesap bakiyesi ve kullanılabilir tutar'},
  {code:'FEES',label:'İşlem ve ağ ücretleri'},
  {code:'PORTFOLIO',label:'Portföy uygunluğu ve toplam kampanya harcaması'},
  {code:'ORDER_LIFECYCLE',label:'Emir gönderme, borsanın kabulü ve fiyat bandı, iptal, dolum ve gerçekleşme'},
  {code:'INVESTMENT_SUITABILITY',label:'Yatırım uygunluğu veya kârlılık'},
  {code:'USD_NATIVE_LIMIT',label:'Borsanın USD bazlı tutar sınırı için bağımsız kur dönüşümü'},
]);

const CHECKS=Object.freeze([
  ['policy','Politika bağı ve geçerlilik zamanı'],
  ['agent-plan','Salt okunur araç planı'],
  ['agent-review','Model incelemesi ve sınırlı düzeltme'],
  ['scope','Sabit ürün kapsamı'],
  ['price-cap','Fiyat üst sınırı'],
  ['notional-cap','Ücret hariç emir bedeli üst sınırı'],
  ['evidence','Kanıt bütünlüğü, tazeliği ve aynı bağlantı bağı'],
  ['instrument','Spot durumu ve listelenen enstrüman kuralları'],
  ['price-grid','Fiyat adımı'],
  ['size-grid','Miktar adımı ve enstrüman sınırları'],
]);

function deepFreeze(value) {
  if(value && typeof value==='object' && !Object.isFrozen(value)){
    Object.freeze(value);for(const child of Object.values(value))deepFreeze(child);
  }
  return value;
}
function plain(value,name='object') {
  if(!value || typeof value!=='object' || Array.isArray(value)
      || ![Object.prototype,null].includes(Object.getPrototypeOf(value))
      || Object.getOwnPropertySymbols(value).length)throw new TypeError(`Invalid ${name}`);
  const descriptors=Object.getOwnPropertyDescriptors(value);
  for(const descriptor of Object.values(descriptors))if(!Object.hasOwn(descriptor,'value'))throw new TypeError(`Invalid ${name}`);
  return descriptors;
}
function exact(value,keys,name) {
  const descriptors=plain(value,name),names=Object.keys(descriptors);
  if(names.length!==keys.length || names.some(key=>!keys.includes(key)))throw new TypeError(`Invalid ${name} fields`);
  return Object.fromEntries(names.map(key=>[key,descriptors[key].value]));
}
function policyRecordFields(value) {
  const descriptors=plain(value,'policy record'),names=Object.keys(descriptors);
  if(RECORD_KEYS.some(key=>!names.includes(key)) || names.some(key=>!RECORD_KEYS.includes(key) && key!=='approvedByUserAtMs'))
    throw new TypeError('Invalid policy record fields');
  if(Object.hasOwn(descriptors,'approvedByUserAtMs'))safeInteger(descriptors.approvedByUserAtMs.value,'approvedByUserAtMs');
  return Object.fromEntries(RECORD_KEYS.map(key=>[key,descriptors[key].value]));
}
function safeInteger(value,name) {
  if(!Number.isSafeInteger(value) || value<0)throw new TypeError(`Invalid ${name}`);return value;
}
function boundedString(value,name,max=256) {
  if(typeof value!=='string' || !value.length || value.length>max)throw new TypeError(`Invalid ${name}`);return value;
}
function decimal(value,name) {
  if(typeof value!=='string' || !AMOUNT.test(value))throw new TypeError(`Invalid ${name}`);
  const units=parseDecimal(value);if(units<=0n)throw new RangeError(`Invalid ${name}`);return {value:formatDecimal(units),units};
}
function hashDomain(domain,value) {return hashCanonical({domain:`Pactway/preflight/v1/${domain}`,value});}
function same(left,right) {return canonicalJson(left)===canonicalJson(right);}

export function normalizePolicyInput(input) {
  const value=exact(input,POLICY_KEYS,'policy');
  for(const key of ['instrument','side','tdMode','ordType'])if(value[key]!==PREFLIGHT_SCOPE[key])throw new RangeError('PREFLIGHT_POLICY_SCOPE');
  const maxNotional=decimal(value.maxNotional,'maxNotional').value;
  const maxPrice=decimal(value.maxPrice,'maxPrice').value;
  if(typeof value.durationSeconds!=='string' || !/^(?:0|[1-9][0-9]*)$/.test(value.durationSeconds))throw new TypeError('Invalid durationSeconds');
  const duration=Number(value.durationSeconds);
  if(!Number.isSafeInteger(duration) || duration<PREFLIGHT_LIMITS.durationSecondsMin || duration>PREFLIGHT_LIMITS.durationSecondsMax)
    throw new RangeError('PREFLIGHT_POLICY_DURATION');
  return deepFreeze({...PREFLIGHT_SCOPE,maxNotional,maxPrice,durationSeconds:String(duration)});
}

function immutablePolicy(record) {
  const item=policyRecordFields(record);
  if(typeof item.id!=='string' || !ID.test(item.id))throw new TypeError('Invalid policy id');
  const terms=normalizePolicyInput(item.policy);
  safeInteger(item.createdAtMs,'createdAtMs');safeInteger(item.validFromMs,'validFromMs');safeInteger(item.expiresAtMs,'expiresAtMs');
  if(item.createdAtMs!==item.validFromMs || item.expiresAtMs!==item.validFromMs+Number(terms.durationSeconds)*1000)
    throw new RangeError('PREFLIGHT_POLICY_TIME_BINDING');
  return deepFreeze({schemaVersion:1,id:item.id,...terms,createdAtMs:item.createdAtMs,
    validFromMs:item.validFromMs,expiresAtMs:item.expiresAtMs});
}
export function hashPreflightPolicy(policyRecord) {return hashDomain('policy',immutablePolicy(policyRecord));}

export function createPolicy(input,id,nowMs) {
  const policy=normalizePolicyInput(input);
  if(typeof id!=='string' || !ID.test(id))throw new TypeError('Invalid policy id');
  safeInteger(nowMs,'nowMs');
  const record={id,policy,policyHash:'',status:'DRAFT',createdAtMs:nowMs,validFromMs:nowMs,
    expiresAtMs:nowMs+Number(policy.durationSeconds)*1000};
  if(!Number.isSafeInteger(record.expiresAtMs))throw new RangeError('PREFLIGHT_POLICY_TIME_RANGE');
  record.policyHash=hashPreflightPolicy(record);
  return deepFreeze(record);
}

function validPolicyRecord(input,{approved=false}={}) {
  const item=policyRecordFields(input);
  const basis=immutablePolicy(item),expected=hashDomain('policy',basis);
  if(typeof item.policyHash!=='string' || item.policyHash!==expected)throw new RangeError('PREFLIGHT_POLICY_HASH');
  if(!['DRAFT','APPROVED'].includes(item.status) || approved && item.status!=='APPROVED')throw new RangeError('PREFLIGHT_POLICY_STATUS');
  return {record:deepFreeze({...item,policy:normalizePolicyInput(item.policy)}),basis};
}

export function approvePolicy(record,policyHash,nowMs) {
  const checked=validPolicyRecord(record);
  safeInteger(nowMs,'nowMs');
  if(typeof policyHash!=='string' || policyHash!==checked.record.policyHash)throw new RangeError('PREFLIGHT_POLICY_HASH');
  if(nowMs<checked.record.validFromMs || nowMs>=checked.record.expiresAtMs)throw new RangeError('PREFLIGHT_POLICY_NOT_CURRENT');
  if(checked.record.status==='APPROVED')return checked.record;
  return deepFreeze({...checked.record,status:'APPROVED'});
}

export function normalizeCandidate(input) {
  const value=exact(input,CANDIDATE_KEYS,'candidate');
  const result={};
  for(const key of ['instrument','side','tdMode','ordType'])result[key]=boundedString(value[key],key,32);
  result.price=decimal(value.price,'price').value;result.size=decimal(value.size,'size').value;
  return deepFreeze(result);
}
export function hashPreflightCandidate(candidate) {return hashDomain('candidate',normalizeCandidate(candidate));}

function bindingHash(input) {
  if(typeof input==='string'){
    if(!HASH.test(input))throw new TypeError('Invalid bindingHash');return input;
  }
  const value=exact(input,BINDING_KEYS,'evidence binding');
  for(const key of BINDING_KEYS)boundedString(value[key],key);
  return hashDomain('evidence-binding',value);
}
function evidenceItem(input,type) {
  const publicInput=Object.hasOwn(plain(input,'evidence item'),'bindingHash');
  const keys=type==='ticker'?(publicInput?TICKER_PUBLIC_KEYS:TICKER_KEYS):(publicInput?INSTRUMENT_PUBLIC_KEYS:INSTRUMENT_KEYS);
  const value=exact(input,keys,`${type} evidence`);
  boundedString(value.sourceObservationId,'sourceObservationId');
  if(typeof value.sourcePayloadHash!=='string' || !HASH.test(value.sourcePayloadHash))throw new TypeError('Invalid sourcePayloadHash');
  const common={sourceObservationId:value.sourceObservationId,sourcePayloadHash:value.sourcePayloadHash,
    bindingHash:bindingHash(publicInput?value.bindingHash:value.binding),observedAtMs:safeInteger(value.observedAtMs,'observedAtMs')};
  if(type==='ticker'){
    safeInteger(value.exchangeTimestampMs,'exchangeTimestampMs');
    if(value.reference!=='BEST_ASK')throw new RangeError('PREFLIGHT_TICKER_REFERENCE');
    return {...common,exchangeTimestampMs:value.exchangeTimestampMs,referencePrice:decimal(value.referencePrice,'referencePrice').value,
      reference:'BEST_ASK'};
  }
  const instrument=exact(value.instrument,INSTRUMENT_VALUE_KEYS,'instrument evidence');
  for(const key of ['instId','instType','baseCcy','quoteCcy','state'])boundedString(instrument[key],key,32);
  for(const key of ['tickSz','lotSz','minSz','maxLmtSz'])instrument[key]=decimal(instrument[key],key).value;
  return {...common,instrument};
}
function sanitizeEvidence(input) {
  if(input===null || input===undefined)return null;
  const value=exact(input,['ticker','instrument'],'evidence');
  return deepFreeze({ticker:evidenceItem(value.ticker,'ticker'),instrument:evidenceItem(value.instrument,'instrument')});
}
export function hashPreflightEvidence(evidence) {return hashDomain('evidence',sanitizeEvidence(evidence));}

function trace(input,mode,checkedAtMs,evidence) {
  let attempts=0;
  const unavailable=failureCode=>deepFreeze({plannerKind:'unavailable',plan:{tools:[]},modelCallCount:attempts,failureCode});
  try {
    const names=Object.keys(input??{});
    const isAgent=names.includes('version') || names.includes('attempts') || names.includes('reviewerKind');
    const value=isAgent?exact(input,['version','plannerKind','plan','modelCallCount','failureCode','reviewerKind','attempts','finalGovernorRead'],'agentTrace')
      :exact(input,['plannerKind','plan','modelCallCount','failureCode'],'agentTrace');
    if(Number.isSafeInteger(value.modelCallCount)
        && (isAgent || value.plannerKind==='unavailable'?[0,1,2]:[0,1]).includes(value.modelCallCount))attempts=value.modelCallCount;
    const failureCode=value.failureCode===null?null:value.failureCode;
    if(failureCode!==null && (typeof failureCode!=='string' || !FAILURE_CODES.has(failureCode)))
      return {value:unavailable(null),valid:false,failureCode:null};
    const planValue=exact(value.plan,['tools'],'agent plan');
    if(typeof value.plannerKind!=='string' || !Array.isArray(planValue.tools) || !Number.isSafeInteger(value.modelCallCount))
      return {value:unavailable(failureCode),valid:false,failureCode};
    const tools=planValue.tools.map(tool=>boundedString(tool,'plan tool',64));
    const planValid=mode==='LIVE_READ_ONLY'
      ? (isAgent?value.plannerKind==='agent' && [1,2].includes(value.modelCallCount)
        :value.plannerKind==='ollama' && value.modelCallCount===1) && tools.length===2
        && new Set(tools).size===2 && tools.every(tool=>ALLOWED_TOOLS.includes(tool))
        && !PLAN_FAILURES.has(failureCode)
      : mode==='REPLAY' && value.plannerKind==='replay' && value.modelCallCount===0 && tools.length===0 && failureCode===null;
    if(isAgent) {
      if(value.version!==1 || value.reviewerKind!=='bounded' || !Array.isArray(value.attempts) || value.attempts.length<1
          || value.attempts.length>2 || value.modelCallCount!==value.attempts.length)
        return {value:unavailable(failureCode),valid:false,failureCode};
      const attemptsValue=value.attempts.map((attempt,index)=>{
        const item=exact(attempt,['attempt','candidate','candidateHash','readFreshness','reviewedReportHash','reviewedEvidenceHash',
          'reviewedVerdict','decisionAtMs','action','reasonCode'],'agent attempt');
        if(item.attempt!==index+1 || !Number.isSafeInteger(item.attempt) || !['ACCEPT','REVISE','WAIT'].includes(item.action)
          || typeof item.candidateHash!=='string' || !HASH.test(item.candidateHash) || !item.candidate || hashPreflightCandidate(item.candidate)!==item.candidateHash
          || !item.readFreshness || typeof item.readFreshness!=='object' || item.readFreshness.verified!==true
          || Object.keys(item.readFreshness).sort().join(',')!=='checkedAtMs,instrumentObservedAtMs,tickerObservedAtMs,verified'
          || !Number.isSafeInteger(item.readFreshness.checkedAtMs)
          || !Number.isSafeInteger(item.readFreshness.tickerObservedAtMs) || !Number.isSafeInteger(item.readFreshness.instrumentObservedAtMs)
          || Math.abs(item.readFreshness.tickerObservedAtMs-item.readFreshness.instrumentObservedAtMs)>MAX_SKEW_MS
          || [item.readFreshness.tickerObservedAtMs,item.readFreshness.instrumentObservedAtMs]
            .some(time=>time>item.readFreshness.checkedAtMs+MAX_SKEW_MS || item.readFreshness.checkedAtMs-time>MAX_AGE_MS)
          || typeof item.reviewedReportHash!=='string' || !HASH.test(item.reviewedReportHash)
          || typeof item.reviewedEvidenceHash!=='string' || !HASH.test(item.reviewedEvidenceHash)
          || !['ALLOW','BLOCK','INSUFFICIENT_DATA'].includes(item.reviewedVerdict)
          || !Number.isSafeInteger(item.decisionAtMs) || item.decisionAtMs<item.readFreshness.checkedAtMs || item.decisionAtMs>checkedAtMs+MAX_SKEW_MS
          || typeof item.reasonCode!=='string' || !REVIEW_REASONS.has(item.reasonCode)) throw new TypeError('Invalid agent attempt');
        if(item.action==='ACCEPT' && item.reasonCode!=='WITHIN_LIMITS'
            || item.action==='REVISE' && item.reasonCode!=='NORMALIZE_TO_RULES'
            || item.action==='WAIT' && !['NO_FEASIBLE_CANDIDATE','INSUFFICIENT_EVIDENCE','UNSUPPORTED_REQUEST'].includes(item.reasonCode))
          throw new TypeError('Invalid agent action');
        if(item.action==='ACCEPT' && item.reviewedVerdict!=='ALLOW' || item.action==='REVISE' && item.reviewedVerdict!=='BLOCK'
            || item.reasonCode==='INSUFFICIENT_EVIDENCE' && item.reviewedVerdict!=='INSUFFICIENT_DATA')
          throw new TypeError('Invalid reviewed verdict');
        return deepFreeze({attempt:item.attempt,candidate:normalizeCandidate(item.candidate),candidateHash:item.candidateHash,
          readFreshness:{tickerObservedAtMs:item.readFreshness.tickerObservedAtMs,instrumentObservedAtMs:item.readFreshness.instrumentObservedAtMs,
            checkedAtMs:item.readFreshness.checkedAtMs,verified:true},
          reviewedReportHash:item.reviewedReportHash,reviewedEvidenceHash:item.reviewedEvidenceHash,
          reviewedVerdict:item.reviewedVerdict,decisionAtMs:item.decisionAtMs,action:item.action,reasonCode:item.reasonCode});
      });
      if(attemptsValue.length===2) {
        const first=attemptsValue[0],second=attemptsValue[1];
        if(first.action!=='REVISE' || second.action==='REVISE'
            || Object.keys(PREFLIGHT_SCOPE).some(key=>first.candidate[key]!==second.candidate[key])
            || parseDecimal(second.candidate.price)>parseDecimal(first.candidate.price)
            || parseDecimal(second.candidate.size)>parseDecimal(first.candidate.size)
            || second.candidateHash===first.candidateHash)throw new TypeError('Invalid agent revision');
      } else if(attemptsValue[0].action==='REVISE')throw new TypeError('Incomplete agent revision');
      let finalGovernorRead=null;
      if(attemptsValue.at(-1).action==='ACCEPT' && value.finalGovernorRead!==null) {
        const final=exact(value.finalGovernorRead,['evidenceHash','tickerObservedAtMs','instrumentObservedAtMs','checkedAtMs'],'final governor read');
        if(typeof final.evidenceHash!=='string' || !HASH.test(final.evidenceHash) || final.evidenceHash!==hashPreflightEvidence(evidence)
            || !Number.isSafeInteger(final.tickerObservedAtMs) || !Number.isSafeInteger(final.instrumentObservedAtMs)
            || !Number.isSafeInteger(final.checkedAtMs) || final.checkedAtMs>checkedAtMs
            || final.tickerObservedAtMs!==(evidence?.ticker?.observedAtMs)
            || final.instrumentObservedAtMs!==(evidence?.instrument?.observedAtMs)
            || final.tickerObservedAtMs<attemptsValue.at(-1).decisionAtMs
            || final.instrumentObservedAtMs<attemptsValue.at(-1).decisionAtMs)
          throw new TypeError('Invalid final governor read');
        finalGovernorRead=deepFreeze({...final});
      } else if(attemptsValue.at(-1).action==='ACCEPT' && failureCode===null)throw new TypeError('Missing final governor read');
      else if(value.finalGovernorRead!==null)throw new TypeError('Unexpected final governor read');
      const sanitizedAgent={version:1,plannerKind:value.plannerKind,plan:{tools},modelCallCount:value.modelCallCount,
        failureCode,reviewerKind:'bounded',attempts:attemptsValue,finalGovernorRead};
      return planValid?{value:deepFreeze(sanitizedAgent),valid:true,failureCode}:{value:unavailable(failureCode),valid:false,failureCode};
    }
    const sanitized=planValid?deepFreeze({plannerKind:value.plannerKind,plan:{tools},modelCallCount:value.modelCallCount,failureCode})
      :unavailable(failureCode);
    return {value:sanitized,valid:planValid,failureCode};
  } catch{return {value:unavailable(null),valid:false,failureCode:null};}
}
function checkMap() {return new Map(CHECKS.map(([id,label])=>[id,{id,label,result:'PASS',reasonCode:'PASS'}]));}
function setCheck(checks,id,result,reasonCode) {checks.set(id,{...checks.get(id),result,reasonCode});}
function reasonCodes(checks) {return [...new Set([...checks.values()].filter(item=>item.result!=='PASS').map(item=>item.reasonCode))];}
function verdict(checks) {
  const values=[...checks.values()];return values.some(item=>item.result==='BLOCK')?'BLOCK'
    :values.some(item=>item.result==='INSUFFICIENT_DATA')?'INSUFFICIENT_DATA':'ALLOW';
}
function unavailableInstrumentChecks(checks) {
  setCheck(checks,'instrument','INSUFFICIENT_DATA','EVIDENCE_UNAVAILABLE');
  setCheck(checks,'price-grid','INSUFFICIENT_DATA','EVIDENCE_UNAVAILABLE');
  setCheck(checks,'size-grid','INSUFFICIENT_DATA','EVIDENCE_UNAVAILABLE');
}

/** Pure preflight evaluator. It never calls a model, reads an account or sends an order. */
export function evaluatePreflight({mode,policyRecord,candidate,evidence,agentTrace,checkedAtMs}) {
  if(!['LIVE_READ_ONLY','REPLAY'].includes(mode))throw new TypeError('Invalid preflight mode');
  safeInteger(checkedAtMs,'checkedAtMs');
  const policyChecked=validPolicyRecord(policyRecord,{approved:true});
  const normalizedCandidate=normalizeCandidate(candidate);
  const checks=checkMap();
  let normalizedEvidence=null;
  try {normalizedEvidence=sanitizeEvidence(evidence);} catch {}
  if(checkedAtMs<policyChecked.record.validFromMs || checkedAtMs>=policyChecked.record.expiresAtMs)
    setCheck(checks,'policy','BLOCK','POLICY_NOT_CURRENT');
  const normalizedTrace=trace(agentTrace,mode,checkedAtMs,normalizedEvidence);
  if(normalizedTrace.value.version!==1)checks.delete('agent-review');
  if(!normalizedTrace.valid)setCheck(checks,'agent-plan','INSUFFICIENT_DATA',
    PLAN_FAILURES.has(normalizedTrace.failureCode)?normalizedTrace.failureCode:'AGENT_PLAN_UNAVAILABLE');
  else if(normalizedTrace.value.version===1) {
    const finalAttempt=normalizedTrace.value.attempts.at(-1);
    if(finalAttempt.action!=='ACCEPT' || normalizedTrace.value.failureCode)
      setCheck(checks,'agent-review','INSUFFICIENT_DATA',normalizedTrace.value.failureCode??finalAttempt.reasonCode);
    if(finalAttempt.candidateHash!==hashPreflightCandidate(normalizedCandidate))
      setCheck(checks,'agent-review','INSUFFICIENT_DATA','INVALID_CANDIDATE');
  }
  if(Object.keys(PREFLIGHT_SCOPE).some(key=>normalizedCandidate[key]!==PREFLIGHT_SCOPE[key]))
    setCheck(checks,'scope','BLOCK','CANDIDATE_SCOPE_MISMATCH');
  const price=parseDecimal(normalizedCandidate.price),size=parseDecimal(normalizedCandidate.size);
  if(price>parseDecimal(policyChecked.record.policy.maxPrice))setCheck(checks,'price-cap','BLOCK','PRICE_CAP_EXCEEDED');
  if(price*size>parseDecimal(policyChecked.record.policy.maxNotional)*DECIMAL_SCALE)
    setCheck(checks,'notional-cap','BLOCK','NOTIONAL_CAP_EXCEEDED');
  if(!normalizedEvidence || EVIDENCE_FAILURES.has(normalizedTrace.failureCode)){
    setCheck(checks,'evidence','INSUFFICIENT_DATA',EVIDENCE_FAILURES.has(normalizedTrace.failureCode)
      ?normalizedTrace.failureCode:'EVIDENCE_UNAVAILABLE');unavailableInstrumentChecks(checks);
  }
  else {
    const ticker=normalizedEvidence.ticker,instrumentEvidence=normalizedEvidence.instrument,instrument=instrumentEvidence.instrument;
    const times=[ticker.observedAtMs,ticker.exchangeTimestampMs,instrumentEvidence.observedAtMs];
    let trusted=true;
    if(ticker.bindingHash!==instrumentEvidence.bindingHash){
      setCheck(checks,'evidence','INSUFFICIENT_DATA','EVIDENCE_BINDING_MISMATCH');trusted=false;
    } else if(times.some(time=>time>checkedAtMs+MAX_SKEW_MS || checkedAtMs-time>MAX_AGE_MS)){
      setCheck(checks,'evidence','INSUFFICIENT_DATA','EVIDENCE_STALE_OR_FUTURE');
      trusted=false;
    } else if(Math.abs(ticker.observedAtMs-instrumentEvidence.observedAtMs)>MAX_SKEW_MS){
      setCheck(checks,'evidence','INSUFFICIENT_DATA','EVIDENCE_TIME_SKEW');trusted=false;
    }
    if(!trusted)unavailableInstrumentChecks(checks);
    else {
      const instrumentOk=instrument.instId==='AVAX-USDT' && instrument.instType==='SPOT'
        && instrument.baseCcy==='AVAX' && instrument.quoteCcy==='USDT';
      if(!instrumentOk)setCheck(checks,'instrument','BLOCK','INSTRUMENT_SCOPE_MISMATCH');
      else if(instrument.state!=='live')setCheck(checks,'instrument','BLOCK','INSTRUMENT_NOT_LIVE');
      const tick=parseDecimal(instrument.tickSz),lot=parseDecimal(instrument.lotSz),min=parseDecimal(instrument.minSz),max=parseDecimal(instrument.maxLmtSz);
      if(min<lot || min%lot!==0n || max<min){
        setCheck(checks,'instrument','INSUFFICIENT_DATA','INSTRUMENT_RULES_INVALID');
        setCheck(checks,'price-grid','INSUFFICIENT_DATA','INSTRUMENT_RULES_UNAVAILABLE');
        setCheck(checks,'size-grid','INSUFFICIENT_DATA','INSTRUMENT_RULES_UNAVAILABLE');
      } else {
        if(price%tick!==0n)setCheck(checks,'price-grid','BLOCK','PRICE_OFF_GRID');
        if(size%lot!==0n)setCheck(checks,'size-grid','BLOCK','SIZE_OFF_GRID');
        else if(size<min)setCheck(checks,'size-grid','BLOCK','SIZE_BELOW_MINIMUM');
        else if(size>max)setCheck(checks,'size-grid','BLOCK','SIZE_ABOVE_MAXIMUM');
      }
    }
  }
  const policy=policyChecked.basis,publicEvidence=normalizedEvidence,evidenceHash=hashDomain('evidence',publicEvidence);
  const report={schemaVersion:1,mode,publication:'LOCAL_ONLY',policy,policyHash:policyChecked.record.policyHash,candidate:normalizedCandidate,
    candidateHash:hashDomain('candidate',normalizedCandidate),verdict:verdict(checks),reasonCodes:reasonCodes(checks),
    checks:deepFreeze([...checks.values()]),sanitizedEvidence:publicEvidence,evidenceHash,agentTrace:normalizedTrace.value,
    checkedAtMs,notChecked:PREFLIGHT_NOT_CHECKED,disclosure:PREFLIGHT_DISCLOSURE};
  report.reportHash=hashDomain('report',report);
  return deepFreeze(report);
}

function reportRecord(report) {
  const value=exact(report,REPORT_KEYS,'report');
  if(value.schemaVersion!==1 || value.publication!=='LOCAL_ONLY' || !['LIVE_READ_ONLY','REPLAY'].includes(value.mode)
      || !['ALLOW','BLOCK','INSUFFICIENT_DATA'].includes(value.verdict))
    throw new TypeError('Invalid report');
  if(typeof value.reportHash!=='string' || !HASH.test(value.reportHash))throw new TypeError('Invalid reportHash');
  return value;
}

/** Offline integrity and decision verification. This proves local consistency, not authorship or publication time. */
export function verifyReport(report) {
  try {
    const value=reportRecord(report),body=Object.fromEntries(REPORT_KEYS.filter(key=>key!=='reportHash').map(key=>[key,value[key]]));
    if(hashDomain('report',body)!==value.reportHash)return {ok:false,code:'REPORT_INVALID'};
    const policy=exact(value.policy,['schemaVersion','id',...POLICY_KEYS,'createdAtMs','validFromMs','expiresAtMs'],'report policy');
    if(policy.schemaVersion!==1)return {ok:false,code:'REPORT_INVALID'};
    const record={id:policy.id,policy:Object.fromEntries(POLICY_KEYS.map(key=>[key,policy[key]])),policyHash:value.policyHash,
      status:'APPROVED',createdAtMs:policy.createdAtMs,validFromMs:policy.validFromMs,expiresAtMs:policy.expiresAtMs};
    if(hashPreflightPolicy(record)!==value.policyHash || hashPreflightCandidate(value.candidate)!==value.candidateHash
        || hashPreflightEvidence(value.sanitizedEvidence)!==value.evidenceHash)return {ok:false,code:'REPORT_INVALID'};
    const rebuilt=evaluatePreflight({mode:value.mode,policyRecord:record,candidate:value.candidate,evidence:value.sanitizedEvidence,
      agentTrace:value.agentTrace,checkedAtMs:value.checkedAtMs});
    return same(rebuilt,value)?{ok:true,code:'REPORT_VERIFIED'}:{ok:false,code:'REPORT_INVALID'};
  } catch{return {ok:false,code:'REPORT_INVALID'};}
}
