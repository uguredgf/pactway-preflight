import {validateATKObservationRecord} from './atk-observation-journal.mjs';
import {copyAccountExpectation} from './atk-account-expectation.mjs';
import {DECIMAL_SCALE,parseDecimal,formatDecimal} from '../domain/money.mjs';

// Field semantics: https://www.okx.com/docs-v5/en/ (read 2026-10-14).
// These are pure supplied-observation projections, not a live snapshot or authority.
const BINDING_KEYS = ['connectionHash','catalogHash','isolatedEntrySha256','sessionId','accountId'];
const CLOCK_KEYS = ['expectedBinding','nowMs','maxAgeMs','maxSkewMs'];
const ENDPOINTS = Object.freeze({
  market_get_instruments:['GET /api/v5/public/instruments'],market_get_ticker:['GET /api/v5/market/ticker'],
  market_get_orderbook:['GET /api/v5/market/books'],account_get_config:['GET /api/v5/account/config'],
  account_get_balance:['GET /api/v5/account/balance'],account_get_trade_fee:['GET /api/v5/account/trade-fee'],
  spot_get_order:['GET /api/v5/trade/order'],
  spot_get_orders:['GET /api/v5/trade/orders-pending','GET /api/v5/trade/orders-history','GET /api/v5/trade/orders-history-archive'],
  spot_get_fills:['GET /api/v5/trade/fills','GET /api/v5/trade/fills-history'],
  spot_get_algo_orders:['GET /api/v5/trade/orders-algo-pending'],
});
const CODES = new Set(['ATK_PROJECTION_FIELDS','ATK_PROJECTION_RECORD','ATK_PROJECTION_UNPROJECTABLE',
  'ATK_PROJECTION_BINDING','ATK_PROJECTION_CONFLICT','ATK_PROJECTION_ENVELOPE','ATK_PROJECTION_TOOL',
  'ATK_PROJECTION_ENDPOINT','ATK_PROJECTION_CAPABILITIES','ATK_PROJECTION_CLOCK','ATK_PROJECTION_STALE',
  'ATK_PROJECTION_FUTURE','ATK_PROJECTION_TIME_MISSING','ATK_PROJECTION_SCOPE','ATK_PROJECTION_ROWS',
  'ATK_PROJECTION_DECIMAL','ATK_PROJECTION_INSTRUMENT','ATK_PROJECTION_TRANSITION',
  'ATK_PROJECTION_BALANCE_POLICY','ATK_PROJECTION_BALANCE_UNKNOWN','ATK_PROJECTION_BALANCE_LIABILITY',
  'ATK_PROJECTION_BALANCE_ASSET','ATK_PROJECTION_BALANCE_CONFLICT','ATK_PROJECTION_FEE_GROUP',
  'ATK_PROJECTION_FEE_POLICY','ATK_PROJECTION_FEE_RATE','ATK_ACCOUNT_EXPECTATION','ATK_ACCOUNT_UID_MISMATCH']);
const BLOCKERS = Object.freeze(['SUPPLIED_OBSERVATION_PROVENANCE_UNVERIFIED','ACCOUNT_SCOPE_NOT_ASSEMBLED',
  'HISTORY_AND_FOREIGN_ACTIVITY_UNVERIFIED','RUNTIME_AND_TARGET_UNVERIFIED']);

