import {validateATKObservationRecord} from './atk-observation-journal.mjs';
import {openATKObservation} from './atk-market-account.mjs';

const BINDING_KEYS = ['connectionHash','catalogHash','isolatedEntrySha256','sessionId','accountId'];
const KINDS = ['SPOT_OPEN_ORDERS','SPOT_ORDER_HISTORY','SPOT_FILLS','OWNED_INTENT_FILLS'];
const DAY = 24*60*60*1000;
const ROW_BYTES = 4*1024*1024;
const numericId = value => typeof value === 'string' && value.trim() === value && /^[1-9][0-9]{0,63}$/.test(value);
const timestamp = value => Number.isSafeInteger(value) && value >= 0;
function fields(value,allowed,required=allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype,null].includes(Object.getPrototypeOf(value)) || Object.getOwnPropertySymbols(value).length)
    throw new TypeError('ATK_HISTORY_CONFIG');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(descriptors).some(key => !allowed.includes(key) || !Object.hasOwn(descriptors[key],'value'))
      || required.some(key => !Object.hasOwn(descriptors,key))) throw new TypeError('ATK_HISTORY_CONFIG');
  return Object.fromEntries(Object.entries(descriptors).map(([key,item]) => [key,item.value]));
}
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '['+value.map(canonical).join(',')+']';
  return '{'+Object.keys(value).sort().map(key => JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}';
}
function config(input) {
  const c = fields(input,['kind','binding','nowMs','beginMs','endMs','pageSize','maxPages','knownOrderId'],
    ['kind','binding','nowMs','pageSize','maxPages']);
  if (!KINDS.includes(c.kind) || !timestamp(c.nowMs) || !Number.isSafeInteger(c.pageSize)
      || c.pageSize < 1 || c.pageSize > 100 || !Number.isSafeInteger(c.maxPages)
      || c.maxPages < 1 || c.maxPages > 100) throw new TypeError('ATK_HISTORY_CONFIG');
  const binding = fields(c.binding,BINDING_KEYS);
  for (const key of BINDING_KEYS) {
    const regex = key.endsWith('Hash') || key === 'isolatedEntrySha256' ? /^[a-f0-9]{64}$/ : /^[A-Za-z0-9_-]{1,128}$/;
    if (typeof binding[key] !== 'string' || binding[key].trim() !== binding[key] || !regex.test(binding[key])) throw new TypeError('ATK_HISTORY_CONFIG');
  }
  if (c.kind === 'SPOT_OPEN_ORDERS') {
    if (c.beginMs !== undefined || c.endMs !== undefined) throw new TypeError('ATK_HISTORY_CONFIG');
  } else if (!timestamp(c.beginMs) || !timestamp(c.endMs) || c.beginMs >= c.endMs
      || c.endMs > c.nowMs || c.beginMs < Math.max(0,c.nowMs-DAY)) {
    // Application restriction: recent 24h only. This is NOT endpoint retention proof.
    throw new TypeError('ATK_HISTORY_INTERVAL_UNSUPPORTED');
  }
  if (c.kind === 'OWNED_INTENT_FILLS' ? !numericId(c.knownOrderId) : c.knownOrderId !== undefined)
    throw new TypeError('ATK_HISTORY_CONFIG');
  return Object.freeze({...c,binding:Object.freeze(binding)});
}

/** Source-only bounded collector. Supplied records must already be journalled.
 * No transport, clock, SDK import, economic projection, ledger commit or resume.
 * SDK 1.4.8 hardcodes SPOT on BOTH tools; this is never whole-account coverage.
 * Private state prevents a caller-provided completion flag becoming evidence.
 */
