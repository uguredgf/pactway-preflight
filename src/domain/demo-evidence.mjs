import {hashCanonical} from './governor.mjs';
import {parseDecimal,formatDecimal,DECIMAL_SCALE} from './money.mjs';
import {normalizeDemoBalance,normalizeDemoInstrument,normalizeDemoTicker,normalizeDemoFeeRates,openATKObservation} from '../adapters/atk-market-account.mjs';
import {createHistoryScan} from '../adapters/atk-history-pages.mjs';
import {normalizeSpotFill} from '../adapters/atk-spot-contract.mjs';
import {correlateDemoOrder} from '../adapters/demo-order-correlation.mjs';

const fail=code=>{throw Object.assign(new Error(code),{code});};
const same=(a,b)=>hashCanonical(a)===hashCanonical(b);
const identityKeys=['connectionHash','catalogHash','isolatedEntrySha256','sessionId','accountId'];
const algoTypes=['conditional','oco','move_order_stop'];
const id=value=>typeof value==='string' && value.length<=128 && /^[A-Za-z0-9_-]+$/.test(value);

export function evidenceIds(evidence) {
  if(!evidence || Object.keys(evidence).sort().join(',')!==
      'algoIds,balanceId,balanceStartId,configId,configStartId,endMs,feeId,fillIds,instrumentId,openEndId,openStartId,orderIds,tickerId')fail('FINAL_EVIDENCE_INPUT');
  if(!Array.isArray(evidence.algoIds) || evidence.algoIds.length!==3 || !Array.isArray(evidence.orderIds)
      || !Array.isArray(evidence.fillIds) || !evidence.orderIds.length || !evidence.fillIds.length
      || evidence.orderIds.length>100 || evidence.fillIds.length>100)fail('FINAL_EVIDENCE_INPUT');
  const ids=[evidence.configStartId,evidence.balanceStartId,evidence.instrumentId,evidence.tickerId,evidence.feeId,
    evidence.openStartId,...evidence.algoIds,...evidence.orderIds,...evidence.fillIds,evidence.openEndId,evidence.configId,evidence.balanceId];
  if(ids.some(value=>!id(value)) || new Set(ids).size!==ids.length)fail('FINAL_EVIDENCE_INPUT');
  return ids;
}

// References are loaded from Store, never replaced by caller-supplied normalizers
// or complete/verified flags. This still cannot protect against a compromised host.
export function durableRecord(store,observationId,context,{nowMs,maxAgeMs=15000}={}) {
  const saved=store.atkToolObservation(observationId),source=store.atkObservationSource(observationId);
  if(!saved || saved.status==='QUARANTINED' || source?.source!=='REGISTERED_STDIO_CAPTURE'
      || !source.activeSession || identityKeys.some(key=>saved.record.context[key]!==context.binding[key]))fail('LIFECYCLE_SOURCE_REQUIRED');
  const c=saved.record.context;
  if(!Number.isSafeInteger(nowMs) || !Number.isSafeInteger(maxAgeMs) || maxAgeMs<1
      || c.receivedAtMs>nowMs || nowMs-c.requestedAtMs>maxAgeMs)
    fail('LIFECYCLE_SOURCE_STALE');
  return saved.record;
}

