import {hashCanonical} from './governor.mjs';
import {ledgerSummary,reconcileIntent} from './ledger.mjs';

/** Internal arithmetic check, never a provenance/coverage attestation. A caller
 * must independently authorize settlement BEFORE persisting this candidate.
 */
export function assessDemoSettlement(task,review) {
  const deny=code=>({ok:false,code,settlementAuthorized:false});
  try {
    if(task.mode!=='demo-prepared' || !task.submission || !review?.ok || !review.arithmeticReady
        || review.requiresReview || review.correlation?.kind!=='ORDER' || !review.correlation.normalized.terminal)
      return deny('SETTLEMENT_NOT_READY');
    if(review.taskRevision!==task.revision || hashCanonical(review.auditHead)!==hashCanonical(task.auditHead))
      return deny('SETTLEMENT_REVIEW_CHANGED');
    if(!review.references?.length || review.references.some(ref=>ref.status!=='APPLIED'))
      return deny('SETTLEMENT_OBSERVATIONS_NOT_CONSUMED');
    // Settlement must not sneak in additional fills or an unconsumed order state.
    if(hashCanonical(task.ledger)!==hashCanonical(review.candidateLedger))return deny('SETTLEMENT_LEDGER_CHANGED');
    const id=task.submission.intentId,intent=task.ledger.intents.find(item=>item.id===id);
    if(!intent || intent.settled || intent.quarantined || !intent.submissionAttempted
        || intent.id!==review.correlation.intentId || ledgerSummary(task.ledger).violation)
      return deny('SETTLEMENT_INTENT');
    const candidateLedger=reconcileIntent(task.ledger,id,{fillsComplete:true,feesComplete:true});
    candidateLedger.phase=task.ledger.stopRequested?'STOPPED':'WAITING';
    return {ok:true,code:'SETTLEMENT_ARITHMETIC_ONLY',candidateLedger,
      before:ledgerSummary(task.ledger),after:ledgerSummary(candidateLedger),settlementAuthorized:false};
  } catch {return deny('SETTLEMENT_INPUT');}
}
