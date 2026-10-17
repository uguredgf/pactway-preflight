// Unexecuted source acceptance cases. Upstream is read as text, never imported.
// Do not eval, import, write, spawn or otherwise execute the derived source.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {draftFixedRoutingEntry} from '../src/adapters/atk-fixed-routing-draft.mjs';
import {PINNED_ATK,createDemoConnectionManifest} from '../src/adapters/demo-connection-manifest.mjs';

const upstreamPath = new URL('../node_modules/@okx_ai/okx-trade-mcp/dist/index.js',import.meta.url);
const licensePath = new URL('../node_modules/@okx_ai/okx-trade-mcp/LICENSE',import.meta.url);
const upstream = () => readFile(upstreamPath,'utf8');
const manifest = (patch = {}) => createDemoConnectionManifest({schemaVersion:1,id:'demo',connectionVersion:'v1',
  accountId:'alias',environment:'demo',instrument:'AVAX-USDT',profile:'demo',site:'tr',
  apiOrigin:'https://tr.okx.com',authMode:'isolated-demo-api-key',sourceTag:'MCP',...patch});
const sha256 = text => createHash('sha256').update(text,'utf8').digest('hex');
function disabled(result) {
  for (const key of ['launchAllowed','writeEnabled','routeVerified','actualAccountVerified']) assert.equal(result[key],false);
  assert.equal(Object.isFrozen(result),true);
  assert.equal(Object.isFrozen(result.requiredBlockers),true);
  assert.equal(result.requiredBlockers.includes('CONFIG_AUTH_LOADING_UNRESOLVED'),true);
  assert.equal(result.requiredBlockers.includes('DEPENDENCY_PROVENANCE_UNVERIFIED'),true);
}
function rejected(result,code) { disabled(result);assert.equal(result.ok,false);assert.equal(result.code,code);assert.equal(result.source,undefined); }

test('exact upstream text produces separately committed source draft without executable approval',async () => {
  const text = await upstream();const declared = manifest();
  const draft = draftFixedRoutingEntry(declared,text);
  disabled(draft);assert.equal(draft.ok,true);assert.equal(draft.verification,'SOURCE_DRAFT_ONLY');
  assert.equal(draft.upstreamSha256,PINNED_ATK.entrySha256);
  assert.equal(sha256(text),PINNED_ATK.entrySha256);
  assert.equal(draft.derivedSha256,sha256(draft.source));
  assert.notEqual(draft.derivedSha256,draft.upstreamSha256);
  assert.equal(draft.connectionHash,declared.configHash);
  assert.equal(draft.patchId,'mandateguard-atk148-fixed-routing-source-v1');
  assert.equal(draftFixedRoutingEntry(declared,text).derivedSha256,draft.derivedSha256);
  assert.equal(draft.source.startsWith('#!/usr/bin/env node\n/*\nMIT License'),true);
  const license = (await readFile(licensePath,'utf8')).replaceAll('\r\n','\n').trim();
  assert.equal(draft.source.includes(license),true);
  const bundled = text.slice(text.indexOf('/*! Bundled license information:'),text.indexOf('//# sourceMappingURL='));
  assert.equal(draft.source.includes(bundled),true);
  assert.equal(draft.source.includes('//# sourceMappingURL='),false);
});

test('manifest/tag and upstream byte changes reject without partial source',async () => {
  const text = await upstream();const declared = manifest();
  rejected(draftFixedRoutingEntry({...declared,configHash:'0'.repeat(64)},text),'DEMO_MANIFEST_HASH');
  rejected(draftFixedRoutingEntry({...declared,package:{...PINNED_ATK,entrySha256:'0'.repeat(64)}},text),'DEMO_MANIFEST_HASH');
  rejected(draftFixedRoutingEntry(manifest({sourceTag:'other'}),text),'ATK_DRAFT_SOURCE_TAG_UNSUPPORTED');
  for (const altered of [text+'\n',text.replace('var PilotManager = class {','var PilotManager = class /* changed */ {'),
    text.replace('installEnvProxyDispatcher();','// removed')])
    rejected(draftFixedRoutingEntry(declared,altered),'ATK_DRAFT_UPSTREAM_HASH_MISMATCH');
  rejected(draftFixedRoutingEntry(declared,{toString(){throw new Error('must not coerce');}}),'ATK_DRAFT_SOURCE_INVALID');
  rejected(draftFixedRoutingEntry(declared,'a'.repeat(8*1024*1024+1)),'ATK_DRAFT_SOURCE_TOO_LARGE');
  rejected(draftFixedRoutingEntry(declared,'€'.repeat(3*1024*1024)),'ATK_DRAFT_SOURCE_TOO_LARGE');
});

test('different approved manifest binds different source/hash without changing upstream pin',async () => {
  const text = await upstream();const tr = draftFixedRoutingEntry(manifest(),text);
  const globalManifest = manifest({site:'global',apiOrigin:'https://www.okx.com',profile:'isolated'});
  const global = draftFixedRoutingEntry(globalManifest,text);
  disabled(global);assert.equal(global.ok,true);
  assert.equal(global.connectionHash,globalManifest.configHash);
  assert.equal(global.upstreamSha256,tr.upstreamSha256);
  assert.notEqual(global.derivedSha256,tr.derivedSha256);
});

// These cover source commitments, invalid inputs and licensing, not transport behavior.
// No derived entry is emitted to disk or executed. Runtime negative transport cases,
// dependency integrity and actual account evidence remain separate future work.
