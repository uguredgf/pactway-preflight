import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {FUJI_ACCEPTANCE_PROFILE} from '../../src/audit/fuji-acceptance-profile.mjs';
import {verifyFujiPolicyReceipt} from './fuji-policy-receipt.mjs';
import {verifyFujiFirstDecisionReceipt} from './fuji-first-decision-receipt.mjs';

const equal=(left,right)=>typeof left==='string' && typeof right==='string' && left.toLowerCase()===right.toLowerCase();
const requireMatch=condition=>{if(!condition)throw new Error('FUJI_ACCEPTANCE_UNVERIFIED');};

// Fixed archived fixture only. Reads public RPC and a pinned local export; never
// reads application/user data and has no signing or transaction submission path.
export async function verifyFujiAcceptanceTest({fetchImpl=fetch,readFileImpl=readFile,
  verifyPolicy=verifyFujiPolicyReceipt,verifyFirstReceipt=verifyFujiFirstDecisionReceipt}={}) {
  const bytes=await readFileImpl(new URL('../../'+FUJI_ACCEPTANCE_PROFILE.publicationPath,import.meta.url));
  requireMatch(Buffer.isBuffer(bytes) && bytes.length<=1048576
    && createHash('sha256').update(bytes).digest('hex')===FUJI_ACCEPTANCE_PROFILE.publicationSha256);
  let publication;
  try {publication=JSON.parse(bytes.toString('utf8'));}catch {throw new Error('FUJI_ACCEPTANCE_UNVERIFIED');}
  const policy=await verifyPolicy({transactionHash:FUJI_ACCEPTANCE_PROFILE.policy.transactionHash,publication,fetchImpl});
  requireMatch(policy?.verified===true && policy.state==='policy-committed'
    && equal(policy.transactionHash,FUJI_ACCEPTANCE_PROFILE.policy.transactionHash)
    && policy.blockNumber===FUJI_ACCEPTANCE_PROFILE.policy.blockNumber
    && equal(policy.blockHash,FUJI_ACCEPTANCE_PROFILE.policy.blockHash)
    && equal(policy.taskId,FUJI_ACCEPTANCE_PROFILE.taskId)
    && equal(policy.policyHash,FUJI_ACCEPTANCE_PROFILE.policyHash));
  const first=await verifyFirstReceipt({transactionHash:FUJI_ACCEPTANCE_PROFILE.firstReceipt.transactionHash,
    publication,fetchImpl});
  requireMatch(first?.verified===true && first.state==='first-decision-recorded'
    && equal(first.transactionHash,FUJI_ACCEPTANCE_PROFILE.firstReceipt.transactionHash)
    && first.blockNumber===FUJI_ACCEPTANCE_PROFILE.firstReceipt.blockNumber
    && equal(first.blockHash,FUJI_ACCEPTANCE_PROFILE.firstReceipt.blockHash)
    && equal(first.taskId,FUJI_ACCEPTANCE_PROFILE.taskId)
    && equal(first.policyHash,FUJI_ACCEPTANCE_PROFILE.policyHash)
    && equal(first.receiptHash,FUJI_ACCEPTANCE_PROFILE.receiptHash)
    && first.sequence===FUJI_ACCEPTANCE_PROFILE.sequence);
  return {state:'VERIFIED',mode:FUJI_ACCEPTANCE_PROFILE.mode,
    policyTx:FUJI_ACCEPTANCE_PROFILE.policy.transactionHash,
    firstReceiptTx:FUJI_ACCEPTANCE_PROFILE.firstReceipt.transactionHash,
    sequence:FUJI_ACCEPTANCE_PROFILE.sequence,onlyFirstReceipt:true,writeEnabled:false};
}
