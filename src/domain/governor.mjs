import { createHash } from 'node:crypto';
import { DECIMAL_SCALE, parseDecimal, formatDecimal, ceilDivide, floorDivide, roundDownToStep } from './money.mjs';

/** Shared policy/receipt canonicalization. Array order is significant. */
export function canonicalJson(value) {
  const ancestors = new Set();
  function encode(item) {
    if (item === null) return 'null';
    if (typeof item === 'string' || typeof item === 'boolean') return JSON.stringify(item);
    if (typeof item === 'bigint') return JSON.stringify(item.toString());
    if (typeof item === 'number') {
      if (!Number.isSafeInteger(item)) throw new TypeError('Only safe integer numbers may be canonicalized');
      return JSON.stringify(item);
    }
    if (typeof item !== 'object' || ancestors.has(item)) throw new TypeError('Unsupported or cyclic canonical value');
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) {
      throw new TypeError('Canonical objects must be plain objects');
    }
    ancestors.add(item);
    let result;
    if (Array.isArray(item)) {
      if (Object.keys(item).length !== item.length || Object.getOwnPropertySymbols(item).length || Array.from({ length:item.length }, (_, index) => index).some(index => !Object.hasOwn(item, index))) {
        throw new TypeError('Sparse or extended arrays are unsupported');
      }
      result = '[' + item.map(encode).join(',') + ']';
    } else {
      if (Object.getOwnPropertySymbols(item).length) throw new TypeError('Symbol keys are unsupported');
      result = '{' + Object.keys(item).sort().map(key => JSON.stringify(key) + ':' + encode(item[key])).join(',') + '}';
    }
    ancestors.delete(item);
    return result;
  }
  return encode(value);
}

export function hashCanonical(value) { return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex'); }

function stringField(value, name) {
  if (typeof value !== 'string' || !value.length) throw new TypeError(`Missing ${name}`);
}
function integer(value, name, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) throw new TypeError(`Invalid ${name}`);
}
function amount(value, name, positive = false) {
  const units = parseDecimal(value);
  if (units < 0n || (positive && units === 0n)) throw new RangeError(`Invalid ${name}`);
  return units;
}

export function validatePolicy(policy) {
  if (!policy || typeof policy !== 'object') throw new TypeError('Policy required');
  for (const key of ['id', 'taskId', 'accountId']) stringField(policy[key], key);
  if (policy.environment !== 'demo' || policy.instrument !== 'AVAX-USDT' || policy.side !== 'buy' || policy.tdMode !== 'cash' || policy.ordType !== 'limit') {
    throw new RangeError('Only demo AVAX-USDT cash limit buys are supported');
  }
  for (const key of ['budget', 'singleOrderNotionalMax', 'maxPrice', 'maxShare']) amount(policy[key], key, true);
  if (parseDecimal(policy.maxShare) > DECIMAL_SCALE) throw new RangeError('Share must be a ratio in (0,1]');
  for (const key of ['quoteFeeRateMax', 'quoteFeeFixedMax', 'baseFeeRateMax']) amount(policy[key], key);
  for (const key of ['quoteFeeRateMax', 'baseFeeRateMax']) {
    if (parseDecimal(policy[key]) > DECIMAL_SCALE) throw new RangeError('Fee rate must be in [0,1]');
  }
  integer(policy.approvedAtMs, 'approvedAtMs'); integer(policy.expiresAtMs, 'expiresAtMs');
  if (policy.expiresAtMs <= policy.approvedAtMs) throw new RangeError('Invalid policy lifetime');
  integer(policy.snapshotMaxAgeMs, 'snapshotMaxAgeMs', 1);
  integer(policy.snapshotMaxSkewMs, 'snapshotMaxSkewMs');
  // Additional metadata is included in the approval hash; it cannot silently disappear.
  canonicalJson(policy);
  return policy;
}

export function hashPolicy(policy) { return hashCanonical(validatePolicy(policy)); }

