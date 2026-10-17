import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { TextDecoder } from 'node:util';
import {createHash,randomUUID} from 'node:crypto';
import {open,lstat} from 'node:fs/promises';
import { atkEnvironment } from './atk-environment.mjs';
import {inspectATKCatalog} from './atk-catalog-fingerprint.mjs';
import {verifyDemoConnectionManifest} from './demo-connection-manifest.mjs';
import {prepareATKObservation} from './atk-observation-journal.mjs';
import {IsolatedATKLaunch} from './atk-isolated-launch.mjs';
import {copyAccountExpectation} from './atk-account-expectation.mjs';
import {compareDemoAccountIdentity} from './atk-market-account.mjs';
import {hashCanonical} from '../domain/governor.mjs';
import {planDemoSafety} from '../domain/demo-safety.mjs';

// Operator-owned configuration only. Never populate executable paths/profile from HTTP input.
// MCP stdio: https://modelcontextprotocol.io/specification/2025-06-18/basic/transports
const MAX_FRAME = 1024 * 1024;
const MAX_TOOLS = 512;
const MAX_CATALOG_BYTES = 4 * MAX_FRAME;
const NAME = /^[a-z][a-z0-9_]{0,127}$/;
const VERSIONS = new Set(['2025-06-18', '2024-11-05', '2025-03-26', '2025-11-25']);
const READ_TOOLS = new Set([
  'market_get_ticker', 'market_get_orderbook', 'market_get_instruments',
  'account_get_config', 'account_get_balance', 'account_get_trade_fee',
  'spot_get_order', 'spot_get_orders', 'spot_get_fills', 'spot_get_algo_orders',
]);
const PREFIX = /^(?:market|account|spot)_get_/;
const DEMO_MARKET_TOOLS = new Set(['market_get_ticker','market_get_orderbook','market_get_instruments']);
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const SCHEMA_KEYS = new Set([
  '$schema', 'title', 'description', 'default', 'examples', 'deprecated',
  'type', 'properties', 'required', 'additionalProperties', 'enum', 'const',
  'items', 'minItems', 'maxItems', 'uniqueItems',
  'minLength', 'maxLength', 'pattern', 'minimum', 'maximum',
  'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
  'allOf', 'anyOf', 'oneOf', 'not',
]);

function error(code) {
  const result = new Error(code);
  result.code = code;
  return result;
}
function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function copy(value) {
  return JSON.parse(JSON.stringify(value));
}

// Observe bytes before launch; this is not a proof of dependency/OS isolation.
// Bounded descriptor read avoids loading an arbitrary-sized entry into memory.
async function entryDigest(path) {
  const link=await lstat(path);
  if(!link.isFile() || link.isSymbolicLink())throw error('ATK_ENTRY_INVALID');
  const file=await open(path,'r');
  try {
    const before=await file.stat();
    if(!before.isFile() || before.size<1 || before.size>32*1024*1024
        || before.ino!==link.ino || before.dev!==link.dev)throw error('ATK_ENTRY_INVALID');
    const hash=createHash('sha256'),buffer=Buffer.alloc(65536);let total=0;
    while(true) {
      const {bytesRead}=await file.read(buffer,0,buffer.length,null);
      if(!bytesRead)break;
      total+=bytesRead;if(total>32*1024*1024)throw error('ATK_ENTRY_INVALID');
      hash.update(buffer.subarray(0,bytesRead));
    }
    const after=await file.stat();
    if(total!==before.size || after.size!==before.size || after.mtimeMs!==before.mtimeMs
        || after.ctimeMs!==before.ctimeMs)throw error('ATK_ENTRY_CHANGED');
    return hash.digest('hex');
  } finally {await file.close();}
}

