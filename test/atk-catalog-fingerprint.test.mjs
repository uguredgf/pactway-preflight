// Source acceptance cases only; not run. Fixtures are supplied declarations, not a real SDK catalog.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createATKCatalogBaseline,inspectATKCatalog} from '../src/adapters/atk-catalog-fingerprint.mjs';
import {createDemoConnectionManifest} from '../src/adapters/demo-connection-manifest.mjs';

const manifest = (patch = {}) => createDemoConnectionManifest({schemaVersion:1,id:'demo',connectionVersion:'v1',
  accountId:'alias',environment:'demo',instrument:'AVAX-USDT',profile:'demo',site:'tr',
  apiOrigin:'https://tr.okx.com',authMode:'isolated-demo-api-key',sourceTag:'MCP',...patch});
const names = ['market_get_ticker','market_get_orderbook','market_get_instruments','account_get_config',
  'account_get_balance','account_get_trade_fee','spot_get_order','spot_get_orders','spot_get_fills'];
const observation = () => ({isolatedEntrySha256:'a'.repeat(64),protocolVersion:'2025-11-25',
  tools:names.map(name => ({name,title:name,description:'Supplied fixture description',
    inputSchema:{type:'object',properties:{value:{type:'number',minimum:0.25},
      ...(name.startsWith('market_') ? {demo:{type:'boolean'}} : {})}},
    annotations:{title:name,readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:true}}))});
const approval = report => ({approvedBaselineHash:report.baselineHash,baseline:report.baseline});
function disabled(result) {
  for (const key of ['launchAllowed','readAuthorized','writeEnabled','routeVerified','actualAccountVerified']) assert.equal(result[key],false);
  assert.equal(Object.isFrozen(result),true);assert.equal(Object.isFrozen(result.requiredBlockers),true);
}
function rejected(result,code) {disabled(result);assert.equal(result.ok,false);assert.equal(result.code,code);}
const clone = value => JSON.parse(JSON.stringify(value));

test('canonical catalog ignores tool/object ordering, keeps fractional schema values, detaches and freezes',() => {
  const declared = manifest();const supplied = observation();
  const baseline = createATKCatalogBaseline(declared,supplied);disabled(baseline);assert.equal(baseline.ok,true);
  const reordered = clone(supplied);reordered.tools.reverse();
  reordered.tools = reordered.tools.map(tool => Object.fromEntries(Object.entries(tool).reverse()));
  for (const tool of reordered.tools) tool.inputSchema.properties = Object.fromEntries(Object.entries(tool.inputSchema.properties).reverse());
  assert.equal(createATKCatalogBaseline(declared,reordered).baselineHash,baseline.baselineHash);
  const result = inspectATKCatalog(declared,approval(baseline),reordered);disabled(result);assert.equal(result.ok,true);
  assert.equal(result.verification,'SUPPLIED_CATALOG_COMPARISON_ONLY');
  assert.equal(baseline.verification,'SUPPLIED_CATALOG_DECLARATION_ONLY');
  const detached = baseline.baseline.tools.find(tool => tool.name === supplied.tools[0].name);
  const before = detached.description;supplied.tools[0].description = 'mutated caller';
  supplied.tools[0].inputSchema.properties.value.minimum = 99;
  assert.equal(detached.description,before);assert.equal(detached.inputSchema.properties.value.minimum,0.25);
  assert.equal(Object.isFrozen(baseline.baseline.tools[0].inputSchema.properties.value),true);
  assert.equal(baseline.baseline.tools[0].inputSchema.properties.value.minimum,0.25);
  assert.throws(() => {baseline.baseline.tools[0].annotations.readOnlyHint = false;},TypeError);
});

test('all descriptor/schema details bind approval, including ordered arrays and optional output schema',() => {
  const declared = manifest();const supplied = observation();
  supplied.tools[0].inputSchema.properties.value.enum = [0.25,0.5];
  const baseline = createATKCatalogBaseline(declared,supplied);
  for (const modify of [
    tool => {tool.description = 'other';},tool => {tool.title = 'other';},
    tool => {tool.annotations.idempotentHint = false;},tool => {tool.annotations.openWorldHint = false;},
    tool => {tool.inputSchema.properties.value.minimum = 0.5;},
    tool => {tool.inputSchema.properties.value.enum.reverse();},
    tool => {tool.outputSchema = {type:'object',properties:{result:{type:'string'}}};},
  ]) {
    const changed = clone(supplied);modify(changed.tools[0]);
    rejected(inspectATKCatalog(declared,approval(baseline),changed),'ATK_CATALOG_DRIFT');
  }
  const numbered = observation();numbered.tools[0].inputSchema.properties.value.enum = [{2:'b',10:'c',1:'a'}];
  const differentInsertion = clone(numbered);differentInsertion.tools[0].inputSchema.properties.value.enum = [{10:'c',1:'a',2:'b'}];
  assert.equal(createATKCatalogBaseline(declared,numbered).baselineHash,createATKCatalogBaseline(declared,differentInsertion).baselineHash);
});

