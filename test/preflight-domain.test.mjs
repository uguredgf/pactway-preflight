// Source-only acceptance tests. Run only in the final coordinated test phase.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PREFLIGHT_DISCLOSURE,PREFLIGHT_NOT_CHECKED,approvePolicy,createPolicy,evaluatePreflight,
  hashPreflightCandidate,hashPreflightEvidence,hashPreflightPolicy,normalizeCandidate,normalizePolicyInput,verifyReport,
} from '../src/preflight/domain.mjs';
import {REPLAY_EXAMPLES,runReplayExample} from '../src/preflight/examples.mjs';

const NOW=2000000000000;
const policyInput={instrument:'AVAX-USDT',side:'buy',tdMode:'cash',ordType:'limit',
  maxNotional:'25',maxPrice:'25',durationSeconds:'600'};
const candidate={instrument:'AVAX-USDT',side:'buy',tdMode:'cash',ordType:'limit',price:'25',size:'0.4'};
const binding={accountId:'demo',catalogHash:'a'.repeat(64),connectionHash:'b'.repeat(64),
  isolatedEntrySha256:'c'.repeat(64),sessionId:'session'};
function evidence(changes={}) {
  const observedAtMs=changes.observedAtMs??NOW-1000;
  return {
    ticker:{sourceObservationId:'ticker',sourcePayloadHash:'d'.repeat(64),binding:changes.tickerBinding??binding,
      observedAtMs,exchangeTimestampMs:changes.exchangeTimestampMs??observedAtMs,referencePrice:'24.95',reference:'BEST_ASK'},
    instrument:{sourceObservationId:'instrument',sourcePayloadHash:'e'.repeat(64),binding:changes.instrumentBinding??binding,
      observedAtMs:changes.instrumentObservedAtMs??observedAtMs,instrument:{instId:'AVAX-USDT',instType:'SPOT',baseCcy:'AVAX',
        quoteCcy:'USDT',state:'live',tickSz:'0.01',lotSz:'0.01',minSz:'0.1',maxLmtSz:'1000',...(changes.instrument??{})}},
  };
}
function policy() {
  const draft=createPolicy(policyInput,'policy-test',NOW-1000);
  return approvePolicy(draft,draft.policyHash,NOW-1000);
}
function evaluate(changes={}) {
  return evaluatePreflight({mode:'LIVE_READ_ONLY',policyRecord:policy(),candidate,evidence:evidence(),
    agentTrace:{plannerKind:'ollama',plan:{tools:['market_get_ticker','market_get_instruments']},modelCallCount:1,failureCode:null},
    checkedAtMs:NOW,...changes});
}
function result(report,id) {return report.checks.find(check=>check.id===id);}

test('policy input rejects unknown fields, noncanonical magnitudes and out-of-range durations',()=>{
  assert.deepEqual(normalizePolicyInput({...policyInput,maxNotional:'25.00',maxPrice:'25.000'}),policyInput);
  assert.throws(()=>normalizePolicyInput({...policyInput,extra:true}));
  assert.throws(()=>normalizePolicyInput({...policyInput,instrument:'BTC-USDT'}),/PREFLIGHT_POLICY_SCOPE/);
  assert.throws(()=>normalizePolicyInput({...policyInput,maxPrice:'00025'}));
  assert.throws(()=>normalizePolicyInput({...policyInput,maxNotional:'1.000000001'}));
  assert.throws(()=>normalizePolicyInput({...policyInput,durationSeconds:'59'}),/PREFLIGHT_POLICY_DURATION/);
  assert.throws(()=>normalizePolicyInput({...policyInput,durationSeconds:'3601'}),/PREFLIGHT_POLICY_DURATION/);
  const draft=createPolicy(policyInput,'policy-test',NOW);
  assert.equal(draft.validFromMs,NOW);assert.equal(draft.expiresAtMs,NOW+600000);
  assert.equal(draft.policyHash,hashPreflightPolicy(draft));
  assert.notEqual(draft.policyHash,hashPreflightPolicy({...draft,id:'policy-other'}));
  assert.throws(()=>approvePolicy(draft,'0'.repeat(64),NOW));
  assert.equal(approvePolicy(approvePolicy(draft,draft.policyHash,NOW),draft.policyHash,NOW).status,'APPROVED');
});

