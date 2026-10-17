import test from 'node:test';
import assert from 'node:assert/strict';
import {demoReadRequest,normalizeSpotAck,normalizeSpotFill,normalizeSpotFillPage,normalizeSpotOrder} from '../src/adapters/atk-spot-contract.mjs';

// Source-only acceptance cases. Not executed during this revision.
const binding={atkVersion:'1.4.8',environment:'demo',instrument:'AVAX-USDT',accountId:'demo-account',connectionVersion:'v1'};
const intent={clOrdId:'mg123',ordId:'987',payload:{instId:'AVAX-USDT',tdMode:'cash',side:'buy',ordType:'limit',px:'25',sz:'1'}};
const context={binding,intent};
const response=(tool,endpoint,rows)=>({tool,isError:false,untrusted:true,data:{endpoint,requestTime:'2026-10-13T12:00:00.000Z',data:rows}});
const fill=(patch={})=>({instType:'SPOT',instId:'AVAX-USDT',side:'buy',ordId:'987',clOrdId:'mg123',tradeId:'11',fillPx:'24.8',fillSz:'0.4',fee:'-0.01',feeCcy:'USDT',...patch});
const order=(patch={})=>({instType:'SPOT',instId:'AVAX-USDT',side:'buy',tdMode:'cash',ordType:'limit',ordId:'987',clOrdId:'mg123',px:'25',sz:'1',accFillSz:'0.4',state:'canceled',...patch});

test('demo reads use actual tool names, explicit market demo and unfiltered account reads',()=>{
  assert.deepEqual(demoReadRequest('ticker'),{tool:'market_get_ticker',args:{instId:'AVAX-USDT',demo:true}});
  assert.equal(demoReadRequest('instruments').args.demo,true);
  assert.deepEqual(demoReadRequest('balances').args,{});
  assert.deepEqual(demoReadRequest('open-orders').args,{status:'open',limit:100});
  assert.equal(demoReadRequest('order-history').tool,'spot_get_orders');
  assert.deepEqual(demoReadRequest('fills',{after:'12'}).args,{limit:100,after:'12'});
  assert.deepEqual(demoReadRequest('intent-fills',{ordId:'987',after:'12'}).args,{instId:'AVAX-USDT',ordId:'987',limit:100,after:'12'});
  assert.throws(()=>demoReadRequest('intent-fills'));
  assert.throws(()=>demoReadRequest('order'));
  assert.throws(()=>demoReadRequest('fills',{after:'bad-cursor'}));
});
test('place ACK binds identity but never claims open, fill or settlement',()=>{
  const r=response('spot_place_order','POST /api/v5/trade/order',[{sCode:'0',ordId:'987',clOrdId:'mg123'}]);
  const ack=normalizeSpotAck(r,{binding,intent:{...intent,ordId:null},kind:'place'});
  assert.equal(ack.ok,true);assert.equal(ack.state,'SUBMITTING');assert.equal(ack.terminal,false);assert.equal(ack.settled,false);
  assert.equal(normalizeSpotAck(r,{...context,kind:'cancel'}).ok,false);
  r.data.data[0].clOrdId='someoneElse';
  assert.equal(normalizeSpotAck(r,{...context,kind:'place'}).code,'ATK_ORDER_IDENTITY');
});
test('cancel ACK and nonzero business status cannot release reserves',()=>{
  const r=response('spot_cancel_order','POST /api/v5/trade/cancel-order',[{sCode:'0',ordId:'987',clOrdId:''}]);
  assert.equal(normalizeSpotAck(r,{...context,kind:'cancel'}).state,'CANCEL_PENDING');
  r.data.data[0].sCode='51400';
  assert.equal(normalizeSpotAck(r,{...context,kind:'cancel'}).code,'ATK_REQUEST_NOT_ACCEPTED');
});
test('per-fill quote and base fees normalize with documented negative charge sign',()=>{
  assert.deepEqual(normalizeSpotFill(fill(),context).fill,{tradeId:'11',baseQty:'0.4',quoteNotional:'9.92',feeQuote:'0.01',feeBase:'0',feesComplete:true});
  const base=normalizeSpotFill(fill({fee:'-0.001',feeCcy:'AVAX'}),context);
  assert.equal(base.fill.feeQuote,'0');assert.equal(base.fill.feeBase,'0.001');
  assert.equal(normalizeSpotFill(fill({fee:'0'}),context).fill.feesComplete,true);
});
test('missing fee is incomplete; unsupported/rebate fees retain a review requirement',()=>{
  assert.equal(normalizeSpotFill(fill({fee:''}),context).fill.feesComplete,false);
  assert.equal(normalizeSpotFill(fill({fee:'0.01'}),context).code,'FEE_REBATE_REQUIRES_RECONCILIATION');
  assert.equal(normalizeSpotFill(fill({feeCcy:'BTC'}),context).code,'UNSUPPORTED_FEE_CURRENCY');
  assert.equal(normalizeSpotFill(fill({fillSz:'0.00000001',fillPx:'0.00000001'}),context).code,'ATK_FILL_PRECISION_REQUIRES_RECONCILIATION');
});
test('fill cannot introduce an unbound ordId or cross intent/account environment',()=>{
  assert.equal(normalizeSpotFill(fill(),{binding,intent:{...intent,ordId:null}}).ok,false);
  assert.equal(normalizeSpotFill(fill({clOrdId:'other'}),context).ok,false);
  assert.equal(normalizeSpotFill(fill({instId:'BTC-USDT'}),context).ok,false);
  assert.equal(normalizeSpotFill(fill(),{...context,binding:{...binding,environment:'live'}}).ok,false);
  assert.equal(normalizeSpotFill(fill({clOrdId:''}),context).ok,true);
});
test('fill page never certifies interval completeness and is rejected as a whole on conflict',()=>{
  const r=response('spot_get_fills','GET /api/v5/trade/fills',[fill()]);
  const page=normalizeSpotFillPage(r,context);
  assert.equal(page.ok,true);assert.equal(page.fillsComplete,false);assert.equal(page.feesComplete,true);
  r.data.data.push(fill({ordId:'999'}));assert.equal(normalizeSpotFillPage(r,context).ok,false);
  r.data.endpoint='GET /api/v5/account/balance';assert.equal(normalizeSpotFillPage(r,context).code,'ATK_FILL_ENVELOPE');
});
test('terminal order is only quantity evidence; cumulative fee is not a fill',()=>{
  const r=response('spot_get_order','GET /api/v5/trade/order',[order({fee:'-5',feeCcy:'USDT'})]);
  const observed=normalizeSpotOrder(r,context);
  assert.equal(observed.state,'CANCELLED');assert.equal(observed.expectedFillQty,'0.4');
  assert.equal(observed.fillsComplete,false);assert.equal(observed.feesComplete,false);assert.equal(observed.settled,false);
  assert.equal(Object.hasOwn(observed,'fill'),false);
});
test('unknown/empty, impossible quantities and amended payload never synthesize terminal success',()=>{
  const observed=row=>normalizeSpotOrder(response('spot_get_order','GET /api/v5/trade/order',row?[row]:[]),context);
  assert.equal(observed(null).code,'ATK_ORDER_UNRESOLVED');
  assert.equal(observed(order({state:'filled',accFillSz:'0.4'})).code,'ATK_ORDER_QUANTITY');
  assert.equal(observed(order({state:'live',accFillSz:'0.4'})).code,'ATK_ORDER_QUANTITY');
  assert.equal(observed(order({px:'26'})).code,'ATK_ORDER_PAYLOAD');
  assert.equal(observed(order({state:'unknown'})).code,'ATK_ORDER_STATE');
});
