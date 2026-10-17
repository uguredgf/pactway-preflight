import {createHash} from 'node:crypto';
import {PINNED_ATK,createDemoConnectionManifest,verifyDemoConnectionManifest} from './demo-connection-manifest.mjs';

const REQUIRED = Object.freeze(['market_get_ticker','market_get_orderbook','market_get_instruments',
  'account_get_config','account_get_balance','account_get_trade_fee','spot_get_order','spot_get_orders','spot_get_fills']);
const TOOL_KEYS = ['name','title','description','inputSchema','outputSchema','annotations'];
const ANNOTATION_KEYS = ['title','readOnlyHint','destructiveHint','idempotentHint','openWorldHint'];
const HEX = /^[a-f0-9]{64}$/;
const LIMITS = Object.freeze({tools:512,totalBytes:4*1024*1024,descriptorBytes:128*1024,
  depth:32,nodes:100000,members:4096,string:65536,key:512});
// An annotation cannot relabel a known write action as a read capability.
// Conservatively refuse action-name tokens throughout the supplied read-only catalog.
const WRITE_NAME = /(?:^|_)(?:place|cancel|amend|batch|set|transfer|withdraw|borrow|repay|close|create|delete|update|start|stop|purchase|redeem|subscribe|unsubscribe|stake|unstake|activate|deactivate|modify|adjust|deposit|convert|invest|reinvest|add|remove)(?:_|$)/;
const CODES = new Set(['DEMO_MANIFEST_HASH','ATK_CATALOG_FIELDS','ATK_CATALOG_CONTEXT_INVALID',
  'ATK_CATALOG_JSON_INVALID','ATK_CATALOG_LIMIT','ATK_CATALOG_DUPLICATE','ATK_CATALOG_TOOL_INVALID',
  'ATK_CATALOG_SCHEMA_INVALID','ATK_CATALOG_READONLY_REQUIRED','ATK_CATALOG_REQUIRED_MISSING',
  'ATK_CATALOG_BASELINE_INVALID','ATK_CATALOG_APPROVAL_HASH_MISMATCH','ATK_CATALOG_CONTEXT_MISMATCH',
  'ATK_CATALOG_DRIFT']);
const BLOCKERS = Object.freeze(['SUPPLIED_CATALOG_NOT_INDEPENDENTLY_OBSERVED','SUPPLIED_ENTRY_CONTEXT_NOT_ATTESTED',
  'CATALOG_COMPLETENESS_UNVERIFIED','SCHEMA_AND_HANDLER_SEMANTICS_UNVERIFIED','RUNTIME_AND_TARGET_UNVERIFIED']);

function fields(input,allowed,required = allowed,code = 'ATK_CATALOG_FIELDS') {
  if (!input || typeof input !== 'object' || Array.isArray(input)
      || ![Object.prototype,null].includes(Object.getPrototypeOf(input))
      || Object.getOwnPropertySymbols(input).length) throw code;
  const names = Object.getOwnPropertyNames(input);
  if (names.length > LIMITS.members || names.some(key => !allowed.includes(key))
      || required.some(key => !names.includes(key))) throw code;
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const result = Object.create(null);
  for (const key of names) {
    if (!Object.hasOwn(descriptors[key],'value')) throw code;
    result[key] = descriptors[key].value;
  }
  return result;
}

