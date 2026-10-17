import {createHash} from 'node:crypto';

const CONTEXT_KEYS = ['schemaVersion','observationId','callId','connectionHash','catalogHash','isolatedEntrySha256',
  'sessionId','accountId','taskId','intentId','tool','args','requestedAtMs','receivedAtMs'];
const TOOLS = new Set(['market_get_ticker','market_get_orderbook','market_get_instruments','account_get_config',
  'account_get_balance','account_get_trade_fee','spot_get_order','spot_get_orders','spot_get_fills','spot_get_algo_orders',
  // Journal acceptance only; does not expand the SDK transport allowlist.
  'spot_place_order','spot_cancel_order']);
const PAYLOAD_BYTES = 1024*1024;
const RECORD_BYTES = PAYLOAD_BYTES + 32*1024;
const REDACTED = '[REDACTED]';
const SECRET_KEYS = new Set(['apikey','okxapikey','secret','secretkey','okxsecretkey','passphrase','okxpassphrase',
  'apisecret','apisecretkey','apipassphrase','privatekey','clientsecret','credential','credentials','auth','authentication',
  'password','token','accesstoken','refreshtoken','bearertoken','authorization','proxyauthorization','headers','httpheaders',
  'requestheaders','responseheaders','rawheaders','cookie','setcookie','signature','sign',
  'okaccesskey','okaccesssign','okaccesspassphrase','okaccesstimestamp']);
const TEXT_KEYS = new Set(['message','msg','suggestion','error','errormessage','stack','stacktrace','errorstack']);
const CODES = new Set(['ATK_OBSERVATION_FIELDS','ATK_OBSERVATION_CONTEXT','ATK_OBSERVATION_JSON',
  'ATK_OBSERVATION_LIMIT','ATK_OBSERVATION_RESULT','ATK_OBSERVATION_RECORD','ATK_OBSERVATION_HASH',
  'ATK_OBSERVATION_PERSIST_FAILED','ATK_OBSERVATION_RECEIPT','ATK_OBSERVATION_PROJECTION_DENIED',
  'ATK_OBSERVATION_PROJECTION_FAILED','ATK_OBSERVATION_SYNC_REQUIRED','ATK_OBSERVATION_REENTRANT']);
const BLOCKERS = Object.freeze(['SUPPLIED_RESULT_PROVENANCE_UNVERIFIED','DURABLE_SINK_CONTRACT_UNVERIFIED',
  'ATOMIC_PROJECTION_UNIMPLEMENTED','RUNTIME_AND_TARGET_UNVERIFIED']);
const NON_SYNC_FUNCTION_PROTOTYPES = new Set([Object.getPrototypeOf(async function() {}),
  Object.getPrototypeOf(function*() {}),Object.getPrototypeOf(async function*() {})]);

function fields(input,allowed,required = allowed,code = 'ATK_OBSERVATION_FIELDS') {
  if (!input || typeof input !== 'object' || Array.isArray(input)
      || ![Object.prototype,null].includes(Object.getPrototypeOf(input)) || Object.getOwnPropertySymbols(input).length) throw code;
  const names = Object.getOwnPropertyNames(input);
  if (names.length > 4096 || names.some(key => !allowed.includes(key)) || required.some(key => !names.includes(key))) throw code;
  const descriptors = Object.getOwnPropertyDescriptors(input);const result = Object.create(null);
  for (const name of names) {
    if (!Object.hasOwn(descriptors[name],'value')) throw code;
    result[name] = descriptors[name].value;
  }
  return result;
}
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '['+value.map(canonical).join(',')+']';
  return '{'+Object.keys(value).sort().map(key => JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}';
}
const hash = body => createHash('sha256').update(canonical(body),'utf8').digest('hex');
function boundedJson(input,maximum) {
  const state = {bytes:0,nodes:0};const active = new Set();
  const count = amount => {state.bytes += amount;if (state.bytes > maximum) throw 'ATK_OBSERVATION_LIMIT';};
  const copy = (value,depth) => {
    if (++state.nodes > 50000 || depth > 24) throw 'ATK_OBSERVATION_LIMIT';
    if (value === null) {count(4);return null;}
    if (typeof value === 'boolean') {count(value ? 4 : 5);return value;}
    if (typeof value === 'number' && Number.isFinite(value)) {
      const number = Object.is(value,-0) ? 0 : value;count(JSON.stringify(number).length);return number;
    }
    if (typeof value === 'string') {
      if (value.length > PAYLOAD_BYTES) throw 'ATK_OBSERVATION_LIMIT';
      count(Buffer.byteLength(JSON.stringify(value),'utf8'));return value;
    }
    if (!value || typeof value !== 'object' || active.has(value) || Object.getOwnPropertySymbols(value).length)
      throw 'ATK_OBSERVATION_JSON';
    active.add(value);
    try {
      const array = Array.isArray(value);
      if (array ? Object.getPrototypeOf(value) !== Array.prototype
        : ![Object.prototype,null].includes(Object.getPrototypeOf(value))) throw 'ATK_OBSERVATION_JSON';
      if (array) {
        const length = Object.getOwnPropertyDescriptor(value,'length')?.value;
        if (!Number.isSafeInteger(length) || length < 0) throw 'ATK_OBSERVATION_JSON';
        if (length > 50000) throw 'ATK_OBSERVATION_LIMIT';
      }
      const names = Object.getOwnPropertyNames(value);
      if (names.length > (array ? 50001 : 4096)) throw 'ATK_OBSERVATION_LIMIT';
      const descriptors = Object.getOwnPropertyDescriptors(value);
      if (array) {
        const length = descriptors.length.value;
        if (names.length !== length+1 || names.some(key => key !== 'length'
            && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length))) throw 'ATK_OBSERVATION_JSON';
        count(2+Math.max(0,length-1));const result = [];
        for (let index=0;index<length;index++) {
          if (!descriptors[index] || !Object.hasOwn(descriptors[index],'value')) throw 'ATK_OBSERVATION_JSON';
          result.push(copy(descriptors[index].value,depth+1));
        }
        return Object.freeze(result);
      }
      names.sort();count(2+names.length+Math.max(0,names.length-1));const result = Object.create(null);
      for (const key of names) {
        if (key.length > 512) throw 'ATK_OBSERVATION_LIMIT';
        count(Buffer.byteLength(JSON.stringify(key),'utf8'));
        if (!Object.hasOwn(descriptors[key],'value')) throw 'ATK_OBSERVATION_JSON';
        result[key] = copy(descriptors[key].value,depth+1);
      }
      return Object.freeze(result);
    } finally {active.delete(value);}
  };
  return copy(input,0);
}

