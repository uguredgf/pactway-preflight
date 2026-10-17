import {createHash} from 'node:crypto';
import {PINNED_ATK,createDemoConnectionManifest,verifyDemoConnectionManifest} from './demo-connection-manifest.mjs';

const MAX_BYTES = 8 * 1024 * 1024;
const PATCH_ID = 'mandateguard-atk148-fixed-routing-source-v1';
const BLOCKERS = Object.freeze(['SOURCE_NOT_EXECUTED_OR_VERIFIED','DEPENDENCY_PROVENANCE_UNVERIFIED',
  'CONFIG_AUTH_LOADING_UNRESOLVED','ACTUAL_DEMO_ACCOUNT_UNVERIFIED']);
const CODES = new Set(['DEMO_MANIFEST_HASH','ATK_DRAFT_SOURCE_TAG_UNSUPPORTED','ATK_DRAFT_SOURCE_INVALID',
  'ATK_DRAFT_SOURCE_TOO_LARGE','ATK_DRAFT_UPSTREAM_HASH_MISMATCH','ATK_DRAFT_ANCHOR_MISMATCH']);
const sha256 = text => createHash('sha256').update(text,'utf8').digest('hex');

// Full upstream package MIT notice, read as text from the installed 1.4.8 LICENSE.
const LICENSE = `/*
MIT License

Copyright (c) 2026 OKX

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/
`;

function uniqueIndex(source,anchor) {
  const index = source.indexOf(anchor);
  if (index < 0 || source.indexOf(anchor,index + anchor.length) !== -1) throw 'ATK_DRAFT_ANCHOR_MISMATCH';
  return index;
}
function replaceOne(source,anchor,replacement) {
  const index = uniqueIndex(source,anchor);
  return source.slice(0,index) + replacement + source.slice(index + anchor.length);
}
function replaceSpan(source,start,end,replacement) {
  const first = uniqueIndex(source,start);
  const last = uniqueIndex(source,end);
  if (last <= first) throw 'ATK_DRAFT_ANCHOR_MISMATCH';
  return source.slice(0,first) + replacement + source.slice(last);
}