function fields(input,allowed,required = allowed) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
      || ![Object.prototype,null].includes(Object.getPrototypeOf(input)) || Object.getOwnPropertySymbols(input).length)
    throw 'ATK_PROJECTION_FIELDS';
  const descriptors = Object.getOwnPropertyDescriptors(input);const names = Object.keys(descriptors);
  if (names.length > 4096 || (allowed && names.some(key => !allowed.includes(key)))
      || (required && required.some(key => !names.includes(key)))) throw 'ATK_PROJECTION_FIELDS';
  const copied = Object.create(null);
  for (const key of names) {
    if (!Object.hasOwn(descriptors[key],'value')) throw 'ATK_PROJECTION_FIELDS';
    copied[key] = descriptors[key].value;
  }
  return copied;
}
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '['+value.map(canonical).join(',')+']';
  return '{'+Object.keys(value).sort().map(key => JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}';
}
function isoTime(value) {
  if (typeof value !== 'string' || value.length !== 24 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value))
    throw 'ATK_PROJECTION_TIME_MISSING';
  const time = Date.parse(value);
  if (!Number.isSafeInteger(time) || time < 0 || new Date(time).toISOString() !== value) throw 'ATK_PROJECTION_CLOCK';
  return time;
}
function exchangeTime(value) {
  if (typeof value !== 'string' || value.length > 16 || value.trim() !== value || !/^[1-9][0-9]*$/.test(value))
    throw 'ATK_PROJECTION_TIME_MISSING';
  const time = Number(value);
  if (!Number.isSafeInteger(time)) throw 'ATK_PROJECTION_CLOCK';
  return time;
}
function decimal(value,{positive=false,signed=false} = {}) {
  if (typeof value !== 'string' || value.length > 64 || value.trim() !== value || !/^-?\d+(?:\.\d+)?$/.test(value))
    throw 'ATK_PROJECTION_DECIMAL';
  let normalized = value.includes('.') ? value.replace(/0+$/,'').replace(/\.$/,'') : value;
  let units;
  try {units = parseDecimal(normalized);} catch {throw 'ATK_PROJECTION_DECIMAL';}
  if ((!signed && units < 0n) || (positive && units <= 0n)) throw 'ATK_PROJECTION_DECIMAL';
  return units;
}
const groupId = value => typeof value === 'string' && value.length <= 16 && value.trim() === value && /^[1-9][0-9]*$/.test(value);
function bindingCopy(input) {
  const binding = fields(input,BINDING_KEYS);
  for (const key of BINDING_KEYS.slice(0,3))
    if (typeof binding[key] !== 'string' || binding[key].length !== 64 || !/^[a-f0-9]{64}$/.test(binding[key])) throw 'ATK_PROJECTION_BINDING';
  for (const key of ['sessionId','accountId'])
    if (typeof binding[key] !== 'string' || binding[key].length > 128 || binding[key].trim() !== binding[key]
        || !/^[A-Za-z0-9_-]+$/.test(binding[key])) throw 'ATK_PROJECTION_BINDING';
  return Object.freeze(binding);
}
function open(record,options) {
  const request = fields(options,['expectedTool','expectedBinding']);const binding = bindingCopy(request.expectedBinding);
  if (!Object.hasOwn(ENDPOINTS,request.expectedTool)) throw 'ATK_PROJECTION_TOOL';
  const valid = validateATKObservationRecord(record);
  if (!valid.ok) throw 'ATK_PROJECTION_RECORD';
  const detached = valid.record;const context = detached.context;
  if (!detached.projectable || detached.redacted || detached.payload.isError === true) throw 'ATK_PROJECTION_UNPROJECTABLE';
  if (context.tool !== request.expectedTool) throw 'ATK_PROJECTION_TOOL';
  if (BINDING_KEYS.some(key => context[key] !== binding[key])) throw 'ATK_PROJECTION_BINDING';
  const copies = [];
  if (Object.hasOwn(detached.payload,'structuredContent')) copies.push(detached.payload.structuredContent);
  for (const block of detached.payload.content ?? []) {
    if (block.type !== 'json') throw 'ATK_PROJECTION_UNPROJECTABLE';
    copies.push(block.data);
  }
  if (!copies.length) throw 'ATK_PROJECTION_ENVELOPE';
  const serialized = canonical(copies[0]);
  if (copies.some(copy => canonical(copy) !== serialized)) throw 'ATK_PROJECTION_CONFLICT';
  const envelope = fields(copies[0],['tool','ok','data','capabilities','timestamp']);
  if (envelope.tool !== request.expectedTool || envelope.ok !== true) throw 'ATK_PROJECTION_ENVELOPE';
  const data = fields(envelope.data,['endpoint','requestTime','data']);
  if (!ENDPOINTS[request.expectedTool].includes(data.endpoint)) throw 'ATK_PROJECTION_ENDPOINT';
  if (!Array.isArray(data.data) || data.data.length > 1000) throw 'ATK_PROJECTION_ROWS';
  const capability = fields(envelope.capabilities,['readOnly','hasAuth','demo','moduleAvailability']);
  if (typeof capability.readOnly !== 'boolean' || capability.demo !== true || capability.hasAuth !== true) throw 'ATK_PROJECTION_CAPABILITIES';
  const module = request.expectedTool.split('_')[0];
  if (!capability.moduleAvailability || typeof capability.moduleAvailability !== 'object'
      || Array.isArray(capability.moduleAvailability) || capability.moduleAvailability[module]?.status !== 'enabled')
    throw 'ATK_PROJECTION_CAPABILITIES';
  const responseRequestTimeMs = isoTime(data.requestTime);const responseTimestampMs = isoTime(envelope.timestamp);
  return {record:detached,context,binding,rows:data.data,endpoint:data.endpoint,envelope:Object.freeze(envelope),
    sourceObservationId:context.observationId,sourcePayloadHash:detached.payloadHash,responseRequestTimeMs,responseTimestampMs};
}