// Reject accessors, cycles, custom objects and non-JSON input before serialization.
function jsonInput(value, depth = 0, seen = new Set(), budget = { nodes: 0 }) {
  if (depth > 20 || ++budget.nodes > 10000) throw error('ATK_ARGUMENT_LIMIT');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object' || seen.has(value)) throw error('ATK_ARGUMENT_NOT_JSON');
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    throw error('ATK_ARGUMENT_NOT_JSON');
  }
  seen.add(value);
  const output = Array.isArray(value) ? [] : Object.create(null);
  if (Object.getOwnPropertySymbols(value).length) throw error('ATK_ARGUMENT_NOT_JSON');
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw error('ATK_ARGUMENT_NOT_JSON');
      output.push(jsonInput(descriptor.value, depth + 1, seen, budget));
    }
    if (Object.keys(value).length !== value.length) throw error('ATK_ARGUMENT_NOT_JSON');
  } else {
    for (const key of Object.keys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (FORBIDDEN_KEYS.has(key) || !Object.hasOwn(descriptor, 'value')) {
        throw error('ATK_ARGUMENT_NOT_JSON');
      }
      output[key] = jsonInput(descriptor.value, depth + 1, seen, budget);
    }
  }
  seen.delete(value);
  return output;
}
function equal(left, right) {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => equal(item, right[index]));
  }
  if (!object(left) || !object(right)) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) && equal(left[key], right[key]));
}
function typeMatches(value, type) {
  switch (type) {
    case 'object': return object(value);
    case 'array': return Array.isArray(value);
    case 'null': return value === null;
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'string': return typeof value === 'string';
    case 'boolean': return typeof value === 'boolean';
    default: throw error('ATK_SCHEMA_UNSUPPORTED');
  }
}

// Small fail-closed JSON Schema subset. Unknown constraints/$ref never silently pass.
function validate(value, schema, depth = 0) {
  if (depth > 20) throw error('ATK_SCHEMA_LIMIT');
  if (schema === true) return true;
  if (schema === false) return false;
  if (!object(schema) || Object.keys(schema).some(key => !SCHEMA_KEYS.has(key))) {
    throw error('ATK_SCHEMA_UNSUPPORTED');
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.length || !types.some(type => typeMatches(value, type))) return false;
  }
  if (schema.enum !== undefined) {
    if (!Array.isArray(schema.enum)) throw error('ATK_SCHEMA_UNSUPPORTED');
    if (!schema.enum.some(item => equal(item, value))) return false;
  }
  if (Object.hasOwn(schema, 'const') && !equal(value, schema.const)) return false;
  for (const keyword of ['allOf', 'anyOf', 'oneOf']) {
    if (schema[keyword] === undefined) continue;
    if (!Array.isArray(schema[keyword]) || !schema[keyword].length || schema[keyword].length > 32) {
      throw error('ATK_SCHEMA_UNSUPPORTED');
    }
    const matches = schema[keyword].map(part => validate(value, part, depth + 1));
    if (keyword === 'allOf' && matches.some(match => !match)) return false;
    if (keyword === 'anyOf' && !matches.some(Boolean)) return false;
    if (keyword === 'oneOf' && matches.filter(Boolean).length !== 1) return false;
  }
  if (schema.not !== undefined && validate(value, schema.not, depth + 1)) return false;
  if (object(value)) {
    if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some(key => typeof key !== 'string'))) {
      throw error('ATK_SCHEMA_UNSUPPORTED');
    }
    if (schema.required?.some(key => !Object.hasOwn(value, key))) return false;
    if (schema.properties !== undefined && !object(schema.properties)) throw error('ATK_SCHEMA_UNSUPPORTED');
    const properties = schema.properties ?? {};
    for (const [key, item] of Object.entries(value)) {
      if (Object.hasOwn(properties, key)) {
        if (!validate(item, properties[key], depth + 1)) return false;
      } else if (schema.additionalProperties === false) return false;
      else if (schema.additionalProperties !== undefined && schema.additionalProperties !== true) {
        if (!validate(item, schema.additionalProperties, depth + 1)) return false;
      }
    }
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) return false;
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return false;
    if (schema.items !== undefined && value.some(item => !validate(item, schema.items, depth + 1))) return false;
    if (schema.uniqueItems === true && value.some((item, index) => value.slice(0, index).some(other => equal(item, other)))) return false;
  }
  if (typeof value === 'string') {
    const length = [...value].length;
    if (schema.minLength !== undefined && length < schema.minLength) return false;
    if (schema.maxLength !== undefined && length > schema.maxLength) return false;
    // Regex evaluation is deliberately not supported: an advertised pattern can be pathological.
    if (schema.pattern !== undefined) throw error('ATK_SCHEMA_PATTERN_UNSUPPORTED');
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) return false;
    if (schema.maximum !== undefined && value > schema.maximum) return false;
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) return false;
    if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) return false;
    if (schema.multipleOf !== undefined) throw error('ATK_SCHEMA_MULTIPLE_OF_UNSUPPORTED');
  }
  return true;
}

