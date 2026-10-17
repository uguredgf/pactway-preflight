import { verifyDecisionReceipt, assertBytes32 } from './commitments.mjs';
import { readBoundedJson } from '../io/bounded-json.mjs';
import {requireFujiRpcHttp} from './fuji-rpc-http.mjs';

export const FUJI_CHAIN_ID = 43113;
export const FUJI_RPC_URL = 'https://api.avax-test.network/ext/bc/C/rpc';
export const DECISION_EVENT_SIGNATURE = 'DecisionRecorded(bytes32,uint256,bytes32,bytes32,bytes32)';
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const QUANTITY = /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/;

/** Read-only: no wallet, key, signing, deployment or transaction submission.
 * contractAddress must be the separately trusted deployment address.
 * The RPC node is trusted here; this is not a consensus/light-client proof.
 */
export async function verifyFujiReceipt({ transactionHash, contractAddress, expectedReceipt,
  rpcUrl = FUJI_RPC_URL, fetchImpl = globalThis.fetch, timeoutMs = 8000 }) {
  assertBytes32(transactionHash, 'transactionHash');
  if (!ADDRESS.test(contractAddress) || /^0x0{40}$/i.test(contractAddress)) throw new TypeError('Valid contractAddress required');
  if (!verifyDecisionReceipt(expectedReceipt)) throw new TypeError('Invalid source receipt commitment');
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch is required');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new TypeError('Invalid timeout');
  const url = new URL(rpcUrl);
  if (url.protocol !== 'https:' || url.username || url.password) throw new TypeError('Use a credential-free HTTPS Fuji RPC URL');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let id = 0;
  async function rpc(method, params = []) {
    const requestId = ++id;
    const response = await fetchImpl(url.href, { method: 'POST', redirect: 'error',
      headers: { 'content-type': 'application/json' }, signal: controller.signal,
      body: JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) });
    await requireFujiRpcHttp(response);
    const envelope = await readBoundedJson(response,{maxBytes:1048576});
    if (envelope.jsonrpc !== '2.0' || envelope.id !== requestId || envelope.error
      || !Object.hasOwn(envelope, 'result')) throw new Error('Invalid Fuji RPC response');
    return envelope.result;
  }
  try {
    const chain = await rpc('eth_chainId');
    if (typeof chain !== 'string' || !QUANTITY.test(chain) || BigInt(chain) !== BigInt(FUJI_CHAIN_ID)) {
      throw new Error('RPC is not Avalanche Fuji C-Chain (43113)');
    }
    const receipt = await rpc('eth_getTransactionReceipt', [transactionHash]);
    if (receipt === null) return { verified: false, state: 'pending', chainId: FUJI_CHAIN_ID };
    if (typeof receipt !== 'object' || Array.isArray(receipt) || !QUANTITY.test(receipt.status ?? '')
      || ![0n,1n].includes(BigInt(receipt.status))) {
      return { verified:false,state:'unverifiable',chainId:FUJI_CHAIN_ID };
    }
    const address = contractAddress.toLowerCase();
    if (receipt.transactionHash?.toLowerCase() !== transactionHash || receipt.to?.toLowerCase() !== address
      || !QUANTITY.test(receipt.blockNumber ?? '') || !/^0x[0-9a-fA-F]{64}$/.test(receipt.blockHash ?? '')) {
      throw new Error('Receipt transaction/address/block mismatch');
    }
    if(BigInt(receipt.status)===0n)return {verified:false,state:'failed',chainId:FUJI_CHAIN_ID,
      contractAddress:address,transactionHash,blockNumber:receipt.blockNumber,blockHash:receipt.blockHash};
    const code = await rpc('eth_getCode', [address, receipt.blockNumber]);
    if (typeof code !== 'string' || !/^0x(?:[0-9a-fA-F]{2})+$/.test(code) || /^0x0*$/i.test(code)) {
      throw new Error('No contract bytecode at receipt block');
    }
    const getterHash = await rpc('web3_sha3', ['0x' + Buffer.from('tasks(bytes32)', 'utf8').toString('hex')]);
    if (!/^0x[0-9a-fA-F]{64}$/.test(getterHash ?? '')) throw new Error('Invalid task getter selector');
    const taskData = await rpc('eth_call', [{ to: address,
      data: getterHash.slice(0, 10) + expectedReceipt.taskId.slice(2) }, receipt.blockNumber]);
    // Public Task getter: policyHash, lastReceiptHash, uint256 sequence, bool committed.
    if (typeof taskData !== 'string' || !/^0x[0-9a-fA-F]{256}$/.test(taskData)
      || ('0x' + taskData.slice(2, 66).toLowerCase()) !== expectedReceipt.policyHash
      || BigInt('0x' + taskData.slice(194, 258)) !== 1n
      || BigInt('0x' + taskData.slice(130, 194)) < BigInt(expectedReceipt.sequence)) {
      return { verified: false, state: 'policy-mismatch', chainId: FUJI_CHAIN_ID };
    }
    // web3_sha3 is Keccak-256. Node SHA3-256 is NOT Ethereum event-topic hashing.
    const topic = await rpc('web3_sha3', ['0x' + Buffer.from(DECISION_EVENT_SIGNATURE, 'utf8').toString('hex')]);
    if (!/^0x[0-9a-fA-F]{64}$/.test(topic ?? '')) throw new Error('Invalid event signature topic');
    const expectedTopics = [topic.toLowerCase(), expectedReceipt.taskId,
      '0x' + BigInt(expectedReceipt.sequence).toString(16).padStart(64, '0'), expectedReceipt.receiptHash];
    const expectedData = expectedReceipt.previousHash + expectedReceipt.eventDigest.slice(2);
    const matches = Array.isArray(receipt.logs) ? receipt.logs.filter(log =>
      log.removed !== true && log.address?.toLowerCase() === address
      && log.transactionHash?.toLowerCase() === transactionHash
      && log.blockHash?.toLowerCase() === receipt.blockHash.toLowerCase()
      && log.blockNumber === receipt.blockNumber
      && Array.isArray(log.topics) && log.topics.length === expectedTopics.length
      && log.topics.every((value, index) => typeof value === 'string' && value.toLowerCase() === expectedTopics[index])
      && typeof log.data === 'string' && log.data.toLowerCase() === expectedData) : [];
    if (matches.length !== 1) return { verified: false, state: 'event-mismatch', chainId: FUJI_CHAIN_ID };
    return { verified: true, state: 'recorded', chainId: FUJI_CHAIN_ID, contractAddress: address,
      transactionHash, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash,
      receiptHash: expectedReceipt.receiptHash, sequence: expectedReceipt.sequence,
      scope: 'Matching registry event; not CEX execution proof or bonus acceptance.' };
  } finally { clearTimeout(timer); }
}