// Known names only: never redact a generic financial field merely called "key".
// Arbitrary strings/PII or credentials embedded under unknown financial names cannot
// be identified by this rule. A later parser/privacy policy remains a separate gate.
function sanitize(value,state,validateOnly = false) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return Object.freeze(value.map(item => sanitize(item,state,validateOnly)));
  const result = Object.create(null);
  for (const key of Object.keys(value)) {
    const normalized = key.replace(/[-_.\s]/g,'').toLowerCase();
    if (SECRET_KEYS.has(normalized) || (TEXT_KEYS.has(normalized) && typeof value[key] === 'string')) {
      if (validateOnly && value[key] !== REDACTED) throw 'ATK_OBSERVATION_RECORD';
      result[key] = REDACTED;state.redacted = true;
    } else result[key] = sanitize(value[key],state,validateOnly);
  }
  return Object.freeze(result);
}
const token = value => typeof value === 'string' && value.length <= 128 && value.trim() === value && /^[A-Za-z0-9_-]+$/.test(value);
const hex = value => typeof value === 'string' && value.length === 64 && /^[a-f0-9]{64}$/.test(value);
function contextCopy(input,state,validateOnly = false) {
  const context = fields(input,CONTEXT_KEYS);
  if (context.schemaVersion !== 1) throw 'ATK_OBSERVATION_CONTEXT';
  for (const key of ['observationId','callId','sessionId','accountId']) if (!token(context[key])) throw 'ATK_OBSERVATION_CONTEXT';
  for (const key of ['connectionHash','catalogHash','isolatedEntrySha256']) if (!hex(context[key])) throw 'ATK_OBSERVATION_CONTEXT';
  if ((context.taskId !== null && !token(context.taskId)) || (context.intentId !== null && !token(context.intentId))
      || (context.taskId === null && context.intentId !== null) || !TOOLS.has(context.tool)
      || !Number.isSafeInteger(context.requestedAtMs) || context.requestedAtMs < 0
      || !Number.isSafeInteger(context.receivedAtMs) || context.receivedAtMs < context.requestedAtMs) throw 'ATK_OBSERVATION_CONTEXT';
  const args = boundedJson(context.args,16*1024);
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw 'ATK_OBSERVATION_CONTEXT';
  context.args = sanitize(args,state,validateOnly);
  return Object.freeze(context);
}

