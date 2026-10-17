import {createHash} from 'node:crypto';
import {canonicalJson} from '../../src/domain/governor.mjs';
import {verifyReport} from '../../src/preflight/domain.mjs';
import {FUJI_PROFILE} from '../../src/audit/fuji-deployment-profile.mjs';
import {selectedFujiArtifact} from './verify-selected-fuji.mjs';

const HASH=/^[0-9a-f]{64}$/;
const ZERO_HASH='0x'+'0'.repeat(64);

export function selectLatestPreflightReport(reports) {
  if(!Array.isArray(reports) || reports.length===0)throw new Error('PREFLIGHT_REPORT_REQUIRED');
  const verified=reports.map(report=>{
    if(!verifyReport(report).ok)throw new Error('PREFLIGHT_REPORT_INVALID');
    return JSON.parse(canonicalJson(report));
  });
  return verified.sort((left,right)=>right.checkedAtMs-left.checkedAtMs || right.reportHash.localeCompare(left.reportHash))[0];
}

// Offline only. Produces calldata for the user to inspect and sign elsewhere.
export async function preparePreflightFujiPublication(report) {
  const snapshot=selectLatestPreflightReport([report]);
  if(snapshot.mode!=='LIVE_READ_ONLY' || !HASH.test(snapshot.reportHash))throw new Error('PREFLIGHT_REPORT_NOT_LIVE');
  const artifact=await selectedFujiArtifact();
  const commitSelector=artifact.methodIdentifiers['commitPolicy(bytes32,bytes32)'];
  const appendSelector=artifact.methodIdentifiers['appendDecision(bytes32,uint256,bytes32,bytes32,bytes32)'];
  if(!/^[0-9a-f]{8}$/.test(commitSelector) || !/^[0-9a-f]{8}$/.test(appendSelector))throw new Error('FUJI_SELECTOR_INVALID');
  const reportHash='0x'+snapshot.reportHash;
  const policyHash='0x'+snapshot.policyHash;
  const taskId='0x'+createHash('sha256')
    .update('Pactway/preflight/fuji-task/v1\0','utf8').update(snapshot.reportHash,'utf8').digest('hex');
  const decisionMetadata={schema:'pactway.preflight-fuji-decision.v1',reportHash,policyHash,
    verdict:snapshot.verdict,mode:snapshot.mode,checkedAtMs:snapshot.checkedAtMs};
  const eventDigest='0x'+createHash('sha256').update('Pactway/preflight/fuji-decision/v1\0','utf8')
    .update(canonicalJson(decisionMetadata),'utf8').digest('hex');
  const commitPolicy={method:'commitPolicy',signature:'commitPolicy(bytes32,bytes32)',args:{taskId,policyHash},
    chainId:43113,from:FUJI_PROFILE.owner,to:FUJI_PROFILE.contractAddress,value:'0x0',
    data:'0x'+commitSelector+taskId.slice(2)+policyHash.slice(2)};
  const appendDecision={method:'appendDecision',signature:'appendDecision(bytes32,uint256,bytes32,bytes32,bytes32)',
    args:{taskId,sequence:'1',previousHash:ZERO_HASH,eventDigest,receiptHash:reportHash},chainId:43113,
    from:FUJI_PROFILE.owner,to:FUJI_PROFILE.contractAddress,value:'0x0',
    data:'0x'+appendSelector+taskId.slice(2)+'1'.padStart(64,'0')+ZERO_HASH.slice(2)+eventDigest.slice(2)+reportHash.slice(2)};
  return {
    schema:'pactway.preflight-fuji-publication.v1',status:'READY_FOR_USER_SIGNATURE',submitted:false,
    signatureRequired:true,profile:FUJI_PROFILE.id,chainId:43113,reportHash,policyHash,taskId,eventDigest,decisionMetadata,
    scope:'Unsigned commitment preparation only. This is not an on-chain publication, transaction receipt, timestamp, authorship proof, or exchange execution proof.',
    sequencing:'appendDecision must be signed or submitted only after commitPolicy has a confirmed successful receipt for this same fresh taskId.',
    report:snapshot,transactions:[commitPolicy,appendDecision],
  };
}