function fixedGuardSource(config) {
  return '\n// MandateGuard fixed-routing SOURCE DRAFT; never launch-approved.\n'
    + `const mandateGuardFixedOrigin = ${JSON.stringify(config.apiOrigin)};\n`
    + `const mandateGuardFixedSite = ${JSON.stringify(config.site)};\n`
    + `const mandateGuardFixedProfile = ${JSON.stringify(config.profile)};\n`
    + String.raw`
function mandateGuardDeny() { throw new TypeError("MANDATEGUARD_FIXED_ROUTE_DENIED"); }
function mandateGuardOwnRecord(input, allowed) {
  if (!input || typeof input !== "object" || Array.isArray(input)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(input))
      || Object.getOwnPropertySymbols(input).length) mandateGuardDeny();
  const fields = Object.getOwnPropertyDescriptors(input);
  const output = Object.create(null);
  for (const name of Object.keys(fields)) {
    if (!allowed.includes(name) || !Object.hasOwn(fields[name], "value")) mandateGuardDeny();
    output[name] = fields[name].value;
  }
  return output;
}
function mandateGuardConfiguration(input) {
  const config = mandateGuardOwnRecord(input, ["apiKey", "secretKey", "passphrase", "hasAuth",
    "profile", "baseUrl", "timeoutMs", "modules", "readOnly", "demo", "site", "userAgent",
    "sourceTag", "proxyUrl", "verbose"]);
  if (config.baseUrl !== mandateGuardFixedOrigin || config.site !== mandateGuardFixedSite
      || config.profile !== mandateGuardFixedProfile || config.demo !== true
      || config.readOnly !== true || config.sourceTag !== "MCP"
      || (config.proxyUrl !== void 0 && config.proxyUrl !== "")) mandateGuardDeny();
  for (const key of ["apiKey", "secretKey", "passphrase"]) {
    if (typeof config[key] !== "string" || !config[key].length || config[key].length > 4096
        || config[key].trim() !== config[key] || /[\x00-\x1f\x7f]/.test(config[key])) mandateGuardDeny();
  }
  if (!Number.isSafeInteger(config.timeoutMs) || config.timeoutMs < 1 || config.timeoutMs > 30000
      || (config.hasAuth !== void 0 && config.hasAuth !== true)
      || (config.verbose !== void 0 && typeof config.verbose !== "boolean")
      || (config.userAgent !== void 0 && (typeof config.userAgent !== "string"
        || config.userAgent.length > 256 || /[\x00-\x1f\x7f]/.test(config.userAgent)))) mandateGuardDeny();
  const modules = config.modules;
  if (!Array.isArray(modules) || Object.getPrototypeOf(modules) !== Array.prototype
      || Object.getOwnPropertySymbols(modules).length) mandateGuardDeny();
  const fields = Object.getOwnPropertyDescriptors(modules);
  if (Object.keys(fields).sort().join(",") !== "0,1,2,length") mandateGuardDeny();
  for (const key of ["0", "1", "2", "length"])
    if (!Object.hasOwn(fields[key], "value")) mandateGuardDeny();
  if (fields.length.value !== 3 || fields[0].value !== "market" || fields[1].value !== "spot"
      || fields[2].value !== "account") mandateGuardDeny();
  config.modules = Object.freeze(["market", "spot", "account"]);
  return Object.freeze(config);
}
function mandateGuardFixedFetch(directDispatcher) {
  return (url, suppliedOptions) => {
    const options = mandateGuardOwnRecord(suppliedOptions,
      ["method", "headers", "body", "signal", "dispatcher", "redirect"]);
    if (typeof url !== "string" || url.length > 16384 || url.includes("#") || options.method !== "GET"
        || options.body !== void 0 || (options.redirect !== void 0 && options.redirect !== "error")
        || (options.dispatcher !== void 0 && options.dispatcher !== directDispatcher)) mandateGuardDeny();
    let target;
    try { target = new URL(url); } catch { mandateGuardDeny(); }
    if (target.origin !== mandateGuardFixedOrigin || target.protocol !== "https:"
        || target.username || target.password || target.hash || target.href !== url
        || !/^\/api\/v5\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(target.pathname)) mandateGuardDeny();
    if (!options.headers || Object.getPrototypeOf(options.headers) !== Headers.prototype) mandateGuardDeny();
    const headers = new Headers();
    for (const [name, value] of Headers.prototype.entries.call(options.headers)) headers.set(name, value);
    if (headers.has("host") || headers.has("authorization") || headers.has("proxy-authorization")
        || headers.get("x-simulated-trading") !== "1") mandateGuardDeny();
    if (options.signal !== void 0 && !(options.signal instanceof AbortSignal)) mandateGuardDeny();
    // No options spread: unknown fetch knobs, redirection and inherited dispatchers never pass through.
    return undiciFetch2(target.href, {
      method: "GET", headers, signal: options.signal, redirect: "error", dispatcher: directDispatcher
    });
  };
}
`;
}

const INERT_PILOT = String.raw`var PilotManager = class {
  constructor() { Object.freeze(this); }
  preparePilot() {}
  cacheDirectIfNeeded() {}
  getConnectionParams() { return Object.freeze({ baseUrl: mandateGuardFixedOrigin }); }
  get isProxyActive() { return false; }
  get hasRetried() { return true; }
  async handleNetworkFailure() { return false; }
};
`;
const FIXED_CONSTRUCTOR = String.raw`  constructor(config, _fetch) {
    if (_fetch !== void 0) mandateGuardDeny();
    const fixedConfig = mandateGuardConfiguration(config);
    const directDispatcher = new Agent({ connect: { rejectUnauthorized: true } });
    Object.defineProperties(this, {
      config: { value: fixedConfig, writable: false, configurable: false },
      dispatcher: { value: directDispatcher, writable: false, configurable: false },
      pilot: { value: new PilotManager(), writable: false, configurable: false },
      _fetchFn: { value: mandateGuardFixedFetch(directDispatcher), writable: false, configurable: false }
    });
    this.rateLimiter = new RateLimiter(3e4, fixedConfig.verbose);
  }
`;

