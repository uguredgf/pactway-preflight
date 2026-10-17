// Source-only acceptance tests. Do not execute until the user authorizes tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDecimal, formatDecimal, mulDecimal, roundDownToStep } from '../src/domain/money.mjs';
import { canonicalJson, hashPolicy, evaluateCandidate } from '../src/domain/governor.mjs';
import { createLedger, ledgerSummary, prepareIntent, markSubmitting, markUnknown, markOpen, requestStop, markCancelPending, recordFill, markTerminal, reconcileIntent } from '../src/domain/ledger.mjs';

const nowMs = 100000;
const policy = {
  id:'policy-v1', taskId:'task-1', accountId:'demo-account', environment:'demo', instrument:'AVAX-USDT', side:'buy', tdMode:'cash', ordType:'limit',
  budget:'100', singleOrderNotionalMax:'25', maxPrice:'25', maxShare:'0.10',
  quoteFeeRateMax:'0', quoteFeeFixedMax:'0.01', baseFeeRateMax:'0.001',
  approvedAtMs:90000, expiresAtMs:690000, snapshotMaxAgeMs:5000, snapshotMaxSkewMs:2000,
};
const snapshot = {
  accountId:'demo-account', environment:'demo', instrument:'AVAX-USDT',
  baseBalance:'1.6', quoteBalance:'460', availableQuote:'460', referencePrice:'25',
  marketAtMs:nowMs, balanceAtMs:nowMs, ordersAtMs:nowMs,
  tickSize:'0.01', lotSize:'0.0001', minSize:'0.0001', foreignActivity:false, openOrderCount:0,
};
const candidate = { instrument:'AVAX-USDT', side:'buy', tdMode:'cash', ordType:'limit', price:'25', size:'0.396' };
function startingLedger() { return createLedger({ taskId:'task-1', accountId:'demo-account', budget:'100', spent:'25' }); }
function evaluate(changes = {}) {
  return evaluateCandidate({ policy, approvedPolicyHash:hashPolicy(policy), snapshot, candidate, ledgerSummary:ledgerSummary(startingLedger()), nowMs, ...changes });
}
function prepared() {
  return prepareIntent(startingLedger(), { id:'intent-1', clOrdId:'MandateGuard0001', decision:evaluate(), createdAtMs:nowMs });
}
function fill(overrides = {}) {
  return { tradeId:'trade-1', baseQty:'0.12', quoteNotional:'3', feeQuote:'0.003', feeBase:'0', feesComplete:true, ...overrides };
}

test('exact decimals, downward steps and upward monetary reservations', () => {
  assert.equal(formatDecimal(parseDecimal('0.1') + parseDecimal('0.2')), '0.3');
  assert.equal(roundDownToStep('25.009', '0.01'), '25');
  assert.equal(mulDecimal('0.00000001', '0.00000001', 'up'), '0.00000001');
  assert.throws(() => parseDecimal(0.1));
  assert.throws(() => parseDecimal('0.000000001'));
  assert.throws(() => roundDownToStep('1', '0'));
});

test('canonical hash binds all approval fields and sorts object keys', () => {
  assert.equal(canonicalJson({ z:1n, a:{ b:'0.1' } }), '{"a":{"b":"0.1"},"z":"1"}');
  assert.equal(hashPolicy(policy), hashPolicy(Object.fromEntries(Object.entries(policy).reverse())));
  assert.equal(evaluate({ policy:{ ...policy, budget:'101' } }).code, 'POLICY_HASH_MISMATCH');
  assert.throws(() => canonicalJson({ omitted:undefined }));
});

test('25 veto, 9.90 accepted, and normalized exchange payload is bound', () => {
  assert.equal(evaluate({ candidate:{ ...candidate, size:'1' } }).code, 'POST_FILL_SHARE_CAP');
  const result = evaluate({ candidate:{ ...candidate, price:'25.009', size:'0.39609' } });
  assert.equal(result.ok, true);
  assert.deepEqual(result.payload, { instId:'AVAX-USDT', side:'buy', tdMode:'cash', ordType:'limit', px:'25', sz:'0.396' });
  assert.equal(result.reserve, '9.91');
  assert.equal(result.evidence.estimatedShare, '0.09980199');
  assert.equal(JSON.stringify(result).includes('BigInt'), false);
});

