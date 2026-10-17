import {createHash} from 'node:crypto';
import {createDemoConnectionManifest,verifyDemoConnectionManifest} from './demo-connection-manifest.mjs';
import {draftFixedRoutingEntry} from './atk-fixed-routing-draft.mjs';

const PATCH_ID = 'pactway-atk148-isolated-session-source-v1';
const CODES = new Set(['DEMO_MANIFEST_HASH','ATK_DRAFT_SOURCE_TAG_UNSUPPORTED','ATK_DRAFT_SOURCE_INVALID',
  'ATK_DRAFT_SOURCE_TOO_LARGE','ATK_DRAFT_UPSTREAM_HASH_MISMATCH','ATK_DRAFT_ANCHOR_MISMATCH',
  'ATK_ISOLATED_ANCHOR_MISMATCH','ATK_ISOLATED_SOURCE_INVALID']);
const BLOCKERS = Object.freeze(['DERIVED_ARTIFACT_NOT_EMITTED_OR_VERIFIED','DEPENDENCY_PROVENANCE_UNVERIFIED',
  'OS_EXECUTION_PROVENANCE_UNVERIFIED','ACTUAL_DEMO_ACCOUNT_UNVERIFIED','TOOL_CATALOG_UNVERIFIED',
  'ISOLATED_RUNTIME_UNVERIFIED']);
const sha256 = text => createHash('sha256').update(text,'utf8').digest('hex');
const OLD_CATCH = [
  'main().catch((error) => {',
  '  const payload = toToolErrorPayload(error);',
  '  process.stderr.write(`${JSON.stringify(payload, null, 2)}',
  '`);',
  '  process.exitCode = 1;',
  '});',
].join('\n');
const STATIC_CATCH = String.raw`main().catch(() => {
  process.stderr.write('{"ok":false,"code":"PACTWAY_ISOLATED_STARTUP_DENIED"}\n');
  process.exitCode = 1;
});`;

function uniqueIndex(source,anchor) {
  const index = source.indexOf(anchor);
  if (index < 0 || source.indexOf(anchor,index + anchor.length) !== -1) throw 'ATK_ISOLATED_ANCHOR_MISMATCH';
  return index;
}

function isolatedMain(config) {
  const args = ['--profile',config.profile,'--demo','--site',config.site,'--modules',
    'market,spot,account','--read-only','--no-log'];
  return '// Pactway isolated session SOURCE DRAFT; no launch authorization.\n'
    + 'async function main() {\n'
    + `  const expectedArgs = Object.freeze(${JSON.stringify(args)});\n`
    + String.raw`  // This guard runs after dependency/top-level evaluation; it cannot attest the OS launch.
  if (!Array.isArray(process.execArgv) || process.execArgv.length !== 0) mandateGuardDeny();
  const actualArgs = process.argv.slice(2);
  if (actualArgs.length !== expectedArgs.length
      || actualArgs.some((value, index) => value !== expectedArgs[index])) mandateGuardDeny();
  // Future launcher must supply this exact environment allowlist, not inherit process.env.
  // No PATH, HOME, profile/TOML, proxy, TLS, loader or unrelated application secrets.
  const allowedEnvironment = Object.freeze(["SystemRoot", "WINDIR", "TEMP", "TMP",
    "OKX_API_KEY", "OKX_SECRET_KEY", "OKX_PASSPHRASE"]);
  if (Object.getOwnPropertySymbols(process.env).length) mandateGuardDeny();
  const environment = Object.getOwnPropertyDescriptors(process.env);
  for (const name of Object.keys(environment)) {
    const field = environment[name];
    if (!allowedEnvironment.includes(name) || !Object.hasOwn(field, "value")
        || typeof field.value !== "string" || !field.value.length || field.value.length > 4096
        || /[\x00-\x1f\x7f]/.test(field.value)) mandateGuardDeny();
  }
  for (const name of ["OKX_API_KEY", "OKX_SECRET_KEY", "OKX_PASSPHRASE"])
    if (!Object.hasOwn(environment, name)) mandateGuardDeny();
  // Private values are read only inside the hypothetical derived process.
  // They are never embedded by the source transformer, logged, hashed or persisted.
  const config = mandateGuardConfiguration({
    apiKey: environment.OKX_API_KEY?.value,
    secretKey: environment.OKX_SECRET_KEY?.value,
    passphrase: environment.OKX_PASSPHRASE?.value,
    hasAuth: true,
    profile: mandateGuardFixedProfile,
    baseUrl: mandateGuardFixedOrigin,
    timeoutMs: 15000,
    modules: Object.freeze(["market", "spot", "account"]),
    readOnly: true,
    demo: true,
    site: mandateGuardFixedSite,
    userAgent: "Pactway/isolated-atk-1.4.8",
    sourceTag: "MCP",
    verbose: false
  });
  const server = createServer2(config, undefined);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
`;
}

/** Pure source-only continuation of the pinned fixed-routing draft. Does not read
 * env/files, invoke the SDK, emit an executable, start a process or make requests.
 * Dedicated main bypasses CLI/TOML/OAuth/setup/update/logger loading, preserves
 * read-only fixed-origin routing and builds private credentials only at a future
 * runtime. Dormant upstream functions/imports remain. Top-level homedir/dependency
 * evaluation happens before main: this draft is NOT proof of process isolation,
 * valid credentials, a verified demo account, tool catalog or runtime behavior.
 * Internal mandateGuard symbols and upstream MCP protocol/server names are retained
 * to keep this bounded patch separate from the public Pactway product identity.
 */
export function draftIsolatedDemoEntry(manifest,upstreamSource) {
  if (!verifyDemoConnectionManifest(manifest)) return report(false,'DEMO_MANIFEST_HASH');
  try {
    const fields = Object.getOwnPropertyDescriptors(manifest);
    const declaration = createDemoConnectionManifest(fields.config.value);
    if (declaration.configHash !== fields.configHash.value) throw 'DEMO_MANIFEST_HASH';
    const routing = draftFixedRoutingEntry(declaration,upstreamSource);
    if (!routing.ok) return report(false,CODES.has(routing.code) ? routing.code : 'ATK_ISOLATED_SOURCE_INVALID');
    const first = uniqueIndex(routing.source,'async function main() {');
    const last = uniqueIndex(routing.source,OLD_CATCH);
    if (last <= first) throw 'ATK_ISOLATED_ANCHOR_MISMATCH';
    const source = routing.source.slice(0,first) + isolatedMain(declaration.config)
      + STATIC_CATCH + routing.source.slice(last + OLD_CATCH.length);
    return report(true,'ATK_ISOLATED_SESSION_SOURCE_DRAFT',{
      source,patchId:PATCH_ID,connectionHash:declaration.configHash,
      upstreamSha256:routing.upstreamSha256,routingDerivedSha256:routing.derivedSha256,
      isolatedDerivedSha256:sha256(source),verification:'ISOLATED_SOURCE_DRAFT_ONLY',
    });
  } catch (code) {
    return report(false,CODES.has(code) ? code : 'ATK_ISOLATED_SOURCE_INVALID');
  }
}

function report(ok,code,extra = {}) {
  return Object.freeze({ok,code,verification:'UNVERIFIED',...extra,requiredBlockers:BLOCKERS,
    launchAllowed:false,writeEnabled:false,actualAccountVerified:false,routeVerified:false});
}