/** Revalidate journal commitment and compare ALL supplied payload copies. Declared
 * capabilities/identity are consistency checks, never independent account proof.
 * Exported for later paginated projections; no adapter/transport invocation here.
 */
export function openATKObservation(record,options) {
  try {return report(true,'ATK_OBSERVATION_OPENED',open(record,options));} catch (code) {return failed(code);}
}
function optionsFor(input,extra = []) {
  const options = fields(input,[...CLOCK_KEYS,...extra]);
  if (!Number.isSafeInteger(options.nowMs) || options.nowMs < 0 || !Number.isSafeInteger(options.maxAgeMs)
      || options.maxAgeMs < 1 || options.maxAgeMs > 300000 || !Number.isSafeInteger(options.maxSkewMs)
      || options.maxSkewMs < 0 || options.maxSkewMs > 60000) throw 'ATK_PROJECTION_CLOCK';
  return options;
}
function fresh(opened,options,sourceTs = null) {
  const {requestedAtMs,receivedAtMs} = opened.context;
  if (receivedAtMs > options.nowMs || options.nowMs-requestedAtMs > options.maxAgeMs) throw 'ATK_PROJECTION_STALE';
  for (const local of [opened.responseRequestTimeMs,opened.responseTimestampMs])
    if (local < requestedAtMs-options.maxSkewMs || local > receivedAtMs+options.maxSkewMs) throw 'ATK_PROJECTION_CLOCK';
  if (opened.responseTimestampMs < opened.responseRequestTimeMs-options.maxSkewMs) throw 'ATK_PROJECTION_CLOCK';
  if (sourceTs !== null) {
    if (sourceTs > options.nowMs+options.maxSkewMs || sourceTs > receivedAtMs+options.maxSkewMs) throw 'ATK_PROJECTION_FUTURE';
    if (options.nowMs-sourceTs > options.maxAgeMs) throw 'ATK_PROJECTION_STALE';
  }
  return Object.freeze({requestedAtMs,receivedAtMs,ageFromRequestStartMs:options.nowMs-requestedAtMs,
    freshness:sourceTs === null ? 'FRESHNESS_NOT_SOURCE_TIMESTAMP' : 'EXCHANGE_TIMESTAMP_CHECKED',sourceTimestampMs:sourceTs});
}
function exactArgs(args,expected) {if (canonical(args) !== canonical(expected)) throw 'ATK_PROJECTION_SCOPE';}
function one(opened) {if (opened.rows.length !== 1) throw 'ATK_PROJECTION_ROWS';return fields(opened.rows[0],null,null);}
const source = opened => ({binding:opened.binding,sourceObservationId:opened.sourceObservationId,sourcePayloadHash:opened.sourcePayloadHash});

/** Compare a fresh config observation to separately configured operator identity.
 * Never returns the UID or promotes supplied records to trusted capture evidence.
 */
