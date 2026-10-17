import { DECIMAL_SCALE, parseDecimal, formatDecimal } from '../domain/money.mjs';
import { normalizeSpotFees } from './spot-fees.mjs';

// Pure ATK 1.4.8 boundary. No transport, credentials, clock, retry or settlement.
// Caller must journal the bounded response BEFORE attempting these projections.
const VERSION = '1.4.8';
const INSTRUMENT = 'AVAX-USDT';
const CLIENT_ID = /^[A-Za-z0-9]{1,32}$/;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const ENDPOINTS = Object.freeze({
  spot_place_order:['POST /api/v5/trade/order'],
  spot_cancel_order:['POST /api/v5/trade/cancel-order'],
  spot_get_order:['GET /api/v5/trade/order'],
  spot_get_orders:['GET /api/v5/trade/orders-pending','GET /api/v5/trade/orders-history','GET /api/v5/trade/orders-history-archive'],
  spot_get_fills:['GET /api/v5/trade/fills','GET /api/v5/trade/fills-history'],
});
const fail = code => ({ok:false,code});
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype,null].includes(Object.getPrototypeOf(value));
const decimal = (value,positive=false) => {
  if(typeof value!=='string' || value.length>64)throw new TypeError('Invalid decimal');
  const units=parseDecimal(value);
  if(units<0n || positive && units===0n)throw new TypeError('Invalid amount');
  return units;
};
function bound(binding) {
  return plain(binding) && binding.atkVersion===VERSION && binding.environment==='demo'
    && binding.instrument===INSTRUMENT && typeof binding.accountId==='string' && ID.test(binding.accountId)
    && typeof binding.connectionVersion==='string' && ID.test(binding.connectionVersion);
}
function expectedIntent(intent) {
  if(!plain(intent) || typeof intent.clOrdId!=='string' || !CLIENT_ID.test(intent.clOrdId)
    || intent.ordId!==null && intent.ordId!==undefined && (typeof intent.ordId!=='string' || !/^\d{1,64}$/.test(intent.ordId))
    || !plain(intent.payload))return false;
  const p=intent.payload;
  if(p.instId!==INSTRUMENT || p.side!=='buy' || p.tdMode!=='cash' || p.ordType!=='limit')return false;
  try {decimal(p.px,true);decimal(p.sz,true);return true;}catch{return false;}
}
function envelope(result,tool) {
  if(!plain(result) || result.tool!==tool || result.isError!==false || result.untrusted!==true
    || !plain(result.data) || !ENDPOINTS[tool]?.includes(result.data.endpoint)
    || !Array.isArray(result.data.data) || result.data.data.length>100)return null;
  return result.data.data;
}
function owned(row,intent,{allowBind=false,requireClient=false}={}) {
  if(!plain(row) || typeof row.ordId!=='string' || !/^\d{1,64}$/.test(row.ordId))return false;
  const hasClient=typeof row.clOrdId==='string' && row.clOrdId!=='';
  if(hasClient && row.clOrdId!==intent.clOrdId || requireClient && !hasClient)return false;
  if(intent.ordId)return row.ordId===intent.ordId;
  // Only the journalled place ACK can introduce ordId. A fill/history cannot.
  return allowBind && hasClient;
}

/** Describes bounded reads, does NOT execute them or prove history completeness.
 * Omit ccy/instId filters on account-wide reads so foreign assets/orders remain visible.
 * after uses ordId for orders and billId for fills, NOT tradeId.
 */
export function demoReadRequest(kind,{after,ordId,clOrdId}={}) {
  if(after!==undefined && (typeof after!=='string' || !/^\d{1,64}$/.test(after)))throw new TypeError('Invalid cursor');
  switch(kind) {
    case 'ticker':return {tool:'market_get_ticker',args:{instId:INSTRUMENT,demo:true}};
    case 'instruments':return {tool:'market_get_instruments',args:{instType:'SPOT',instId:INSTRUMENT,demo:true}};
    case 'balances':return {tool:'account_get_balance',args:{}};
    case 'fees':return {tool:'account_get_trade_fee',args:{instType:'SPOT',instId:INSTRUMENT}};
    case 'open-orders':return {tool:'spot_get_orders',args:{status:'open',limit:100,...(after?{after}:{})}};
    case 'order-history':return {tool:'spot_get_orders',args:{status:'history',limit:100,...(after?{after}:{})}};
    case 'fills':return {tool:'spot_get_fills',args:{limit:100,...(after?{after}:{})}};
    case 'intent-fills': {
      if(typeof ordId!=='string' || !/^\d{1,64}$/.test(ordId))throw new TypeError('Known order identity required');
      return {tool:'spot_get_fills',args:{instId:INSTRUMENT,ordId,limit:100,...(after?{after}:{})}};
    }
    case 'order': {
      if(ordId!==undefined && (typeof ordId!=='string' || !/^\d{1,64}$/.test(ordId))
        || clOrdId!==undefined && (typeof clOrdId!=='string' || !CLIENT_ID.test(clOrdId))
        || !ordId && !clOrdId)throw new TypeError('Known order identity required');
      return {tool:'spot_get_order',args:{instId:INSTRUMENT,...(ordId?{ordId}:{}),...(clOrdId?{clOrdId}:{})}};
    }
    default:throw new TypeError('Unsupported demo read');
  }
}

/** ACK confirms request acceptance only. It is never FILLED/CANCELLED/settled.
 * No HTTP write path exists here. A nonzero sCode also needs query reconciliation.
 */
