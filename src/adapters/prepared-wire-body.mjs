import {createHash} from 'node:crypto';
import {hashPolicy,hashCanonical} from '../domain/governor.mjs';
import {parseDecimal,formatDecimal,DECIMAL_SCALE,ceilDivide} from '../domain/money.mjs';
import {verifyDemoConnectionManifest} from './demo-connection-manifest.mjs';

const fail=code=>{throw code;};
const hash=value=>typeof value==='string' && value.length===64 && /^[a-f0-9]{64}$/.test(value);
function clone(input) {
  let nodes=0,bytes=0;const ancestors=new Set();
  function copy(value,depth=0) {
    if(++nodes>4096 || depth>12)fail('WIRE_INPUT_LIMIT');
    if(value===null || typeof value==='boolean')return value;
    if(typeof value==='number') {if(!Number.isSafeInteger(value))fail('WIRE_INPUT');return value;}
    if(typeof value==='string') {bytes+=Buffer.byteLength(value,'utf8');if(bytes>65536)fail('WIRE_INPUT_LIMIT');return value;}
    if(!value || typeof value!=='object' || ancestors.has(value) || Object.getOwnPropertySymbols(value).length)fail('WIRE_INPUT');
    const array=Array.isArray(value);
    if(![array?Array.prototype:Object.prototype,null].includes(Object.getPrototypeOf(value)))fail('WIRE_INPUT');
    ancestors.add(value);const descriptors=Object.getOwnPropertyDescriptors(value),result=array?[]:Object.create(null);
    const keys=Object.keys(descriptors).filter(key=>!(array && key==='length'));
    if(keys.length>256 || array && keys.length!==value.length)fail('WIRE_INPUT_LIMIT');
    for(const key of keys) {
      if(key.length>128 || !Object.hasOwn(descriptors[key],'value') || array && !/^(0|[1-9][0-9]*)$/.test(key))fail('WIRE_INPUT');
      result[key]=copy(descriptors[key].value,depth+1);
    }
    ancestors.delete(value);return Object.freeze(result);
  }
  return copy(input);
}
function exact(value,keys) {
  if(!value || Array.isArray(value) || Object.keys(value).sort().join(',')!==[...keys].sort().join(','))fail('WIRE_FIELDS');
}
function money(value,positive=false) {
  if(typeof value!=='string' || value.length>64 || value.trim()!==value)fail('WIRE_DECIMAL');
  const units=parseDecimal(value);
  if(units<0n || positive && units===0n || formatDecimal(units)!==value)fail('WIRE_DECIMAL');
  return units;
}
const sha=text=>createHash('sha256').update(text,'utf8').digest('hex');

/** Pure request-byte preparation. No SDK, signing, credentials, network, marker,
 * freshness attestation or delivery capability. A later transport must use these
 * exact bytes, rather than rebuild the object or let a handler add extra fields.
 */