function payloadFromRaw(input,state) {
  const raw = boundedJson(input,PAYLOAD_BYTES);
  const values = fields(raw,['content','structuredContent','isError'],[],'ATK_OBSERVATION_RESULT');
  if ((!Object.hasOwn(values,'content') && !Object.hasOwn(values,'structuredContent'))
      || (Object.hasOwn(values,'isError') && typeof values.isError !== 'boolean')) throw 'ATK_OBSERVATION_RESULT';
  const payload = Object.create(null);
  if (Object.hasOwn(values,'content')) {
    if (!Array.isArray(values.content)) throw 'ATK_OBSERVATION_RESULT';
    payload.content = Object.freeze(values.content.map(block => {
      if (!block || typeof block !== 'object' || Array.isArray(block)) throw 'ATK_OBSERVATION_RESULT';
      if (block.type !== 'text' || typeof block.text !== 'string'
          || Object.keys(block).length !== 2) {
        state.redacted = true;return Object.freeze({type:'omitted',reason:'UNSUPPORTED_CONTENT'});
      }
      let parsed;
      try {parsed = JSON.parse(block.text);} catch {
        state.redacted = true;return Object.freeze({type:'omitted',reason:'NON_JSON_TEXT'});
      }
      return Object.freeze({type:'json',data:sanitize(boundedJson(parsed,PAYLOAD_BYTES),state)});
    }));
  }
  if (Object.hasOwn(values,'structuredContent')) payload.structuredContent = sanitize(values.structuredContent,state);
  if (Object.hasOwn(values,'isError')) payload.isError = values.isError;
  // Bound the combined normalized page after deliberate redaction replacements.
  return boundedJson(payload,PAYLOAD_BYTES);
}

function checkedPayload(input,state) {
  const payload = fields(boundedJson(input,PAYLOAD_BYTES),['content','structuredContent','isError'],[],'ATK_OBSERVATION_RECORD');
  if ((!Object.hasOwn(payload,'content') && !Object.hasOwn(payload,'structuredContent'))
      || (Object.hasOwn(payload,'isError') && typeof payload.isError !== 'boolean')) throw 'ATK_OBSERVATION_RECORD';
  if (Object.hasOwn(payload,'content')) {
    if (!Array.isArray(payload.content)) throw 'ATK_OBSERVATION_RECORD';
    for (const block of payload.content) {
      if (block?.type === 'json') {
        fields(block,['type','data'],undefined,'ATK_OBSERVATION_RECORD');
        sanitize(block.data,state,true);
      } else {
        const omitted = fields(block,['type','reason'],undefined,'ATK_OBSERVATION_RECORD');
        if (omitted.type !== 'omitted' || !['NON_JSON_TEXT','UNSUPPORTED_CONTENT'].includes(omitted.reason)) throw 'ATK_OBSERVATION_RECORD';
        state.redacted = true;
      }
    }
  }
  if (Object.hasOwn(payload,'structuredContent')) sanitize(payload.structuredContent,state,true);
  return Object.freeze(payload);
}
function projectable(payload,state) {
  return !state.redacted && payload.isError !== true && (Object.hasOwn(payload,'structuredContent')
    || Boolean(payload.content?.some(block => block.type === 'json')));
}
function recordBody(context,payload,state) {
  return Object.freeze({schemaVersion:1,source:'SANITIZED_MCP_TOOL_RESULT',context,payload,
    redacted:state.redacted,projectable:projectable(payload,state)});
}

/** Sanitize and bind the entire bounded tool-result page, not economic rows. This
 * is a supplied MCP result snapshot, NOT raw HTTP/header/wire capture or provenance.
 * Non-JSON text is omitted with a marker; known secret/header and free-text fields
 * are redacted. No truncation, row filtering, normalization or authorization here.
 */
export function prepareATKObservation(context,rawResult) {
  try {
    const state = {redacted:false};const copiedContext = contextCopy(context,state);
    const payload = payloadFromRaw(rawResult,state);const body = recordBody(copiedContext,payload,state);
    const payloadHash = hash(body);
    const record = Object.freeze({...body,payloadHash});
    if (Buffer.byteLength(canonical(record),'utf8') > RECORD_BYTES) throw 'ATK_OBSERVATION_LIMIT';
    return report(true,'ATK_OBSERVATION_PREPARED',{record,payloadHash});
  } catch (code) {return failed(code);}
}

/** Independently checks detached sanitized record shape, flags and whole-envelope
 * hash. Hash consistency is not authenticity. A store must call this before writing.
 */
export function validateATKObservationRecord(input) {
  try {
    const value = fields(input,['schemaVersion','source','context','payload','redacted','projectable','payloadHash'],undefined,'ATK_OBSERVATION_RECORD');
    if (value.schemaVersion !== 1 || value.source !== 'SANITIZED_MCP_TOOL_RESULT' || !hex(value.payloadHash)
        || typeof value.redacted !== 'boolean' || typeof value.projectable !== 'boolean') throw 'ATK_OBSERVATION_RECORD';
    const state = {redacted:false};const context = contextCopy(value.context,state,true);
    const payload = checkedPayload(value.payload,state);const body = recordBody(context,payload,state);
    if (value.redacted !== body.redacted || value.projectable !== body.projectable) throw 'ATK_OBSERVATION_RECORD';
    const payloadHash = hash(body);
    if (payloadHash !== value.payloadHash) throw 'ATK_OBSERVATION_HASH';
    const record = Object.freeze({...body,payloadHash});
    if (Buffer.byteLength(canonical(record),'utf8') > RECORD_BYTES) throw 'ATK_OBSERVATION_LIMIT';
    return report(true,'ATK_OBSERVATION_RECORD_VALID',{record,payloadHash});
  } catch (code) {return failed(code);}
}