export function compareDemoAccountIdentity(record,input) {
  try {
    const options=optionsFor(input,['accountExpectation']);
    const opened=open(record,{expectedTool:'account_get_config',expectedBinding:options.expectedBinding});
    const expected=copyAccountExpectation(options.accountExpectation,opened.binding.connectionHash,opened.binding.accountId);
    exactArgs(opened.context.args,{});
    const timing=fresh(opened,options),account=one(opened);
    if(account.uid!==expected.expectedUid)throw 'ATK_ACCOUNT_UID_MISMATCH';
    return report(true,'ATK_ACCOUNT_UID_MATCHED',{...source(opened),timing,uidMatchesExpectation:true});
  } catch(code) {return failed(code instanceof Error ? code.message : code);}
}

export function normalizeDemoInstrument(record,input) {
  try {
    const options = optionsFor(input);const opened = open(record,{expectedTool:'market_get_instruments',expectedBinding:options.expectedBinding});
    exactArgs(opened.context.args,{instType:'SPOT',instId:'AVAX-USDT',demo:true});const timing = fresh(opened,options);
    const row = one(opened);
    if (row.instId !== 'AVAX-USDT' || row.instType !== 'SPOT' || row.baseCcy !== 'AVAX' || row.quoteCcy !== 'USDT'
        || row.state !== 'live' || row.ruleType !== 'normal' || !groupId(row.groupId)) throw 'ATK_PROJECTION_INSTRUMENT';
    if (!Array.isArray(row.upcChg) || row.upcChg.length !== 0) throw 'ATK_PROJECTION_TRANSITION';
    const tick = decimal(row.tickSz,{positive:true});const lot = decimal(row.lotSz,{positive:true});
    const min = decimal(row.minSz,{positive:true});const max = decimal(row.maxLmtSz,{positive:true});
    const maxAmount = decimal(row.maxLmtAmt,{positive:true});
    if (min < lot || min%lot !== 0n || max < min) throw 'ATK_PROJECTION_INSTRUMENT';
    const instrument = Object.freeze({instId:'AVAX-USDT',instType:'SPOT',baseCcy:'AVAX',quoteCcy:'USDT',state:'live',
      tickSz:formatDecimal(tick),lotSz:formatDecimal(lot),minSz:formatDecimal(min),maxLmtSz:formatDecimal(max),
      maxLimitAmountUsd:formatDecimal(maxAmount),groupId:row.groupId});
    return report(true,'ATK_DEMO_INSTRUMENT_PROJECTED',{...source(opened),instrument,timing,
      usdNotionalLimitRequiresIndependentCheck:true});
  } catch (code) {return failed(code);}
}

export function normalizeDemoTicker(record,input) {
  try {
    const options = optionsFor(input);const opened = open(record,{expectedTool:'market_get_ticker',expectedBinding:options.expectedBinding});
    exactArgs(opened.context.args,{instId:'AVAX-USDT',demo:true});const row = one(opened);
    if (row.instId !== 'AVAX-USDT' || row.instType !== 'SPOT') throw 'ATK_PROJECTION_SCOPE';
    const ts = exchangeTime(row.ts);const timing = fresh(opened,options,ts);
    const ask = decimal(row.askPx,{positive:true});const askSize = decimal(row.askSz,{positive:true});
    return report(true,'ATK_DEMO_TICKER_PROJECTED',{...source(opened),
      ticker:Object.freeze({instId:'AVAX-USDT',referencePrice:formatDecimal(ask),reference:'BEST_ASK',askSize:formatDecimal(askSize),exchangeTimestampMs:ts}),timing});
  } catch (code) {return failed(code);}
}

/** Public informational market view. It is never an account snapshot or an
 * execution input; all three price fields and the exchange timestamp are required. */
export function normalizeReadOnlyMarketTicker(record,input) {
  try {
    const options=optionsFor(input);const opened=open(record,{expectedTool:'market_get_ticker',expectedBinding:options.expectedBinding});
    exactArgs(opened.context.args,{instId:'AVAX-USDT',demo:true});const row=one(opened);
    if(row.instId!=='AVAX-USDT' || row.instType!=='SPOT')throw 'ATK_PROJECTION_SCOPE';
    const ts=exchangeTime(row.ts),timing=fresh(opened,options,ts);
    const bid=decimal(row.bidPx,{positive:true}),ask=decimal(row.askPx,{positive:true});
    decimal(row.bidSz,{positive:true});decimal(row.askSz,{positive:true});
    const last=decimal(row.last,{positive:true});
    if(ask<bid)throw 'ATK_PROJECTION_DECIMAL';
    return report(true,'ATK_READONLY_MARKET_PROJECTED',{...source(opened),timing,
      market:Object.freeze({instrument:'AVAX-USDT',bid:formatDecimal(bid),ask:formatDecimal(ask),
        last:formatDecimal(last),spread:formatDecimal(ask-bid),exchangeTimestampMs:ts})});
  } catch(code) {return failed(code);}
}