test('candidate strings are exact and hashes are domain-separated',()=>{
  assert.deepEqual(normalizeCandidate({...candidate,price:'25.00'}),candidate);
  assert.throws(()=>normalizeCandidate({...candidate,size:0.4}));
  assert.throws(()=>normalizeCandidate({...candidate,size:'0.000000001'}));
  assert.throws(()=>normalizeCandidate({...candidate,authority:'trade'}));
  assert.notEqual(hashPreflightCandidate(candidate),hashPreflightEvidence(null));
});

test('fresh bound evidence allows only the stated checks and produces an offline-verifiable local report',()=>{
  const report=evaluate();
  assert.equal(report.verdict,'ALLOW');assert.deepEqual(report.reasonCodes,[]);
  assert.equal(report.publication,'LOCAL_ONLY');assert.equal(report.reportHash.length,64);
  assert.equal(report.checks.length,9);assert.ok(report.checks.every(check=>check.result==='PASS'));
  assert.equal(report.sanitizedEvidence.ticker.binding,undefined);
  assert.equal(report.sanitizedEvidence.ticker.bindingHash,report.sanitizedEvidence.instrument.bindingHash);
  assert.equal(report.evidenceHash,hashPreflightEvidence(report.sanitizedEvidence));
  assert.deepEqual(report.notChecked,PREFLIGHT_NOT_CHECKED);assert.equal(report.disclosure,PREFLIGHT_DISCLOSURE);
  assert.deepEqual(verifyReport(JSON.parse(JSON.stringify(report))),{ok:true,code:'REPORT_VERIFIED'});
});

test('agent trace is hash-covered, bounded, and WAIT independently prevents ALLOW',()=>{
  const freshness={tickerObservedAtMs:NOW-1000,instrumentObservedAtMs:NOW-1000,checkedAtMs:NOW-1000,verified:true};
  const attempt={attempt:1,candidate,candidateHash:hashPreflightCandidate(candidate),readFreshness:freshness,
    reviewedReportHash:'f'.repeat(64),reviewedEvidenceHash:hashPreflightEvidence(evidence()),reviewedVerdict:'ALLOW',
    decisionAtMs:NOW-1000,action:'ACCEPT',reasonCode:'WITHIN_LIMITS'};
  const finalGovernorRead={evidenceHash:hashPreflightEvidence(evidence()),tickerObservedAtMs:NOW-1000,
    instrumentObservedAtMs:NOW-1000,checkedAtMs:NOW};
  const accepted=evaluate({agentTrace:{version:1,plannerKind:'agent',plan:{tools:['market_get_ticker','market_get_instruments']},
    modelCallCount:1,failureCode:null,reviewerKind:'bounded',attempts:[attempt],finalGovernorRead}});
  assert.equal(accepted.verdict,'ALLOW');assert.equal(verifyReport(accepted).ok,true);
  const mismatchedCount=evaluate({agentTrace:{...accepted.agentTrace,modelCallCount:2}});
  assert.equal(mismatchedCount.verdict,'INSUFFICIENT_DATA');assert.equal(mismatchedCount.agentTrace.plannerKind,'unavailable');
  const wrongOrder=evaluate({agentTrace:{...accepted.agentTrace,attempts:[{...attempt,decisionAtMs:NOW-500}]}});
  assert.equal(wrongOrder.verdict,'INSUFFICIENT_DATA');assert.equal(wrongOrder.agentTrace.plannerKind,'unavailable');
  const waiting=evaluate({agentTrace:{...accepted.agentTrace,attempts:[{...attempt,reviewedVerdict:'INSUFFICIENT_DATA',
    action:'WAIT',reasonCode:'INSUFFICIENT_EVIDENCE'}],finalGovernorRead:null}});
  assert.equal(waiting.verdict,'INSUFFICIENT_DATA');assert.equal(result(waiting,'agent-review').reasonCode,'INSUFFICIENT_EVIDENCE');
  assert.equal(verifyReport({...accepted,agentTrace:{...accepted.agentTrace,modelCallCount:2}}).ok,false);
  const growing=evaluate({candidate:{...candidate,size:'0.5'},agentTrace:{...accepted.agentTrace,modelCallCount:2,attempts:[
    {...attempt,action:'REVISE',reasonCode:'NORMALIZE_TO_RULES'},
    {...attempt,attempt:2,candidate:{...candidate,size:'0.5'},candidateHash:hashPreflightCandidate({...candidate,size:'0.5'})}]}});
  assert.equal(growing.verdict,'INSUFFICIENT_DATA');assert.equal(growing.agentTrace.plannerKind,'unavailable');
});

