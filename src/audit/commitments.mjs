import { createHash, randomBytes } from 'node:crypto';

export const ZERO_HASH = '0x' + '0'.repeat(64);
const HEX32 = /^0x[0-9a-f]{64}$/;
const MAX_SEQUENCE = (1n << 256n) - 1n;
const SECRET_KEY = /^(?:api[_-]?key|secret|api[_-]?secret|private[_-]?key|seed|mnemonic|password|passphrase|authorization|access[_-]?token|refresh[_-]?token)$/i;

export function assertBytes32(value, name = 'hash') {
  if (typeof value !== 'string' || !HEX32.test(value)) {
    throw new TypeError(`${name} must be a lowercase 0x-prefixed bytes32`);
  }
  return value;
}

/** Project-defined canonical JSON; not an RFC 8785 implementation.
 * Plain JSON only. Money/quantities must be decimal strings, never floats.
 * Keys sort by JS UTF-16 code units; arrays keep order; strings stay byte-exact.
 */
export function canonicalJson(value) {
  const ancestors = new Set();
  function encode(item) {
    if (item === null) return 'null';
    if (typeof item === 'string' || typeof item === 'boolean') return JSON.stringify(item);
    if (typeof item === 'number') {
      if (!Number.isSafeInteger(item) || Object.is(item, -0)) {
        throw new TypeError('Use decimal strings for non-integer/unsafe numbers');
      }
      return JSON.stringify(item);
    }
    if (typeof item !== 'object') throw new TypeError('Source must contain only JSON values');
    if (ancestors.has(item)) throw new TypeError('Cyclic source');
    if (Object.getOwnPropertySymbols(item).length) throw new TypeError('Symbol keys are unsupported');
    ancestors.add(item);
    try {
      if (Array.isArray(item)) {
        if (Object.keys(item).length !== item.length) throw new TypeError('Sparse/extended arrays are unsupported');
        const entries = [];
        for (let i = 0; i < item.length; i++) {
          const descriptor = Object.getOwnPropertyDescriptor(item, String(i));
          if (!descriptor || !('value' in descriptor)) throw new TypeError('Array accessors are unsupported');
          entries.push(encode(descriptor.value));
        }
        return '[' + entries.join(',') + ']';
      }
      const prototype = Object.getPrototypeOf(item);
      if (prototype !== Object.prototype && prototype !== null) throw new TypeError('Only plain JSON objects are supported');
      const keys = Object.keys(item).sort();
      return '{' + keys.map(key => {
        if (SECRET_KEY.test(key)) throw new TypeError('Remove credentials from public audit sources');
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        if (!descriptor || !('value' in descriptor)) throw new TypeError('Source accessors are unsupported');
        return JSON.stringify(key) + ':' + encode(descriptor.value);
      }).join(',') + '}';
    } finally { ancestors.delete(item); }
  }
  return encode(value);
}

/** Domain prefix + NUL + canonical UTF-8 JSON, SHA-256. */
export function hashCanonical(domain, source) {
  if (!['task', 'policy', 'decision', 'receipt'].includes(domain)) throw new TypeError('Unknown audit domain');
  return '0x' + createHash('sha256')
    .update(`MandateGuard/v1/${domain}\0`, 'utf8')
    .update(canonicalJson(source), 'utf8').digest('hex');
}

export function createTaskId(taskId) {
  if (typeof taskId !== 'string' || !taskId.trim()) throw new TypeError('Task ID is required');
  return hashCanonical('task', { taskId });
}

export function createNonce() { return '0x' + randomBytes(32).toString('hex'); }

function sequenceString(value) {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new TypeError('Unsafe sequence');
    value = String(value);
  } else if (typeof value === 'bigint') value = value.toString();
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value) || BigInt(value) > MAX_SEQUENCE) {
    throw new TypeError('Sequence must be a positive uint256 decimal integer');
  }
  return value;
}

function publicClone(value) { return JSON.parse(canonicalJson(value)); }

export function createPolicyCommitment({ taskId, policy, nonce = createNonce() }) {
  assertBytes32(taskId, 'taskId'); assertBytes32(nonce, 'nonce');
  const source = publicClone({ schema: 'mandateguard.policy.v1', taskId, nonce, policy });
  return { source, taskId, policyHash: hashCanonical('policy', source) };
}

export function createDecisionReceipt({ taskId, policyHash, sequence, previousHash = ZERO_HASH, decision, nonce = createNonce() }) {
  assertBytes32(taskId, 'taskId'); assertBytes32(policyHash, 'policyHash');
  assertBytes32(previousHash, 'previousHash'); assertBytes32(nonce, 'nonce');
  sequence = sequenceString(sequence);
  const publicDecision = publicClone(decision);
  const eventDigest = hashCanonical('decision', publicDecision);
  const source = publicClone({ schema: 'mandateguard.receipt.v1', taskId, policyHash, sequence, previousHash, eventDigest, nonce, decision: publicDecision });
  return { source, taskId, policyHash, sequence, previousHash, eventDigest, receiptHash: hashCanonical('receipt', source) };
}

export function verifyPolicyCommitment(commitment) {
  try {
    const { source, taskId, policyHash } = commitment;
    return source.schema === 'mandateguard.policy.v1' && source.taskId === assertBytes32(taskId)
      && Boolean(assertBytes32(source.nonce)) && hashCanonical('policy', source) === assertBytes32(policyHash);
  } catch { return false; }
}

export function verifyDecisionReceipt(receipt) {
  try {
    const { source } = receipt;
    if (source.schema !== 'mandateguard.receipt.v1') return false;
    for (const key of ['taskId', 'policyHash', 'previousHash', 'eventDigest']) {
      if (assertBytes32(source[key], key) !== receipt[key]) return false;
    }
    assertBytes32(source.nonce, 'nonce');
    return sequenceString(source.sequence) === source.sequence && source.sequence === receipt.sequence
      && hashCanonical('decision', source.decision) === receipt.eventDigest
      && hashCanonical('receipt', source) === assertBytes32(receipt.receiptHash);
  } catch { return false; }
}

/** Verify internal linkage; completeness additionally requires a separately trusted expectedHead. */
export function verifyAuditChain({ policyCommitment, receipts, expectedHead }) {
  if (!verifyPolicyCommitment(policyCommitment) || !Array.isArray(receipts) || !receipts.length) return false;
  let previousHash = ZERO_HASH;
  let sequence = 1n;
  const seen = new Set();
  for (const receipt of receipts) {
    if (!verifyDecisionReceipt(receipt) || receipt.taskId !== policyCommitment.taskId
      || receipt.policyHash !== policyCommitment.policyHash || receipt.sequence !== sequence.toString()
      || receipt.previousHash !== previousHash || seen.has(receipt.receiptHash)) return false;
    seen.add(receipt.receiptHash); previousHash = receipt.receiptHash; sequence++;
  }
  if(expectedHead!==undefined){
    try {return sequenceString(expectedHead.sequence)===(sequence-1n).toString() && assertBytes32(expectedHead.receiptHash)===previousHash;}
    catch {return false;}
  }
  return true;
}