const BALANCE_TOP = ['uTime','details','totalEq','isoEq','adjEq','availEq','ordFroz','imr','mmr','borrowFroz',
  'mgnRatio','notionalUsd','notionalUsdForSwap','notionalUsdForFutures','notionalUsdForOption','notionalUsdForBorrow','upl'];
const ASSET_REQUIRED = ['ccy','uTime','eq','cashBal','availBal','frozenBal','ordFrozen','liab','crossLiab','interest','borrowFroz',
  'fixedBal','stgyEq','spotIsoBal','smtSyncEq','spotCopyTradingEq'];
const ASSET_OPTIONAL = ['eqUsd','isoEq','availEq','disEq','upl','uplLiab','isoLiab','mgnRatio','twap','frpType','maxLoan',
  'notionalLever','isoUpl','spotInUseAmt','clSpotInUseAmt','maxSpotInUseAmt','maxSpotInUse','spotBal',
  'openAvgPx','accAvgPx','spotUpl','spotUplRatio','totalPnl','totalPnlRatio','collateralEnabled','imr','mmr'];
const INAPPLICABLE_SPOT = new Set(['isoEq','availEq','disEq','upl','uplLiab','isoLiab','mgnRatio','notionalLever',
  'isoUpl','spotInUseAmt','clSpotInUseAmt','maxSpotInUseAmt','maxSpotInUse','imr','mmr']);
const ZERO_ASSET = ['liab','crossLiab','interest','borrowFroz','fixedBal','stgyEq','spotIsoBal','smtSyncEq','spotCopyTradingEq'];

/** Restricted application cash policy, NOT a universal OKX balance equation. Both
 * AVAX/USDT rows must be present; omitted-zero inference is intentionally unsupported.
 * Missing required liabilities never become zero. Mode-inapplicable empty fields
 * remain tagged inapplicable, not numeric zero. Unknown financial fields veto.
 * uTime is last UPDATE, not request freshness: old idle balances are not rejected.
 */