export function prepareDemoWireBody(input) {
  try {
    const data=clone(input);exact(data,['manifest','policy','approvedPolicyHash','intent','nowMs']);
    const {manifest,policy,intent,nowMs}=data;
    if(!verifyDemoConnectionManifest(manifest))fail('WIRE_MANIFEST');
    if(!Number.isSafeInteger(nowMs) || nowMs<0)fail('WIRE_TIME');
    if(!hash(data.approvedPolicyHash) || hashPolicy(policy)!==data.approvedPolicyHash)fail('WIRE_POLICY');
    const c=manifest.config;
    if(policy.executionMode!=='demo-prepared' || policy.accountId!==c.accountId || policy.connectionVersion!==c.connectionVersion
        || policy.environment!==c.environment || policy.instrument!==c.instrument || !hash(policy.campaignHash)
        || typeof policy.campaignId!=='string' || !policy.campaignId || !Number.isSafeInteger(policy.campaignVersion) || policy.campaignVersion<1)
      fail('WIRE_BINDING');
    if(nowMs<policy.approvedAtMs || nowMs>=policy.expiresAtMs)fail('WIRE_POLICY_EXPIRED');
    exact(intent,['id','clOrdId','ordId','state','settled','submissionAttempted','createdAtMs','payload','payloadHash',
      'policyHash','snapshotHash','initialReserve','expectedFillQty','fills']);
    if(typeof intent.id!=='string' || !intent.id || intent.id.length>128 || intent.id.trim()!==intent.id
        || typeof intent.clOrdId!=='string' || intent.clOrdId.trim()!==intent.clOrdId || !/^[A-Za-z0-9]{1,32}$/.test(intent.clOrdId)
        || intent.state!=='PREPARED' || intent.submissionAttempted!==false || intent.settled!==false
        || intent.ordId!==null || intent.expectedFillQty!==null || !Array.isArray(intent.fills) || intent.fills.length)
      fail('WIRE_INTENT_STATE');
    if(!Number.isSafeInteger(intent.createdAtMs) || intent.createdAtMs<policy.approvedAtMs || intent.createdAtMs>nowMs
        || !Number.isSafeInteger(policy.orderLifetimeMs) || policy.orderLifetimeMs<1
        || !Number.isSafeInteger(intent.createdAtMs+policy.orderLifetimeMs)
        || nowMs-intent.createdAtMs>=policy.orderLifetimeMs)fail('WIRE_INTENT_EXPIRED');
    if(intent.policyHash!==data.approvedPolicyHash || !hash(intent.snapshotHash))fail('WIRE_INTENT_BINDING');
    const p=intent.payload;
    exact(p,['instId','side','tdMode','ordType','px','sz']);
    if(p.instId!=='AVAX-USDT' || p.side!=='buy' || p.tdMode!=='cash' || p.ordType!=='limit'
        || hashCanonical(p)!==intent.payloadHash)fail('WIRE_ECONOMIC_PAYLOAD');
    const px=money(p.px,true),sz=money(p.sz,true),product=px*sz;
    if(px>parseDecimal(policy.maxPrice) || product>parseDecimal(policy.singleOrderNotionalMax)*DECIMAL_SCALE)fail('WIRE_POLICY_CAP');
    const notional=ceilDivide(product,DECIMAL_SCALE);
    const reserve=notional+ceilDivide(notional*parseDecimal(policy.quoteFeeRateMax),DECIMAL_SCALE)+parseDecimal(policy.quoteFeeFixedMax);
    if(money(intent.initialReserve,true)!==reserve || reserve>parseDecimal(policy.budget))fail('WIRE_RESERVE');
    const body=Object.freeze({instId:p.instId,tdMode:p.tdMode,side:p.side,ordType:p.ordType,sz:p.sz,px:p.px,
      clOrdId:intent.clOrdId,tag:c.sourceTag});
    const bodyText=JSON.stringify(body);
    const commitment=Object.freeze({schemaVersion:1,taskId:policy.taskId,intentId:intent.id,clOrdId:intent.clOrdId,
      accountId:c.accountId,connectionHash:manifest.configHash,connectionVersion:c.connectionVersion,
      campaignId:policy.campaignId,campaignVersion:policy.campaignVersion,campaignHash:policy.campaignHash,
      policyHash:data.approvedPolicyHash,economicPayloadHash:intent.payloadHash,snapshotHash:intent.snapshotHash,
      initialReserve:intent.initialReserve,method:'POST',apiOrigin:c.apiOrigin,path:'/api/v5/trade/order',
      demoHeader:'1',bodySha256:sha(bodyText),bodyByteLength:Buffer.byteLength(bodyText,'utf8'),
      preparedAtMs:nowMs,expiresAtMs:Math.min(policy.expiresAtMs,intent.createdAtMs+policy.orderLifetimeMs)});
    return Object.freeze({ok:true,code:'WIRE_BODY_PREPARED',body,bodyText,commitment,commitmentHash:hashCanonical(commitment),
      dispatchAllowed:false,writeEnabled:false,verification:'SUPPLIED_INTENT_ONLY'});
  } catch(code) {
    return Object.freeze({ok:false,code:typeof code==='string' && /^WIRE_[A-Z_]+$/.test(code)?code:'WIRE_INPUT',dispatchAllowed:false,writeEnabled:false});
  }
}

/** Equality against a fresh preparation at the original preparation time. This
 * check grants no authority and must not replace the later final snapshot gate.
 */
export function matchesPreparedWireBody(prepared,input,bodyText) {
  try {
    const saved=clone(prepared),rebuilt=prepareDemoWireBody(input);
    return rebuilt.ok && typeof bodyText==='string' && bodyText===rebuilt.bodyText
      && hashCanonical(saved)===hashCanonical(rebuilt);
  } catch {return false;}
}