/** Read-only by default. The optional pinned isolated execution mode exposes
 * only dedicated durable-submit/cancel methods; callReadTool stays read-only.
 * All returned server/tool content is untrusted data, never instructions. */
export class ReadOnlyATK {
  #config;
  #child = null;
  #pending = new Map();
  #nextId = 1;
  #buffer = Buffer.alloc(0);
  #state = 'idle';
  #connection = null;
  #catalog = [];
  #advertised = new Map();
  #stale = false;
  #closing = null;
  #entryHash=null;
  #protocolVersion=null;
  #sessionId=randomUUID();
  #journal=null;
  #isolatedLaunch=null;
  #launchDescription=null;
  #execution=false;
  #manifest=null;
  #identityObservationId=null;
  #deliveryClaims=new Set();

  constructor({ nodePath, entryPath, profile = 'demo', timeoutMs = 15000, isolated=null, execution=false } = {}) {
    if(typeof execution!=='boolean' || execution && !isolated)throw error('ATK_EXECUTION_REQUIRES_ISOLATION');
    this.#execution=execution;
    for (const path of [nodePath, entryPath]) {
      if (typeof path !== 'string' || !isAbsolute(path) || /[\0\r\n]/.test(path)) {
        throw error('ATK_OPERATOR_PATH_REQUIRED');
      }
    }
    if (typeof profile !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(profile)) throw error('ATK_PROFILE_INVALID');
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120000) throw error('ATK_TIMEOUT_INVALID');
    this.#config = Object.freeze({ nodePath, entryPath, profile, timeoutMs });
    if(isolated!==null) {
      if(!isolated || !verifyDemoConnectionManifest(isolated.manifest) || isolated.manifest.config.profile!==profile)
        throw error('ATK_ISOLATED_LAUNCH_DENIED');
      this.#isolatedLaunch=new IsolatedATKLaunch({manifest:isolated.manifest,upstreamEntryPath:isolated.upstreamEntryPath,
        derivedEntryPath:entryPath,credentials:isolated.credentials,osEnvironment:isolated.osEnvironment,execution,bootstrapEntryPath:isolated.bootstrapEntryPath});
      this.#manifest=copy(isolated.manifest);
    }
  }

  connect() {
    if (this.#state === 'closed') return Promise.reject(error('ATK_CLOSED'));
    if (this.#connection) return this.#connection;
    if (this.#state !== 'idle') return Promise.reject(error('ATK_CLOSED'));
    this.#state = 'connecting';
    this.#connection = this.#initialize();
    return this.#connection;
  }

  async #initialize() {
    try {
      const { nodePath, entryPath, profile } = this.#config;
      if(this.#isolatedLaunch)this.#launchDescription=await this.#isolatedLaunch.inspect();
      this.#entryHash=await entryDigest(entryPath);
      if(this.#launchDescription && this.#entryHash!==this.#launchDescription.entrySha256)throw error('ATK_ENTRY_CHANGED');
      if(this.#state==='closed')throw error('ATK_CLOSED');
      const args=this.#launchDescription?.args ?? ['--profile',profile,'--demo','--modules','market,spot,account','--read-only'];
      const bootstrap=this.#launchDescription?.bootstrapEntryPath;
      if(bootstrap && await entryDigest(bootstrap)!==this.#launchDescription.bootstrapSha256)throw error('ATK_ENTRY_CHANGED');
      this.#child = spawn(nodePath, [...(bootstrap?[bootstrap]:[]),entryPath,...args], {
        shell: false, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
        env:this.#isolatedLaunch?this.#isolatedLaunch.takeEnvironment():atkEnvironment(),
      });
      this.#child.stderr.on('data', () => {}); // Drain without retaining/logging possible credentials.
      this.#child.stdout.on('data', chunk => this.#consume(chunk));
      this.#child.stdout.on('end', () => this.#fail(error('ATK_STREAM_ENDED')));
      this.#child.stdin.on('error', () => this.#fail(error('ATK_TRANSPORT_ERROR')));
      this.#child.stdout.on('error', () => this.#fail(error('ATK_TRANSPORT_ERROR')));
      this.#child.stderr.on('error', () => this.#fail(error('ATK_TRANSPORT_ERROR')));
      this.#child.on('error', () => this.#fail(error('ATK_START_FAILED')));
      this.#child.on('close', () => this.#fail(error('ATK_PROCESS_CLOSED')));
      const initialized = await this.#request('initialize', {
        protocolVersion: '2025-06-18', capabilities: {},
        clientInfo: { name: 'mandateguard-read-only', version: '0.1.0' },
      });
      if (!object(initialized) || !VERSIONS.has(initialized.protocolVersion)
          || !object(initialized.capabilities) || !object(initialized.capabilities.tools)) {
        throw error('ATK_HANDSHAKE_UNSUPPORTED');
      }
      this.#send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      this.#protocolVersion=initialized.protocolVersion;
      let cursor, bytes = 0;
      const cursors = new Set();
      const catalog = [];
      for (let page = 0; page < 16; page += 1) {
        const listed = await this.#request('tools/list', cursor ? { cursor } : {});
        if (!object(listed) || !Array.isArray(listed.tools)) throw error('ATK_CATALOG_INVALID');
        bytes += Buffer.byteLength(JSON.stringify(listed.tools));
        if (bytes > MAX_CATALOG_BYTES || catalog.length + listed.tools.length > MAX_TOOLS) throw error('ATK_CATALOG_LIMIT');
        for (const tool of listed.tools) {
          if (!object(tool) || typeof tool.name !== 'string' || tool.name.length > 128
              || !object(tool.inputSchema) || tool.inputSchema.type !== 'object'
              || this.#advertised.has(tool.name)) throw error('ATK_CATALOG_INVALID');
          // Preserve actual names/schema for capability display; do not infer aliases.
          const descriptor = copy(tool);
          catalog.push(descriptor);
          this.#advertised.set(tool.name, descriptor);
        }
        if (listed.nextCursor === undefined) {
          if(await entryDigest(entryPath)!==this.#entryHash)throw error('ATK_ENTRY_CHANGED');
          if(bootstrap && await entryDigest(bootstrap)!==this.#launchDescription.bootstrapSha256)throw error('ATK_ENTRY_CHANGED');
          if(this.#state==='closed')throw error('ATK_CLOSED');
          this.#catalog = catalog;
          this.#state = 'ready';
          return { protocolVersion: initialized.protocolVersion, toolCount: catalog.length };
        }
        if (typeof listed.nextCursor !== 'string' || !listed.nextCursor || listed.nextCursor.length > 4096 || cursors.has(listed.nextCursor)) {
          throw error('ATK_CATALOG_INVALID');
        }
        cursors.add(listed.nextCursor); cursor = listed.nextCursor;
      }
      throw error('ATK_CATALOG_LIMIT');
    } catch (failure) {
      this.#fail(failure?.code ? failure : error('ATK_CONNECT_FAILED'));
      throw failure?.code ? failure : error('ATK_CONNECT_FAILED');
    }
  }

  // Snapshot only: no tool is executed or UI action emitted by catalog discovery.
  tools() {
    if (this.#state !== 'ready') throw error('ATK_NOT_CONNECTED');
    if (this.#stale) throw error('ATK_CATALOG_CHANGED');
    return copy(this.#catalog);
  }
  launchContext() {
    if(this.#state!=='ready' || this.#stale)throw error('ATK_NOT_CONNECTED');
    return this.#launchDescription?{...this.#launchDescription}:{verification:'STANDARD_PROFILE_RUNTIME',
      actualAccountVerified:false,routeVerified:false,writeEnabled:false};
  }

  /** Internal operator composition only. No HTTP route accepts these objects.
   * Approval is compared with the ACTUAL handshake/catalog and observed entry
   * bytes. The legacy isolatedEntrySha256 field does not attest process isolation.
   */
  attachObservationJournal({store,manifest,approval,accountExpectation=null}) {
    if(this.#journal || this.#pending.size || this.#state!=='ready' || this.#stale)throw error('ATK_JOURNAL_STATE');
    if(!store || typeof store.openATKCaptureSession!=='function' || typeof store.pauseGlobal!=='function'
        || !verifyDemoConnectionManifest(manifest) || manifest.config.profile!==this.#config.profile)
      throw error('ATK_JOURNAL_CONFIG');
    if(this.#launchDescription && this.#launchDescription.connectionHash!==manifest.configHash)throw error('ATK_JOURNAL_CONFIG');
    const checked=inspectATKCatalog(manifest,approval,{isolatedEntrySha256:this.#entryHash,
      protocolVersion:this.#protocolVersion,tools:this.#catalog},{execution:this.#execution});
    if(!checked.ok)throw error(checked.code);
    const binding=Object.freeze({connectionHash:manifest.configHash,catalogHash:checked.baselineHash,
      isolatedEntrySha256:this.#entryHash,sessionId:this.#sessionId,accountId:manifest.config.accountId});
    const expected=accountExpectation===null ? null
      : copyAccountExpectation(accountExpectation,binding.connectionHash,binding.accountId);
    if(this.#execution && !expected)throw error('ATK_ACCOUNT_EXPECTATION_REQUIRED');
    let captureSession;
    try {
      captureSession=store.openATKCaptureSession(binding);
      if(!captureSession || ['capture','invalidate','close'].some(key=>typeof captureSession[key]!=='function'))
        throw error('ATK_JOURNAL_CAPTURE_SESSION');
    } catch {
      try {captureSession?.close?.();} catch {}
      try {store.pauseGlobal('STORAGE_UNCERTAIN');}
      finally {this.#fail(error('ATK_JOURNAL_CAPTURE_FAILED'));}
      throw error('ATK_JOURNAL_CAPTURE_FAILED');
    }
    this.#journal={store,binding,captureSession,accountExpectation:expected};
    return {binding,verification:'OBSERVED_STDIO_ENTRY_AND_CATALOG_ONLY',writeEnabled:false,actualAccountVerified:false,routeVerified:false};
  }

  journalContext() {
    if(!this.#journal || this.#state!=='ready' || this.#stale)throw error('ATK_JOURNAL_STATE');
    return {...this.#journal.binding};
  }

  // Called through the captured prototype below: an object with forged methods
  // or an ordinary read-only session cannot stand in for this private state.
  executionContext(store,nowMs=Date.now()) {
    if(!this.#execution || !this.#launchDescription?.execution || this.#state!=='ready' || this.#stale
        || this.#journal?.store!==store || !this.#identityObservationId)throw error('DEMO_RUNTIME_UNAVAILABLE');
    const saved=store.atkToolObservation(this.#identityObservationId);
    const source=store.atkObservationSource(this.#identityObservationId);
    const identity=compareDemoAccountIdentity(saved?.record,{expectedBinding:this.#journal.binding,
      accountExpectation:this.#journal.accountExpectation,nowMs,maxAgeMs:15000,maxSkewMs:1000});
    if(!identity.ok || source?.source!=='REGISTERED_STDIO_CAPTURE' || !source.activeSession)
      throw error('DEMO_RUNTIME_IDENTITY');
    return {binding:{...this.#journal.binding},manifest:copy(this.#manifest),identityObservationId:this.#identityObservationId};
  }

  async submitDemo(input) {
    const store=this.#journal?.store;
    this.executionContext(store);
    const prepared=input.prepared,body=prepared?.body;
    if(!body || hashCanonical(prepared.commitment)!==prepared.commitmentHash)throw error('DEMO_WIRE_REQUIRED');
    const {tag,...args}=body;
    this.#writeArguments('spot_place_order',args);
    if(this.#pending.size || !this.#child?.stdin.writable)throw error('ATK_DELIVERY_BUSY');
    // No await or callback between durable admission and the single stream write.
    const ticket=store.commitDemoSubmission(input);
    const key=ticket.commitmentHash;
    if(this.#deliveryClaims.has(key))throw error('ATK_DELIVERY_ALREADY_ATTEMPTED');
    this.#deliveryClaims.add(key);
    try {
      const result=await this.#writeResponse('spot_place_order',args,{taskId:ticket.taskId,intentId:prepared.commitment.intentId},
        {bodyText:ticket.bodyText,expiresAtMs:ticket.validUntilMs});
      store.markDemoSubmissionUnknown(ticket.taskId,key);
      return {code:'DELIVERY_RESPONSE_JOURNALLED',observationId:result.observationId,attempted:true,retryAllowed:false};
    } catch {
      try {store.markDemoSubmissionUnknown(ticket.taskId,key);} catch {store.pauseGlobal('STORAGE_UNCERTAIN');}
      return {code:'DELIVERY_OUTCOME_UNKNOWN',attempted:true,retryAllowed:false};
    }
  }

  async cancelDemo(taskId) {
    const store=this.#journal?.store,context=this.executionContext(store),nowMs=Date.now();
    const task=store.get(taskId),intent=task?.ledger.intents.find(item=>!item.settled);
    if(!intent || !store.verifySafetyTask(task))throw error('SAFETY_IDENTITY');
    const campaign=store.campaign(task.campaignId);
    const plan=planDemoSafety({task,intent,nowMs,globalPaused:store.globalSafetyStatus().paused,
      campaignPaused:!campaign || campaign.paused || !!campaign.supersededBy,ownerActive:store.ownerSessionActive(task.ownerId,nowMs)});
    if(!plan.cancel)throw error('SAFETY_CANCEL_NOT_REQUIRED');
    this.#writeArguments('spot_cancel_order',plan.cancel.args);
    if(this.#pending.size || !this.#child?.stdin.writable)throw error('ATK_DELIVERY_BUSY');
    store.recordDemoCancelAttempt({taskId,intentId:intent.id,taskRevision:task.revision,
      request:plan.cancel,binding:context.binding,atMs:nowMs});
    const a=plan.cancel.args,bodyText=JSON.stringify({instId:a.instId,ordId:a.ordId,clOrdId:a.clOrdId});
    return this.#writeResponse('spot_cancel_order',a,{taskId,intentId:intent.id},{bodyText,expiresAtMs:nowMs+15000});
  }

  #writeArguments(name,args) {
    if(!this.#execution || !this.#advertised.has(name) || !['spot_place_order','spot_cancel_order'].includes(name)
        || !validate(args,this.#advertised.get(name).inputSchema))throw error('ATK_WRITE_SCHEMA');
  }

  async #writeResponse(name,args,owner,packet) {
    const requestedAtMs=Date.now(),callId=randomUUID();
    if(this.#state!=='ready' || this.#stale || requestedAtMs>=packet.expiresAtMs)throw error('ATK_WRITE_EXPIRED');
    const result=await this.#request('tools/call',{name,arguments:{...args,_pactway:packet}});
    const prepared=prepareATKObservation({schemaVersion:1,...this.#journal.binding,...owner,
      observationId:randomUUID(),callId,tool:name,args,requestedAtMs,receivedAtMs:Date.now()},result);
    try {
      if(!prepared.ok)throw error('ATK_WRITE_RESPONSE');
      const receipt=this.#journal.captureSession.capture(prepared.record);
      if(receipt.payloadHash!==prepared.payloadHash || receipt.duplicate || receipt.status!=='PENDING')throw error('ATK_JOURNAL_RECEIPT');
      return receipt;
    } catch {
      try {this.#journal.store.pauseGlobal('STORAGE_UNCERTAIN');} finally {this.#fail(error('ATK_JOURNAL_CAPTURE_FAILED'));}
      throw error('ATK_JOURNAL_CAPTURE_FAILED');
    }
  }

  async callJournalledRead(name,args={},owner={taskId:null,intentId:null}) {
    if(!this.#journal)throw error('ATK_JOURNAL_REQUIRED');
    const linked=jsonInput(owner);
    if(!object(linked) || Object.keys(linked).sort().join(',')!=='intentId,taskId'
        || [linked.taskId,linked.intentId].some(id=>id!==null && (typeof id!=='string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id)))
        || linked.taskId===null && linked.intentId!==null)throw error('ATK_JOURNAL_OWNER');
    const captured=await this.#readResponse(name,args,linked);
    return {observationId:captured.receipt.observationId,payloadHash:captured.receipt.payloadHash,status:'PENDING',
      verification:'SDK_STDIO_CAPTURE_ONLY',writeEnabled:false,actualAccountVerified:false,routeVerified:false};
  }

  async callReadTool(name, args = {}) {
    const {result}=await this.#readResponse(name,args,{taskId:null,intentId:null});
    const content = result.content.map(block => {
      if (!object(block) || block.type !== 'text' || typeof block.text !== 'string')return {type:'unsupported'};
      try {return {type:'json',data:JSON.parse(block.text)};} catch {return {type:'text',text:block.text};}
    });
    const structured=Object.hasOwn(result,'structuredContent')?copy(result.structuredContent):undefined;
    const jsonBlocks=content.filter(block=>block.type==='json').map(block=>block.data);
    return {tool:name,isError:result.isError===true,untrusted:true,
      data:structured??(jsonBlocks.length===1?jsonBlocks[0]:jsonBlocks.length?jsonBlocks:null),content};
  }

  async #readResponse(name,args,owner) {
    if (this.#state !== 'ready') throw error('ATK_NOT_CONNECTED');
    if (this.#stale) throw error('ATK_CATALOG_CHANGED');
    if (typeof name !== 'string' || !NAME.test(name) || !PREFIX.test(name)
        || !READ_TOOLS.has(name) || !this.#advertised.has(name)) throw error('ATK_READ_TOOL_DENIED');
    const input = jsonInput(args);
    if (!object(input)) throw error('ATK_ARGUMENT_OBJECT_REQUIRED');
    // ATK 1.4.8 market handlers use demo=false by default, even with --demo.
    // Require an explicit demo argument; do not silently change caller input.
    if (DEMO_MARKET_TOOLS.has(name) && input.demo !== true) throw error('ATK_MARKET_DEMO_REQUIRED');
    if (!validate(input, this.#advertised.get(name).inputSchema)) throw error('ATK_ARGUMENT_SCHEMA');
    if(this.#journal && Buffer.byteLength(JSON.stringify(input),'utf8')>16384)throw error('ATK_ARGUMENT_LIMIT');
    const requestedAtMs=Date.now(),callId=randomUUID();
    const result = await this.#request('tools/call', { name, arguments: input });
    let receipt=null,record=null;
    if(this.#journal) {
      try {
        const prepared=prepareATKObservation({schemaVersion:1,...this.#journal.binding,...owner,
          observationId:randomUUID(),callId,tool:name,args:input,requestedAtMs,receivedAtMs:Date.now()},result);
        if(!prepared.ok)throw error(prepared.code);
        record=prepared.record;
        receipt=this.#journal.captureSession.capture(prepared.record);
        if(!receipt || receipt.observationId!==prepared.record.context.observationId
            || receipt.payloadHash!==prepared.payloadHash || receipt.status!=='PENDING' || receipt.duplicate!==false)
          throw error('ATK_JOURNAL_RECEIPT');
      } catch {
        try {this.#journal.store.pauseGlobal('STORAGE_UNCERTAIN');}
        finally {this.#fail(error('ATK_JOURNAL_CAPTURE_FAILED'));}
        throw error('ATK_JOURNAL_CAPTURE_FAILED');
      }
    }
    // Retain a response received concurrently with catalog drift, but never
    // hand it to a caller as a usable projection under the old catalog.
    if(this.#stale || this.#state!=='ready')throw error('ATK_CATALOG_CHANGED');
    // Check only the directly captured response, after durable storage. Do not
    // accept an observation ID or caller-provided response on this path.
    if(name==='account_get_config' && this.#journal?.accountExpectation) {
      const identity=compareDemoAccountIdentity(record,{expectedBinding:this.#journal.binding,
        accountExpectation:this.#journal.accountExpectation,nowMs:Date.now(),maxAgeMs:15000,maxSkewMs:1000});
      if(!identity.ok) {
        try {this.#journal.store.pauseGlobal('SAFETY_PROCESSING_FAILED');}
        finally {this.#fail(error('ATK_ACCOUNT_IDENTITY_REJECTED'));}
        throw error('ATK_ACCOUNT_IDENTITY_REJECTED');
      }
      this.#identityObservationId=receipt.observationId;
    }
    if (!object(result) || !Array.isArray(result.content)
        || (result.isError !== undefined && typeof result.isError !== 'boolean')) {
      this.#fail(error('ATK_TOOL_RESULT_INVALID'));
      throw error('ATK_TOOL_RESULT_INVALID');
    }
    return {result,receipt};
  }

  #request(method, params) {
    if (!this.#child || this.#state === 'closed') return Promise.reject(error('ATK_CLOSED'));
    if (this.#pending.size >= 16) return Promise.reject(error('ATK_PENDING_LIMIT'));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.#fail(error('ATK_REQUEST_TIMEOUT')), this.#config.timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      try { this.#send({ jsonrpc: '2.0', id, method, params }); }
      catch (failure) { this.#fail(failure); }
    });
  }

  #send(message) {
    if (!this.#child || this.#state === 'closed' || !this.#child.stdin.writable) throw error('ATK_CLOSED');
    const frame = Buffer.from(JSON.stringify(message) + '\n', 'utf8');
    if (frame.length - 1 > MAX_FRAME) throw error('ATK_FRAME_LIMIT');
    this.#child.stdin.write(frame, failure => {
      if (failure) this.#fail(error('ATK_TRANSPORT_ERROR'));
    });
  }

  #consume(chunk) {
    if (this.#state === 'closed') return;
    try {
      let offset = 0;
      while (offset < chunk.length) {
        const newline = chunk.indexOf(10, offset);
        const end = newline < 0 ? chunk.length : newline;
        const part = chunk.subarray(offset, end);
        if (this.#buffer.length + part.length > MAX_FRAME) throw error('ATK_FRAME_LIMIT');
        this.#buffer = this.#buffer.length ? Buffer.concat([this.#buffer, part]) : Buffer.from(part);
        if (newline < 0) break;
        if (this.#buffer.length) {
          const text = new TextDecoder('utf-8', { fatal: true }).decode(this.#buffer);
          this.#receive(JSON.parse(text));
        }
        this.#buffer = Buffer.alloc(0);
        if (this.#state === 'closed') return;
        offset = newline + 1;
      }
    } catch (failure) {
      this.#fail(failure?.code === 'ATK_FRAME_LIMIT' ? failure : error('ATK_PROTOCOL_INVALID'));
    }
  }

  #receive(message) {
    if (!object(message) || message.jsonrpc !== '2.0') throw error('ATK_PROTOCOL_INVALID');
    if (typeof message.method === 'string') {
      if (Object.hasOwn(message, 'id')) {
        if (!(typeof message.id === 'string' || Number.isSafeInteger(message.id))) throw error('ATK_PROTOCOL_INVALID');
        this.#send(message.method === 'ping'
          ? { jsonrpc: '2.0', id: message.id, result: {} }
          : { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Unsupported client method' } });
      } else if (message.method === 'notifications/tools/list_changed') {
        this.#stale = true; // Deliberate reconnect required; never silently expand permissions.
        this.#journal?.captureSession.invalidate();
      }
      return; // Logs, prompts, sampling and arbitrary notifications are not executed.
    }
    if (!Number.isSafeInteger(message.id)
        || Object.hasOwn(message, 'result') === Object.hasOwn(message, 'error')) throw error('ATK_PROTOCOL_INVALID');
    if (Object.hasOwn(message, 'error') && (!object(message.error)
        || !Number.isInteger(message.error.code) || typeof message.error.message !== 'string')) {
      throw error('ATK_PROTOCOL_INVALID');
    }
    const pending = this.#pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer); this.#pending.delete(message.id);
    if (Object.hasOwn(message, 'error')) {
      pending.reject(error('ATK_RPC_ERROR')); // Do not surface server text/data that may contain secrets.
    } else pending.resolve(message.result);
  }

  #fail(failure) {
    this.#isolatedLaunch?.discard();
    this.#journal?.captureSession.close();
    if (this.#state === 'closed') return;
    this.#state = 'closed'; this.#buffer = Buffer.alloc(0);
    this.#catalog = []; this.#advertised.clear();
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer); pending.reject(failure);
    }
    this.#pending.clear();
    void this.#stopChild();
  }

  #stopChild() {
    if (this.#closing) return this.#closing;
    const child = this.#child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    this.#closing = new Promise(resolve => {
      let termTimer, killTimer, finishTimer;
      const finish = () => {
        clearTimeout(termTimer); clearTimeout(killTimer); clearTimeout(finishTimer);
        child.removeListener('close', finish); resolve();
      };
      child.once('close', finish);
      child.stdin.end();
      termTimer = setTimeout(() => { try { child.kill('SIGTERM'); } catch {} }, 500);
      killTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 1000);
      finishTimer = setTimeout(finish, 1500);
    });
    return this.#closing;
  }

  async close() {
    this.#fail(error('ATK_CLOSED'));
    await this.#stopChild();
  }
}

const executionContext=ReadOnlyATK.prototype.executionContext;
export const inspectDemoRuntime=(client,store,nowMs)=>executionContext.call(client,store,nowMs);
