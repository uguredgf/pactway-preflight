import {verifyAuditChain,canonicalJson,ZERO_HASH} from '../../src/audit/commitments.mjs';
import {FUJI_PROFILE} from '../../src/audit/fuji-deployment-profile.mjs';
import {selectedFujiArtifact} from './verify-selected-fuji.mjs';

// Offline only: prepares unsigned calls, never submits or signs them.
// The complete audit is retained; only its first receipt is prepared for publication.
export async function prepareFujiPublication(audit) {
  const snapshot=JSON.parse(canonicalJson(audit));
  if(!snapshot.expectedHead || !verifyAuditChain(snapshot))throw new Error('FUJI_AUDIT_INVALID');
  const {policyCommitment,receipts}=snapshot,first=receipts[0];
  if(first.sequence!=='1' || first.previousHash!==ZERO_HASH)throw new Error('FUJI_FIRST_RECEIPT_INVALID');
  if([policyCommitment.taskId,policyCommitment.policyHash,first.eventDigest,first.receiptHash].includes(ZERO_HASH))throw new Error('FUJI_ZERO_COMMITMENT');
  const artifact=await selectedFujiArtifact();
  function call(signature,args,words) {
    const selector=artifact.methodIdentifiers[signature];
    if(!/^[0-9a-f]{8}$/.test(selector))throw new Error('FUJI_SELECTOR_INVALID');
    return {method:signature.split('(')[0],args,chainId:43113,from:FUJI_PROFILE.owner,
      to:FUJI_PROFILE.contractAddress,value:'0x0',data:'0x'+selector+words.join('')};
  }
  return {schema:'pactway.fuji-publication.v1',state:'UNSIGNED_NOT_PUBLISHED',profile:FUJI_PROFILE.id,
    scope:'Audit commitments only. No proof of model quality, exchange execution or full audit publication.',
    audit:snapshot,firstReceipt:first,
    commitPolicy:call('commitPolicy(bytes32,bytes32)',
      {taskId:policyCommitment.taskId,policyHash:policyCommitment.policyHash},
      [policyCommitment.taskId.slice(2),policyCommitment.policyHash.slice(2)]),
    appendDecision:call('appendDecision(bytes32,uint256,bytes32,bytes32,bytes32)',
      {taskId:first.taskId,sequence:first.sequence,previousHash:first.previousHash,eventDigest:first.eventDigest,receiptHash:first.receiptHash},
      [first.taskId.slice(2),BigInt(first.sequence).toString(16).padStart(64,'0'),first.previousHash.slice(2),first.eventDigest.slice(2),first.receiptHash.slice(2)])};
}