/** Pure admission check; never sends an order or trusts an LLM-provided authority field. */
export function evaluateCandidate({ policy, approvedPolicyHash, snapshot, candidate, ledgerSummary, nowMs }) {
  const reject = (code, evidence = {}) => ({ ok:false, code, evidence });
  try {
    integer(nowMs, 'nowMs');
    const policyHash = hashPolicy(policy);
    if (approvedPolicyHash !== policyHash) return reject('POLICY_HASH_MISMATCH');
    if (ledgerSummary?.violation === true) return reject('LEDGER_VIOLATION');
    if (nowMs < policy.approvedAtMs || nowMs >= policy.expiresAtMs) return reject('POLICY_NOT_CURRENT');
    if (!ledgerSummary || ledgerSummary.taskId !== policy.taskId || ledgerSummary.phase !== 'RUNNING') return reject('TASK_NOT_RUNNING');
    if (ledgerSummary.stopRequested === true) return reject('STOP_REQUESTED');
    integer(ledgerSummary.activeIntentCount, 'activeIntentCount');
    if (ledgerSummary.activeIntentCount !== 0) return reject('ACTIVE_OR_UNKNOWN_INTENT');
    if (!snapshot || snapshot.accountId !== policy.accountId || snapshot.environment !== policy.environment || snapshot.instrument !== policy.instrument) return reject('SNAPSHOT_IDENTITY_MISMATCH');
    if (snapshot.foreignActivity !== false) return reject('FOREIGN_ACTIVITY_OR_UNCERTAIN_ACCOUNT');
    integer(snapshot.openOrderCount, 'openOrderCount');
    if (snapshot.openOrderCount !== 0) return reject('EXTERNAL_OR_OPEN_ORDER');
    const times = ['marketAtMs', 'balanceAtMs', 'ordersAtMs'].map(key => {
      integer(snapshot[key], key); return snapshot[key];
    });
    if (times.some(time => time > nowMs || nowMs - time > policy.snapshotMaxAgeMs)) return reject('STALE_OR_FUTURE_SNAPSHOT');
    if (Math.max(...times) - Math.min(...times) > policy.snapshotMaxSkewMs) return reject('INCOHERENT_SNAPSHOT');
    if (!candidate || candidate.instrument !== policy.instrument || candidate.side !== policy.side || candidate.tdMode !== policy.tdMode || candidate.ordType !== policy.ordType) return reject('CANDIDATE_SCOPE_MISMATCH');
    const allowedCandidateKeys = ['instrument', 'side', 'tdMode', 'ordType', 'price', 'size'];
    if (Object.keys(candidate).some(key => !allowedCandidateKeys.includes(key))) return reject('UNSUPPORTED_CANDIDATE_FIELD');
    amount(candidate.price, 'price', true); amount(candidate.size, 'size', true);
    for (const key of ['tickSize', 'lotSize', 'minSize', 'referencePrice']) amount(snapshot[key], key, true);
    const px = roundDownToStep(candidate.price, snapshot.tickSize);
    const sz = roundDownToStep(candidate.size, snapshot.lotSize);
    const price = parseDecimal(px), quantity = parseDecimal(sz);
    if (price <= 0n || quantity < parseDecimal(snapshot.minSize)) return reject('BELOW_MINIMUM_AFTER_NORMALIZATION');
    if (price > parseDecimal(policy.maxPrice)) return reject('PRICE_CAP');
    // Product keeps all 16 decimal places for cap checks. Reserve rounds upward.
    const notionalProduct = price * quantity;
    if (notionalProduct > parseDecimal(policy.singleOrderNotionalMax) * DECIMAL_SCALE) return reject('SINGLE_NOTIONAL_CAP');
    const notional = ceilDivide(notionalProduct, DECIMAL_SCALE);
    const quoteFee = ceilDivide(notional * parseDecimal(policy.quoteFeeRateMax), DECIMAL_SCALE) + parseDecimal(policy.quoteFeeFixedMax);
    const reserve = notional + quoteFee;
    const spent = amount(ledgerSummary.spent, 'spent');
    const reserved = amount(ledgerSummary.reserved, 'reserved');
    const localReserved = amount(ledgerSummary.localReserved, 'localReserved');
    if (localReserved > reserved) return reject('INCONSISTENT_RESERVES');
    if (ledgerSummary.budget !== policy.budget && parseDecimal(ledgerSummary.budget) !== parseDecimal(policy.budget)) return reject('LEDGER_BUDGET_MISMATCH');
    if (spent + reserved + reserve > parseDecimal(policy.budget)) return reject('TOTAL_BUDGET_CAP');
    const base = amount(snapshot.baseBalance, 'baseBalance');
    const quote = amount(snapshot.quoteBalance, 'quoteBalance');
    const available = amount(snapshot.availableQuote, 'availableQuote');
    if (available > quote) return reject('INCONSISTENT_BALANCE');
    if (reserve + localReserved > available) return reject('AVAILABLE_QUOTE_CAP');
    const reference = parseDecimal(snapshot.referencePrice);
    // Base fee = zero gives the largest AVAX holding. Maximum quote fee shrinks equity.
    // No floor-rounded percentage is ever used to decide admission.
    const baseValueProduct = (base + quantity) * reference;
    // The rounded-up quote cost also bounds settlement rounding at our scale.
    const remainingQuoteProduct = (quote - reserve) * DECIMAL_SCALE;
    const totalValueProduct = baseValueProduct + remainingQuoteProduct;
    if (remainingQuoteProduct < 0n || totalValueProduct <= 0n) return reject('INVALID_POST_FILL_EQUITY');
    const estimatedShare = formatDecimal(floorDivide(baseValueProduct * DECIMAL_SCALE, totalValueProduct));
    const evidence = {
      policyHash, snapshotHash:hashCanonical(snapshot), checkedAtMs:nowMs,
      notional:formatDecimal(notional), quoteFeeReserve:formatDecimal(quoteFee),
      estimatedShare, maxShare:policy.maxShare, shareBasis:'ADMISSION_FULL_FILL_BASE_FEE_ZERO_QUOTE_FEE_MAX',
      shareNumerator:baseValueProduct.toString(), shareDenominator:totalValueProduct.toString(),
    };
    if (baseValueProduct * DECIMAL_SCALE > parseDecimal(policy.maxShare) * totalValueProduct) return reject('POST_FILL_SHARE_CAP', evidence);
    const payload = { instId:policy.instrument, side:policy.side, tdMode:policy.tdMode, ordType:policy.ordType, px, sz };
    return { ok:true, code:'ACCEPTED', payload, payloadHash:hashCanonical(payload), reserve:formatDecimal(reserve), evidence };
  } catch (error) {
    return reject('INVALID_INPUT', { message:error.message });
  }
}
