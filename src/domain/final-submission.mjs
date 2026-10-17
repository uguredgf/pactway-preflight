import {evaluateCandidate,hashCanonical,hashPolicy} from './governor.mjs';
import {ledgerSummary} from './ledger.mjs';
import {projectCampaign} from './campaign.mjs';
import {parseDecimal} from './money.mjs';
import {matchesPreparedWireBody,prepareDemoWireBody} from '../adapters/prepared-wire-body.mjs';

/** Internal economic assessment, NOT an attestation of the supplied snapshot.
 * Store must re-read tasks/campaign and independently verify source evidence.
 * No caller-supplied ready/verified/authorized flag grants delivery authority.
 */
export function assessFinalSubmission({task,campaign,peers,manifest,intent,prepared,snapshot,nowMs}) {
  const deny=code=>({ok:false,code,dispatchAllowed:false});
  try {
    if(!Number.isSafeInteger(nowMs) || nowMs<0) return deny('FINAL_TIME');
    if(task.mode!=='demo-prepared' || task.policy.executionMode!=='demo-prepared'
        || task.id!==task.policy.taskId || task.ledger.taskId!==task.id
        || task.ledger.accountId!==task.policy.accountId || hashPolicy(task.policy)!==task.approvedPolicyHash
        || task.ledger.phase!=='WAITING' || task.ledger.stopRequested!==false || task.busy!==false
        || task.attempts!==0 || task.ledger.intents.length || task.submission
        || task.queue && !['QUEUED','RUNNING'].includes(task.queue.state)) return deny('FINAL_TASK_STATE');
    if(task.queue && (!Number.isSafeInteger(task.queue.expiresAtMs) || nowMs>=task.queue.expiresAtMs)
        || task.approvalRequest && task.queue?.state!=='RUNNING')return deny('FINAL_QUEUE_EXPIRED');
    if(peers.some(other=>other.id===task.id)) return deny('FINAL_PEER_SET');
    if(peers.some(other=>other.busy || other.queue?.state==='RUNNING'
        || other.ledger.intents.some(order=>!order.settled))) return deny('FINAL_EXECUTION_LANE');
    // IDs are never reused, including a settled order in an older campaign.
    if(peers.some(other=>other.policy.accountId===task.policy.accountId
        && other.ledger.intents.some(order=>order.clOrdId===intent.clOrdId))) return deny('FINAL_CLIENT_ID_REUSED');
    const projected=projectCampaign(campaign,[...peers.filter(other=>other.campaignId===task.campaignId),task]);
    if(projected.paused || projected.supersededBy || projected.violations.length) return deny('FINAL_CAMPAIGN_PAUSED');
    const wireInput={manifest,policy:task.policy,approvedPolicyHash:task.approvedPolicyHash,intent,nowMs:prepared.commitment.preparedAtMs};
    if(!matchesPreparedWireBody(prepared,wireInput,prepared.bodyText)
        || prepared.commitment.preparedAtMs>nowMs) return deny('FINAL_WIRE_CHANGED');
    const current=prepareDemoWireBody({...wireInput,nowMs});
    if(!current.ok) return deny(current.code);
    if(hashCanonical(snapshot)!==intent.snapshotHash) return deny('FINAL_SNAPSHOT_CHANGED');
    const p=intent.payload;
    // This is the FIRST reservation. Existing prepared/submitted intents are
    // rejected above; never subtract their reserve to manufacture headroom.
    const summary={...ledgerSummary(task.ledger),phase:'RUNNING'};
    const decision=evaluateCandidate({policy:task.policy,approvedPolicyHash:task.approvedPolicyHash,snapshot,
      candidate:{instrument:p.instId,side:p.side,tdMode:p.tdMode,ordType:p.ordType,price:p.px,size:p.sz},
      ledgerSummary:summary,nowMs});
    if(!decision.ok) return deny('FINAL_'+decision.code);
    if(decision.payloadHash!==intent.payloadHash || decision.reserve!==intent.initialReserve)
      return deny('FINAL_ECONOMICS_CHANGED');
    if(parseDecimal(decision.reserve)>parseDecimal(projected.summary.remaining)) return deny('FINAL_CAMPAIGN_BUDGET');
    return {ok:true,code:'FINAL_ECONOMICS_ONLY',decision,dispatchAllowed:false,
      campaignHash:projected.configHash,taskRevision:task.revision,
      validUntilMs:Math.min(current.commitment.expiresAtMs,
        task.queue?.expiresAtMs??task.policy.expiresAtMs,
        ...['marketAtMs','balanceAtMs','ordersAtMs'].map(key=>snapshot[key]+task.policy.snapshotMaxAgeMs))};
  } catch {return deny('FINAL_INPUT');}
}
