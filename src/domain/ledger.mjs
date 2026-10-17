import { parseDecimal, formatDecimal, DECIMAL_SCALE, ceilDivide } from './money.mjs';
import { hashCanonical } from './governor.mjs';

const TERMINAL = new Set(['FILLED', 'CANCELLED', 'REJECTED']);
const clone = value => JSON.parse(JSON.stringify(value));
function nonnegative(value, name) {
  const units = parseDecimal(value);
  if (units < 0n) throw new RangeError(`${name} must be nonnegative`);
  return units;
}
function getIntent(ledger, id) {
  const intent = ledger.intents.find(item => item.id === id);
  if (!intent) throw new RangeError('Unknown intent');
  return intent;
}
function mutate(ledger, id, operation) {
  const next = clone(ledger); operation(getIntent(next, id), next); return next;
}
function totalFillQty(intent) { return intent.fills.reduce((sum, fill) => sum + parseDecimal(fill.baseQty), 0n); }
function fillCost(fill) { return parseDecimal(fill.quoteNotional) + parseDecimal(fill.feeQuote ?? '0'); }
function costs(intent) { return intent.fills.reduce((sum, fill) => sum + fillCost(fill), 0n); }
function remainingReserve(intent) {
  if (intent.settled) return 0n;
  const remaining = parseDecimal(intent.initialReserve) - costs(intent);
  // A real cost cannot be erased to keep the admission invariant looking true.
  // An exhausted allowance is zero, never a negative reservation.
  return remaining < 0n ? 0n : remaining;
}

function flagViolation(ledger, intent, code, tradeId = null) {
  ledger.violations ??= [];
  if (!ledger.violations.some(item => item.code === code && item.intentId === intent.id && item.tradeId === tradeId))
    ledger.violations.push({ code, intentId:intent.id, tradeId });
  ledger.phase = ledger.stopRequested ? 'STOP_REQUESTED' : 'WAITING';
  intent.quarantined = true;
}

/** Ledger values are JSON-safe decimal strings. Persistence belongs to the caller. */
export function createLedger({ taskId, budget, spent = '0', phase = 'RUNNING', accountId = null }) {
  if (typeof taskId !== 'string' || !taskId.length) throw new TypeError('taskId required');
  const cap = nonnegative(budget, 'budget'), initial = nonnegative(spent, 'spent');
  if (cap <= 0n || initial > cap) throw new RangeError('Invalid starting budget');
  return { taskId, accountId, budget:formatDecimal(cap), initialSpent:formatDecimal(initial), phase, stopRequested:false, intents:[] };
}

export function ledgerSummary(ledger) {
  const spent = parseDecimal(ledger.initialSpent) + ledger.intents.reduce((sum, item) => sum + costs(item), 0n);
  const reserved = ledger.intents.reduce((sum, item) => sum + remainingReserve(item), 0n);
  const localReserved = ledger.intents.reduce((sum, item) => sum + (!item.settled && ['PREPARED', 'SUBMITTING', 'UNKNOWN'].includes(item.state) ? remainingReserve(item) : 0n), 0n);
  const remaining = parseDecimal(ledger.budget) - spent - reserved;
  const violations = [...(ledger.violations ?? [])];
  for (const intent of ledger.intents) if (costs(intent) > parseDecimal(intent.initialReserve)
    && !violations.some(item => item.code === 'RESERVE_EXCEEDED' && item.intentId === intent.id))
    violations.push({ code:'RESERVE_EXCEEDED', intentId:intent.id, tradeId:null });
  if (remaining < 0n && !violations.some(item => item.code === 'BUDGET_EXCEEDED'))
    violations.push({ code:'BUDGET_EXCEEDED', intentId:null, tradeId:null });
  return {
    taskId:ledger.taskId, phase:ledger.phase, stopRequested:ledger.stopRequested,
    budget:ledger.budget, spent:formatDecimal(spent), reserved:formatDecimal(reserved),
    localReserved:formatDecimal(localReserved), remaining:formatDecimal(remaining),
    availableToSpend:formatDecimal(remaining < 0n ? 0n : remaining),
    budgetExceeded:formatDecimal(remaining < 0n ? -remaining : 0n),
    violation:violations.length > 0, violations,
    activeIntentCount:ledger.intents.filter(item => !item.settled).length,
  };
}

