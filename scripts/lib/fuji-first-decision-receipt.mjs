import {canonicalJson,verifyDecisionReceipt} from '../../src/audit/commitments.mjs';
import {FUJI_PROFILE} from '../../src/audit/fuji-deployment-profile.mjs';
import {FUJI_CHAIN_ID,FUJI_RPC_URL} from '../../src/audit/fuji.mjs';
import {readBoundedJson} from '../../src/io/bounded-json.mjs';
import {requireFujiRpcHttp} from '../../src/audit/fuji-rpc-http.mjs';
import {prepareFujiPublication} from './fuji-publication.mjs';
import {selectedFujiArtifact,verifySelectedFuji} from './verify-selected-fuji.mjs';

export const DECISION_RECORDED_TOPIC='0x2252f03985dac7246b1f20864d206b87206f672a01435f82fc9c4ff5225d10a5';
const HEX32=/^0x[0-9a-f]{64}$/;
const BYTES32=/^0x[0-9a-f]{64}$/i;
const QUANTITY=/^0x(?:0|[1-9a-f][0-9a-f]*)$/i;
const equal=(left,right)=>typeof left==='string' && typeof right==='string' && left.toLowerCase()===right.toLowerCase();
const requireMatch=(condition,code)=>{if(!condition)throw new Error(code);};

