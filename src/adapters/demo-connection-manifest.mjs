import { hashCanonical } from '../domain/governor.mjs';

/** Pure, operator-owned connection declaration. No filesystem, credentials or IO.
 * Declaring demo/auth/routing is NOT evidence that an actual process uses them.
 * Actual package/config/catalog/target checks are the next independent gate.
 */
export const PINNED_ATK = Object.freeze({
  name:'@okx_ai/okx-trade-mcp',version:'1.4.8',
  entrySha256:'9b3b0f6f3ae25d20628eedc9c4d6dc5fdc4a8c2d700a3f3f0db13c0ba21d695f',
});
// Application allowlist from installed 1.4.8 constants.ts, not account access proof.
const ORIGINS = Object.freeze({global:'https://www.okx.com',eea:'https://eea.okx.com',us:'https://us.okx.com',tr:'https://tr.okx.com'});
const KEYS=['schemaVersion','id','connectionVersion','accountId','environment','instrument','profile','site','apiOrigin','authMode','sourceTag'];
const TOKEN=/^[A-Za-z0-9_-]{1,64}$/;
const READ_TOOLS=Object.freeze(['market_get_ticker','market_get_orderbook','market_get_instruments',
  'account_get_balance','account_get_trade_fee','spot_get_order','spot_get_orders','spot_get_fills']);
function failure(code){return Object.assign(new TypeError(code),{code});}
function record(input,keys){
  if(!input || typeof input!=='object' || Array.isArray(input)
    || ![Object.prototype,null].includes(Object.getPrototypeOf(input))
    || Object.getOwnPropertySymbols(input).length)throw failure('DEMO_MANIFEST_INVALID');
  const descriptors=Object.getOwnPropertyDescriptors(input);
  if(Object.keys(descriptors).length!==keys.length || Object.keys(descriptors).some(key=>!keys.includes(key)))
    throw failure('DEMO_MANIFEST_FIELDS');
  const result=Object.create(null);
  for(const key of keys){
    const descriptor=descriptors[key];
    if(!descriptor || !Object.hasOwn(descriptor,'value'))throw failure('DEMO_MANIFEST_FIELDS');
    result[key]=descriptor.value;
  }
  return result;
}

/** Secrets, filesystem paths and arbitrary extra properties are never accepted.
 * A new profile/site/account/tag needs a new connection version and new approval.
 */
export function createDemoConnectionManifest(input){
  const values=record(input,KEYS);
  if(values.schemaVersion!==1)throw failure('DEMO_MANIFEST_VERSION');
  for(const key of ['id','connectionVersion','accountId','profile'])
    if(typeof values[key]!=='string' || !TOKEN.test(values[key]))throw failure('DEMO_MANIFEST_IDENTITY');
  if(values.environment!=='demo' || values.instrument!=='AVAX-USDT')throw failure('DEMO_MANIFEST_SCOPE');
  if(typeof values.site!=='string' || !Object.hasOwn(ORIGINS,values.site))throw failure('DEMO_MANIFEST_SITE');
  if(values.apiOrigin!==ORIGINS[values.site])throw failure('DEMO_MANIFEST_ORIGIN');
  if(values.authMode!=='isolated-demo-api-key')throw failure('DEMO_MANIFEST_AUTH');
  // Application-owned narrow tag; this is not a claim about OKX's full tag schema.
  if(typeof values.sourceTag!=='string' || !/^[A-Za-z0-9]{1,16}$/.test(values.sourceTag))throw failure('DEMO_MANIFEST_TAG');
  const config=Object.freeze({...values});
  return Object.freeze({config,package:PINNED_ATK,configHash:hashCanonical({config,package:PINNED_ATK})});
}

export function verifyDemoConnectionManifest(manifest){
  try{
    const values=record(manifest,['config','package','configHash']);
    const pinned=record(values.package,['name','version','entrySha256']);
    if(Object.keys(pinned).some(key=>pinned[key]!==PINNED_ATK[key]))return false;
    return typeof values.configHash==='string'
      && createDemoConnectionManifest(values.config).configHash===values.configHash;
  }catch{return false;}
}

/** Normalizer context plus identity hash, not transport authorization. */
export function demoBindingFromManifest(manifest){
  if(!verifyDemoConnectionManifest(manifest))throw failure('DEMO_MANIFEST_HASH');
  const c=manifest.config;
  return Object.freeze({atkVersion:PINNED_ATK.version,environment:c.environment,instrument:c.instrument,
    accountId:c.accountId,connectionVersion:c.connectionVersion,connectionHash:manifest.configHash});
}

/** Safe next-step preparation. Always read-only, NEVER a write capability.
 * Does not start a process. Paths/actual config need separate operator validation.
 * Fixed apiOrigin is a declared target; Pilot/TOML/auth must still be inspected.
 */
export function demoReadOnlyDeclaration(manifest){
  if(!verifyDemoConnectionManifest(manifest))throw failure('DEMO_MANIFEST_HASH');
  const c=manifest.config;
  return Object.freeze({package:PINNED_ATK,binding:demoBindingFromManifest(manifest),site:c.site,
    declaredApiOrigin:c.apiOrigin,declaredAuthMode:c.authMode,sourceTag:c.sourceTag,
    args:Object.freeze(['--profile',c.profile,'--demo','--site',c.site,'--modules','market,spot,account','--read-only']),
    readTools:READ_TOOLS,writeEnabled:false,verification:'DECLARATION_ONLY'});
}
