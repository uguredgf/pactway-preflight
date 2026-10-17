// Not run. These cases inspect source transformations and catalogs without
// executing the derived SDK, loading credentials, spawning or using a network.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createDemoConnectionManifest} from '../src/adapters/demo-connection-manifest.mjs';
import {draftExecutionDemoEntry} from '../src/adapters/atk-execution-entry.mjs';
import {createATKCatalogBaseline,inspectATKCatalog} from '../src/adapters/atk-catalog-fingerprint.mjs';
import {ReadOnlyATK,inspectDemoRuntime} from '../src/adapters/atk.mjs';
import {Store} from '../src/persistence/store.mjs';
import {catalog} from './support/stdio-catalog.mjs';

const manifest=createDemoConnectionManifest({schemaVersion:1,id:'connection',connectionVersion:'v1',accountId:'account',
  environment:'demo',instrument:'AVAX-USDT',profile:'demo',site:'tr',apiOrigin:'https://tr.okx.com',authMode:'isolated-demo-api-key',sourceTag:'MCP'});
test('execution transformation keeps pinning and exact one-use POST fence',()=>{
  const source=readFileSync(new URL('../node_modules/@okx_ai/okx-trade-mcp/dist/index.js',import.meta.url),'utf8');
  const result=draftExecutionDemoEntry(manifest,source);
  assert.equal(result.ok,true);assert.equal(result.writeEnabled,false);
  assert.ok(result.source.includes('mandateGuardPackets.delete(options.body)'));
  assert.ok(result.source.includes('Date.now() >= packet.expiresAtMs'));
  assert.ok(result.source.includes('redirect:"error"'));
  assert.ok(result.source.includes('client.privatePost(path,body,undefined,false)'));
  assert.ok(result.source.includes('JSON.stringify(expected) !== packet.bodyText'));
  assert.ok(result.source.includes('used.add(args.clOrdId)'));
  assert.ok(result.source.includes('async handleNetworkFailure() { return false; }'));
  assert.equal(draftExecutionDemoEntry(manifest,source+'\n').ok,false);
});
test('execution approval differs from read-only approval and permits only two named writes',()=>{
  const writes=['spot_place_order','spot_cancel_order'].map(name=>({name,inputSchema:{type:'object',properties:{}},
    annotations:{readOnlyHint:false,destructiveHint:name==='spot_cancel_order'}}));
  const algo={name:'spot_get_algo_orders',inputSchema:{type:'object',properties:{}},annotations:{readOnlyHint:true,destructiveHint:false}};
  const observed={isolatedEntrySha256:'a'.repeat(64),protocolVersion:'2025-06-18',tools:[...catalog,algo,...writes]};
  const result=createATKCatalogBaseline(manifest,observed,{execution:true});
  assert.equal(result.ok,true);assert.equal(result.baseline.schemaVersion,2);
  const approval={baseline:result.baseline,approvedBaselineHash:result.baselineHash};
  assert.equal(inspectATKCatalog(manifest,approval,observed,{execution:true}).ok,true);
  assert.equal(inspectATKCatalog(manifest,approval,observed).ok,false);
  assert.equal(createATKCatalogBaseline(manifest,{...observed,tools:[...observed.tools,
    {...writes[0],name:'spot_amend_order'}]},{execution:true}).ok,false);
});
test('a forged runtime, including an object with the right prototype, cannot register',()=>{
  const directory=mkdtempSync(join(tmpdir(),'pactway-runtime-brand-')),store=new Store(directory);
  try {
    for(const client of [{executionContext(){return {verified:true};}},Object.create(ReadOnlyATK.prototype)]) {
      assert.throws(()=>inspectDemoRuntime(client,store,Date.now()));
      assert.throws(()=>store.attachDemoRuntime(client));
    }
    assert.throws(()=>store.demoRuntimeContext(),{code:'FINAL_EVIDENCE_NOT_CONNECTED'});
    assert.throws(()=>new ReadOnlyATK({nodePath:process.execPath,entryPath:process.execPath,execution:true}),
      {code:'ATK_EXECUTION_REQUIRES_ISOLATION'});
  } finally {store.close();rmSync(directory,{recursive:true,force:true});}
});
