// Acceptance sources only. No execution occurred during implementation.
import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareDemoLaunch} from '../src/adapters/demo-launch-preparation.mjs';
import {createDemoConnectionManifest,PINNED_ATK} from '../src/adapters/demo-connection-manifest.mjs';

const makeManifest = (patch = {}) => createDemoConnectionManifest({schemaVersion:1,id:'demo',connectionVersion:'v1',
  accountId:'alias',environment:'demo',instrument:'AVAX-USDT',profile:'demo',site:'tr',
  apiOrigin:'https://tr.okx.com',authMode:'isolated-demo-api-key',sourceTag:'MCP',...patch});
const makeFingerprint = manifest => ({ok:true,code:'ATK_PACKAGE_FINGERPRINT_MATCH',verification:'INSTALLED_FILES_ONLY',
  package:{...PINNED_ATK},connectionHash:manifest.configHash,entryBytes:521863,writeEnabled:false});
const makeInput = () => ({configuration:{profile:'demo',site:'tr',apiOrigin:'https://tr.okx.com',demo:true,
  readOnly:true,modules:'market,spot,account',sourceTag:'MCP',tomlState:'ABSENT'},
  credentials:{OKX_API_KEY:'private-fixture-key',OKX_SECRET_KEY:'private-fixture-secret',OKX_PASSPHRASE:'private-fixture-passphrase'},
  inheritedEnvironment:{}});
const prepared = (manifest,input = makeInput(),fingerprint = makeFingerprint(manifest)) => prepareDemoLaunch(manifest,fingerprint,input);
function disabled(result) {
  for (const key of ['launchAllowed','writeEnabled','actualAccountVerified','routeVerified']) assert.equal(result[key],false);
  assert.equal(Object.isFrozen(result),true);
  assert.equal(Object.isFrozen(result.requiredBlockers),true);
  assert.equal(result.requiredBlockers.includes('PILOT_ROUTING_UNRESOLVED'),true);
  assert.equal(result.requiredBlockers.includes('SUPPLIED_SNAPSHOTS_NOT_ATTESTED'),true);
}
function rejected(result,code) { disabled(result);assert.equal(result.ok,false);assert.equal(result.code,code);assert.equal(result.args,undefined); }

test('matching supplied snapshots prepare only evidenced read-only args; launch remains disabled',() => {
  const manifest = makeManifest();
  for (const tomlState of ['ABSENT','EMPTY']) {
    const input = makeInput();input.configuration.tomlState = tomlState;
    const result = prepared(manifest,input);
    disabled(result);assert.equal(result.ok,true);
    assert.equal(result.verification,'CONFIGURATION_PREPARED_ONLY');
    assert.equal(result.fingerprintEvidence,'SUPPLIED_SNAPSHOT_ONLY');
    assert.deepEqual(result.args,['--profile','demo','--demo','--site','tr','--modules','market,spot,account','--read-only']);
    assert.equal(Object.isFrozen(result.args),true);
  }
});

test('manifest commitment fails before private input getters',() => {
  let reads = 0;const input = {get credentials(){reads++;throw new Error('private');}};
  const manifest = makeManifest();
  rejected(prepared({...manifest,configHash:'0'.repeat(64)},input),'DEMO_MANIFEST_HASH');
  rejected(prepared({...manifest,config:{...manifest.config,environment:'live'}},input),'DEMO_MANIFEST_HASH');
  assert.equal(reads,0);
});

test('partial, empty, whitespace, control, extra and oversized credentials fail without disclosure',() => {
  const manifest = makeManifest();
  for (const key of ['OKX_API_KEY','OKX_SECRET_KEY','OKX_PASSPHRASE']) {
    for (const value of [undefined,'',' ',' credential','credential\n','x'.repeat(4097),{secret:'private'}]) {
      const input = makeInput();input.credentials[key] = value;
      rejected(prepared(manifest,input),'DEMO_CREDENTIALS_INVALID');
    }
    const input = makeInput();delete input.credentials[key];
    rejected(prepared(manifest,input),'DEMO_CREDENTIALS_INVALID');
  }
  const input = makeInput();input.credentials.EXTRA_SECRET = 'extra-private';
  rejected(prepared(manifest,input),'DEMO_CREDENTIALS_INVALID');
});

test('scope, target, module, read-only and TOML discrepancies fail',() => {
  const manifest = makeManifest();
  for (const patch of [{profile:'other'},{site:'global'},{apiOrigin:'https://www.okx.com'},
    {demo:false},{readOnly:false},{modules:'all'},{modules:['market','spot','account']},{sourceTag:'other'}]) {
    const input = makeInput();Object.assign(input.configuration,patch);
    rejected(prepared(manifest,input),'DEMO_CONFIGURATION_MISMATCH');
  }
  for (const tomlState of ['POPULATED','UNKNOWN',null]) {
    const input = makeInput();input.configuration.tomlState = tomlState;
    rejected(prepared(manifest,input),'DEMO_TOML_UNRESOLVED');
  }
  const custom = makeManifest({sourceTag:'custom'});const input = makeInput();input.configuration.sourceTag = 'custom';
  rejected(prepared(custom,input),'DEMO_SOURCE_TAG_UNSUPPORTED');
});