export function prepareIntent(ledger, { id, clOrdId, decision, createdAtMs }) {
  const summary = ledgerSummary(ledger);
  if (summary.violation || summary.phase !== 'RUNNING' || summary.stopRequested || summary.activeIntentCount) throw new RangeError('New intent is blocked');
  if (typeof id !== 'string' || !id.length || !/^[A-Za-z0-9]{1,32}$/.test(clOrdId)) throw new TypeError('Invalid intent/client order ID');
  if (ledger.intents.some(item => item.id === id || item.clOrdId === clOrdId)) throw new RangeError('Intent and client IDs must never be reused');
  if (!Number.isSafeInteger(createdAtMs) || createdAtMs < 0) throw new TypeError('Invalid creation time');
  if (!decision?.ok || decision.code !== 'ACCEPTED' || hashCanonical(decision.payload) !== decision.payloadHash) throw new RangeError('Valid governor decision required');
  const reserve = nonnegative(decision.reserve, 'reserve');
  if (reserve <= 0n || reserve > parseDecimal(summary.remaining)) throw new RangeError('Insufficient task budget');
  if (decision.payload.instId !== 'AVAX-USDT' || decision.payload.side !== 'buy' || decision.payload.tdMode !== 'cash' || decision.payload.ordType !== 'limit') throw new RangeError('Unsupported payload');
  const qty = parseDecimal(decision.payload.sz), px = parseDecimal(decision.payload.px);
  if (qty <= 0n || px <= 0n || qty * px > reserve * DECIMAL_SCALE) throw new RangeError('Invalid payload reserve');
  const next = clone(ledger);
  next.intents.push({
    id, clOrdId, ordId:null, state:'PREPARED', settled:false, submissionAttempted:false,
    createdAtMs, payload:clone(decision.payload), payloadHash:decision.payloadHash,
    policyHash:decision.evidence.policyHash, snapshotHash:decision.evidence.snapshotHash,
    initialReserve:formatDecimal(reserve), expectedFillQty:null, fills:[],
  });
  return next;
}

/** Persist this result BEFORE touching the network; never replay a marked attempt. */
export function markSubmitting(ledger, id) {
  return mutate(ledger, id, (intent, next) => {
    if (ledgerSummary(next).violation || next.phase !== 'RUNNING' || next.stopRequested || intent.state !== 'PREPARED' || intent.submissionAttempted) throw new RangeError('Submission is blocked');
    intent.submissionAttempted = true; intent.state = 'SUBMITTING';
  });
}

export function markUnknown(ledger, id) {
  return mutate(ledger, id, intent => {
    if (TERMINAL.has(intent.state)) return;
    if (!['PREPARED', 'SUBMITTING', 'OPEN', 'PARTIAL', 'CANCEL_PENDING', 'UNKNOWN'].includes(intent.state)) throw new RangeError('Cannot mark unknown');
    intent.state = 'UNKNOWN';
  });
}

/** OPEN is exchange-observed state, never inferred from a submit acknowledgement. */
export function bindOrderIdentity(ledger,id,ordId) {
  return mutate(ledger,id,intent=>{
    if(!intent.submissionAttempted || typeof ordId!=='string' || !/^[0-9]{1,64}$/.test(ordId)
        || intent.ordId && intent.ordId!==ordId)throw new RangeError('Conflicting or unsubmitted order identity');
    intent.ordId=ordId;
  });
}

export function markOpen(ledger, id, { ordId }) {
  return mutate(ledger, id, intent => {
    if (typeof ordId !== 'string' || !ordId.length) throw new TypeError('ordId required');
    if (intent.ordId && intent.ordId !== ordId) throw new RangeError('Conflicting exchange order ID');
    if (!intent.submissionAttempted) throw new RangeError('No submission attempt recorded');
    intent.ordId = ordId;
    if (!TERMINAL.has(intent.state) && intent.state !== 'CANCEL_PENDING') intent.state = intent.fills.length ? 'PARTIAL' : 'OPEN';
  });
}

export function requestStop(ledger) {
  const next = clone(ledger); next.stopRequested = true; next.phase = 'STOP_REQUESTED'; return next;
}

export function markCancelPending(ledger, id) {
  return mutate(ledger, id, intent => {
    if (!TERMINAL.has(intent.state)) intent.state = 'CANCEL_PENDING';
  });
}

