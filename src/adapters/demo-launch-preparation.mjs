import {PINNED_ATK,createDemoConnectionManifest,verifyDemoConnectionManifest} from './demo-connection-manifest.mjs';

const CONFIG_KEYS = ['profile','site','apiOrigin','demo','readOnly','modules','sourceTag','tomlState'];
const CREDENTIAL_KEYS = ['OKX_API_KEY','OKX_SECRET_KEY','OKX_PASSPHRASE'];
const FINGERPRINT_KEYS = ['ok','code','verification','package','connectionHash','entryBytes','writeEnabled'];
const FAILURE_CODES = new Set(['DEMO_MANIFEST_HASH','DEMO_PREPARATION_FIELDS','DEMO_CONFIGURATION_FIELDS',
  'DEMO_CONFIGURATION_MISMATCH','DEMO_TOML_UNRESOLVED','DEMO_SOURCE_TAG_UNSUPPORTED',
  'DEMO_CREDENTIALS_INVALID','DEMO_ENVIRONMENT_INVALID','DEMO_ENVIRONMENT_OVERRIDE',
  'DEMO_ENVIRONMENT_TARGET_MISMATCH','DEMO_FINGERPRINT_INVALID']);
const BLOCKERS = Object.freeze(['PILOT_ROUTING_UNRESOLVED','ACTUAL_DEMO_ACCOUNT_UNVERIFIED',
  'SUPPLIED_SNAPSHOTS_NOT_ATTESTED']);

function record(input,keys,code) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
      || ![Object.prototype,null].includes(Object.getPrototypeOf(input))
      || Object.getOwnPropertySymbols(input).length) throw code;
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const names = Object.keys(descriptors);
  if (names.length > 256 || (keys && (names.length !== keys.length || names.some(key => !keys.includes(key))))) throw code;
  const values = Object.create(null);
  for (const key of names) {
    if (!Object.hasOwn(descriptors[key],'value')) throw code;
    values[key] = descriptors[key].value;
  }
  return values;
}

function fingerprint(snapshot,connectionHash) {
  const value = record(snapshot,FINGERPRINT_KEYS,'DEMO_FINGERPRINT_INVALID');
  const pinned = record(value.package,['name','version','entrySha256'],'DEMO_FINGERPRINT_INVALID');
  if (value.ok !== true || value.code !== 'ATK_PACKAGE_FINGERPRINT_MATCH'
      || value.verification !== 'INSTALLED_FILES_ONLY' || value.writeEnabled !== false
      || value.connectionHash !== connectionHash || !Number.isSafeInteger(value.entryBytes)
      || value.entryBytes < 1 || value.entryBytes > 8 * 1024 * 1024
      || Object.keys(pinned).some(key => pinned[key] !== PINNED_ATK[key])) throw 'DEMO_FINGERPRINT_INVALID';
}

function configuration(snapshot,declared) {
  const value = record(snapshot,CONFIG_KEYS,'DEMO_CONFIGURATION_FIELDS');
  for (const key of ['profile','site','apiOrigin','sourceTag'])
    if (value[key] !== declared[key]) throw 'DEMO_CONFIGURATION_MISMATCH';
  if (value.demo !== true || value.readOnly !== true || value.modules !== 'market,spot,account') throw 'DEMO_CONFIGURATION_MISMATCH';
  if (!['ABSENT','EMPTY'].includes(value.tomlState)) throw 'DEMO_TOML_UNRESOLVED';
  // Installed MCP 1.4.8 parseCli has no source-tag option; main sets sourceTag: "MCP".
  if (value.sourceTag !== 'MCP') throw 'DEMO_SOURCE_TAG_UNSUPPORTED';
}

function credentials(input) {
  const value = record(input,CREDENTIAL_KEYS,'DEMO_CREDENTIALS_INVALID');
  for (const key of CREDENTIAL_KEYS) {
    const secret = value[key];
    if (typeof secret !== 'string' || !secret.length || secret.length > 4096
        || secret.trim() !== secret || /[\x00-\x1f\x7f]/.test(secret)) throw 'DEMO_CREDENTIALS_INVALID';
  }
  // Validation only: credentials are never returned, hashed, staged or persisted.
}