export function normalizeDemoBalance(record,input) {
  try {
    const options = optionsFor(input,['accountConfigRecord']);
    const configured = open(options.accountConfigRecord,{expectedTool:'account_get_config',expectedBinding:options.expectedBinding});
    exactArgs(configured.context.args,{});const configTiming = fresh(configured,options);const account = one(configured);
    if (account.acctLv !== '1' || account.enableSpotBorrow !== false || account.autoLoan !== false
        || typeof account.spotBorrowAutoRepay !== 'boolean' || !['0','1'].includes(account.feeType)
        || typeof account.uid !== 'string' || account.uid.length > 64 || !/^[0-9]+$/.test(account.uid)) throw 'ATK_PROJECTION_BALANCE_POLICY';
    const opened = open(record,{expectedTool:'account_get_balance',expectedBinding:options.expectedBinding});
    exactArgs(opened.context.args,{});const timing = fresh(opened,options);
    if (Math.abs(configured.context.requestedAtMs-opened.context.requestedAtMs) > options.maxSkewMs
        || Math.abs(configured.context.receivedAtMs-opened.context.receivedAtMs) > options.maxSkewMs)
      throw 'ATK_PROJECTION_CLOCK';
    const row = fields(one(opened),BALANCE_TOP,['uTime','details','imr','mmr','borrowFroz','notionalUsd']);
    if (!Array.isArray(row.details) || row.details.length > 1000) throw 'ATK_PROJECTION_BALANCE_UNKNOWN';
    const accountUpdate = exchangeTime(row.uTime);
    if (accountUpdate > opened.context.receivedAtMs+options.maxSkewMs) throw 'ATK_PROJECTION_FUTURE';
    for (const key of ['imr','mmr','borrowFroz','notionalUsd'])
      if (decimal(row[key]) !== 0n) throw 'ATK_PROJECTION_BALANCE_LIABILITY';
    for (const key of ['isoEq','availEq','mgnRatio','notionalUsdForSwap','notionalUsdForFutures','notionalUsdForOption','upl']) {
      if (!Object.hasOwn(row,key) || row[key] === '') continue; // Known inapplicable fields are not converted to zero.
      if (decimal(row[key],{signed:true}) !== 0n) throw 'ATK_PROJECTION_BALANCE_POLICY';
    }
    for (const key of ['totalEq','adjEq','ordFroz']) if (Object.hasOwn(row,key)) decimal(row[key]);
    if (Object.hasOwn(row,'notionalUsdForBorrow') && decimal(row.notionalUsdForBorrow) !== 0n) throw 'ATK_PROJECTION_BALANCE_LIABILITY';
    const assets = Object.create(null);const seen = new Set();
    for (const supplied of row.details) {
      const detail = fields(supplied,[...ASSET_REQUIRED,...ASSET_OPTIONAL],ASSET_REQUIRED);
      if (typeof detail.ccy !== 'string' || detail.ccy.length > 16 || detail.ccy.trim() !== detail.ccy
          || !/^[A-Z0-9]+$/.test(detail.ccy) || seen.has(detail.ccy)) throw 'ATK_PROJECTION_BALANCE_ASSET';
      seen.add(detail.ccy);const updatedAt = exchangeTime(detail.uTime);
      if (updatedAt > opened.context.receivedAtMs+options.maxSkewMs || updatedAt > accountUpdate+options.maxSkewMs) throw 'ATK_PROJECTION_FUTURE';
      const cash = decimal(detail.cashBal);const available = decimal(detail.availBal);const frozen = decimal(detail.frozenBal);
      const equity = decimal(detail.eq);const orderFrozen = decimal(detail.ordFrozen);
      if (equity !== cash || available+frozen > cash || orderFrozen > frozen) throw 'ATK_PROJECTION_BALANCE_CONFLICT';
      for (const key of ZERO_ASSET) if (decimal(detail[key]) !== 0n) throw 'ATK_PROJECTION_BALANCE_LIABILITY';
      const inapplicable = [];
      for (const key of ASSET_OPTIONAL) {
        if (!Object.hasOwn(detail,key)) continue;
        if (INAPPLICABLE_SPOT.has(key)) {
          if (detail[key] === '') {inapplicable.push(key);continue;}
          if (decimal(detail[key],{signed:true}) !== 0n) throw 'ATK_PROJECTION_BALANCE_POLICY';
        } else if (['uplLiab','isoLiab'].includes(key)) {
          if (decimal(detail[key]) !== 0n) throw 'ATK_PROJECTION_BALANCE_LIABILITY';
        } else if (key === 'collateralEnabled') {
          throw 'ATK_PROJECTION_BALANCE_POLICY';
        } else if (key === 'frpType') {
          if (detail[key] !== '0') throw 'ATK_PROJECTION_BALANCE_POLICY';
        } else if (['twap','maxLoan'].includes(key)) {
          if (decimal(detail[key]) !== 0n) throw 'ATK_PROJECTION_BALANCE_LIABILITY';
        } else decimal(detail[key],{signed:['spotUpl','spotUplRatio','totalPnl','totalPnlRatio'].includes(key)});
      }
      if (!['AVAX','USDT'].includes(detail.ccy)) {
        if (cash !== 0n || equity !== 0n || available !== 0n || frozen !== 0n || orderFrozen !== 0n
            || (Object.hasOwn(detail,'eqUsd') && decimal(detail.eqUsd) !== 0n)) throw 'ATK_PROJECTION_BALANCE_ASSET';
        continue;
      }
      assets[detail.ccy] = Object.freeze({cash:formatDecimal(cash),available:formatDecimal(available),frozen:formatDecimal(frozen),
        orderFrozen:formatDecimal(orderFrozen),lastUpdateMs:updatedAt,inapplicableFields:Object.freeze(inapplicable)});
    }
    if (!Object.hasOwn(assets,'AVAX') || !Object.hasOwn(assets,'USDT')) throw 'ATK_PROJECTION_BALANCE_ASSET';
    return report(true,'ATK_DEMO_BALANCE_PROJECTED',{...source(opened),timing,
      balances:Object.freeze(assets),accountLastUpdateMs:accountUpdate,accountMode:'SPOT_BORROW_DISABLED',
      balancePolicy:'RESTRICTED_CASH_POLICY',feeType:account.feeType,
      configObservationId:configured.sourceObservationId,configPayloadHash:configured.sourcePayloadHash,configTiming});
  } catch (code) {return failed(code);}
}