export function normalizeSpotAck(result,{binding,intent,kind}={}) {
  if(!bound(binding) || !expectedIntent(intent))return fail('ATK_BINDING_REQUIRED');
  const tool=kind==='place'?'spot_place_order':kind==='cancel'?'spot_cancel_order':null;
  if(!tool)return fail('ATK_ACK_KIND');
  const rows=envelope(result,tool);
  if(!rows || rows.length!==1 || !plain(rows[0]))return fail('ATK_ACK_ENVELOPE');
  const row=rows[0];
  if(typeof row.sCode!=='string' || !/^\d{1,10}$/.test(row.sCode))return fail('ATK_ACK_STATUS');
  if(row.sCode!=='0')return fail('ATK_REQUEST_NOT_ACCEPTED');
  if(!owned(row,intent,{allowBind:kind==='place',requireClient:kind==='place'}))return fail('ATK_ORDER_IDENTITY');
  return {ok:true,ordId:row.ordId,clOrdId:intent.clOrdId,requestAccepted:true,
    state:kind==='place'?'SUBMITTING':'CANCEL_PENDING',terminal:false,settled:false};
}

/** REST fills only. Never use order-level cumulative fee as a per-trade fee.
 * Missing fee stays incomplete; rebates/other currencies require raw review.
 * Exact quote products above our 8-decimal ledger precision are NOT rounded away.
 */
export function normalizeSpotFill(row,{binding,intent}={}) {
  if(!bound(binding) || !expectedIntent(intent))return fail('ATK_BINDING_REQUIRED');
  if(!owned(row,intent) || row.instType!=='SPOT' || row.instId!==INSTRUMENT || row.side!=='buy')
    return fail('ATK_FILL_IDENTITY');
  if(typeof row.tradeId!=='string' || !/^\d{1,64}$/.test(row.tradeId))return fail('ATK_FILL_TRADE_ID');
  let size,price;
  try {size=decimal(row.fillSz,true);price=decimal(row.fillPx,true);}catch{return fail('ATK_FILL_AMOUNT');}
  const product=size*price;
  if(product%DECIMAL_SCALE!==0n)return fail('ATK_FILL_PRECISION_REQUIRES_RECONCILIATION');
  const feePresent=row.fee!==undefined && row.fee!==null && row.fee!=='';
  if(feePresent && (typeof row.fee!=='string' || row.fee.length>64))return fail('ATK_FILL_FEE');
  const fee=normalizeSpotFees({amount:row.fee,currency:row.feeCcy,observed:feePresent,signConvention:'negative-is-charge'});
  if(!fee.ok)return fail(fee.code);
  return {ok:true,ordId:row.ordId,clOrdId:intent.clOrdId,fill:{tradeId:row.tradeId,
    baseQty:formatDecimal(size),quoteNotional:formatDecimal(product/DECIMAL_SCALE),
    ...(fee.feesComplete?{feeQuote:fee.feeQuote,feeBase:fee.feeBase}:{}),feesComplete:fee.feesComplete}};
}

/** One page cannot prove completeness. Caller must collect the required interval,
 * validate cursors/duplicates, and compare total quantity with terminal accFillSz.
 * All-or-nothing projection; on error preserve the WHOLE page in the raw journal.
 */
export function normalizeSpotFillPage(result,{binding,intent}={}) {
  if(!bound(binding) || !expectedIntent(intent))return fail('ATK_BINDING_REQUIRED');
  const rows=envelope(result,'spot_get_fills');
  if(!rows)return fail('ATK_FILL_ENVELOPE');
  const fills=[];
  for(const row of rows) {
    const item=normalizeSpotFill(row,{binding,intent});
    if(!item.ok)return item;
    fills.push(item.fill);
  }
  return {ok:true,fills,fillsComplete:false,feesComplete:fills.length>0 && fills.every(fill=>fill.feesComplete)};
}

/** Reads terminal evidence; does NOT release reserves or synthesize fills.
 * A 404/empty reply is unknown, and terminal quantity still requires fill/fee history.
 */
export function normalizeSpotOrder(result,{binding,intent}={}) {
  if(!bound(binding) || !expectedIntent(intent))return fail('ATK_BINDING_REQUIRED');
  const rows=envelope(result,'spot_get_order');
  if(!rows || rows.length!==1)return fail('ATK_ORDER_UNRESOLVED');
  const row=rows[0],p=intent.payload;
  if(!owned(row,intent) || row.instType!=='SPOT' || row.instId!==INSTRUMENT
    || row.side!=='buy' || row.tdMode!=='cash' || row.ordType!=='limit')return fail('ATK_ORDER_IDENTITY');
  let size,filled;
  try {
    size=decimal(row.sz,true);filled=decimal(row.accFillSz);
    if(size!==decimal(p.sz,true) || decimal(row.px,true)!==decimal(p.px,true))return fail('ATK_ORDER_PAYLOAD');
  }catch{return fail('ATK_ORDER_AMOUNT');}
  const states={live:'OPEN',partially_filled:'PARTIAL',filled:'FILLED',canceled:'CANCELLED'};
  if(!Object.hasOwn(states,row.state))return fail('ATK_ORDER_STATE');
  if(filled>size || row.state==='live' && filled!==0n
    || row.state==='partially_filled' && (filled===0n || filled>=size)
    || row.state==='filled' && filled!==size)return fail('ATK_ORDER_QUANTITY');
  const terminal=['filled','canceled'].includes(row.state);
  return {ok:true,ordId:row.ordId,clOrdId:intent.clOrdId,state:states[row.state],terminal,
    expectedFillQty:terminal?formatDecimal(filled):null,observedFillQty:formatDecimal(filled),
    fillsComplete:false,feesComplete:false,settled:false};
}