test('legitimate optional read tools are accepted and adding/removing/changing them invalidates old approval',() => {
  const declared = manifest();const requiredOnly = observation();
  const requiredBaseline = createATKCatalogBaseline(declared,requiredOnly);
  const extended = clone(requiredOnly);const optional = clone(extended.tools[0]);
  optional.name = 'account_get_max_withdrawal';extended.tools.push(optional);
  const extendedBaseline = createATKCatalogBaseline(declared,extended);
  disabled(extendedBaseline);assert.equal(extendedBaseline.ok,true);
  assert.equal(inspectATKCatalog(declared,approval(extendedBaseline),extended).ok,true);
  rejected(inspectATKCatalog(declared,approval(requiredBaseline),extended),'ATK_CATALOG_DRIFT');
  rejected(inspectATKCatalog(declared,approval(extendedBaseline),requiredOnly),'ATK_CATALOG_DRIFT');
  const changed = clone(extended);changed.tools.at(-1).inputSchema.properties.value.minimum = 0.75;
  rejected(inspectATKCatalog(declared,approval(extendedBaseline),changed),'ATK_CATALOG_DRIFT');
});

test('missing/duplicate tools, bad schemas, unsupported metadata and relabelled write tools fail closed',() => {
  const declared = manifest();
  for (const name of names) {
    const input = observation();input.tools = input.tools.filter(tool => tool.name !== name);
    rejected(createATKCatalogBaseline(declared,input),'ATK_CATALOG_REQUIRED_MISSING');
  }
  const duplicate = observation();duplicate.tools.push(clone(duplicate.tools[0]));
  rejected(createATKCatalogBaseline(declared,duplicate),'ATK_CATALOG_DUPLICATE');
  for (const patch of [{inputSchema:{type:'array'}},{inputSchema:undefined},{icons:[]},{_meta:{private:'secret'}}]) {
    const input = observation();Object.assign(input.tools[0],patch);
    const result = createATKCatalogBaseline(declared,input);disabled(result);assert.equal(result.ok,false);
  }
  const noDemo = observation();delete noDemo.tools[0].inputSchema.properties.demo;
  rejected(createATKCatalogBaseline(declared,noDemo),'ATK_CATALOG_SCHEMA_INVALID');
  for (const name of ['spot_place_order','spot_cancel_order','spot_amend_order','spot_batch_orders',
    'account_transfer','account_set_position_mode']) {
    const input = observation();const write = clone(input.tools[0]);write.name = name;input.tools.push(write);
    rejected(createATKCatalogBaseline(declared,input),'ATK_CATALOG_READONLY_REQUIRED');
  }
  const writeAnnotation = observation();writeAnnotation.tools[0].annotations.readOnlyHint = false;
  rejected(createATKCatalogBaseline(declared,writeAnnotation),'ATK_CATALOG_READONLY_REQUIRED');
  const newlineName = observation();newlineName.tools.push({...clone(newlineName.tools[0]),name:'extra_read\n'});
  rejected(createATKCatalogBaseline(declared,newlineName),'ATK_CATALOG_TOOL_INVALID');
});

test('separate approved hash rejects forged/edited baseline; entry/protocol/connection changes invalidate context',() => {
  const declared = manifest();const input = observation();const baseline = createATKCatalogBaseline(declared,input);
  rejected(inspectATKCatalog(declared,{baseline:baseline.baseline},input),'ATK_CATALOG_FIELDS');
  rejected(inspectATKCatalog(declared,{...approval(baseline),approvedBaselineHash:'0'.repeat(64)},input),'ATK_CATALOG_APPROVAL_HASH_MISMATCH');
  const forged = clone(baseline.baseline);forged.tools[0].description = 'forged';
  rejected(inspectATKCatalog(declared,{...approval(baseline),baseline:forged},input),'ATK_CATALOG_APPROVAL_HASH_MISMATCH');
  const packageChanged = clone(baseline.baseline);packageChanged.package.version = '1.4.9';
  rejected(inspectATKCatalog(declared,{...approval(baseline),baseline:packageChanged},input),'ATK_CATALOG_BASELINE_INVALID');
  for (const patch of [{isolatedEntrySha256:'b'.repeat(64)},{protocolVersion:'2026-01-01'}])
    rejected(inspectATKCatalog(declared,approval(baseline),{...input,...patch}),'ATK_CATALOG_CONTEXT_MISMATCH');
  rejected(inspectATKCatalog(manifest({connectionVersion:'v2'}),approval(baseline),input),'ATK_CATALOG_CONTEXT_MISMATCH');
  rejected(createATKCatalogBaseline({...declared,configHash:'0'.repeat(64)},input),'DEMO_MANIFEST_HASH');
  for (const patch of [{isolatedEntrySha256:'a'.repeat(64)+'\n'},{protocolVersion:'2025-11-25\n'}])
    rejected(createATKCatalogBaseline(declared,{...input,...patch}),'ATK_CATALOG_CONTEXT_INVALID');
  rejected(inspectATKCatalog(declared,{...approval(baseline),approvedBaselineHash:baseline.baselineHash+'\n'},input),'ATK_CATALOG_BASELINE_INVALID');
});

