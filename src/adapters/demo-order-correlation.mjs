import {createHash} from 'node:crypto';
import {hashCanonical,hashPolicy} from '../domain/governor.mjs';
import {validateATKObservationRecord} from './atk-observation-journal.mjs';
import {openATKObservation} from './atk-market-account.mjs';
import {normalizeSpotAck,normalizeSpotOrder,demoReadRequest} from './atk-spot-contract.mjs';

const bindingKeys=['connectionHash','catalogHash','isolatedEntrySha256','sessionId','accountId'];
const result=(ok,code,extra={})=>({ok,code,...extra,dispatchAllowed:false,settlementAuthorized:false,
  verification:'SUPPLIED_JOURNAL_CORRELATION_ONLY'});

/** Pure matching against the original committed attempt. Caller must supply
 * persisted task/record and trusted connection context; hashes aren't provenance.
 * Empty/not-found/error responses never establish rejection or release money.
 */
export function correlateDemoOrder({task,record,expectedBinding,nowMs}) {
  try {
    const checked=validateATKObservationRecord(record);
    if(!checked.ok)return result(false,checked.code);
    const r=checked.record,c=r.context,s=task.submission,p=s?.prepared;
    const intent=task.ledger.intents.find(item=>item.id===s?.intentId);
    if(task.mode!=='demo-prepared' || !intent?.submissionAttempted || !s || !p?.ok
        || p.commitmentHash!==hashCanonical(p.commitment) || p.commitment.taskId!==task.id
        || p.commitment.intentId!==intent.id || p.commitment.clOrdId!==intent.clOrdId
        || p.commitment.economicPayloadHash!==hashCanonical(intent.payload)
        || p.commitment.policyHash!==task.approvedPolicyHash
        || p.commitment.accountId!==task.policy.accountId || hashPolicy(task.policy)!==task.approvedPolicyHash
        || task.ledger.taskId!==task.id || task.ledger.accountId!==task.policy.accountId
        || !Number.isSafeInteger(s.committedAtMs) || s.committedAtMs<p.commitment.preparedAtMs
        || p.commitment.bodySha256!==createHash('sha256').update(p.bodyText,'utf8').digest('hex')
        || hashCanonical(JSON.parse(p.bodyText))!==hashCanonical(p.body)) return result(false,'CORRELATION_ATTEMPT');
    const {clOrdId,tag,...economic}=p.body;
    if(clOrdId!==intent.clOrdId || hashCanonical(economic)!==hashCanonical(intent.payload))
      return result(false,'CORRELATION_BODY');
    if(c.taskId!==task.id || c.intentId!==intent.id || c.accountId!==task.policy.accountId
        || c.connectionHash!==p.commitment.connectionHash
        || bindingKeys.some(key=>c[key]!==expectedBinding[key]))return result(false,'CORRELATION_BINDING');
    if(!Number.isSafeInteger(nowMs) || c.requestedAtMs<s.committedAtMs || c.receivedAtMs>nowMs
        || !r.projectable || r.redacted)return result(false,'CORRELATION_OBSERVATION');
    const binding={atkVersion:'1.4.8',environment:'demo',instrument:'AVAX-USDT',
      accountId:task.policy.accountId,connectionVersion:task.policy.connectionVersion};
    let normalized,kind;
    if(c.tool==='spot_get_order') {
      const request=demoReadRequest('order',{clOrdId:intent.clOrdId,...(intent.ordId?{ordId:intent.ordId}:{})});
      const original=demoReadRequest('order',{clOrdId:intent.clOrdId});
      if(hashCanonical(c.args)!==hashCanonical(request.args) && hashCanonical(c.args)!==hashCanonical(original.args))return result(false,'CORRELATION_QUERY');
      const opened=openATKObservation(r,{expectedTool:c.tool,expectedBinding});
      if(!opened.ok)return result(false,opened.code);
      if(opened.rows.length!==1)return result(false,'CORRELATION_UNRESOLVED');
      const row=opened.rows[0];
      // Lost ACK: only the explicit original-client-ID query plus a complete
      // matching order row can introduce ordId. Never bind from fills/history.
      if(!intent.ordId && row.clOrdId!==intent.clOrdId)return result(false,'CORRELATION_CLIENT_ID');
      const candidate=intent.ordId?intent:{...intent,ordId:row.ordId};
      normalized=normalizeSpotOrder({tool:c.tool,isError:false,untrusted:true,
        data:{endpoint:opened.endpoint,data:opened.rows}},{binding,intent:candidate});
      kind='ORDER';
    } else if(['spot_place_order','spot_cancel_order'].includes(c.tool)) {
      kind=c.tool==='spot_place_order'?'PLACE_ACK':'CANCEL_ACK';
      const {tag,...placeArgs}=p.body;
      const expectedArgs=kind==='PLACE_ACK'?placeArgs:
        {instId:intent.payload.instId,clOrdId:intent.clOrdId,...(intent.ordId?{ordId:intent.ordId}:{})};
      if(hashCanonical(c.args)!==hashCanonical(expectedArgs))return result(false,'CORRELATION_REQUEST');
      const copies=[...(r.payload.structuredContent?[r.payload.structuredContent]:[]),
        ...(r.payload.content??[]).map(block=>block.type==='json'?block.data:null)];
      if(!copies.length || copies.some(value=>!value || hashCanonical(value)!==hashCanonical(copies[0])))
        return result(false,'CORRELATION_ENVELOPE');
      const envelope=copies[0],cap=envelope.capabilities;
      if(r.payload.isError===true || envelope.tool!==c.tool || envelope.ok!==true
          || cap?.demo!==true || cap.hasAuth!==true || cap.readOnly!==false
          || cap.moduleAvailability?.spot?.status!=='enabled')return result(false,'CORRELATION_ACK_UNRESOLVED');
      normalized=normalizeSpotAck({tool:c.tool,isError:false,untrusted:true,data:envelope.data},
        {binding,intent,kind:kind==='PLACE_ACK'?'place':'cancel'});
    } else return result(false,'CORRELATION_TOOL');
    if(!normalized.ok)return result(false,normalized.code);
    return result(true,'ORDER_CORRELATED',{kind,intentId:intent.id,observationId:c.observationId,
      payloadHash:r.payloadHash,observedAtMs:c.receivedAtMs,normalized,
      nextAction:kind==='ORDER' && normalized.terminal?'READ_FILLS':'QUERY_ORIGINAL_ORDER'});
  } catch {return result(false,'CORRELATION_INPUT');}
}