function bytes(state,count) {
  state.totalBytes += count;state.descriptorBytes += count;
  if (state.totalBytes > LIMITS.totalBytes || state.descriptorBytes > LIMITS.descriptorBytes) throw 'ATK_CATALOG_LIMIT';
}
function stringBytes(state,text,key = false) {
  if (text.length > (key ? LIMITS.key : LIMITS.string)) throw 'ATK_CATALOG_LIMIT';
  bytes(state,Buffer.byteLength(JSON.stringify(text),'utf8'));
}
function arrayFields(input,maximum,code = 'ATK_CATALOG_JSON_INVALID') {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype
      || Object.getOwnPropertySymbols(input).length) throw code;
  const lengthDescriptor = Object.getOwnPropertyDescriptor(input,'length');
  if (!lengthDescriptor || !Object.hasOwn(lengthDescriptor,'value')
      || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0) throw code;
  const length = lengthDescriptor.value;
  if (length > maximum) throw 'ATK_CATALOG_LIMIT';
  const names = Object.getOwnPropertyNames(input);
  if (names.length !== length + 1 || names.some(name => name !== 'length'
      && (!/^(0|[1-9][0-9]*)$/.test(name) || Number(name) >= length))) throw code;
  const descriptors = Object.getOwnPropertyDescriptors(input);
  for (let index = 0;index < length;index++)
    if (!descriptors[index] || !Object.hasOwn(descriptors[index],'value')) throw code;
  return {descriptors,length};
}

function copyJson(input,state,active = new Set(),depth = 0) {
  if (++state.nodes > LIMITS.nodes || depth > LIMITS.depth) throw 'ATK_CATALOG_LIMIT';
  if (input === null) {bytes(state,4);return null;}
  if (typeof input === 'string') {stringBytes(state,input);return input;}
  if (typeof input === 'boolean') {bytes(state,input ? 4 : 5);return input;}
  if (typeof input === 'number' && Number.isFinite(input)) {
    const value = Object.is(input,-0) ? 0 : input;bytes(state,JSON.stringify(value).length);return value;
  }
  if (!input || typeof input !== 'object' || active.has(input)) throw 'ATK_CATALOG_JSON_INVALID';
  active.add(input);
  try {
    if (Array.isArray(input)) {
      const {descriptors,length} = arrayFields(input,LIMITS.nodes);
      bytes(state,2 + Math.max(0,length-1));
      const values = [];
      for (let index = 0;index < length;index++) values.push(copyJson(descriptors[index].value,state,active,depth+1));
      return Object.freeze(values);
    }
    if (![Object.prototype,null].includes(Object.getPrototypeOf(input)) || Object.getOwnPropertySymbols(input).length)
      throw 'ATK_CATALOG_JSON_INVALID';
    const names = Object.getOwnPropertyNames(input).sort();
    if (names.length > LIMITS.members) throw 'ATK_CATALOG_LIMIT';
    bytes(state,2 + names.length + Math.max(0,names.length-1));
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const value = Object.create(null);
    for (const key of names) {
      stringBytes(state,key,true);
      if (!Object.hasOwn(descriptors[key],'value')) throw 'ATK_CATALOG_JSON_INVALID';
      value[key] = copyJson(descriptors[key].value,state,active,depth+1);
    }
    return Object.freeze(value);
  } finally {active.delete(input);}
}

// Separate canonical JSON supports fractional schema values and lexical object keys.
// JSON.stringify alone reorders integer-like object keys; schema arrays stay ordered.
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key)+':'+canonical(value[key])).join(',') + '}';
}
const digest = baseline => createHash('sha256').update(canonical(baseline),'utf8').digest('hex');

