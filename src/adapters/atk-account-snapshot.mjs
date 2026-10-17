import {validateATKObservationRecord} from './atk-observation-journal.mjs';
import {openATKObservation,normalizeDemoInstrument,normalizeDemoTicker,normalizeDemoBalance,normalizeDemoFeeRates} from './atk-market-account.mjs';
import {createHistoryScan} from './atk-history-pages.mjs';

const REQUIRED = ['expectedBinding','nowMs','maxAgeMs','maxSkewMs','beginMs','endMs','pageSize',
  'instrumentRecord','tickerRecord','configRecord','balanceRecord','feeRecord','histories'];
const HISTORIES = {openOrders:'SPOT_OPEN_ORDERS',orders:'SPOT_ORDER_HISTORY',fills:'SPOT_FILLS'};
const BLOCKERS = Object.freeze([
  'OBSERVATION_PROVENANCE_UNVERIFIED','DURABLE_CONSUMPTION_UNVERIFIED',
  'RUNTIME_AND_TARGET_UNVERIFIED','ACCOUNT_SCOPE_INCOMPLETE','HISTORY_CONSISTENCY_UNVERIFIED',
  'OWNERSHIP_AND_BALANCE_RECONCILIATION_MISSING','USD_NOTIONAL_LIMIT_UNVERIFIED',
]);
function fields(value,keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype,null].includes(Object.getPrototypeOf(value)) || Object.getOwnPropertySymbols(value).length)
    throw 'ATK_SNAPSHOT_INPUT';
  const descriptors=Object.getOwnPropertyDescriptors(value);
  if (Object.keys(descriptors).length !== keys.length
      || keys.some(key=>!Object.hasOwn(descriptors,key) || !Object.hasOwn(descriptors[key],'value')))
    throw 'ATK_SNAPSHOT_INPUT';
  return Object.fromEntries(keys.map(key=>[key,descriptors[key].value]));
}
function pages(value) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
      || value.length < 1 || value.length > 100 || Object.getOwnPropertySymbols(value).length)
    throw 'ATK_SNAPSHOT_HISTORY_INPUT';
  const descriptors=Object.getOwnPropertyDescriptors(value);
  if (Object.keys(descriptors).length !== value.length+1) throw 'ATK_SNAPSHOT_HISTORY_INPUT';
  const result=[];
  for (let i=0;i<value.length;i++) {
    if (!Object.hasOwn(descriptors,String(i)) || !Object.hasOwn(descriptors[i],'value')) throw 'ATK_SNAPSHOT_HISTORY_INPUT';
    result.push(descriptors[i].value);
  }
  return result;
}
function result(ok,code,extra={}) {
  return Object.freeze({ok,code,...extra,verification:'SUPPLIED_RECORDS_ASSEMBLED_ONLY',
    requiredBlockers:BLOCKERS,ready:false,complete:false,accountComplete:false,economicComplete:false,
    foreignActivity:'UNKNOWN',launchAllowed:false,readAuthorized:false,writeEnabled:false,
    routeVerified:false,actualAccountVerified:false});
}

/** Pure diagnostic snapshot preparation. Replays raw journal-shaped records rather
 * than trusting supplied normalizer/scan flags. Never a governor-ready snapshot.
 * No transport, implicit clock, Store mutation, ledger consume or authority input.
 */