test('base fee upper bound cannot make an unsafe share pass', () => {
  const changedPolicy = { ...policy, baseFeeRateMax:'1' };
  const result = evaluate({ policy:changedPolicy, approvedPolicyHash:hashPolicy(changedPolicy), candidate:{ ...candidate, size:'1' } });
  assert.equal(result.code, 'POST_FILL_SHARE_CAP');
});

test('share comparison does not use rounded display value', () => {
  const changedPolicy = { ...policy, quoteFeeFixedMax:'0' };
  const result = evaluate({ policy:changedPolicy, approvedPolicyHash:hashPolicy(changedPolicy), snapshot:{ ...snapshot, baseBalance:'1.99990001', quoteBalance:'450.0025', availableQuote:'450.0025' }, candidate:{ ...candidate, size:'0.0001' } });
  assert.equal(result.code, 'POST_FILL_SHARE_CAP');
  assert.equal(result.evidence.estimatedShare, '0.1');
});

test('limits, freshness, identity, phase and available balance fail closed', () => {
  assert.equal(evaluate({ candidate:{ ...candidate, size:'1.0001' } }).code, 'SINGLE_NOTIONAL_CAP');
  assert.equal(evaluate({ candidate:{ ...candidate, price:'25.01' } }).code, 'PRICE_CAP');
  assert.equal(evaluate({ candidate:{ ...candidate, size:'0.00001' } }).code, 'BELOW_MINIMUM_AFTER_NORMALIZATION');
  assert.equal(evaluate({ snapshot:{ ...snapshot, marketAtMs:nowMs - 5001 } }).code, 'STALE_OR_FUTURE_SNAPSHOT');
  assert.equal(evaluate({ snapshot:{ ...snapshot, marketAtMs:nowMs - 2001 } }).code, 'INCOHERENT_SNAPSHOT');
  assert.equal(evaluate({ snapshot:{ ...snapshot, marketAtMs:nowMs + 1 } }).code, 'STALE_OR_FUTURE_SNAPSHOT');
  assert.equal(evaluate({ snapshot:{ ...snapshot, foreignActivity:true } }).code, 'FOREIGN_ACTIVITY_OR_UNCERTAIN_ACCOUNT');
  assert.equal(evaluate({ candidate:{ ...candidate, tdMode:'isolated' } }).code, 'CANDIDATE_SCOPE_MISMATCH');
  assert.equal(evaluate({ ledgerSummary:{ ...ledgerSummary(startingLedger()), phase:'WAITING' } }).code, 'TASK_NOT_RUNNING');
  assert.equal(evaluate({ snapshot:{ ...snapshot, availableQuote:'9.90' } }).code, 'AVAILABLE_QUOTE_CAP');
  assert.equal(evaluate({ ledgerSummary:{ ...ledgerSummary(startingLedger()), spent:'90.10' } }).code, 'TOTAL_BUDGET_CAP');
});

test('unknown blocks a second intent and an attempted order cannot be replayed', () => {
  const before = prepared();
  const uncertain = markUnknown(markSubmitting(before, 'intent-1'), 'intent-1');
  assert.equal(before.intents[0].state, 'PREPARED');
  assert.equal(ledgerSummary(uncertain).reserved, '9.91');
  assert.equal(evaluate({ ledgerSummary:ledgerSummary(uncertain) }).code, 'ACTIVE_OR_UNKNOWN_INTENT');
  assert.throws(() => markSubmitting(uncertain, 'intent-1'));
  assert.throws(() => prepareIntent(uncertain, { id:'intent-2', clOrdId:'MandateGuard0002', decision:evaluate(), createdAtMs:nowMs }));
});