/** Pure text transformation of exact pinned upstream bytes; no filesystem, SDK
 * import, process, env, eval or network. Returns source text, never an executable.
 * Tests have not executed this transformer or derived entry. Derived hash is a
 * separate commitment and never replaces PINNED_ATK. Dependencies, loadConfig,
 * pre-client TOML/OAuth and actual account remain unresolved. Public binary GET
 * has no demo header in this upstream and is deliberately denied; every POST is
 * denied. No runtime safety, authentication or route-verification claim is made.
 */
export function draftFixedRoutingEntry(manifest,upstreamSource) {
  if (!verifyDemoConnectionManifest(manifest)) return report(false,'DEMO_MANIFEST_HASH');
  try {
    const manifestFields = Object.getOwnPropertyDescriptors(manifest);
    const declaration = createDemoConnectionManifest(manifestFields.config.value);
    if (declaration.configHash !== manifestFields.configHash.value) throw 'DEMO_MANIFEST_HASH';
    if (declaration.config.sourceTag !== 'MCP') throw 'ATK_DRAFT_SOURCE_TAG_UNSUPPORTED';
    if (typeof upstreamSource !== 'string') throw 'ATK_DRAFT_SOURCE_INVALID';
    if (upstreamSource.length > MAX_BYTES || Buffer.byteLength(upstreamSource,'utf8') > MAX_BYTES) throw 'ATK_DRAFT_SOURCE_TOO_LARGE';
    if (sha256(upstreamSource) !== PINNED_ATK.entrySha256) throw 'ATK_DRAFT_UPSTREAM_HASH_MISMATCH';
    // Every changed boundary must occur exactly once after the upstream pin check.
    // These three unchanged call sites all use the single immutable guarded _fetchFn.
    for (const call of ['response = await this._fetchFn(url, {',
      'return await this._fetchFn(`${conn.baseUrl}${path4}`, fetchOptions);',
      'response = await this._fetchFn(url, fetchOptions);']) uniqueIndex(upstreamSource,call);
    let source = replaceSpan(upstreamSource,'var PilotManager = class {','function getNow() {',
      fixedGuardSource(declaration.config) + INERT_PILOT);
    source = replaceSpan(source,'  constructor(config, _fetch) {',
      '  /**\n   * Resolve OAuth access token via the okx-auth binary (fd3 pipe).',FIXED_CONSTRUCTOR);
    source = replaceOne(source,'installEnvProxyDispatcher();','// MandateGuard: global environment proxy installation removed.');
    source = replaceOne(source,'  checkForUpdates("@okx_ai/okx-trade-mcp", SERVER_VERSION);',
      '  // MandateGuard: background update network invocation removed.');
    source = replaceOne(source,'//# sourceMappingURL=index.js.map','// MandateGuard: upstream sourcemap does not describe this derived source.');
    source = replaceOne(source,'#!/usr/bin/env node\n','#!/usr/bin/env node\n' + LICENSE);
    return report(true,'ATK_FIXED_ROUTING_SOURCE_DRAFT',{
      source,patchId:PATCH_ID,connectionHash:declaration.configHash,
      upstreamSha256:PINNED_ATK.entrySha256,derivedSha256:sha256(source),
      verification:'SOURCE_DRAFT_ONLY',
    });
  } catch (code) {
    return report(false,CODES.has(code) ? code : 'ATK_DRAFT_SOURCE_INVALID');
  }
}
function report(ok,code,extra = {}) {
  return Object.freeze({ok,code,verification:'UNVERIFIED',...extra,requiredBlockers:BLOCKERS,
    launchAllowed:false,writeEnabled:false,routeVerified:false,actualAccountVerified:false});
}
