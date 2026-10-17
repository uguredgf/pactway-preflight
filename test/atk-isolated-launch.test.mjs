// Source-only tests. Not executed. No child process, SDK import or network in
// this file; source comparison is not an OS/dependency/runtime attestation.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createDemoConnectionManifest} from '../src/adapters/demo-connection-manifest.mjs';
import {draftIsolatedDemoEntry} from '../src/adapters/atk-isolated-session-draft.mjs';
import {IsolatedATKLaunch} from '../src/adapters/atk-isolated-launch.mjs';
import {ISOLATED_BOOTSTRAP_SOURCE} from '../src/adapters/atk-isolated-bootstrap-source.mjs';
const upstreamEntryPath=fileURLToPath(new URL('../node_modules/@okx_ai/okx-trade-mcp/dist/index.js',import.meta.url));
const manifest=createDemoConnectionManifest({schemaVersion:1,id:'connection',connectionVersion:'v1',accountId:'account',
  environment:'demo',instrument:'AVAX-USDT',profile:'demo',site:'tr',apiOrigin:'https://tr.okx.com',authMode:'isolated-demo-api-key',sourceTag:'MCP'});
const credentials=()=>({OKX_API_KEY:'fake-key',OKX_SECRET_KEY:'fake-secret',OKX_PASSPHRASE:'fake-passphrase'});
function fixture() {
  const directory=mkdtempSync(join(tmpdir(),'pactway-isolated-')),derivedEntryPath=join(directory,'derived.mjs');
  const draft=draftIsolatedDemoEntry(manifest,readFileSync(upstreamEntryPath,'utf8'));
  assert.equal(draft.ok,true);writeFileSync(derivedEntryPath,draft.source);
  return {directory,derivedEntryPath,draft,options:{manifest,upstreamEntryPath,derivedEntryPath,credentials:credentials()}};
}
test('pinned derived bytes and explicit environment match; secrets are handed off once',async()=>{
  const f=fixture();
  try {
    const privateValues=credentials(),launch=new IsolatedATKLaunch({...f.options,credentials:privateValues,osEnvironment:{TEMP:'C:\\Temp'}});
    privateValues.OKX_API_KEY='later-mutation';
    const description=await launch.inspect();
    assert.equal(description.entrySha256,f.draft.isolatedDerivedSha256);
    assert.deepEqual(description.args,['--profile','demo','--demo','--site','tr','--modules','market,spot,account','--read-only','--no-log']);
    assert.equal(JSON.stringify(description).includes('fake-'),false);
    assert.equal(description.routeVerified,false);assert.equal(description.actualAccountVerified,false);
    const environment=launch.takeEnvironment();
    assert.deepEqual(Object.keys(environment).sort(),['OKX_API_KEY','OKX_PASSPHRASE','OKX_SECRET_KEY','TEMP']);
    assert.equal(environment.OKX_API_KEY,'fake-key');assert.equal(environment.NODE_OPTIONS,undefined);assert.equal(environment.HOME,undefined);
    assert.throws(()=>launch.takeEnvironment(),/LAUNCH_DENIED/);
  } finally {rmSync(f.directory,{recursive:true,force:true});}
});
test('changed derived source, wrong upstream and wrong manifest fail before any environment handoff',async()=>{
  const f=fixture();
  try {
    writeFileSync(f.derivedEntryPath,f.draft.source+'\n// changed');
    const launch=new IsolatedATKLaunch(f.options);
    await assert.rejects(launch.inspect(),/LAUNCH_DENIED/);assert.throws(()=>launch.takeEnvironment(),/LAUNCH_DENIED/);
    writeFileSync(f.derivedEntryPath,f.draft.source);
    const wrong=join(f.directory,'upstream.mjs');writeFileSync(wrong,'not the pinned SDK');
    await assert.rejects(new IsolatedATKLaunch({...f.options,upstreamEntryPath:wrong}).inspect(),/LAUNCH_DENIED/);
    const changed=createDemoConnectionManifest({...manifest.config,site:'global',apiOrigin:'https://www.okx.com'});
    await assert.rejects(new IsolatedATKLaunch({...f.options,manifest:changed}).inspect(),/LAUNCH_DENIED/);
  } finally {rmSync(f.directory,{recursive:true,force:true});}
});
test('ambient overrides, partial credentials and accessors are rejected without reading secrets',()=>{
  const base={manifest,upstreamEntryPath,derivedEntryPath:join(tmpdir(),'uncreated-derived.mjs'),credentials:credentials()};
  for(const name of ['NODE_OPTIONS','HOME','HTTP_PROXY','OKX_SITE'])
    assert.throws(()=>new IsolatedATKLaunch({...base,osEnvironment:{[name]:'bad'}}),/LAUNCH_DENIED/);
  assert.throws(()=>new IsolatedATKLaunch({...base,credentials:{OKX_API_KEY:'fake'}}),/LAUNCH_DENIED/);
  let reads=0;const values=credentials();Object.defineProperty(values,'OKX_SECRET_KEY',{get(){reads++;return 'fake';}});
  assert.throws(()=>new IsolatedATKLaunch({...base,credentials:values}),/LAUNCH_DENIED/);assert.equal(reads,0);
  const discarded=new IsolatedATKLaunch(base);discarded.discard();assert.throws(()=>discarded.takeEnvironment(),/LAUNCH_DENIED/);
});

test('optional Windows bootstrap requires exact reviewed source before credential handoff',async()=>{
  const f=fixture(),bootstrapEntryPath=join(f.directory,'bootstrap.mjs');
  try {
    writeFileSync(bootstrapEntryPath,ISOLATED_BOOTSTRAP_SOURCE);
    const launch=new IsolatedATKLaunch({...f.options,bootstrapEntryPath});
    const inspected=await launch.inspect();assert.equal(inspected.bootstrapEntryPath,bootstrapEntryPath);assert.match(inspected.bootstrapSha256,/^[a-f0-9]{64}$/);
    writeFileSync(bootstrapEntryPath,ISOLATED_BOOTSTRAP_SOURCE+'\n// tampered');
    const changed=new IsolatedATKLaunch({...f.options,bootstrapEntryPath});
    await assert.rejects(changed.inspect(),/LAUNCH_DENIED/);assert.throws(()=>changed.takeEnvironment(),/LAUNCH_DENIED/);
  }finally{rmSync(f.directory,{recursive:true,force:true});}
});