/** Base fees reduce acquired AVAX; quoteNotional already includes their acquisition cost. */
export function recordFill(ledger, id, fill) {
  return mutate(ledger, id, (intent, next) => {
    if (!intent.submissionAttempted) throw new RangeError('Fill without recorded submission');
    if (typeof fill.tradeId !== 'string' || !fill.tradeId.length) throw new TypeError('tradeId required');
    const qty = nonnegative(fill.baseQty, 'baseQty'), notional = nonnegative(fill.quoteNotional, 'quoteNotional');
    if (qty <= 0n || notional <= 0n) throw new RangeError('Fill must be positive');
    const exceedsLimit = notional > ceilDivide(qty * parseDecimal(intent.payload.px), DECIMAL_SCALE);
    if (typeof fill.feesComplete !== 'boolean') throw new TypeError('Explicit fee completeness required');
    const quoteFee = fill.feeQuote === undefined ? null : formatDecimal(nonnegative(fill.feeQuote, 'feeQuote'));
    const baseFee = fill.feeBase === undefined ? null : formatDecimal(nonnegative(fill.feeBase, 'feeBase'));
    if (fill.feesComplete && (quoteFee === null || baseFee === null)) throw new TypeError('Complete fees require both currency amounts');
    const exceedsBase = baseFee !== null && parseDecimal(baseFee) > qty;
    const normalized = { tradeId:fill.tradeId, baseQty:formatDecimal(qty), quoteNotional:formatDecimal(notional), feeQuote:quoteFee, feeBase:baseFee, feesComplete:fill.feesComplete };
    // One account and one instrument per ledger: trade ID is scoped by that identity.
    const existingOwner = next.intents.find(item => item.fills.some(entry => entry.tradeId === fill.tradeId));
    if (existingOwner && existingOwner.id !== intent.id) throw new RangeError('Trade ID belongs to another intent');
    const previous = intent.fills.find(entry => entry.tradeId === fill.tradeId);
    if (previous) {
      if (previous.baseQty !== normalized.baseQty || previous.quoteNotional !== normalized.quoteNotional) throw new RangeError('Conflicting duplicate fill');
      for (const key of ['feeQuote', 'feeBase']) {
        if (previous[key] !== null && normalized[key] !== null && previous[key] !== normalized[key]) throw new RangeError('Conflicting duplicate fee');
        if (normalized[key] === null) normalized[key] = previous[key];
      }
      normalized.feesComplete = previous.feesComplete || normalized.feesComplete;
      if (intent.settled && hashCanonical(previous) !== hashCanonical(normalized)) {
        intent.settled = false; flagViolation(next, intent, 'SETTLED_FILL_CHANGED', fill.tradeId);
      }
      Object.assign(previous, normalized);
    } else {
      if (intent.settled) {
        intent.settled = false; flagViolation(next, intent, 'FILL_AFTER_SETTLEMENT', fill.tradeId);
      }
      intent.fills.push(normalized);
    }
    const total = totalFillQty(intent);
    if (exceedsLimit) flagViolation(next, intent, 'FILL_ABOVE_LIMIT', fill.tradeId);
    if (exceedsBase) flagViolation(next, intent, 'BASE_FEE_EXCEEDS_QUANTITY', fill.tradeId);
    if (total > parseDecimal(intent.payload.sz) || (intent.expectedFillQty !== null && total > parseDecimal(intent.expectedFillQty)))
      flagViolation(next, intent, 'FILL_QUANTITY_MISMATCH', fill.tradeId);
    if (costs(intent) > parseDecimal(intent.initialReserve)) flagViolation(next, intent, 'RESERVE_EXCEEDED');
    if (!TERMINAL.has(intent.state) && !['UNKNOWN', 'CANCEL_PENDING'].includes(intent.state)) intent.state = 'PARTIAL';
    ledgerSummary(next);
  });
}

export function markTerminal(ledger, id, { state, expectedFillQty }) {
  return mutate(ledger, id, intent => {
    if (!TERMINAL.has(state)) throw new RangeError('Terminal state required');
    const qty = nonnegative(expectedFillQty, 'expectedFillQty');
    if (qty > parseDecimal(intent.payload.sz) || qty < totalFillQty(intent)) throw new RangeError('Inconsistent terminal quantity');
    if (state === 'FILLED' && qty !== parseDecimal(intent.payload.sz)) throw new RangeError('FILLED must cover the full order');
    if (state === 'REJECTED' && qty !== 0n) throw new RangeError('Rejected order cannot have fills');
    if (TERMINAL.has(intent.state) && (intent.state !== state || intent.expectedFillQty !== formatDecimal(qty))) throw new RangeError('Conflicting terminal update');
    intent.state = state; intent.expectedFillQty = formatDecimal(qty);
    // This deliberately does not release the remaining reserve.
  });
}

export function reconcileIntent(ledger, id, { fillsComplete, feesComplete }) {
  return mutate(ledger, id, intent => {
    if (intent.quarantined) throw new RangeError('Quarantined observation requires operator reconciliation');
    if (!TERMINAL.has(intent.state)) throw new RangeError('Terminal order required for settlement');
    if (fillsComplete !== true || feesComplete !== true || totalFillQty(intent) !== parseDecimal(intent.expectedFillQty) || intent.fills.some(fill => !fill.feesComplete)) {
      throw new RangeError('Incomplete fill/fee reconciliation');
    }
    remainingReserve(intent); intent.settled = true;
  });
}