// Verifies an already-submitted first appendDecision call. No wallet, signing,
// sendTransaction, retry, or transaction-submission capability exists here.
export async function verifyFujiFirstDecisionReceipt({transactionHash,publication,fetchImpl=fetch,timeoutMs=10000}) {
  requireMatch(HEX32.test(transactionHash),'FUJI_DECISION_TX_INVALID');
  requireMatch(publication && typeof publication==='object' && !Array.isArray(publication),'FUJI_DECISION_SOURCE_INVALID');
  requireMatch(Number.isSafeInteger(timeoutMs) && timeoutMs>=1 && timeoutMs<=30000,'FUJI_DECISION_TIMEOUT_INVALID');

  let prepared;
  try {
    prepared=await prepareFujiPublication(publication.audit);
    const sourceKeys=Object.keys(publication);
    requireMatch(sourceKeys.length===Object.keys(prepared).length+1 && sourceKeys.includes('provenance')
      && publication.provenance && typeof publication.provenance==='object' && !Array.isArray(publication.provenance),
    'FUJI_DECISION_SOURCE_INVALID');
    canonicalJson(publication.provenance);
    for(const [key,value] of Object.entries(prepared))
      requireMatch(canonicalJson(publication[key])===canonicalJson(value),'FUJI_DECISION_SOURCE_INVALID');
    requireMatch(verifyDecisionReceipt(prepared.firstReceipt) && prepared.firstReceipt.sequence==='1',
      'FUJI_DECISION_SOURCE_INVALID');
  } catch {throw new Error('FUJI_DECISION_SOURCE_INVALID');}

  const artifact=await selectedFujiArtifact();
  const selector=artifact.methodIdentifiers['appendDecision(bytes32,uint256,bytes32,bytes32,bytes32)'];
  requireMatch(/^[0-9a-f]{8}$/.test(selector),'FUJI_DECISION_SELECTOR_INVALID');
  const first=prepared.firstReceipt;
  const expectedInput='0x'+selector+first.taskId.slice(2)
    +BigInt(first.sequence).toString(16).padStart(64,'0')+first.previousHash.slice(2)
    +first.eventDigest.slice(2)+first.receiptHash.slice(2);
  const expectedFrom=prepared.appendDecision.from;
  requireMatch(prepared.appendDecision.chainId===FUJI_CHAIN_ID
    && (equal(expectedFrom,FUJI_PROFILE.owner) || equal(expectedFrom,FUJI_PROFILE.recorder))
    && equal(prepared.appendDecision.to,FUJI_PROFILE.contractAddress)
    && prepared.appendDecision.value==='0x0' && equal(prepared.appendDecision.data,expectedInput),
  'FUJI_DECISION_SOURCE_INVALID');

  await verifySelectedFuji({fetchImpl});

  let id=0;
  const signal=AbortSignal.timeout(timeoutMs);
  async function rpc(method,params=[]) {
    const requestId=++id;
    const response=await fetchImpl(FUJI_RPC_URL,{method:'POST',redirect:'error',signal,
      headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:requestId,method,params})});
    await requireFujiRpcHttp(response,'FUJI_DECISION_RPC_HTTP');
    const envelope=await readBoundedJson(response,{maxBytes:1048576});
    requireMatch(envelope.jsonrpc==='2.0' && envelope.id===requestId && !envelope.error
      && Object.hasOwn(envelope,'result'),'FUJI_DECISION_RPC_ENVELOPE');
    return envelope.result;
  }

  const chainId=await rpc('eth_chainId');
  requireMatch(QUANTITY.test(chainId) && BigInt(chainId)===BigInt(FUJI_CHAIN_ID),'FUJI_DECISION_WRONG_CHAIN');
  const receipt=await rpc('eth_getTransactionReceipt',[transactionHash]);
  if(receipt===null)return {verified:false,state:'pending',chainId:FUJI_CHAIN_ID,transactionHash};
  requireMatch(receipt && equal(receipt.transactionHash,transactionHash) && equal(receipt.from,expectedFrom)
    && equal(receipt.to,FUJI_PROFILE.contractAddress) && BYTES32.test(receipt.blockHash)
    && QUANTITY.test(receipt.blockNumber),'FUJI_DECISION_RECEIPT_MISMATCH');
  requireMatch(QUANTITY.test(receipt.status) && BigInt(receipt.status)===1n,'FUJI_DECISION_REVERTED');

  const transaction=await rpc('eth_getTransactionByHash',[transactionHash]);
  requireMatch(transaction && equal(transaction.hash,transactionHash) && equal(transaction.from,expectedFrom)
    && equal(transaction.to,FUJI_PROFILE.contractAddress) && transaction.value==='0x0'
    && equal(transaction.input,expectedInput) && equal(transaction.blockHash,receipt.blockHash)
    && transaction.blockNumber===receipt.blockNumber,'FUJI_DECISION_TRANSACTION_MISMATCH');

  const block=await rpc('eth_getBlockByNumber',[receipt.blockNumber,false]);
  requireMatch(block && equal(block.hash,receipt.blockHash) && block.number===receipt.blockNumber
    && Array.isArray(block.transactions) && block.transactions.some(hash=>equal(hash,transactionHash)),
  'FUJI_DECISION_BLOCK_MISMATCH');

  const expectedTopics=[DECISION_RECORDED_TOPIC,first.taskId,
    '0x'+BigInt(first.sequence).toString(16).padStart(64,'0'),first.receiptHash];
  const expectedData=first.previousHash+first.eventDigest.slice(2);
  const matchingLogs=Array.isArray(receipt.logs)?receipt.logs.filter(log=>log?.removed!==true
    && equal(log.address,FUJI_PROFILE.contractAddress) && equal(log.transactionHash,transactionHash)
    && equal(log.blockHash,receipt.blockHash) && log.blockNumber===receipt.blockNumber
    && Array.isArray(log.topics) && log.topics.length===expectedTopics.length
    && log.topics.every((topic,index)=>equal(topic,expectedTopics[index])) && equal(log.data,expectedData)):[];
  requireMatch(matchingLogs.length===1,'FUJI_DECISION_EVENT_MISMATCH');

  const taskResult=await rpc('eth_call',[{to:FUJI_PROFILE.contractAddress,
    data:'0x'+artifact.methodIdentifiers['tasks(bytes32)']+first.taskId.slice(2)},receipt.blockNumber]);
  requireMatch(typeof taskResult==='string' && /^0x[0-9a-f]{256}$/i.test(taskResult),'FUJI_DECISION_TASK_RESPONSE_INVALID');
  const words=taskResult.slice(2).toLowerCase().match(/.{64}/g);
  requireMatch(equal('0x'+words[0],first.policyHash) && equal('0x'+words[1],first.receiptHash)
    && BigInt('0x'+words[2])===1n && BigInt('0x'+words[3])===1n,'FUJI_DECISION_TASK_MISMATCH');

  const recordedResult=await rpc('eth_call',[{to:FUJI_PROFILE.contractAddress,
    data:'0x'+artifact.methodIdentifiers['recordedReceipts(bytes32)']+first.receiptHash.slice(2)},receipt.blockNumber]);
  requireMatch(typeof recordedResult==='string' && /^0x[0-9a-f]{64}$/i.test(recordedResult)
    && BigInt(recordedResult)===1n,'FUJI_DECISION_RECORDED_MISMATCH');

  return {verified:true,state:'first-decision-recorded',chainId:FUJI_CHAIN_ID,
    contractAddress:FUJI_PROFILE.contractAddress,transactionHash,
    blockNumber:receipt.blockNumber,blockHash:receipt.blockHash.toLowerCase(),from:expectedFrom.toLowerCase(),
    taskId:first.taskId,policyHash:first.policyHash,receiptHash:first.receiptHash,sequence:first.sequence,
    scope:'Exact first decision commitment on the selected Fuji registry; no CEX execution proof.'};
}