test('price and size grids are rejected without rounding',()=>{
  const badPrice=evaluate({candidate:{...candidate,price:'24.999'}});
  assert.equal(badPrice.verdict,'BLOCK');assert.equal(result(badPrice,'price-grid').reasonCode,'PRICE_OFF_GRID');
  assert.equal(badPrice.candidate.price,'24.999');
  const badSize=evaluate({candidate:{...candidate,size:'0.405'}});
  assert.equal(badSize.verdict,'BLOCK');assert.equal(result(badSize,'size-grid').reasonCode,'SIZE_OFF_GRID');
  assert.equal(badSize.candidate.size,'0.405');
});

test('price times size uses the exact 16-decimal product for the fee-exclusive cap',()=>{
  const draft=createPolicy({...policyInput,maxNotional:'1.00000002'},'exact-product',NOW-1000);
  const policyRecord=approvePolicy(draft,draft.policyHash,NOW-1000);
  const exact=evaluate({policyRecord,candidate:{...candidate,price:'1',size:'1'}});
  assert.equal(result(exact,'notional-cap').result,'PASS');
  const fineGrid=evidence({instrument:{tickSz:'0.00000001',lotSz:'0.00000001',minSz:'0.00000001'}});
  const over=evaluate({policyRecord,candidate:{...candidate,price:'1.00000001',size:'1.00000001'},evidence:fineGrid});
  assert.equal(over.verdict,'BLOCK');assert.equal(result(over,'notional-cap').reasonCode,'NOTIONAL_CAP_EXCEEDED');
  assert.equal(result(over,'price-grid').result,'PASS');assert.equal(result(over,'size-grid').result,'PASS');
});

test('known violations remain BLOCK when evidence is unavailable',()=>{
  const report=evaluate({candidate:{...candidate,price:'25.01'},evidence:null,
    agentTrace:{plannerKind:'unavailable',plan:{tools:[]},modelCallCount:0,failureCode:'PREFLIGHT_LIVE_UNAVAILABLE'}});
  assert.equal(report.verdict,'BLOCK');
  assert.ok(report.reasonCodes.includes('PRICE_CAP_EXCEEDED'));
  assert.ok(report.reasonCodes.includes('PREFLIGHT_LIVE_UNAVAILABLE'));
  assert.ok(report.reasonCodes.includes('AGENT_PLAN_UNAVAILABLE'));
  assert.deepEqual(verifyReport(report),{ok:true,code:'REPORT_VERIFIED'});
});

test('missing, stale, future, skewed and differently bound evidence is insufficient rather than a fake pass',()=>{
  const missing=evaluate({evidence:null,agentTrace:{plannerKind:'ollama',plan:{tools:[]},modelCallCount:1,failureCode:'PREFLIGHT_PLAN_INVALID'}});
  assert.equal(missing.verdict,'INSUFFICIENT_DATA');assert.equal(missing.agentTrace.modelCallCount,1);
  assert.equal(result(missing,'agent-plan').reasonCode,'PREFLIGHT_PLAN_INVALID');
  assert.equal(result(missing,'evidence').reasonCode,'EVIDENCE_UNAVAILABLE');
  for(const id of ['instrument','price-grid','size-grid'])assert.equal(result(missing,id).result,'INSUFFICIENT_DATA');
  const stale=evaluate({evidence:evidence({observedAtMs:NOW-10001})});
  assert.equal(stale.verdict,'INSUFFICIENT_DATA');assert.equal(result(stale,'evidence').reasonCode,'EVIDENCE_STALE_OR_FUTURE');
  const future=evaluate({evidence:evidence({exchangeTimestampMs:NOW+5001})});
  assert.equal(result(future,'evidence').reasonCode,'EVIDENCE_STALE_OR_FUTURE');
  const skew=evaluate({evidence:evidence({instrumentObservedAtMs:NOW-6001})});
  assert.equal(result(skew,'evidence').reasonCode,'EVIDENCE_TIME_SKEW');
  const mismatch=evaluate({evidence:evidence({instrumentBinding:{...binding,sessionId:'other'}})});
  assert.equal(result(mismatch,'evidence').reasonCode,'EVIDENCE_BINDING_MISMATCH');
  const captureFailure=evaluate({evidence:null,agentTrace:{plannerKind:'ollama',
    plan:{tools:['market_get_instruments','market_get_ticker']},modelCallCount:1,failureCode:'PREFLIGHT_CAPTURE_FAILED'}});
  assert.equal(result(captureFailure,'agent-plan').result,'PASS');
  assert.equal(result(captureFailure,'evidence').reasonCode,'PREFLIGHT_CAPTURE_FAILED');
});