function opened(store,observationId,context,options,tool,args) {
  const record=durableRecord(store,observationId,context,options);
  const view=openATKObservation(record,{expectedTool:tool,expectedBinding:context.binding});
  if(!view.ok || !same(record.context.args,args))fail('FINAL_EVIDENCE_QUERY');
  return {record,view};
}
function checked(result) {if(!result.ok)fail(result.code);return result;}
export function demoCashFromStates(states) {
  let base=0n,quote=0n;
  const trades=new Set();
  for(const task of states)for(const intent of task.ledger.intents)for(const fill of intent.fills) {
    if(!fill.feesComplete || trades.has(fill.tradeId))fail('FINAL_KNOWN_FEES_REQUIRED');
    trades.add(fill.tradeId);
    base+=parseDecimal(fill.baseQty)-parseDecimal(fill.feeBase);
    quote+=parseDecimal(fill.quoteNotional)+parseDecimal(fill.feeQuote);
  }
  return {base,quote};
}
export function verifyDemoCash(baseline,states,balance) {
  if(!baseline)fail('FINAL_BASELINE_REQUIRED');
  const {checkpointHash,...body}=baseline;
  if(hashCanonical(body)!==checkpointHash)fail('FINAL_BASELINE_CHANGED');
  const delta=demoCashFromStates(states);
  const prior={base:0n,quote:0n};
  const priorTrades=new Set();
  for(const fill of baseline.fills) {
    const owner=states.find(s=>s.id===fill.taskId)?.ledger.intents.find(i=>i.id===fill.intentId);
    const current=owner?.fills.find(f=>f.tradeId===fill.tradeId);
    if(priorTrades.has(fill.tradeId) || !current || !current.feesComplete
        || parseDecimal(current.baseQty)-parseDecimal(current.feeBase)!==parseDecimal(fill.baseNet)
        || parseDecimal(current.quoteNotional)+parseDecimal(current.feeQuote)!==parseDecimal(fill.quoteCost))
      fail('FINAL_BASELINE_FILL_CHANGED');
    priorTrades.add(fill.tradeId);
    prior.base+=parseDecimal(fill.baseNet);prior.quote+=parseDecimal(fill.quoteCost);
  }
  if(parseDecimal(baseline.balances.AVAX)+delta.base-prior.base!==parseDecimal(balance.balances.AVAX.cash)
      || parseDecimal(baseline.balances.USDT)-delta.quote+prior.quote!==parseDecimal(balance.balances.USDT.cash))
    fail('FINAL_UNEXPLAINED_BALANCE');
}

// A historical checkpoint is not fresh trading authority. Its capture receipts
// and dedicated creation event must survive, and its economics are replayed at
// the original observation time; every new submission still needs fresh reads.
export function verifyDemoBaseline(store,campaign,context) {
  const baseline=campaign?.balanceBaseline;
  if(!baseline)fail('FINAL_BASELINE_REQUIRED');
  const {checkpointHash,...body}=baseline;
  if(hashCanonical(body)!==checkpointHash || baseline.schemaVersion!==1
      || baseline.campaignHash!==campaign.configHash
      || baseline.connectionVersion!==context.manifest.config.connectionVersion
      || identityKeys.filter(key=>key!=='sessionId').some(key=>baseline.binding?.[key]!==context.binding[key]))
    fail('FINAL_BASELINE_CHANGED');
  const evidence=store.demoBaselineEvidence(campaign),ids=evidenceIds(evidence);
  for(const observationId of ids) {
    const saved=store.atkToolObservation(observationId),source=store.atkObservationSource(observationId);
    if(!saved || saved.status!=='APPLIED' || source?.source!=='REGISTERED_STDIO_CAPTURE'
        || identityKeys.some(key=>saved.record.context[key]!==baseline.binding[key])
        || saved.record.context.taskId!==null || saved.record.context.intentId!==null)
      fail('FINAL_BASELINE_SOURCE_REQUIRED');
  }
  const balanceRecord=store.atkToolObservation(evidence.balanceId).record;
  const configRecord=store.atkToolObservation(evidence.configId).record;
  if(!same(baseline.references,[{id:evidence.balanceId,hash:balanceRecord.payloadHash},
      {id:evidence.configId,hash:configRecord.payloadHash}]))fail('FINAL_BASELINE_CHANGED');
  const balance=checked(normalizeDemoBalance(balanceRecord,{accountConfigRecord:configRecord,
    expectedBinding:baseline.binding,nowMs:baseline.atMs,maxAgeMs:15000,maxSkewMs:15000}));
  if(balance.timing.receivedAtMs!==baseline.atMs || balance.balances.AVAX.cash!==baseline.balances.AVAX
      || balance.balances.USDT.cash!==baseline.balances.USDT)fail('FINAL_BASELINE_CHANGED');
  return baseline;
}