test('partial fill moves spending once and holds the rest through cancellation acknowledgement', () => {
  let ledger = markSubmitting(prepared(), 'intent-1');
  ledger = markOpen(ledger, 'intent-1', { ordId:'exchange-1' });
  ledger = recordFill(ledger, 'intent-1', fill());
  ledger = recordFill(ledger, 'intent-1', fill());
  assert.equal(ledgerSummary(ledger).spent, '28.003');
  assert.equal(ledgerSummary(ledger).reserved, '6.907');
  assert.equal(ledgerSummary(ledger).remaining, '65.09');
  ledger = markCancelPending(requestStop(ledger), 'intent-1');
  assert.equal(ledgerSummary(ledger).reserved, '6.907');
  ledger = markTerminal(ledger, 'intent-1', { state:'CANCELLED', expectedFillQty:'0.12' });
  assert.equal(ledgerSummary(ledger).activeIntentCount, 1);
  ledger = reconcileIntent(ledger, 'intent-1', { fillsComplete:true, feesComplete:true });
  assert.equal(ledgerSummary(ledger).reserved, '0');
  assert.equal(ledgerSummary(ledger).remaining, '71.997');
  assert.equal(ledgerSummary(ledger).activeIntentCount, 0);
  assert.throws(() => markSubmitting(ledger, 'intent-1'));
});

test('terminal quantity requires missing fills and fee enrichment before release', () => {
  let ledger = markSubmitting(prepared(), 'intent-1');
  ledger = recordFill(ledger, 'intent-1', fill({ feeQuote:undefined, feeBase:undefined, feesComplete:false }));
  ledger = markTerminal(ledger, 'intent-1', { state:'CANCELLED', expectedFillQty:'0.12' });
  assert.throws(() => reconcileIntent(ledger, 'intent-1', { fillsComplete:true, feesComplete:true }));
  ledger = recordFill(ledger, 'intent-1', fill());
  ledger = reconcileIntent(ledger, 'intent-1', { fillsComplete:true, feesComplete:true });
  const duplicate = recordFill(ledger, 'intent-1', fill());
  assert.deepEqual(duplicate, ledger);
  assert.throws(() => recordFill(ledger, 'intent-1', fill({ quoteNotional:'2.99' })));
  assert.equal(markOpen(ledger, 'intent-1', { ordId:'exchange-1' }).intents[0].state, 'CANCELLED');
});

test('a late cancellation fill is kept, and base fee is not double charged', () => {
  let ledger = markCancelPending(markSubmitting(prepared(), 'intent-1'), 'intent-1');
  ledger = markTerminal(ledger, 'intent-1', { state:'CANCELLED', expectedFillQty:'0.12' });
  assert.throws(() => reconcileIntent(ledger, 'intent-1', { fillsComplete:true, feesComplete:true }));
  ledger = recordFill(ledger, 'intent-1', fill({ feeQuote:'0', feeBase:'0.00012' }));
  assert.equal(ledgerSummary(ledger).spent, '28');
  assert.equal(ledger.intents[0].state, 'CANCELLED');
  ledger = reconcileIntent(ledger, 'intent-1', { fillsComplete:true, feesComplete:true });
  assert.equal(ledgerSummary(ledger).remaining, '72');
  assert.throws(() => markTerminal(ledger, 'intent-1', { state:'FILLED', expectedFillQty:'0.396' }));
});

test('a cost beyond reserve and task budget stays visible and is quarantined, not discarded',()=>{
  let ledger=markSubmitting(prepared(),'intent-1');
  ledger=recordFill(ledger,'intent-1',fill({quoteNotional:'101',feeQuote:'0'}));
  const summary=ledgerSummary(ledger);
  assert.equal(summary.spent,'126');assert.equal(summary.reserved,'0');
  assert.equal(summary.remaining,'-26');assert.equal(summary.availableToSpend,'0');
  assert.equal(summary.violation,true);assert.equal(ledger.intents[0].quarantined,true);
  assert.equal(ledgerSummary(recordFill(ledger,'intent-1',fill({quoteNotional:'101',feeQuote:'0'}))).spent,'126');
  assert.equal(evaluate({ledgerSummary:{...summary,phase:'RUNNING'}}).code,'LEDGER_VIOLATION');
  assert.throws(()=>prepareIntent(ledger,{id:'next',clOrdId:'Next0001',decision:evaluate(),createdAtMs:nowMs}));
});