test('fixed scope, live instrument and size limits are deterministic BLOCK checks',()=>{
  const scope=evaluate({candidate:{...candidate,side:'sell'}});
  assert.equal(scope.verdict,'BLOCK');assert.equal(result(scope,'scope').reasonCode,'CANDIDATE_SCOPE_MISMATCH');
  const halted=evaluate({evidence:evidence({instrument:{state:'suspend'}})});
  assert.equal(halted.verdict,'BLOCK');assert.equal(result(halted,'instrument').reasonCode,'INSTRUMENT_NOT_LIVE');
  const below=evaluate({candidate:{...candidate,size:'0.05'}});
  assert.equal(result(below,'size-grid').reasonCode,'SIZE_BELOW_MINIMUM');
  const above=evaluate({candidate:{...candidate,size:'1000.01'}});
  assert.equal(result(above,'size-grid').reasonCode,'SIZE_ABOVE_MAXIMUM');
});

test('invalid instrument rules fail closed as insufficient',()=>{
  const report=evaluate({evidence:evidence({instrument:{lotSz:'0.03',minSz:'0.1'}})});
  assert.equal(report.verdict,'INSUFFICIENT_DATA');
  assert.equal(result(report,'instrument').reasonCode,'INSTRUMENT_RULES_INVALID');
});

test('offline verification rejects report, candidate, evidence and schema tampering',()=>{
  const report=JSON.parse(JSON.stringify(evaluate()));
  for(const changed of [
    {...report,verdict:'BLOCK'},
    {...report,candidate:{...report.candidate,size:'0.5'}},
    {...report,sanitizedEvidence:{...report.sanitizedEvidence,ticker:{...report.sanitizedEvidence.ticker,referencePrice:'1'}}},
    {...report,publication:'ONCHAIN'},
    {...report,extra:true},
  ])assert.deepEqual(verifyReport(changed),{ok:false,code:'REPORT_INVALID'});
});

test('the three immutable replay examples use the same evaluator and state their mode',()=>{
  assert.deepEqual(REPLAY_EXAMPLES,['within-limits','limit-breach','stale-evidence']);
  const within=runReplayExample('within-limits'),breach=runReplayExample('limit-breach'),stale=runReplayExample('stale-evidence');
  assert.equal(within.mode,'REPLAY');assert.equal(within.verdict,'ALLOW');
  assert.equal(breach.verdict,'BLOCK');assert.ok(breach.reasonCodes.includes('PRICE_CAP_EXCEEDED'));
  assert.equal(stale.verdict,'INSUFFICIENT_DATA');assert.ok(stale.reasonCodes.includes('EVIDENCE_STALE_OR_FUTURE'));
  assert.deepEqual(runReplayExample('within-limits'),within);
  for(const report of [within,breach,stale])assert.deepEqual(verifyReport(report),{ok:true,code:'REPORT_VERIFIED'});
  assert.throws(()=>runReplayExample('unknown'),/PREFLIGHT_REPLAY_NAME/);
});

test('reports make excluded account, fee, execution and suitability claims explicit',()=>{
  const report=evaluate(),codes=new Set(report.notChecked.map(item=>item.code));
  for(const code of ['ACCOUNT_BALANCE','FEES','PORTFOLIO','ORDER_LIFECYCLE','INVESTMENT_SUITABILITY','USD_NATIVE_LIMIT'])
    assert.equal(codes.has(code),true);
  const encoded=JSON.stringify(report);
  assert.equal(encoded.includes('availableBalance'),false);assert.equal(encoded.includes('feeRate'),false);
});