export function deriveDemoSnapshot({store,context,task,campaign,evidence,nowMs,baseline=false}) {
  const ids=evidenceIds(evidence),binding=context.binding;
  const maxAgeMs=task?.policy.snapshotMaxAgeMs??15000,maxSkewMs=task?.policy.snapshotMaxSkewMs??15000;
  const options={expectedBinding:binding,nowMs,maxAgeMs,maxSkewMs};
  const sourceOptions={nowMs,maxAgeMs};
  const records=ids.map(key=>durableRecord(store,key,context,sourceOptions));
  if(records.some(r=>r.context.taskId!==null || r.context.intentId!==null))fail('FINAL_ACCOUNT_SCOPE');
  if(records.at(-1).context.receivedAtMs-records[0].context.requestedAtMs>maxSkewMs)fail('FINAL_EVIDENCE_SKEW');
  // The opening balance/config and closing balance/config bracket the scans.
  for(let n=1;n<records.length;n++)if(records[n].context.requestedAtMs<records[n-1].context.receivedAtMs)
    fail('FINAL_EVIDENCE_SEQUENCE');
  const get=key=>durableRecord(store,evidence[key],context,sourceOptions);
  const config=get('configId'),configStart=get('configStartId');
  if(context.identityObservationId!==evidence.configId)fail('FINAL_ACCOUNT_IDENTITY');
  const start=checked(normalizeDemoBalance(get('balanceStartId'),{...options,accountConfigRecord:configStart}));
  const balance=checked(normalizeDemoBalance(get('balanceId'),{...options,accountConfigRecord:config}));
  if(start.feeType!==balance.feeType)fail('FINAL_ACCOUNT_CONFIGURATION_CHANGED');
  for(const ccy of ['AVAX','USDT']) {
    if(start.balances[ccy].cash!==balance.balances[ccy].cash
        || balance.balances[ccy].frozen!=='0' || balance.balances[ccy].orderFrozen!=='0'
        || balance.balances[ccy].available!==balance.balances[ccy].cash)fail('FINAL_BALANCE_CHANGED_OR_FROZEN');
  }
  const instrumentRecord=get('instrumentId'),instrument=checked(normalizeDemoInstrument(instrumentRecord,options));
  const ticker=checked(normalizeDemoTicker(get('tickerId'),options));
  const fees=checked(normalizeDemoFeeRates(get('feeId'),{...options,instrumentRecord}));
  if(fees.fees.rebateObserved)fail('FINAL_REBATE_UNSUPPORTED');
  for(const key of ['openStartId','openEndId']) {
    const read=opened(store,evidence[key],context,sourceOptions,'spot_get_orders',{status:'open',limit:100});
    if(read.view.endpoint!=='GET /api/v5/trade/orders-pending' || read.view.rows.length)fail('FINAL_OPEN_ORDERS');
  }
  for(let n=0;n<algoTypes.length;n++) {
    const read=opened(store,evidence.algoIds[n],context,sourceOptions,'spot_get_algo_orders',
      {status:'pending',ordType:algoTypes[n],limit:100});
    if(read.view.rows.length)fail('FINAL_ALGO_ORDERS');
  }
  const states=store.list().filter(s=>s.policy.accountId===binding.accountId);
  if(states.some(s=>!store.verifySafetyTask(s) || s.ledger.intents.some(i=>!i.settled)))fail('FINAL_UNSETTLED_ACCOUNT');
  const beginMs=baseline?Math.max(0,evidence.endMs-3600000):campaign.balanceBaseline?.atMs;
  if(!Number.isSafeInteger(beginMs) || evidence.endMs>records[0].context.requestedAtMs
      || evidence.endMs<=beginMs || beginMs<nowMs-86400000)fail('FINAL_HISTORY_WINDOW');
  const histories={};
  for(const [key,kind] of [['orderIds','SPOT_ORDER_HISTORY'],['fillIds','SPOT_FILLS']]) {
    const scan=createHistoryScan({kind,binding,nowMs:evidence.endMs,beginMs,endMs:evidence.endMs,pageSize:100,maxPages:100});
    for(const observationId of evidence[key])checked(scan.append(durableRecord(store,observationId,context,sourceOptions)));
    const view=scan.view();if(!view.ok || !view.scanExhausted)fail('FINAL_HISTORY_INCOMPLETE');
    histories[key]=view.rows;
  }
  // Foreign symbols, sell orders and unknown client/order/trade IDs all block.
  for(const row of histories.orderIds) {
    const owner=states.flatMap(s=>s.ledger.intents).find(i=>i.ordId===row.ordId && i.clOrdId===row.clOrdId);
    if(row.instId!=='AVAX-USDT' || row.side!=='buy' || !owner?.settled)fail('FINAL_FOREIGN_ORDER');
    if(row.tdMode!==owner.payload.tdMode || row.ordType!==owner.payload.ordType
        || parseDecimal(row.px)!==parseDecimal(owner.payload.px) || parseDecimal(row.sz)!==parseDecimal(owner.payload.sz)
        || parseDecimal(row.accFillSz)!==parseDecimal(owner.expectedFillQty)
        || ({filled:'FILLED',canceled:'CANCELLED'})[row.state]!==owner.state)fail('FINAL_ORDER_CHANGED');
  }
  for(const row of histories.fillIds) {
    const state=states.find(s=>s.ledger.intents.some(i=>i.ordId===row.ordId));
    const intent=state?.ledger.intents.find(i=>i.ordId===row.ordId);
    if(!intent?.settled)fail('FINAL_FOREIGN_FILL');
    const normalized=normalizeSpotFill(row,{binding:{atkVersion:'1.4.8',environment:'demo',instrument:'AVAX-USDT',
      accountId:binding.accountId,connectionVersion:context.manifest.config.connectionVersion},intent});
    const known=intent.fills.find(fill=>fill.tradeId===row.tradeId);
    if(!normalized.ok || !known || !same(known,normalized.fill))fail('FINAL_FILL_CHANGED');
  }
  for(const state of states)for(const intent of state.ledger.intents) {
    if(intent.createdAtMs<beginMs || intent.createdAtMs>evidence.endMs)continue;
    if(!histories.orderIds.some(row=>row.ordId===intent.ordId)
        || intent.fills.some(fill=>!histories.fillIds.some(row=>row.ordId===intent.ordId && row.tradeId===fill.tradeId)))
      fail('FINAL_HISTORY_OMITTED_KNOWN_EXECUTION');
  }
  if(!baseline)verifyDemoCash(verifyDemoBaseline(store,campaign,context),states.filter(s=>s.campaignId===campaign.config.id),balance);
  const rawBalance=checked(openATKObservation(get('balanceId'),{expectedTool:'account_get_balance',expectedBinding:binding}));
  const quote=rawBalance.rows[0].details.find(d=>d.ccy==='USDT');
  const quoteCash=parseDecimal(quote.cashBal),quoteUsd=parseDecimal(quote.eqUsd);
  if(quoteCash<=0n || quoteUsd<=0n)fail('FINAL_USD_VALUATION_REQUIRED');
  return {accountId:binding.accountId,environment:'demo',instrument:'AVAX-USDT',foreignActivity:false,openOrderCount:0,
    marketAtMs:ticker.timing.requestedAtMs,balanceAtMs:balance.timing.requestedAtMs,
    ordersAtMs:get('openEndId').context.requestedAtMs,tickSize:instrument.instrument.tickSz,lotSize:instrument.instrument.lotSz,
    minSize:instrument.instrument.minSz,referencePrice:ticker.ticker.referencePrice,
    baseBalance:balance.balances.AVAX.cash,quoteBalance:balance.balances.USDT.cash,availableQuote:balance.balances.USDT.available,
    maxLimitSize:instrument.instrument.maxLmtSz,maxLimitAmountUsd:instrument.instrument.maxLimitAmountUsd,
    quoteUsdValue:formatDecimal(quoteUsd),quoteCash:formatDecimal(quoteCash),fees:fees.fees,
    source:'REGISTERED_DEMO_RUNTIME',evidence:JSON.parse(JSON.stringify(evidence))};
}