export function normalizeDemoFeeRates(record,input) {
  try {
    const options = optionsFor(input,['instrumentRecord']);
    const instrumentProjection = normalizeDemoInstrument(options.instrumentRecord,{
      expectedBinding:options.expectedBinding,nowMs:options.nowMs,maxAgeMs:options.maxAgeMs,maxSkewMs:options.maxSkewMs});
    if (!instrumentProjection.ok) throw instrumentProjection.code;
    const opened = open(record,{expectedTool:'account_get_trade_fee',expectedBinding:options.expectedBinding});
    exactArgs(opened.context.args,{instType:'SPOT',instId:'AVAX-USDT'});const row = one(opened);
    if (row.instType !== 'SPOT' || !Array.isArray(row.feeGroup)) throw 'ATK_PROJECTION_FEE_GROUP';
    const timing = fresh(opened,options,exchangeTime(row.ts));const groups = new Set();let selected = null;
    if (Math.abs(instrumentProjection.timing.requestedAtMs-opened.context.requestedAtMs) > options.maxSkewMs
        || Math.abs(instrumentProjection.timing.receivedAtMs-opened.context.receivedAtMs) > options.maxSkewMs)
      throw 'ATK_PROJECTION_CLOCK';
    for (const candidate of row.feeGroup) {
      const group = fields(candidate,['groupId','maker','taker','rpiMaker','elpMaker'],['groupId','maker','taker']);
      if (!groupId(group.groupId) || groups.has(group.groupId)) throw 'ATK_PROJECTION_FEE_GROUP';
      groups.add(group.groupId);
      if (group.groupId === instrumentProjection.instrument.groupId) selected = group;
    }
    if (!selected) throw 'ATK_PROJECTION_FEE_GROUP';
    for (const key of ['rpiMaker','elpMaker']) if (Object.hasOwn(selected,key) && selected[key] !== '') throw 'ATK_PROJECTION_FEE_POLICY';
    const maker = decimal(selected.maker,{signed:true});const taker = decimal(selected.taker,{signed:true});
    if (maker > DECIMAL_SCALE || maker < -DECIMAL_SCALE || taker > DECIMAL_SCALE || taker < -DECIMAL_SCALE) throw 'ATK_PROJECTION_FEE_RATE';
    const worst = [0n,-maker,-taker].reduce((max,value) => value > max ? value : max,0n);
    return report(true,'ATK_DEMO_FEES_PROJECTED',{...source(opened),timing,
      instrumentObservationId:instrumentProjection.sourceObservationId,instrumentPayloadHash:instrumentProjection.sourcePayloadHash,
      fees:Object.freeze({instId:'AVAX-USDT',instType:'SPOT',groupId:selected.groupId,maker:formatDecimal(maker),taker:formatDecimal(taker),
        quoteFeeRateMax:formatDecimal(worst),baseFeeRateMax:formatDecimal(worst),rebatesExcludedFromBudget:true,
        rebateObserved:maker > 0n || taker > 0n,feeCurrencyResolved:false,settled:false})});
  } catch (code) {return failed(code);}
}

function failed(code) {return report(false,CODES.has(code) ? code : 'ATK_PROJECTION_FIELDS');}
function report(ok,code,extra = {}) {
  return Object.freeze({ok,code,verification:'SUPPLIED_JOURNALED_PROJECTION_ONLY',...extra,requiredBlockers:BLOCKERS,
    launchAllowed:false,readAuthorized:false,writeEnabled:false,routeVerified:false,actualAccountVerified:false});
}