test('unknown fields, accessors, nested cycles and inherited properties are rejected',() => {
  const manifest = makeManifest();
  const extra = makeInput();extra.configuration.proxyUrl = 'https://private.example';
  rejected(prepared(manifest,extra),'DEMO_CONFIGURATION_FIELDS');
  let reads = 0;const accessor = makeInput();
  Object.defineProperty(accessor.configuration,'profile',{enumerable:true,get(){reads++;return 'demo';}});
  rejected(prepared(manifest,accessor),'DEMO_CONFIGURATION_FIELDS');assert.equal(reads,0);
  const cyclic = makeInput();cyclic.configuration.profile = cyclic.configuration;
  rejected(prepared(manifest,cyclic),'DEMO_CONFIGURATION_MISMATCH');
  const inherited = makeInput();inherited.configuration = Object.create(inherited.configuration);
  rejected(prepared(manifest,inherited),'DEMO_CONFIGURATION_FIELDS');
  const missingEnvironment = makeInput();delete missingEnvironment.inheritedEnvironment;
  rejected(prepared(manifest,missingEnvironment),'DEMO_PREPARATION_FIELDS');
});

test('base-url, proxy, auth binary, Pilot and runtime overrides fail even when empty',() => {
  const manifest = makeManifest();
  for (const key of ['OKX_API_BASE_URL','HTTP_PROXY','https_proxy','ALL_PROXY','NO_PROXY','OKX_AUTH_BIN',
    'OKX_PILOT_BINARY_PATH','OKX_PILOT_CACHE_PATH','NODE_OPTIONS','NODE_PATH','NODE_TLS_REJECT_UNAUTHORIZED',
    'SSL_CERT_FILE','LD_PRELOAD','DYLD_INSERT_LIBRARIES','PATH','HOME','OKX_API_KEY','OKX_SECRET_KEY','OKX_PASSPHRASE']) {
    const input = makeInput();input.inheritedEnvironment[key] = '';
    rejected(prepared(manifest,input),'DEMO_ENVIRONMENT_OVERRIDE');
  }
});

test('explicit inherited target values must agree and environment accessors/cycles fail',() => {
  const manifest = makeManifest();
  for (const env of [{OKX_SITE:'global'},{OKX_DEMO:'false'},{okx_site:'tr'},{OKX_SITE:'tr',okx_site:'tr'}]) {
    const input = makeInput();input.inheritedEnvironment = env;
    const result = prepared(manifest,input);disabled(result);assert.equal(result.ok,false);
  }
  const input = makeInput();input.inheritedEnvironment = {OKX_SITE:'tr',OKX_DEMO:'1'};
  assert.equal(prepared(manifest,input).ok,true);
  input.inheritedEnvironment = {cycle:input};
  rejected(prepared(manifest,input),'DEMO_ENVIRONMENT_INVALID');
  let reads = 0;input.inheritedEnvironment = {get OPENAI_API_KEY(){reads++;return 'private';}};
  rejected(prepared(manifest,input),'DEMO_ENVIRONMENT_INVALID');assert.equal(reads,0);
});

test('altered fingerprint fields/pins and additional paths fail; shape alone cannot authenticate a forgery',() => {
  const manifest = makeManifest();
  for (const patch of [{ok:false},{code:'MATCH'},{verification:'ATTESTED'},{writeEnabled:true},
    {connectionHash:'0'.repeat(64)},{entryBytes:0},{entryBytes:8*1024*1024+1},{absolutePath:'C:/private'},
    {package:{...PINNED_ATK,version:'1.4.9'}},{package:{...PINNED_ATK,entrySha256:'0'.repeat(64)}}]) {
    rejected(prepared(manifest,makeInput(),{...makeFingerprint(manifest),...patch}),'DEMO_FINGERPRINT_INVALID');
  }
  // This deliberately constructed fixture is a supplied snapshot, not file evidence.
  const shapeOnly = prepared(manifest);disabled(shapeOnly);
  assert.equal(shapeOnly.fingerprintEvidence,'SUPPLIED_SNAPSHOT_ONLY');
  assert.equal(shapeOnly.ok,true);
});

test('reports never copy credentials, inherited secrets, hashes of secrets or arbitrary errors',() => {
  const manifest = makeManifest();const input = makeInput();
  input.inheritedEnvironment = {OPENAI_API_KEY:'private-model-secret',APP_SECRET:'private-app-secret'};
  const result = prepared(manifest,input);disabled(result);assert.equal(result.ok,true);
  const encoded = JSON.stringify(result);
  for (const secret of [...Object.values(input.credentials),...Object.values(input.inheritedEnvironment)]) assert.equal(encoded.includes(secret),false);
  assert.deepEqual(Object.keys(result).sort(),['ok','code','verification','fingerprintEvidence','args','requiredBlockers',
    'launchAllowed','writeEnabled','actualAccountVerified','routeVerified'].sort());
  const hostile = new Proxy({}, {getPrototypeOf(){throw new Error('C:/private private-app-secret');}});
  const failed = prepared(manifest,hostile);rejected(failed,'DEMO_PREPARATION_FIELDS');
  assert.equal(JSON.stringify(failed).includes('private'),false);
});