export class ATKHistoryScan {
  #config;#cursor=null;#pages=0;#blocked=null;#exhausted=false;
  #rows=new Map();#references=[];#referenceKeys=new Set();#observationHashes=new Map();#bytes=0;
  constructor(input) {this.#config=config(input);}
  request() {
    if (this.#blocked || this.#exhausted) return null;
    const c=this.#config, orders=c.kind.startsWith('SPOT_OPEN') || c.kind === 'SPOT_ORDER_HISTORY';
    const args={...(orders ? {status:c.kind === 'SPOT_OPEN_ORDERS' ? 'open' : 'history'} : {archive:false}),
      ...(c.kind === 'OWNED_INTENT_FILLS' ? {instId:'AVAX-USDT',ordId:c.knownOrderId} : {}),
      ...(c.kind === 'SPOT_OPEN_ORDERS' ? {} : {begin:String(c.beginMs),end:String(c.endMs)}),
      limit:c.pageSize,...(this.#cursor ? {after:this.#cursor} : {})};
    const path=orders ? c.kind === 'SPOT_OPEN_ORDERS' ? 'orders-pending' : 'orders-history' : 'fills';
    return Object.freeze({tool:orders ? 'spot_get_orders' : 'spot_get_fills',
      args:Object.freeze(args),endpoint:'GET /api/v5/trade/'+path});
  }
  #failure(code) {this.#blocked=code;return this.#report(false,code);}
  append(input) {
    if (this.#blocked || this.#exhausted) return this.#report(false,'ATK_HISTORY_SCAN_CLOSED');
    // Validate before reading any supplied getters. Retain the verified journal
    // reference even if binding/query/rows fail; never consume its economic rows.
    const checked=validateATKObservationRecord(input);
    if (!checked.ok) return this.#failure(checked.code);
    const record=checked.record, reference={sourceObservationId:record.context.observationId,
      sourcePayloadHash:record.payloadHash};
    const referenceKey=reference.sourceObservationId+':'+reference.sourcePayloadHash;
    if (!this.#referenceKeys.has(referenceKey)) {
      this.#referenceKeys.add(referenceKey);this.#references.push(Object.freeze(reference));
    }
    const previousHash=this.#observationHashes.get(reference.sourceObservationId);
    if (previousHash && previousHash !== reference.sourcePayloadHash)
      return this.#failure('ATK_HISTORY_OBSERVATION_CONFLICT');
    this.#observationHashes.set(reference.sourceObservationId,reference.sourcePayloadHash);
    const expected=this.request();
    const opened=openATKObservation(record,{expectedTool:expected.tool,expectedBinding:this.#config.binding});
    if (!opened.ok) return this.#failure(opened.code);
    if (opened.endpoint !== expected.endpoint || canonical(opened.context.args) !== canonical(expected.args))
      return this.#failure('ATK_HISTORY_QUERY_MISMATCH');
    const rows=opened.rows;
    if (!Array.isArray(rows) || rows.length > this.#config.pageSize) return this.#failure('ATK_HISTORY_PAGE_LIMIT');
    const orders=expected.tool === 'spot_get_orders', idKey=orders ? 'ordId' : 'billId';
    const additions=new Map();let last=null,newCount=0,bytes=0;
    for (const row of rows) {
      const id=row?.[idKey];
      if (!numericId(id) || row.instType !== 'SPOT' || typeof row.instId !== 'string' || !row.instId)
        return this.#failure('ATK_HISTORY_ROW_IDENTITY');
      if (this.#config.kind === 'OWNED_INTENT_FILLS'
          && (row.ordId !== this.#config.knownOrderId || row.instId !== 'AVAX-USDT'))
        return this.#failure('ATK_HISTORY_ROW_IDENTITY');
      if (last !== null && BigInt(id) >= BigInt(last)) return this.#failure('ATK_HISTORY_PAGE_ORDER');
      last=id;
      const body=canonical(row),previous=this.#rows.get(id);
      if (previous && previous.body !== body) return this.#failure('ATK_HISTORY_ROW_CONFLICT');
      if (this.#cursor && BigInt(id) >= BigInt(this.#cursor) && !previous)
        return this.#failure('ATK_HISTORY_CURSOR');
      if (!previous) {
        additions.set(id,{row,body});newCount++;bytes+=Buffer.byteLength(body,'utf8');
      }
    }
    if (rows.length && (!newCount || this.#cursor && BigInt(last) >= BigInt(this.#cursor)))
      return this.#failure('ATK_HISTORY_NO_PROGRESS');
    if (this.#bytes+bytes > ROW_BYTES) return this.#failure('ATK_HISTORY_ROW_LIMIT');
    // Commit the entire validated page atomically to this in-memory source scan.
    for (const [id,value] of additions) this.#rows.set(id,value);
    this.#bytes+=bytes;this.#pages++;
    if (rows.length === 0) this.#exhausted=true;
    else this.#cursor=last;
    if (!this.#exhausted && this.#pages >= this.#config.maxPages) return this.#failure('ATK_HISTORY_MAX_PAGES');
    return this.#report(true,this.#exhausted ? 'ATK_HISTORY_EXHAUSTED' : 'ATK_HISTORY_PAGE_ACCEPTED');
  }
  view() {return this.#report(!this.#blocked,this.#blocked ?? 'ATK_HISTORY_SCAN');}
  #report(ok,code) {
    const c=this.#config;
    return Object.freeze({ok,code,kind:c.kind,binding:c.binding,
      interval:c.kind === 'SPOT_OPEN_ORDERS' ? null : Object.freeze({beginMs:c.beginMs,endMs:c.endMs,nowMs:c.nowMs}),
      pages:this.#pages,cursor:this.#cursor,blocked:Boolean(this.#blocked),exhausted:this.#exhausted,
      scanExhausted:this.#exhausted,intervalCoverageVerified:false,
      // Exhaustion proves traversal of the supplied endpoint query only. Pending
      // orders can mutate while paging; history has endpoint retention exclusions.
      scopeComplete:false,
      scope:'SUPPLIED_SPOT_ENDPOINT_QUERY_ONLY',consistencyUnverified:true,
      complete:false,economicComplete:false,accountComplete:false,fillsComplete:false,feesComplete:false,
      rows:Object.freeze([...this.#rows.values()].map(value => value.row)),
      references:Object.freeze([...this.#references]),nextRequest:this.request(),
      launchAllowed:false,readAuthorized:false,writeEnabled:false,routeVerified:false,actualAccountVerified:false});
  }
}
export const createHistoryScan = input => new ATKHistoryScan(input);
export function appendHistoryPage(scan,record) {
  if (!(scan instanceof ATKHistoryScan)) throw new TypeError('ATK_HISTORY_SCAN_REQUIRED');
  return scan.append(record);
}
