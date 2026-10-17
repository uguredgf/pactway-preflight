import {demoReadRequest} from '../adapters/atk-spot-contract.mjs';

/** Requirements only, never a cancel/submit call. Stop does not undo a fill. */
export function planDemoSafety({task,intent,nowMs,globalPaused,campaignPaused,ownerActive}) {
  if(!Number.isSafeInteger(nowMs) || nowMs<0 || typeof globalPaused!=='boolean'
      || typeof campaignPaused!=='boolean' || typeof ownerActive!=='boolean')throw new TypeError('Safety inputs required');
  const validDeadline=Number.isSafeInteger(task.policy.expiresAtMs) && Number.isSafeInteger(intent.createdAtMs)
    && Number.isSafeInteger(task.policy.orderLifetimeMs) && task.policy.orderLifetimeMs>0
    && Number.isSafeInteger(intent.createdAtMs+task.policy.orderLifetimeMs);
  const stopped=task.ledger.stopRequested || globalPaused || campaignPaused || !ownerActive || !validDeadline
    || nowMs>=task.policy.expiresAtMs || nowMs>=intent.createdAtMs+task.policy.orderLifetimeMs;
  const flags={stopRequired:!!stopped,dispatchAllowed:false,resubmitAllowed:false,releaseReserve:false,reverseTrade:false};
  if(intent.settled)return {...flags,action:'NONE',priority:3,query:null,cancel:null};
  const query=demoReadRequest('order',{clOrdId:intent.clOrdId,...(intent.ordId?{ordId:intent.ordId}:{})});
  const uncertain=['PREPARED','SUBMITTING','UNKNOWN'].includes(intent.state);
  const cancel=stopped && !uncertain && !!intent.ordId && ['OPEN','PARTIAL','CANCEL_PENDING'].includes(intent.state);
  return {...flags,action:uncertain?'QUERY':cancel?'CANCEL_THEN_QUERY':'QUERY',priority:uncertain?0:cancel?1:2,
    query,cancel:cancel?{tool:'spot_cancel_order',args:{instId:'AVAX-USDT',clOrdId:intent.clOrdId,ordId:intent.ordId}}:null};
}
