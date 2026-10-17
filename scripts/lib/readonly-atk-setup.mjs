import {readFile,mkdir,writeFile,lstat,realpath} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createDemoConnectionManifest} from '../../src/adapters/demo-connection-manifest.mjs';
import {inspectInstalledATKPackage} from '../../src/adapters/atk-package-fingerprint.mjs';
import {draftIsolatedDemoEntry} from '../../src/adapters/atk-isolated-session-draft.mjs';
import {createATKCatalogBaseline} from '../../src/adapters/atk-catalog-fingerprint.mjs';
import {ISOLATED_BOOTSTRAP_SOURCE} from '../../src/adapters/atk-isolated-bootstrap-source.mjs';
import {localPlannerEnvironment} from './local-model-setup.mjs';
import {fujiEnvironment} from '../../src/audit/fuji-deployment-profile.mjs';

export const root=fileURLToPath(new URL('../../',import.meta.url));
export const fail=code=>Object.assign(new Error(code),{code});
export function osEnvironment(environment=process.env) {
  const output={};
  for(const key of ['SystemRoot','WINDIR','TEMP','TMP']){
    const value=environment[key]??environment[key.toUpperCase()];if(value)output[key]=value;
  }
  return output;
}
export async function prepareReadonlyInstallation(id) {
  if(typeof id!=='string' || !/^[a-f0-9-]{36}$/.test(id))throw fail('SETUP_ID_INVALID');
  const manifest=createDemoConnectionManifest({schemaVersion:1,id,connectionVersion:'readonly-v1',accountId:'demo-'+id,
    environment:'demo',instrument:'AVAX-USDT',profile:'pactway-tr-readonly',site:'tr',apiOrigin:'https://tr.okx.com',authMode:'isolated-demo-api-key',sourceTag:'MCP'});
  const packageRoot=resolve(root,'node_modules/@okx_ai/okx-trade-mcp'),upstreamEntryPath=join(packageRoot,'dist/index.js');
  const inspected=await inspectInstalledATKPackage(manifest,{packageRoot,entryPath:upstreamEntryPath});
  if(!inspected.ok)throw fail(inspected.code);
  const prepared=draftIsolatedDemoEntry(manifest,await readFile(upstreamEntryPath,'utf8'));
  if(!prepared.ok)throw fail(prepared.code);
  const directory=join(root,'.local');await mkdir(directory,{recursive:true});
  if((await lstat(directory)).isSymbolicLink() || (await realpath(directory)).toLowerCase()!==directory.replace(/[\\/]$/,'').toLowerCase())throw fail('SETUP_PATH_INVALID');
  const entryPath=join(directory,'readonly-atk-'+id+'.mjs');
  const bootstrapEntryPath=join(directory,'readonly-bootstrap-'+id+'.mjs');
  await writeFile(entryPath,prepared.source,{flag:'wx',mode:0o600});
  await writeFile(bootstrapEntryPath,ISOLATED_BOOTSTRAP_SOURCE,{flag:'wx',mode:0o600});
  return {manifest,entryPath,upstreamEntryPath,bootstrapEntryPath};
}
export function observedBaseline(client,manifest,handshake) {
  const context=client.launchContext();
  if(context.execution!==false || context.connectionHash!==manifest.configHash || context.writeEnabled!==false
      || context.verification!=='PINNED_DERIVED_SOURCE_AND_EXPLICIT_ENVIRONMENT')throw fail('READONLY_LAUNCH_REQUIRED');
  const baseline=createATKCatalogBaseline(manifest,{isolatedEntrySha256:context.entrySha256,protocolVersion:handshake.protocolVersion,tools:client.tools()});
  if(!baseline.ok)throw fail(baseline.code);
  return baseline;
}
export function explicitApproval(baseline,typedHash) {
  if(!baseline?.ok || !/^[a-f0-9]{64}$/.test(typedHash) || typedHash!==baseline.baselineHash)throw fail('CATALOG_NOT_APPROVED');
  return {baseline:baseline.baseline,approvedBaselineHash:typedHash};
}
export function readonlyApplicationPort(environment={}) {
  const value=environment.PACTWAY_APP_PORT??'18774';
  if(typeof value!=='string' || !/^[1-9][0-9]{3,4}$/.test(value) || String(Number(value))!==value
      || Number(value)<1024 || Number(value)>65535)throw fail('APP_PORT_INVALID');
  return value;
}
export function readonlyServerEnvironment(setup,files,credentials,environment=process.env) {
  return {...osEnvironment(environment),MG_PORT:readonlyApplicationPort(environment),MG_DATA_DIR:files.data,...localPlannerEnvironment(environment),...fujiEnvironment(environment),MG_EXECUTION_MODE:'fixture',
    MG_ATK_EXECUTION:'0',MG_ATK_ISOLATED:'1',MG_ATK_NODE:process.execPath,MG_ATK_ENTRY:setup.entryPath,
    MG_ATK_UPSTREAM_ENTRY:setup.upstreamEntryPath,MG_ATK_PROFILE:setup.manifest.config.profile,
    MG_ATK_BOOTSTRAP_ENTRY:setup.bootstrapEntryPath,
    MG_ATK_MANIFEST_FILE:files.manifest,MG_ATK_CATALOG_APPROVAL_FILE:files.approval,MG_ATK_ACCOUNT_EXPECTATION_FILE:files.account,
    OKX_API_KEY:credentials.apiKey,OKX_SECRET_KEY:credentials.secret,OKX_PASSPHRASE:credentials.passphrase};
}
