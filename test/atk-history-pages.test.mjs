// Source acceptance cases only; not executed. No SDK, network or live account.
import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareATKObservation} from '../src/adapters/atk-observation-journal.mjs';
import {createHistoryScan,appendHistoryPage} from '../src/adapters/atk-history-pages.mjs';

const binding={connectionHash:'a'.repeat(64),catalogHash:'b'.repeat(64),isolatedEntrySha256:'c'.repeat(64),
  sessionId:'session-1',accountId:'account-alias'};
const nowMs=1770000000000;
const settings=(patch={}) => ({kind:'SPOT_ORDER_HISTORY',binding,nowMs,beginMs:nowMs-600000,
  endMs:nowMs,pageSize:2,maxPages:5,...patch});
const fill=(billId,patch={}) => ({billId,ordId:'100',tradeId:'777',instType:'SPOT',instId:'AVAX-USDT',
  fillPx:'10',fillSz:'1',fee:'-0.01',feeCcy:'USDT',opaqueEconomic:{amount:'17'},...patch});
const order=(ordId,patch={}) => ({ordId,instType:'SPOT',instId:'AVAX-USDT',state:'filled',accFillSz:'1',...patch});
function record(scan,rows,index=1,{args,bindingPatch={},endpoint}={}) {
  const request=scan.request();
  const envelope={tool:request.tool,ok:true,data:{endpoint:endpoint ?? request.endpoint,
    requestTime:new Date(nowMs).toISOString(),data:rows},
    capabilities:{readOnly:true,hasAuth:true,demo:true,moduleAvailability:{spot:{status:'enabled'}}},
    timestamp:new Date(nowMs).toISOString()};
  const prepared=prepareATKObservation({schemaVersion:1,observationId:'observation-'+index,callId:'call-'+index,
    ...binding,...bindingPatch,taskId:'task-1',intentId:null,tool:request.tool,args:args ?? request.args,
    requestedAtMs:nowMs,receivedAtMs:nowMs},
    {structuredContent:envelope,content:[{type:'text',text:JSON.stringify(envelope)}],isError:false});
  assert.equal(prepared.ok,true);return prepared.record;
}
function incomplete(view) {
  for (const key of ['complete','economicComplete','accountComplete','fillsComplete','feesComplete',
    'launchAllowed','readAuthorized','writeEnabled','routeVerified','actualAccountVerified','intervalCoverageVerified'])
    assert.equal(view[key],false,key);
  assert.equal(view.consistencyUnverified,true);assert.equal(Object.isFrozen(view),true);
  assert.equal(Object.hasOwn(view,'foreignActivity'),false);
}
test('short pages require explicit empty terminal; rows and references preserve opaque data',() => {
  const scan=createHistoryScan(settings());
  assert.deepEqual(scan.request().args,{status:'history',begin:String(nowMs-600000),end:String(nowMs),limit:2});
  const page=record(scan,[order('30')]);const first=appendHistoryPage(scan,page);
  assert.equal(first.ok,true);assert.equal(first.exhausted,false);assert.equal(first.cursor,'30');
  assert.equal(first.nextRequest.args.after,'30');incomplete(first);
  const terminal=appendHistoryPage(scan,record(scan,[],2));
  assert.equal(terminal.exhausted,true);assert.equal(terminal.scopeComplete,false);assert.equal(terminal.nextRequest,null);
  assert.equal(terminal.references.length,2);assert.equal(terminal.rows.length,1);incomplete(terminal);
  assert.equal(appendHistoryPage(scan,page).code,'ATK_HISTORY_SCAN_CLOSED');
});
test('fill pagination uses billId, permits identical overlap only with older progress',() => {
  const scan=createHistoryScan(settings({kind:'SPOT_FILLS'}));
  assert.equal(scan.request().args.archive,false);assert.equal('instId' in scan.request().args,false);
  appendHistoryPage(scan,record(scan,[fill('30'),fill('20')],1));
  assert.equal(scan.request().args.after,'20');
  const next=appendHistoryPage(scan,record(scan,[fill('20'),fill('10')],2));
  assert.equal(next.ok,true);assert.equal(next.cursor,'10');assert.equal(next.rows.length,3);
  assert.equal(next.rows[0].opaqueEconomic.amount,'17');assert.equal(next.rows[0].tradeId,'777');
  assert.equal(Object.isFrozen(next.rows[0].opaqueEconomic),true);incomplete(next);
  const repeated=appendHistoryPage(scan,record(scan,[fill('10')],3));
  assert.equal(repeated.code,'ATK_HISTORY_NO_PROGRESS');assert.equal(repeated.references.length,3);
  assert.equal(repeated.rows.length,3);assert.equal(repeated.nextRequest,null);
});
test('conflicting same-ID page fails atomically and keeps its journal reference',() => {
  const scan=createHistoryScan(settings({kind:'SPOT_FILLS'}));
  appendHistoryPage(scan,record(scan,[fill('30'),fill('20')],1));
  const conflicting=record(scan,[fill('20',{fee:'-9'}),fill('10')],2);
  const view=appendHistoryPage(scan,conflicting);
  assert.equal(view.code,'ATK_HISTORY_ROW_CONFLICT');assert.equal(view.rows.length,2);
  assert.equal(view.rows[1].fee,'-0.01');assert.equal(view.references[1].sourcePayloadHash,conflicting.payloadHash);
  incomplete(view);
});
test('binding, every query filter and endpoint are checked exactly',() => {
  for (const options of [
    {bindingPatch:{sessionId:'session-2'}},
    {args:{status:'history',begin:String(nowMs-600000),end:String(nowMs),limit:2,instId:'AVAX-USDT'}},
    {args:{status:'history',begin:String(nowMs-600000),end:String(nowMs),limit:2,after:'90'}},
    {endpoint:'GET /api/v5/trade/orders-history-archive'},
  ]) {
    const scan=createHistoryScan(settings());const supplied=record(scan,[order('30')],1,options);
    const view=appendHistoryPage(scan,supplied);
    assert.equal(view.ok,false);assert.equal(view.rows.length,0);assert.equal(view.references.length,1);incomplete(view);
  }
});
test('max pages, oversized pages, ordering and non-progress block without completion',() => {
  const bounded=createHistoryScan(settings({maxPages:1}));
  const limit=appendHistoryPage(bounded,record(bounded,[order('30')]));
  assert.equal(limit.code,'ATK_HISTORY_MAX_PAGES');assert.equal(limit.exhausted,false);incomplete(limit);
  for (const [rows,code] of [
    [[order('30'),order('20'),order('10')],'ATK_HISTORY_PAGE_LIMIT'],
    [[order('20'),order('30')],'ATK_HISTORY_PAGE_ORDER'],
    [[order('20'),order('20')],'ATK_HISTORY_PAGE_ORDER'],
    [[order('0')],'ATK_HISTORY_ROW_IDENTITY'],
  ]) {
    const scan=createHistoryScan(settings());const view=appendHistoryPage(scan,record(scan,rows));
    assert.equal(view.code,code);assert.equal(view.rows.length,0);incomplete(view);
  }
  const scan=createHistoryScan(settings());appendHistoryPage(scan,record(scan,[order('20')]));
  assert.equal(appendHistoryPage(scan,record(scan,[order('30')],2)).code,'ATK_HISTORY_CURSOR');
});
test('open orders and owned fills retain separate scope and incomplete economic authority',() => {
  const open=createHistoryScan({kind:'SPOT_OPEN_ORDERS',binding,nowMs,pageSize:2,maxPages:3});
  assert.deepEqual(open.request().args,{status:'open',limit:2});
  const empty=appendHistoryPage(open,record(open,[]));
  assert.equal(empty.exhausted,true);assert.equal(empty.scopeComplete,false);assert.equal(empty.interval,null);incomplete(empty);
  const owned=createHistoryScan(settings({kind:'OWNED_INTENT_FILLS',knownOrderId:'100'}));
  assert.equal(owned.request().args.ordId,'100');assert.equal(owned.request().args.instId,'AVAX-USDT');
  assert.equal(appendHistoryPage(owned,record(owned,[fill('30',{ordId:'101'})])).code,'ATK_HISTORY_ROW_IDENTITY');
});
test('unsupported intervals, archives, accessor config and forged record hashes are rejected',() => {
  for (const patch of [{beginMs:nowMs-86400001},{endMs:nowMs+1},{beginMs:nowMs},
    {pageSize:101},{maxPages:101},{archive:true},{knownOrderId:'100'},
    {binding:{...binding,extra:'untrusted'}}]) assert.throws(() => createHistoryScan(settings(patch)));
  let reads=0;const input=settings();Object.defineProperty(input,'pageSize',{get(){reads++;return 2;}});
  assert.throws(() => createHistoryScan(input));assert.equal(reads,0);
  const scan=createHistoryScan(settings());const fake=JSON.parse(JSON.stringify(record(scan,[order('30')])));
  fake.payload.structuredContent.data.data[0].accFillSz='999';
  const rejected=appendHistoryPage(scan,fake);assert.equal(rejected.ok,false);assert.equal(rejected.references.length,0);
  assert.equal(rejected.rows.length,0);incomplete(rejected);
  assert.throws(() => appendHistoryPage({...scan.view(),complete:true},fake));
});