function toolIsValid(tool,execution=false) {
  fields(tool,TOOL_KEYS,['name','inputSchema','annotations'],'ATK_CATALOG_TOOL_INVALID');
  if (typeof tool.name !== 'string' || tool.name.trim() !== tool.name
      || !/^[a-z][a-z0-9_]{0,127}$/.test(tool.name)) throw 'ATK_CATALOG_TOOL_INVALID';
  for (const key of ['title','description'])
    if (Object.hasOwn(tool,key) && typeof tool[key] !== 'string') throw 'ATK_CATALOG_TOOL_INVALID';
  if (!tool.inputSchema || Array.isArray(tool.inputSchema) || typeof tool.inputSchema !== 'object'
      || tool.inputSchema.type !== 'object') throw 'ATK_CATALOG_SCHEMA_INVALID';
  // Fingerprint supported JSON Schema declarations without pretending to validate keywords.
  if (Object.hasOwn(tool,'outputSchema') && (!tool.outputSchema || Array.isArray(tool.outputSchema)
      || typeof tool.outputSchema !== 'object')) throw 'ATK_CATALOG_SCHEMA_INVALID';
  const annotation = fields(tool.annotations,ANNOTATION_KEYS,['readOnlyHint','destructiveHint'],'ATK_CATALOG_TOOL_INVALID');
  const write=execution && ['spot_place_order','spot_cancel_order'].includes(tool.name);
  if (annotation.readOnlyHint !== !write || annotation.destructiveHint !== (write && tool.name==='spot_cancel_order')
      || !write && WRITE_NAME.test(tool.name))
    throw 'ATK_CATALOG_READONLY_REQUIRED';
  if (Object.hasOwn(annotation,'title') && typeof annotation.title !== 'string') throw 'ATK_CATALOG_TOOL_INVALID';
  for (const key of ['idempotentHint','openWorldHint'])
    if (Object.hasOwn(annotation,key) && typeof annotation[key] !== 'boolean') throw 'ATK_CATALOG_TOOL_INVALID';
}