function thenable(value) {
  if (!value || !['object','function'].includes(typeof value)) return false;
  let current = value;
  for (let depth=0;current && depth<16;depth++,current=Object.getPrototypeOf(current)) {
    const descriptor = Object.getOwnPropertyDescriptor(current,'then');
    if (descriptor) return !Object.hasOwn(descriptor,'value') || typeof descriptor.value === 'function';
  }
  if (current) throw 'ATK_OBSERVATION_SYNC_REQUIRED';
  return false;
}

/** Source-only coordinator, not connected to ReadOnlyATK. Trusted synchronous sink
 * must actually durably persist BEFORE returning the exact PENDING receipt. A fake
 * receipt cannot establish durability. Latch is local to this instance, not restart
 * safety. Callbacks are trusted internal code, must not perform network or ledger
 * commits; this is not an execution sandbox. A thenable check cannot undo callback
 * side effects. Projection never marks APPLIED; later atomic consume must do that.
 */
export class ATKObservationJournal {
  #persist;#blocked = false;#busy = false;
  constructor(input) {
    const {persist} = fields(input,['persist']);
    if (typeof persist !== 'function' || NON_SYNC_FUNCTION_PROTOTYPES.has(Object.getPrototypeOf(persist)))
      throw new TypeError('ATK_OBSERVATION_PERSIST_REQUIRED');
    this.#persist = persist;
  }
  get blocked() {return this.#blocked;}
  captureAndProject(context,rawResult,project) {
    if (this.#blocked) return report(false,'ATK_OBSERVATION_JOURNAL_BLOCKED');
    if (this.#busy) {this.#blocked = true;return report(false,'ATK_OBSERVATION_REENTRANT');}
    this.#busy = true;let metadata = {captureStatus:'NOT_ATTEMPTED'};
    try {
      const prepared = prepareATKObservation(context,rawResult);
      if (!prepared.ok) throw prepared.code;
      const {record,payloadHash} = prepared;
      metadata = {observationId:record.context.observationId,payloadHash,captureStatus:'NOT_ATTEMPTED'};
      let receipt;
      metadata.captureStatus = 'UNKNOWN';
      try {receipt = this.#persist(record);} catch {throw 'ATK_OBSERVATION_PERSIST_FAILED';}
      if (thenable(receipt)) throw 'ATK_OBSERVATION_SYNC_REQUIRED';
      const values = fields(receipt,['observationId','payloadHash','status','duplicate'],undefined,'ATK_OBSERVATION_RECEIPT');
      if (values.observationId !== metadata.observationId || values.payloadHash !== payloadHash || values.status !== 'PENDING'
          || typeof values.duplicate !== 'boolean') throw 'ATK_OBSERVATION_RECEIPT';
      metadata = {...metadata,status:'PENDING',captureStatus:'CAPTURED_PENDING',duplicate:values.duplicate};
      if (this.#blocked) throw 'ATK_OBSERVATION_REENTRANT';
      if (!record.projectable) throw 'ATK_OBSERVATION_PROJECTION_DENIED';
      if (values.duplicate) return report(true,'ATK_OBSERVATION_DUPLICATE_PENDING',{...metadata,duplicate:true});
      if (typeof project !== 'function' || NON_SYNC_FUNCTION_PROTOTYPES.has(Object.getPrototypeOf(project))) throw 'ATK_OBSERVATION_SYNC_REQUIRED';
      let projected;
      try {projected = project(record);} catch {throw 'ATK_OBSERVATION_PROJECTION_FAILED';}
      if (thenable(projected)) throw 'ATK_OBSERVATION_SYNC_REQUIRED';
      if (this.#blocked) throw 'ATK_OBSERVATION_REENTRANT';
      return report(true,'ATK_OBSERVATION_PENDING',{...metadata,duplicate:false,projected});
    } catch (code) {
      this.#blocked = true;return failed(code,metadata);
    } finally {this.#busy = false;}
  }
}
function failed(code,metadata = {}) {return report(false,CODES.has(code) ? code : 'ATK_OBSERVATION_JSON',metadata);}
function report(ok,code,extra = {}) {
  return Object.freeze({ok,code,verification:'SUPPLIED_SANITIZED_OBSERVATION_ONLY',...extra,requiredBlockers:BLOCKERS,
    launchAllowed:false,readAuthorized:false,writeEnabled:false,routeVerified:false,actualAccountVerified:false});
}
