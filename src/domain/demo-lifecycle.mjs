import {correlateDemoOrder} from '../adapters/demo-order-correlation.mjs';
import {createHistoryScan} from '../adapters/atk-history-pages.mjs';
import {validateATKObservationRecord} from '../adapters/atk-observation-journal.mjs';
import {normalizeSpotFill} from '../adapters/atk-spot-contract.mjs';
import {bindOrderIdentity,markOpen,markCancelPending,markTerminal,recordFill,ledgerSummary} from './ledger.mjs';
import {parseDecimal,formatDecimal} from './money.mjs';

/** Source-derived preview only. Never writes Store, consumes an observation,
 * releases reserve or treats caller completion flags as authority.
 */
export function previewDemoLifecycle({task,record,expectedBinding,nowMs,fillRecords=[],pageSize=100,scanEndMs=nowMs}) {
  const correlation=correlateDemoOrder({task,record,expectedBinding,nowMs});
  const base={correlation,applied:false,dispatchAllowed:false,settlementAuthorized:false};
  if(!correlation.ok)return {...base,ok:false,code:correlation.code,requiresReview:true};
  let ledger=JSON.parse(JSON.stringify(task.ledger));
  const id=correlation.intentId,n=correlation.normalized,issues=[];
  let exhausted=false;
  try {
    ledger=bindOrderIdentity(ledger,id,n.ordId);
    if(correlation.kind==='CANCEL_ACK')ledger=markCancelPending(ledger,id);
    if(correlation.kind==='ORDER') {
      if(n.terminal)ledger=markTerminal(ledger,id,{state:n.state,expectedFillQty:n.expectedFillQty});
      else {
        const target=ledger.intents.find(i=>i.id===id);
        const known=target.fills.reduce((sum,f)=>sum+parseDecimal(f.baseQty),0n);
        if(known>parseDecimal(n.observedFillQty) || ['FILLED','CANCELLED','REJECTED'].includes(target.state)
            || target.state==='PARTIAL' && n.state==='OPEN')throw new Error('Order observation regressed');
        ledger=markOpen(ledger,id,{ordId:n.ordId});
        const observed=ledger.intents.find(i=>i.id===id);
        if(n.state==='PARTIAL' && observed.state!=='CANCEL_PENDING')observed.state='PARTIAL';
      }
    }
    if(!Array.isArray(fillRecords) || fillRecords.length>100)throw new Error('Fill input limit');
    if(fillRecords.length) {
      const original=ledger.intents.find(i=>i.id===id);
      const scan=createHistoryScan({kind:'OWNED_INTENT_FILLS',binding:expectedBinding,nowMs,pageSize,maxPages:100,
        knownOrderId:n.ordId,beginMs:original.createdAtMs,endMs:scanEndMs});
      let previousReceipt=-1;
      for(const source of fillRecords) {
        const checked=validateATKObservationRecord(source);
        if(!checked.ok){issues.push(checked.code);break;}
        const c=checked.record.context;
        if(c.taskId!==task.id || c.intentId!==id || c.requestedAtMs<task.submission.committedAtMs
            || c.requestedAtMs<previousReceipt || c.receivedAtMs>nowMs) {
          issues.push('FILL_CONTEXT_MISMATCH');break;
        }
        previousReceipt=c.receivedAtMs;
        const appended=scan.append(checked.record);
        if(!appended.ok){issues.push(appended.code);break;}
      }
      const view=scan.view();exhausted=view.scanExhausted && issues.length===0;
      const binding={atkVersion:'1.4.8',environment:'demo',instrument:'AVAX-USDT',
        accountId:task.policy.accountId,connectionVersion:task.policy.connectionVersion};
      for(const row of view.rows) {
        const intent=ledger.intents.find(i=>i.id===id);
        const normalized=normalizeSpotFill(row,{binding,intent});
        if(!normalized.ok){issues.push(normalized.code);continue;}
        try {ledger=recordFill(ledger,id,normalized.fill);} catch {issues.push('FILL_CONFLICT');}
      }
    }
  } catch {issues.push('LIFECYCLE_CONFLICT');}
  const target=ledger.intents.find(i=>i.id===id),summary=ledgerSummary(ledger);
  const total=target.fills.reduce((sum,f)=>sum+parseDecimal(f.baseQty),0n);
  const arithmeticReady=correlation.kind==='ORDER' && n.terminal && exhausted && !issues.length
    && !summary.violation && !target.quarantined && total===parseDecimal(n.expectedFillQty)
    && target.fills.every(fill=>fill.feesComplete);
  // Incomplete/unsupported rows retain their raw journal references. Known costs
  // in the preview survive, but nothing is committed or declared complete here.
  return {...base,ok:issues.length===0,code:issues.length?'LIFECYCLE_REVIEW_REQUIRED':'LIFECYCLE_PREVIEW',
    candidateLedger:ledger,summary,issues:[...new Set(issues)],requiresReview:issues.length>0 || summary.violation || !!target.quarantined,
    observedFillQuantity:formatDecimal(total),scanExhausted:exhausted,arithmeticReady,
    blockers:['DURABLE_PROVENANCE_UNVERIFIED','INTERVAL_COVERAGE_UNVERIFIED','ATOMIC_CONSUME_NOT_CONNECTED'],
    nextAction:arithmeticReady?'VERIFY_COVERAGE_BEFORE_SETTLEMENT':'QUERY_OR_READ_FILLS'};
}
