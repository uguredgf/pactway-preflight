import {canonicalJson,ZERO_HASH} from '../../src/audit/commitments.mjs';
import {FUJI_PROFILE} from '../../src/audit/fuji-deployment-profile.mjs';
import {FUJI_CHAIN_ID,FUJI_RPC_URL} from '../../src/audit/fuji.mjs';
import {readBoundedJson} from '../../src/io/bounded-json.mjs';
import {requireFujiRpcHttp} from '../../src/audit/fuji-rpc-http.mjs';
import {prepareFujiPublication} from './fuji-publication.mjs';
import {selectedFujiArtifact,verifySelectedFuji} from './verify-selected-fuji.mjs';

export const POLICY_COMMITTED_TOPIC='0x9ec359c75ecd47893d3d3129a84eb240347d3955a8902bc855bf6d8205c11aba';
const HEX32=/^0x[0-9a-f]{64}$/;
const BYTES32=/^0x[0-9a-f]{64}$/i;
const QUANTITY=/^0x(?:0|[1-9a-f][0-9a-f]*)$/i;
const equal=(left,right)=>typeof left==='string' && typeof right==='string' && left.toLowerCase()===right.toLowerCase();
const requireMatch=(condition,code)=>{if(!condition)throw new Error(code);};

// Read-only verification of one already-submitted commitPolicy transaction. This
// module has no wallet, signing, sendTransaction, retry, or submission path.
export async function verifyFujiPolicyReceipt({transactionHash,publication,fetchImpl=fetch,timeoutMs=10000}) {
  requireMatch(HEX32.test(transactionHash),'FUJI_POLICY_TX_INVALID');
  requireMatch(publication && typeof publication==='object' && !Array.isArray(publication),'FUJI_POLICY_SOURCE_INVALID');
  requireMatch(Number.isSafeInteger(timeoutMs) && timeoutMs>=1 && timeoutMs<=30000,'FUJI_POLICY_TIMEOUT_INVALID');

  let prepared;
  try {
    prepared=await prepareFujiPublication(publication.audit);
    const sourceKeys=Object.keys(publication);
    requireMatch(sourceKeys.length===Object.keys(prepared).length+1 && sourceKeys.includes('provenance')
      && publication.provenance && typeof publication.provenance==='object' && !Array.isArray(publication.provenance),
    'FUJI_POLICY_SOURCE_INVALID');
    canonicalJson(publication.provenance);
    for(const [key,value] of Object.entries(prepared))
      requireMatch(canonicalJson(publication[key])===canonicalJson(value),'FUJI_POLICY_SOURCE_INVALID');
  } catch {throw new Error('FUJI_POLICY_SOURCE_INVALID');}

  const artifact=await selectedFujiArtifact();
  const selector=artifact.methodIdentifiers['commitPolicy(bytes32,bytes32)'];
  requireMatch(/^[0-9a-f]{8}$/.test(selector),'FUJI_POLICY_SELECTOR_INVALID');
  const expectedInput='0x'+selector+prepared.commitPolicy.args.taskId.slice(2)+prepared.commitPolicy.args.policyHash.slice(2);
  requireMatch(prepared.commitPolicy.chainId===FUJI_CHAIN_ID
    && equal(prepared.commitPolicy.from,FUJI_PROFILE.owner)
    && equal(prepared.commitPolicy.to,FUJI_PROFILE.contractAddress)
    && prepared.commitPolicy.value==='0x0' && equal(prepared.commitPolicy.data,expectedInput),'FUJI_POLICY_SOURCE_INVALID');

  // This rechecks the pinned source, runtime and owner/recorder of the selected
  // registry before the policy transaction is considered.
  await verifySelectedFuji({fetchImpl});

  let id=0;
  const signal=AbortSignal.timeout(timeoutMs);
  async function rpc(method,params=[]) {
    const requestId=++id;
    const response=await fetchImpl(FUJI_RPC_URL,{method:'POST',redirect:'error',signal,
      headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:requestId,method,params})});
    await requireFujiRpcHttp(response,'FUJI_POLICY_RPC_HTTP');
    const envelope=await readBoundedJson(response,{maxBytes:1048576});
    requireMatch(envelope.jsonrpc==='2.0' && envelope.id===requestId && !envelope.error
      && Object.hasOwn(envelope,'result'),'FUJI_POLICY_RPC_ENVELOPE');
    return envelope.result;
  }

  const chainId=await rpc('eth_chainId');
  requireMatch(QUANTITY.test(chainId) && BigInt(chainId)===BigInt(FUJI_CHAIN_ID),'FUJI_POLICY_WRONG_CHAIN');
  const receipt=await rpc('eth_getTransactionReceipt',[transactionHash]);
  if(receipt===null)return {verified:false,state:'pending',chainId:FUJI_CHAIN_ID,transactionHash};
  requireMatch(receipt && equal(receipt.transactionHash,transactionHash)
    && equal(receipt.from,FUJI_PROFILE.owner) && equal(receipt.to,FUJI_PROFILE.contractAddress)
    && BYTES32.test(receipt.blockHash) && QUANTITY.test(receipt.blockNumber),'FUJI_POLICY_RECEIPT_MISMATCH');
  requireMatch(QUANTITY.test(receipt.status) && BigInt(receipt.status)===1n,'FUJI_POLICY_REVERTED');

  const transaction=await rpc('eth_getTransactionByHash',[transactionHash]);
  requireMatch(transaction && equal(transaction.hash,transactionHash)
    && equal(transaction.from,FUJI_PROFILE.owner) && equal(transaction.to,FUJI_PROFILE.contractAddress)
    && transaction.value==='0x0' && equal(transaction.input,expectedInput)
    && equal(transaction.blockHash,receipt.blockHash) && transaction.blockNumber===receipt.blockNumber,
  'FUJI_POLICY_TRANSACTION_MISMATCH');

  const block=await rpc('eth_getBlockByNumber',[receipt.blockNumber,false]);
  requireMatch(block && equal(block.hash,receipt.blockHash) && block.number===receipt.blockNumber
    && Array.isArray(block.transactions) && block.transactions.some(hash=>equal(hash,transactionHash)),
  'FUJI_POLICY_BLOCK_MISMATCH');

  const expectedTopics=[POLICY_COMMITTED_TOPIC,prepared.commitPolicy.args.taskId,prepared.commitPolicy.args.policyHash];
  const matchingLogs=Array.isArray(receipt.logs)?receipt.logs.filter(log=>log?.removed!==true
    && equal(log.address,FUJI_PROFILE.contractAddress) && equal(log.transactionHash,transactionHash)
    && equal(log.blockHash,receipt.blockHash) && log.blockNumber===receipt.blockNumber
    && Array.isArray(log.topics) && log.topics.length===expectedTopics.length
    && log.topics.every((topic,index)=>equal(topic,expectedTopics[index])) && log.data==='0x'):[];
  requireMatch(matchingLogs.length===1,'FUJI_POLICY_EVENT_MISMATCH');

  const taskResult=await rpc('eth_call',[{to:FUJI_PROFILE.contractAddress,
    data:'0x'+artifact.methodIdentifiers['tasks(bytes32)']+prepared.commitPolicy.args.taskId.slice(2)},receipt.blockNumber]);
  requireMatch(typeof taskResult==='string' && /^0x[0-9a-f]{256}$/i.test(taskResult),'FUJI_POLICY_TASK_RESPONSE_INVALID');
  const words=taskResult.slice(2).toLowerCase().match(/.{64}/g);
  requireMatch(equal('0x'+words[0],prepared.commitPolicy.args.policyHash)
    && equal('0x'+words[1],ZERO_HASH) && BigInt('0x'+words[2])===0n && BigInt('0x'+words[3])===1n,
  'FUJI_POLICY_TASK_MISMATCH');

  return {verified:true,state:'policy-committed',chainId:FUJI_CHAIN_ID,
    contractAddress:FUJI_PROFILE.contractAddress,transactionHash,
    blockNumber:receipt.blockNumber,blockHash:receipt.blockHash.toLowerCase(),
    from:FUJI_PROFILE.owner,taskId:prepared.commitPolicy.args.taskId,
    policyHash:prepared.commitPolicy.args.policyHash,
    scope:'Exact policy commitment on the selected Fuji registry; no CEX execution or decision-receipt proof.'};
}