test('own JSON copying rejects getter/cycle/prototype/symbol/sparse and nonfinite values with sanitized errors',() => {
  const declared = manifest();let reads = 0;
  const getter = observation();Object.defineProperty(getter.tools[0].inputSchema.properties,'private',{
    enumerable:true,get(){reads++;throw new Error('private-secret');}});
  rejected(createATKCatalogBaseline(declared,getter),'ATK_CATALOG_JSON_INVALID');assert.equal(reads,0);
  for (const invalid of [undefined,NaN,Infinity,()=>{},1n,Symbol('private')]) {
    const input = observation();input.tools[0].inputSchema.private = invalid;
    rejected(createATKCatalogBaseline(declared,input),'ATK_CATALOG_JSON_INVALID');
  }
  const cyclic = observation();cyclic.tools[0].inputSchema.private = cyclic.tools[0];
  rejected(createATKCatalogBaseline(declared,cyclic),'ATK_CATALOG_JSON_INVALID');
  const prototype = observation();prototype.tools[0].inputSchema = Object.create({type:'object'});
  rejected(createATKCatalogBaseline(declared,prototype),'ATK_CATALOG_JSON_INVALID');
  const symbol = observation();symbol.tools[0][Symbol('private')] = 'secret';
  rejected(createATKCatalogBaseline(declared,symbol),'ATK_CATALOG_JSON_INVALID');
  const sparse = observation();sparse.tools[0].inputSchema.enum = new Array(2);
  rejected(createATKCatalogBaseline(declared,sparse),'ATK_CATALOG_JSON_INVALID');
  const hostile = new Proxy({}, {getPrototypeOf(){throw new Error('C:/private secret-value');}});
  const failed = createATKCatalogBaseline(declared,hostile);rejected(failed,'ATK_CATALOG_JSON_INVALID');
  assert.equal(JSON.stringify(failed).includes('private'),false);
});

test('tools, descriptor, aggregate, depth, node and key/string budgets reject oversized declarations',() => {
  const declared = manifest();
  const tooMany = observation();tooMany.tools = Array.from({length:513},(_,i) => ({...tooMany.tools[0],name:'read_'+i}));
  rejected(createATKCatalogBaseline(declared,tooMany),'ATK_CATALOG_LIMIT');
  const longString = observation();longString.tools[0].description = 'x'.repeat(65537);
  rejected(createATKCatalogBaseline(declared,longString),'ATK_CATALOG_LIMIT');
  const descriptor = observation();descriptor.tools[0].description = 'x'.repeat(65536);descriptor.tools[0].title = 'x'.repeat(65536);
  rejected(createATKCatalogBaseline(declared,descriptor),'ATK_CATALOG_LIMIT');
  const aggregate = observation();
  for (let i=0;i<80;i++) aggregate.tools.push({...clone(aggregate.tools[0]),name:'read_'+i,description:'x'.repeat(60000)});
  rejected(createATKCatalogBaseline(declared,aggregate),'ATK_CATALOG_LIMIT');
  const deep = observation();let level = {};deep.tools[0].inputSchema.private = level;
  for (let i=0;i<33;i++) {level.next = {};level = level.next;}
  rejected(createATKCatalogBaseline(declared,deep),'ATK_CATALOG_LIMIT');
  const longKey = observation();longKey.tools[0].inputSchema['x'.repeat(513)] = true;
  rejected(createATKCatalogBaseline(declared,longKey),'ATK_CATALOG_LIMIT');
  const manyNodes = observation();
  for (let i=0;i<101;i++) manyNodes.tools.push({...clone(manyNodes.tools[0]),name:'read_'+i,
    inputSchema:{type:'object',enum:Array(1000).fill(null)}});
  rejected(createATKCatalogBaseline(declared,manyNodes),'ATK_CATALOG_LIMIT');
});

// Fingerprint equality does not establish observed completeness, schema/handler
// semantics or authentic owner approval. No SDK/transport/adapter integration here.