function environment(input,declared) {
  const values = record(input,null,'DEMO_ENVIRONMENT_INVALID');
  const seen = new Set();
  for (const key of Object.keys(values)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key)
        || typeof values[key] !== 'string' || values[key].length > 8192 || values[key].includes('\0')) throw 'DEMO_ENVIRONMENT_INVALID';
    const name = key.toUpperCase();
    if (seen.has(name)) throw 'DEMO_ENVIRONMENT_INVALID';
    seen.add(name);
    if (name === 'OKX_SITE' || name === 'OKX_DEMO') {
      // Case variants are ambiguous across OSes. Permit only exact source-evidenced names.
      if (key !== name || (name === 'OKX_SITE' ? values[key] !== declared.site : !['1','true'].includes(values[key])))
        throw 'DEMO_ENVIRONMENT_TARGET_MISMATCH';
      continue;
    }
    // Complete credentials belong only in the private input, never inherited env.
    // Reject even empty override values: empty base-url variables change SDK behavior.
    if (/^OKX_|^NODE_|^SSL_|^OPENSSL_|^LD_|^DYLD_|^NPM_CONFIG_/.test(name)
        || ['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY','GLOBAL_AGENT_HTTP_PROXY',
          'PATH','PATHEXT','HOME','USERPROFILE','HOMEDRIVE','HOMEPATH','XDG_CONFIG_HOME'].includes(name))
      throw 'DEMO_ENVIRONMENT_OVERRIDE';
    // Unrelated application environment (including secrets) is ignored, never copied.
  }
}

/** Pure operator-supplied preparation, with no filesystem/env/process/SDK/network IO.
 * Configuration (including ABSENT/EMPTY TOML), credential authenticity, and the
 * fingerprint report are supplied snapshots, NOT independently observed proof.
 * A fabricated correctly-shaped fingerprint cannot be authenticated by this helper.
 * Bundled Pilot may resolve another host and retry resolution after network failure
 * even when hasCustomProxy skips initial resolution. There is no evidenced disable
 * CLI flag. Every report therefore blocks launch, regardless of valid snapshots.
 */
export function prepareDemoLaunch(manifest,fingerprintSnapshot,input) {
  if (!verifyDemoConnectionManifest(manifest)) return report(false,'DEMO_MANIFEST_HASH');
  try {
    const manifestValues = record(manifest,['config','package','configHash'],'DEMO_MANIFEST_HASH');
    // Recreate a safe normalized declaration before reading config values or building args.
    const declaration = createDemoConnectionManifest(manifestValues.config);
    if (declaration.configHash !== manifestValues.configHash) throw 'DEMO_MANIFEST_HASH';
    fingerprint(fingerprintSnapshot,declaration.configHash);
    const supplied = record(input,['configuration','credentials','inheritedEnvironment'],'DEMO_PREPARATION_FIELDS');
    configuration(supplied.configuration,declaration.config);
    credentials(supplied.credentials);
    environment(supplied.inheritedEnvironment,declaration.config);
    const c = declaration.config;
    return report(true,'DEMO_CONFIGURATION_PREPARED',{
      verification:'CONFIGURATION_PREPARED_ONLY',fingerprintEvidence:'SUPPLIED_SNAPSHOT_ONLY',
      args:Object.freeze(['--profile',c.profile,'--demo','--site',c.site,'--modules','market,spot,account','--read-only']),
    });
  } catch (code) {
    return report(false,FAILURE_CODES.has(code) ? code : 'DEMO_PREPARATION_FIELDS');
  }
}

function report(ok,code,extra = {}) {
  return Object.freeze({ok,code,verification:'UNVERIFIED',...extra,requiredBlockers:BLOCKERS,
    launchAllowed:false,writeEnabled:false,actualAccountVerified:false,routeVerified:false});
}
