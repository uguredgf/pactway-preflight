// Acceptance sources for the new connection declaration. Not executed here.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createDemoConnectionManifest,verifyDemoConnectionManifest,demoBindingFromManifest,demoReadOnlyDeclaration,PINNED_ATK} from '../src/adapters/demo-connection-manifest.mjs';

const declaration=()=>({schemaVersion:1,id:'campaign-demo',connectionVersion:'connection-v1',accountId:'account-alias',
  environment:'demo',instrument:'AVAX-USDT',profile:'demo',site:'tr',apiOrigin:'https://tr.okx.com',
  authMode:'isolated-demo-api-key',sourceTag:'MCP'});

test('manifest is canonical, frozen and does not claim verified execution',()=>{
  const m=createDemoConnectionManifest(declaration());
  assert.equal(verifyDemoConnectionManifest(m),true);assert.equal(Object.isFrozen(m.config),true);
  const reversed=Object.fromEntries(Object.entries(declaration()).reverse());
  assert.equal(createDemoConnectionManifest(reversed).configHash,m.configHash);
  const read=demoReadOnlyDeclaration(m);
  assert.equal(read.writeEnabled,false);assert.equal(read.verification,'DECLARATION_ONLY');
  assert.equal(read.args.includes('--read-only'),true);assert.equal(read.readTools.some(name=>name.includes('place')||name.includes('cancel')),false);
  assert.equal(read.package.version,'1.4.8');assert.equal(PINNED_ATK.entrySha256.length,64);
});
test('demo scope, explicit site/origin and API-key-only declaration are required',()=>{
  for(const patch of [{environment:'live'},{instrument:'BTC-USDT'},{site:'unknown'},
    {apiOrigin:'https://www.okx.com'},{apiOrigin:'http://tr.okx.com'},
    {apiOrigin:'https://tr.okx.com.evil.example'},{apiOrigin:'https://tr.okx.com:8443'},
    {apiOrigin:'https://tr.okx.com/path'},{authMode:'oauth-fallback'}])
    assert.throws(()=>createDemoConnectionManifest({...declaration(),...patch}));
});
test('secret, extra fields and accessors are rejected without invoking a getter',()=>{
  assert.throws(()=>createDemoConnectionManifest({...declaration(),apiKey:'test-secret'}),{code:'DEMO_MANIFEST_FIELDS'});
  let reads=0;const input=declaration();Object.defineProperty(input,'profile',{get(){reads++;return 'demo';},enumerable:true});
  assert.throws(()=>createDemoConnectionManifest(input));assert.equal(reads,0);
});
test('identity or declared target mutation breaks the original commitment',()=>{
  const m=createDemoConnectionManifest(declaration());
  for(const patch of [{accountId:'other-account'},{connectionVersion:'connection-v2'},{profile:'other-profile'},{sourceTag:'other'}])
    assert.equal(verifyDemoConnectionManifest({...m,config:{...m.config,...patch}}),false);
  assert.equal(verifyDemoConnectionManifest({...m,package:{...m.package,version:'1.4.9'}}),false);
  assert.equal(verifyDemoConnectionManifest({...m,package:{...m.package,entrySha256:'0'.repeat(64)}}),false);
  const context=demoBindingFromManifest(m);assert.equal(context.connectionHash,m.configHash);
  assert.equal(context.accountId,'account-alias');
  assert.throws(()=>demoBindingFromManifest({...m,configHash:'0'.repeat(64)}),{code:'DEMO_MANIFEST_HASH'});
});