export function verifyDemoLimits(snapshot,policy,intent) {
  if(parseDecimal(intent.payload.sz)>parseDecimal(snapshot.maxLimitSize)
      || parseDecimal(intent.payload.px)*parseDecimal(intent.payload.sz)*parseDecimal(snapshot.quoteUsdValue)
        >parseDecimal(snapshot.maxLimitAmountUsd)*parseDecimal(snapshot.quoteCash)*DECIMAL_SCALE)fail('FINAL_INSTRUMENT_LIMIT');
  if(parseDecimal(snapshot.fees.quoteFeeRateMax)>parseDecimal(policy.quoteFeeRateMax)
      || parseDecimal(snapshot.fees.baseFeeRateMax)>parseDecimal(policy.baseFeeRateMax))fail('FINAL_FEE_BOUND');
}

export function verifySettlementEvidence({store,context,state,review,input,nowMs}) {
  const coverage=input.coverage;
  if(!coverage || Object.keys(coverage).sort().join(',')!=='balanceId,configId,confirmId'
      || Object.values(coverage).some(value=>!id(value)))fail('SETTLEMENT_COVERAGE_REQUIRED');
  const sourceOptions={nowMs,maxAgeMs:15000};
  const first=durableRecord(store,input.observationId,context,sourceOptions);
  const confirm=durableRecord(store,coverage.confirmId,context,sourceOptions);
  const confirmed=correlateDemoOrder({task:state,record:confirm,expectedBinding:context.binding,nowMs});
  if(!confirmed.ok || confirmed.kind!=='ORDER' || !confirmed.normalized.terminal
      || !same(confirmed.normalized,review.correlation.normalized))fail('SETTLEMENT_TERMINAL_CHANGED');
  const pages=input.fillObservationIds.map(key=>durableRecord(store,key,context,sourceOptions));
  if(!pages.length || first.context.receivedAtMs>pages[0].context.requestedAtMs
      || confirm.context.requestedAtMs<pages.at(-1).context.receivedAtMs)fail('SETTLEMENT_SEQUENCE');
  const args=pages[0].context.args;
  if(Number(args.end)<first.context.receivedAtMs || Number(args.begin)>state.ledger.intents[0].createdAtMs)
    fail('SETTLEMENT_INTERVAL');
  const firstOrder=checked(openATKObservation(first,{expectedTool:'spot_get_order',expectedBinding:context.binding})).rows[0];
  const lastOrder=checked(openATKObservation(confirm,{expectedTool:'spot_get_order',expectedBinding:context.binding})).rows[0];
  // Two terminal observations must agree on cumulative fees as well as quantity.
  for(const key of ['fee','feeCcy','accFillSz','uTime'])if(firstOrder[key]!==lastOrder[key])fail('SETTLEMENT_TERMINAL_CHANGED');
  if(typeof lastOrder.fee!=='string' || !['AVAX','USDT'].includes(lastOrder.feeCcy)
      || typeof lastOrder.uTime!=='string' || !/^[0-9]{1,16}$/.test(lastOrder.uTime))fail('SETTLEMENT_FEES_REQUIRED');
  const charged=-parseDecimal(lastOrder.fee),intent=state.ledger.intents.find(i=>i.id===state.submission.intentId);
  const quoteFees=intent.fills.reduce((sum,fill)=>sum+parseDecimal(fill.feeQuote),0n);
  const baseFees=intent.fills.reduce((sum,fill)=>sum+parseDecimal(fill.feeBase),0n);
  if(charged<0n || (lastOrder.feeCcy==='AVAX'?(baseFees!==charged || quoteFees!==0n):(quoteFees!==charged || baseFees!==0n)))
    fail('SETTLEMENT_FEE_TOTAL');
  const terminalAt=Number(lastOrder.uTime);
  if(!Number.isSafeInteger(terminalAt) || terminalAt<intent.createdAtMs-state.policy.snapshotMaxSkewMs
      || terminalAt>Number(args.end)+state.policy.snapshotMaxSkewMs)fail('SETTLEMENT_INTERVAL');
  for(const page of pages) {
    const rows=checked(openATKObservation(page,{expectedTool:'spot_get_fills',expectedBinding:context.binding})).rows;
    for(const row of rows)if(typeof row.ts!=='string' || !/^[0-9]{1,16}$/.test(row.ts)
        || Number(row.ts)<intent.createdAtMs-state.policy.snapshotMaxSkewMs || Number(row.ts)>terminalAt)
      fail('SETTLEMENT_FILL_INTERVAL');
  }
  const cfg=durableRecord(store,coverage.configId,context,sourceOptions);
  const bal=durableRecord(store,coverage.balanceId,context,sourceOptions);
  if(context.identityObservationId!==coverage.configId || cfg.context.requestedAtMs<confirm.context.receivedAtMs
      || bal.context.requestedAtMs<cfg.context.receivedAtMs)fail('SETTLEMENT_SEQUENCE');
  const balance=checked(normalizeDemoBalance(bal,{expectedBinding:context.binding,nowMs,maxAgeMs:15000,maxSkewMs:15000,accountConfigRecord:cfg}));
  for(const ccy of ['AVAX','USDT'])if(balance.balances[ccy].frozen!=='0' || balance.balances[ccy].orderFrozen!=='0'
      || balance.balances[ccy].available!==balance.balances[ccy].cash)fail('SETTLEMENT_BALANCE_FROZEN');
  const peers=store.list().filter(s=>s.campaignId===state.campaignId && s.id!==state.id);
  if(peers.some(s=>!store.verifySafetyTask(s) || s.ledger.intents.some(i=>!i.settled)))fail('SETTLEMENT_PEER_UNRESOLVED');
  verifyDemoCash(verifyDemoBaseline(store,store.campaign(state.campaignId),context),[...peers,state],balance);
  return [coverage.confirmId,coverage.configId,coverage.balanceId];
}
