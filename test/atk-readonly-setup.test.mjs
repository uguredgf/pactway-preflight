import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,realpathSync,readFileSync} from 'node:fs';
import {join,dirname,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {Store} from '../src/persistence/store.mjs';
import {verifyReadOnlyIdentity} from '../src/adapters/atk-readonly-identity.mjs';
import {prepareATKObservation} from '../src/adapters/atk-observation-journal.mjs';
import {createDemoConnectionManifest} from '../src/adapters/demo-connection-manifest.mjs';
import {observedBaseline,explicitApproval,readonlyServerEnvironment,osEnvironment} from '../scripts/lib/readonly-atk-setup.mjs';
import {catalog} from './support/stdio-catalog.mjs';
import {FUJI_PROFILE} from '../src/audit/fuji-deployment-profile.mjs';
const manifest=createDemoConnectionManifest({schemaVersion:1,id:'setup',connectionVersion:'v1',accountId:'demo-account',environment:'demo',instrument:'AVAX-USDT',profile:'demo',site:'tr',apiOrigin:'https://tr.okx.com',authMode:'isolated-demo-api-key',sourceTag:'MCP'});
const context={execution:false,connectionHash:manifest.configHash,writeEnabled:false,verification:'PINNED_DERIVED_SOURCE_AND_EXPLICIT_ENVIRONMENT',entrySha256:'a'.repeat(64)};
test('catalog approval requires independently typed exact hash; write catalog and execution context denied',()=>{
  const client={launchContext:()=>context,tools:()=>catalog};
  const baseline=observedBaseline(client,manifest,{protocolVersion:'2025-06-18'});
  assert.throws(()=>explicitApproval(baseline,''));assert.throws(()=>explicitApproval(baseline,'0'.repeat(64)));
  assert.equal(explicitApproval(baseline,baseline.baselineHash).approvedBaselineHash,baseline.baselineHash);
  assert.throws(()=>observedBaseline({...client,launchContext:()=>({...context,execution:true})},manifest,{protocolVersion:'2025-06-18'}));
  assert.throws(()=>observedBaseline({...client,tools:()=>[...catalog,{name:'spot_place_order',inputSchema:{type:'object'},annotations:{readOnlyHint:false,destructiveHint:false}}]},manifest,{protocolVersion:'2025-06-18'}));
});
test('read-only server inherits only allowlisted environment, fixed fixture mode and no execution capability',()=>{
  const ambient={SystemRoot:'system',TEMP:'temp',OPENAI_API_KEY:'never',NODE_OPTIONS:'never',MG_ATK_EXECUTION:'1',MG_PUBLIC_ORIGIN:'https://bad',HTTP_PROXY:'never'};
  const env=readonlyServerEnvironment({manifest,entryPath:'derived',upstreamEntryPath:'upstream'},{data:'data',manifest:'manifest',approval:'approval',account:'account'},{apiKey:'fake',secret:'fake',passphrase:'fake'},ambient);
  assert.equal(env.MG_ATK_EXECUTION,'0');assert.equal(env.MG_ATK_ISOLATED,'1');assert.equal(env.MG_PLANNER,'fixture');assert.equal(env.MG_EXECUTION_MODE,'fixture');
  for(const key of ['OPENAI_API_KEY','NODE_OPTIONS','MG_PUBLIC_ORIGIN','HTTP_PROXY'])assert.equal(env[key],undefined);
  assert.deepEqual(osEnvironment(ambient),{SystemRoot:'system',TEMP:'temp'});
});

test('Fuji opt-in reaches only the read-only server without granting ATK writes',()=>{
  const env=readonlyServerEnvironment({manifest,entryPath:'derived',upstreamEntryPath:'upstream'},
    {data:'data',manifest:'manifest',approval:'approval',account:'account'},
    {apiKey:'fake',secret:'fake',passphrase:'fake'},
    {PACTWAY_FUJI_PROFILE:FUJI_PROFILE.id,MG_ATK_EXECUTION:'1',MG_EXECUTION_MODE:'demo-prepared'});
  assert.equal(env.MG_FUJI_PROFILE,FUJI_PROFILE.id);
  assert.equal(env.MG_ATK_EXECUTION,'0');assert.equal(env.MG_EXECUTION_MODE,'fixture');
  assert.equal(osEnvironment(env).MG_FUJI_PROFILE,undefined);
});
function fixture(t,{uid='123',perm='read_only',registered=true}={}) {
  const directory=mkdtempSync(join(tmpdir(),'pactway-readonly-id-')),store=new Store(directory);
  t.after(()=>{store.close();const target=realpathSync(directory);assert.equal(dirname(target),realpathSync(tmpdir()));assert.ok(basename(target).startsWith('pactway-readonly-id-'));rmSync(target,{recursive:true,force:true});});
  const binding={sessionId:'test-session',accountId:'demo-account',connectionHash:manifest.configHash,catalogHash:'b'.repeat(64),isolatedEntrySha256:'a'.repeat(64)};
  const capture=store.openATKCaptureSession(binding);let closes=0,calls=0;
  const client={journalContext:()=>binding,close:async()=>{closes++;capture.close();},callJournalledRead:async(name,args)=>{
    calls++;assert.equal(name,'account_get_config');assert.deepEqual(args,{});
    const ms=Date.now(),at=new Date(ms).toISOString();
    const envelope={tool:name,ok:true,data:{endpoint:'GET /api/v5/account/config',requestTime:at,data:[{uid,...(perm===null?{}:{perm})}]},capabilities:{readOnly:true,hasAuth:true,demo:true,moduleAvailability:{account:{status:'enabled'}}},timestamp:at};
    const prepared=prepareATKObservation({schemaVersion:1,...binding,taskId:null,intentId:null,observationId:'observation',callId:'call',tool:name,args:{},requestedAtMs:ms,receivedAtMs:ms},{content:[{type:'text',text:JSON.stringify(envelope)}],structuredContent:envelope,isError:false});
    assert.equal(prepared.ok,true);
    return registered?capture.capture(prepared.record):store.captureATKToolObservation(prepared.record);
  }};
  const expected={schemaVersion:1,connectionHash:binding.connectionHash,accountId:binding.accountId,expectedUid:'123'};
  return {store,client,expected,closes:()=>closes,calls:()=>calls};
}
test('captured UID and read-only permission verified on same saved response without granting writes',async t=>{
  const f=fixture(t),result=await verifyReadOnlyIdentity(f.client,f.store,f.expected);
  assert.equal(result.accountExpectationState,'CAPTURED_UID_MATCHED');assert.equal(result.readPermissionConfirmed,true);assert.equal(result.writeEnabled,false);
  assert.equal(f.calls(),1);assert.equal(f.closes(),0);assert.equal(f.store.globalSafetyStatus().paused,false);
  assert.equal(f.store.atkToolObservation('observation').status,'APPLIED');assert.equal(f.store.hasUnappliedObservations(),false);
});
for(const [name,options] of [['UID mismatch',{uid:'456'}],['trade permission',{perm:'read_only,trade'}],['missing permission',{perm:null}],['supplied rather than captured',{registered:false}]])test(name+' closes and pauses read-only connection',async t=>{
  const f=fixture(t,options);await assert.rejects(verifyReadOnlyIdentity(f.client,f.store,f.expected),{code:'ATK_READONLY_IDENTITY_REJECTED'});
  assert.equal(f.store.globalSafetyStatus().paused,true);assert.equal(f.closes(),1);
});
test('launcher has no automatic approval, credential file output or inherited child stdio',()=>{
  const source=readFileSync(new URL('../scripts/connect-okx-tr-readonly.mjs',import.meta.url),'utf8');
  assert.match(source,/explicitApproval\(baseline,await hidden/);assert.match(source,/await probe\(credentials,\{expectedUid\}\)/);
  assert.match(source,/stdio:\['ignore','ignore','ignore','ipc'\]/);assert.doesNotMatch(source,/JSON\.stringify\(credentials/);
});