function normalize(manifestHash,input,execution=false) {
  if(typeof execution!=='boolean')throw 'ATK_CATALOG_CONTEXT_INVALID';
  const supplied = fields(input,['isolatedEntrySha256','protocolVersion','tools']);
  if (typeof supplied.isolatedEntrySha256 !== 'string' || supplied.isolatedEntrySha256.length !== 64 || !HEX.test(supplied.isolatedEntrySha256)
      || typeof supplied.protocolVersion !== 'string' || supplied.protocolVersion.length !== 10
      || !/^\d{4}-\d{2}-\d{2}$/.test(supplied.protocolVersion))
    throw 'ATK_CATALOG_CONTEXT_INVALID';
  const {descriptors,length} = arrayFields(supplied.tools,LIMITS.tools,'ATK_CATALOG_TOOL_INVALID');
  const state = {totalBytes:2 + Math.max(0,length-1),descriptorBytes:0,nodes:0};
  const tools = [];const names = new Set();
  for (let index = 0;index < length;index++) {
    state.descriptorBytes = 0;
    const tool = copyJson(descriptors[index].value,state);
    toolIsValid(tool,execution);
    if (names.has(tool.name)) throw 'ATK_CATALOG_DUPLICATE';
    names.add(tool.name);tools.push(tool);
  }
  for (const name of REQUIRED) if (!names.has(name)) throw 'ATK_CATALOG_REQUIRED_MISSING';
  if(execution)for(const name of ['spot_place_order','spot_cancel_order','spot_get_algo_orders'])
    if(!names.has(name))throw 'ATK_CATALOG_REQUIRED_MISSING';
  for (const tool of tools) {
    if (!REQUIRED.includes(tool.name) || !tool.name.startsWith('market_')) continue;
    const properties = tool.inputSchema.properties;
    if (!properties || typeof properties !== 'object' || Array.isArray(properties)
        || !properties.demo || typeof properties.demo !== 'object' || Array.isArray(properties.demo)
        || properties.demo.type !== 'boolean') throw 'ATK_CATALOG_SCHEMA_INVALID';
  }
  tools.sort((a,b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const baseline = Object.freeze({schemaVersion:execution?2:1,manifestHash,package:PINNED_ATK,
    isolatedEntrySha256:supplied.isolatedEntrySha256,protocolVersion:supplied.protocolVersion,tools:Object.freeze(tools)});
  // Tools consumed budget incrementally; include the small context overhead too.
  if (Buffer.byteLength(canonical(baseline),'utf8') > LIMITS.totalBytes) throw 'ATK_CATALOG_LIMIT';
  return baseline;
}

function declarationHash(manifest) {
  if (!verifyDemoConnectionManifest(manifest)) throw 'DEMO_MANIFEST_HASH';
  const descriptors = Object.getOwnPropertyDescriptors(manifest);
  const declaration = createDemoConnectionManifest(descriptors.config.value);
  if (declaration.configHash !== descriptors.configHash.value) throw 'DEMO_MANIFEST_HASH';
  return declaration.configHash;
}

/** Pure nonsecret supplied-catalog declaration. No SDK/transport/schema validator.
 * Metadata/schema equality is not handler semantics, full pagination, independently
 * observed entry/catalog evidence, explicit operator approval, or call authorization.
 * Required9 extend preparation to account_get_config; existing adapters stay unchanged.
 * Market demo:boolean only fingerprints the declared input; callers still need demo:true.
 */
export function createATKCatalogBaseline(manifest,input,{execution=false}={}) {
  try {
    const baseline = normalize(declarationHash(manifest),input,execution);
    return report(true,'ATK_CATALOG_BASELINE_DECLARED',{baseline,baselineHash:digest(baseline),
      verification:'SUPPLIED_CATALOG_DECLARATION_ONLY'});
  } catch (code) {return rejected(code);}
}

/** approvedBaselineHash is separately supplied approval intent, never inferred from
 * current observation or the baseline object. Authenticity of that intent is still
 * the later owner/session boundary's responsibility. Even MATCH authorizes nothing.
 */
export function inspectATKCatalog(manifest,approval,observation,{execution=false}={}) {
  try {
    const manifestHash = declarationHash(manifest);
    const approved = fields(approval,['approvedBaselineHash','baseline']);
    if (typeof approved.approvedBaselineHash !== 'string' || approved.approvedBaselineHash.length !== 64 || !HEX.test(approved.approvedBaselineHash))
      throw 'ATK_CATALOG_BASELINE_INVALID';
    const declared = fields(approved.baseline,['schemaVersion','manifestHash','package','isolatedEntrySha256','protocolVersion','tools'],
      undefined,'ATK_CATALOG_BASELINE_INVALID');
    const pinned = fields(declared.package,['name','version','entrySha256'],undefined,'ATK_CATALOG_BASELINE_INVALID');
    if (declared.schemaVersion !== (execution?2:1) || Object.keys(pinned).some(key => pinned[key] !== PINNED_ATK[key])) throw 'ATK_CATALOG_BASELINE_INVALID';
    if (declared.manifestHash !== manifestHash) throw 'ATK_CATALOG_CONTEXT_MISMATCH';
    const baseline = normalize(manifestHash,{isolatedEntrySha256:declared.isolatedEntrySha256,
      protocolVersion:declared.protocolVersion,tools:declared.tools},execution);
    const baselineHash = digest(baseline);
    if (baselineHash !== approved.approvedBaselineHash) throw 'ATK_CATALOG_APPROVAL_HASH_MISMATCH';
    const observed = normalize(manifestHash,observation,execution);
    if (observed.isolatedEntrySha256 !== baseline.isolatedEntrySha256 || observed.protocolVersion !== baseline.protocolVersion)
      throw 'ATK_CATALOG_CONTEXT_MISMATCH';
    if (digest(observed) !== baselineHash) throw 'ATK_CATALOG_DRIFT';
    return report(true,'ATK_CATALOG_FINGERPRINT_MATCH',{baselineHash,
      verification:'SUPPLIED_CATALOG_COMPARISON_ONLY'});
  } catch (code) {return rejected(code);}
}

function rejected(code) {return report(false,CODES.has(code) ? code : 'ATK_CATALOG_JSON_INVALID');}
function report(ok,code,extra = {}) {
  return Object.freeze({ok,code,verification:'UNVERIFIED',...extra,requiredBlockers:BLOCKERS,
    launchAllowed:false,readAuthorized:false,writeEnabled:false,routeVerified:false,actualAccountVerified:false});
}
