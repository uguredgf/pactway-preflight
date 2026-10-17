// Unexecuted acceptance source: SDK entry is read as text, never imported or run.
// Do not emit or execute any derived source to conduct these source-commitment tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {draftIsolatedDemoEntry} from '../src/adapters/atk-isolated-session-draft.mjs';
import {draftFixedRoutingEntry} from '../src/adapters/atk-fixed-routing-draft.mjs';
import {PINNED_ATK,createDemoConnectionManifest} from '../src/adapters/demo-connection-manifest.mjs';

const upstreamPath = new URL('../node_modules/@okx_ai/okx-trade-mcp/dist/index.js',import.meta.url);
const licensePath = new URL('../node_modules/@okx_ai/okx-trade-mcp/LICENSE',import.meta.url);
const upstream = () => readFile(upstreamPath,'utf8');
const sha256 = text => createHash('sha256').update(text,'utf8').digest('hex');
const manifest = (patch = {}) => createDemoConnectionManifest({schemaVersion:1,id:'demo',connectionVersion:'v1',
  accountId:'alias',environment:'demo',instrument:'AVAX-USDT',profile:'demo',site:'tr',
  apiOrigin:'https://tr.okx.com',authMode:'isolated-demo-api-key',sourceTag:'MCP',...patch});

function disabled(result) {
  for (const key of ['launchAllowed','writeEnabled','actualAccountVerified','routeVerified']) assert.equal(result[key],false);
  assert.equal(Object.isFrozen(result),true);assert.equal(Object.isFrozen(result.requiredBlockers),true);
  assert.equal(result.requiredBlockers.includes('OS_EXECUTION_PROVENANCE_UNVERIFIED'),true);
  assert.equal(result.requiredBlockers.includes('TOOL_CATALOG_UNVERIFIED'),true);
  assert.equal(result.requiredBlockers.includes('ISOLATED_RUNTIME_UNVERIFIED'),true);
}
function rejected(result,code) {
  disabled(result);assert.equal(result.ok,false);assert.equal(result.code,code);assert.equal(result.source,undefined);
}

test('upstream, routing and isolated commitments stay distinct, deterministic and license-preserving',async () => {
  const text = await upstream();const declared = manifest();
  const routing = draftFixedRoutingEntry(declared,text);
  const isolated = draftIsolatedDemoEntry(declared,text);
  disabled(isolated);assert.equal(isolated.ok,true);
  assert.equal(isolated.verification,'ISOLATED_SOURCE_DRAFT_ONLY');
  assert.equal(isolated.patchId,'pactway-atk148-isolated-session-source-v1');
  assert.equal(isolated.connectionHash,declared.configHash);
  assert.equal(isolated.upstreamSha256,PINNED_ATK.entrySha256);
  assert.equal(isolated.upstreamSha256,sha256(text));
  assert.equal(isolated.routingDerivedSha256,routing.derivedSha256);
  assert.equal(isolated.isolatedDerivedSha256,sha256(isolated.source));
  assert.equal(new Set([isolated.upstreamSha256,isolated.routingDerivedSha256,isolated.isolatedDerivedSha256]).size,3);
  assert.equal(draftIsolatedDemoEntry(declared,text).isolatedDerivedSha256,isolated.isolatedDerivedSha256);
  const license = (await readFile(licensePath,'utf8')).replaceAll('\r\n','\n').trim();
  assert.equal(isolated.source.includes(license),true);
  const bundled = text.slice(text.indexOf('/*! Bundled license information:'),text.indexOf('//# sourceMappingURL='));
  assert.equal(isolated.source.includes(bundled),true);
  assert.equal(isolated.source.includes('//# sourceMappingURL='),false);
});

test('manifest, source-tag, pin, source type and byte bounds fail with no partial source or secret disclosure',async () => {
  const text = await upstream();const declared = manifest();
  rejected(draftIsolatedDemoEntry({...declared,configHash:'0'.repeat(64)},text),'DEMO_MANIFEST_HASH');
  rejected(draftIsolatedDemoEntry({...declared,package:{...PINNED_ATK,version:'1.4.9'}},text),'DEMO_MANIFEST_HASH');
  rejected(draftIsolatedDemoEntry(manifest({sourceTag:'other'}),text),'ATK_DRAFT_SOURCE_TAG_UNSUPPORTED');
  rejected(draftIsolatedDemoEntry(declared,text+'\n'),'ATK_DRAFT_UPSTREAM_HASH_MISMATCH');
  rejected(draftIsolatedDemoEntry(declared,'x'.repeat(8*1024*1024+1)),'ATK_DRAFT_SOURCE_TOO_LARGE');
  rejected(draftIsolatedDemoEntry(declared,'€'.repeat(3*1024*1024)),'ATK_DRAFT_SOURCE_TOO_LARGE');
  let reads = 0;
  const privateSource = {toString(){reads++;throw new Error('private-fixture-value');}};
  rejected(draftIsolatedDemoEntry(declared,privateSource),'ATK_DRAFT_SOURCE_INVALID');assert.equal(reads,0);
  const secret = 'private-fixture-not-embedded-746b';
  const secretHash = sha256(secret);
  for (const result of [draftIsolatedDemoEntry(declared,text+secret),
    draftIsolatedDemoEntry({...declared,credential:secret},text)]) {
    disabled(result);assert.equal(result.ok,false);assert.equal(result.source,undefined);
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes(secret),false);assert.equal(serialized.includes(secretHash),false);
  }
  const hostile = new Proxy({}, {getPrototypeOf(){throw new Error(secret);}});
  rejected(draftIsolatedDemoEntry(hostile,text),'DEMO_MANIFEST_HASH');
});

test('approved identity/profile/site changes rebind both derived commitments independently of upstream',async () => {
  const text = await upstream();const first = draftIsolatedDemoEntry(manifest(),text);
  const changed = manifest({profile:'isolated',site:'global',apiOrigin:'https://www.okx.com',connectionVersion:'v2'});
  const second = draftIsolatedDemoEntry(changed,text);
  disabled(second);assert.equal(second.ok,true);
  assert.equal(second.connectionHash,changed.configHash);
  assert.equal(second.upstreamSha256,first.upstreamSha256);
  assert.notEqual(second.routingDerivedSha256,first.routingDerivedSha256);
  assert.notEqual(second.isolatedDerivedSha256,first.isolatedDerivedSha256);
  assert.deepEqual(Object.keys(second).sort(),['ok','code','verification','source','patchId','connectionHash',
    'upstreamSha256','routingDerivedSha256','isolatedDerivedSha256','requiredBlockers','launchAllowed',
    'writeEnabled','actualAccountVerified','routeVerified'].sort());
});

// Transport/startup/environment behavior, parser correctness, dependency integrity
// and OS process isolation require future explicit runtime acceptance, not marker tests.