export function assembleDemoAccountSnapshot(input) {
  let stage='input';
  try {
    const data=fields(input,REQUIRED);
    const options={expectedBinding:data.expectedBinding,nowMs:data.nowMs,maxAgeMs:data.maxAgeMs,maxSkewMs:data.maxSkewMs};
    const supplied=fields(data.histories,Object.keys(HISTORIES));
    const transcripts=Object.fromEntries(Object.keys(HISTORIES).map(key=>[key,pages(supplied[key])]));
    const ids=new Set(),calls=new Set(),references=[];
    let bytes=0,earliest=Infinity,latest=-Infinity;
    function capture(record,tool) {
      const checked=validateATKObservationRecord(record);
      if (!checked.ok) throw 'ATK_SNAPSHOT_RECORD';
      const detached=checked.record;
      bytes+=Buffer.byteLength(JSON.stringify(detached),'utf8');
      if (bytes > 8*1024*1024) throw 'ATK_SNAPSHOT_BYTE_LIMIT';
      const opened=openATKObservation(detached,{expectedTool:tool,expectedBinding:data.expectedBinding});
      if (!opened.ok) throw opened.code;
      const c=opened.context,callKey=c.sessionId+':'+c.callId;
      if (ids.has(c.observationId) || calls.has(callKey)) throw 'ATK_SNAPSHOT_DUPLICATE_CALL';
      ids.add(c.observationId);calls.add(callKey);
      if (c.receivedAtMs > data.nowMs || data.nowMs-c.requestedAtMs > data.maxAgeMs)
        throw 'ATK_SNAPSHOT_STALE';
      for (const local of [opened.responseRequestTimeMs,opened.responseTimestampMs])
        if (local < c.requestedAtMs-data.maxSkewMs || local > c.receivedAtMs+data.maxSkewMs)
          throw 'ATK_SNAPSHOT_CLOCK';
      if (opened.responseTimestampMs < opened.responseRequestTimeMs-data.maxSkewMs) throw 'ATK_SNAPSHOT_CLOCK';
      earliest=Math.min(earliest,c.requestedAtMs);latest=Math.max(latest,c.receivedAtMs);
      if (latest-earliest > data.maxSkewMs) throw 'ATK_SNAPSHOT_SKEW';
      references.push(Object.freeze({sourceObservationId:c.observationId,sourcePayloadHash:detached.payloadHash,tool}));
      return detached;
    }
    // Normalizer validates clock options and binding before any arithmetic below.
    stage='instrument';
    const instrument=normalizeDemoInstrument(data.instrumentRecord,options);
    if (!instrument.ok) throw instrument.code;
    const instrumentRecord=capture(data.instrumentRecord,'market_get_instruments');
    stage='ticker';
    const ticker=normalizeDemoTicker(capture(data.tickerRecord,'market_get_ticker'),options);
    if (!ticker.ok) throw ticker.code;
    stage='balance';
    const configRecord=capture(data.configRecord,'account_get_config');
    const balance=normalizeDemoBalance(capture(data.balanceRecord,'account_get_balance'),{...options,accountConfigRecord:configRecord});
    if (!balance.ok) throw balance.code;
    stage='fees';
    const fees=normalizeDemoFeeRates(capture(data.feeRecord,'account_get_trade_fee'),{...options,instrumentRecord});
    if (!fees.ok) throw fees.code;
    const history={};
    for (const [name,kind] of Object.entries(HISTORIES)) {
      stage=name;
      const config={kind,binding:instrument.binding,nowMs:data.nowMs,pageSize:data.pageSize,maxPages:100,
        ...(name === 'openOrders' ? {} : {beginMs:data.beginMs,endMs:data.endMs})};
      let scan;
      try {scan=createHistoryScan(config);} catch {throw 'ATK_SNAPSHOT_HISTORY_INPUT';}
      let previousReceived=-Infinity;
      for (const page of transcripts[name]) {
        const request=scan.request();
        if (!request) throw 'ATK_SNAPSHOT_EXTRA_PAGE';
        const detached=capture(page,request.tool);
        if (detached.context.requestedAtMs < previousReceived) throw 'ATK_SNAPSHOT_PAGE_SEQUENCE';
        previousReceived=detached.context.receivedAtMs;
        const accepted=scan.append(detached);
        if (!accepted.ok) throw accepted.code;
      }
      const view=scan.view();
      if (!view.scanExhausted) throw 'ATK_SNAPSHOT_HISTORY_UNFINISHED';
      history[name]=view;
    }
    return result(true,'ATK_SNAPSHOT_PREPARED_BLOCKED',{
      binding:instrument.binding,assembledAtMs:data.nowMs,
      observationWindow:Object.freeze({earliestRequestMs:earliest,latestReceiptMs:latest,spanMs:latest-earliest}),
      interval:Object.freeze({beginMs:data.beginMs,endMs:data.endMs}),
      instrument:instrument.instrument,ticker:ticker.ticker,balances:balance.balances,
      balancePolicy:balance.balancePolicy,accountMode:balance.accountMode,feeType:balance.feeType,fees:fees.fees,
      histories:Object.freeze(history),references:Object.freeze(references),
    });
  } catch (code) {
    // No partial balances/rows on failure; journal remains the diagnostic source.
    return result(false,typeof code === 'string' && /^ATK_[A-Z_]+$/.test(code) ? code : 'ATK_SNAPSHOT_INPUT',{stage});
  }
}
