// Starts ONLY the local fake stdio fixture; results are recorded in docs/ADIM-8-2-STDIO-SONUC.md.
import test,{before} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {ReadOnlyATK} from '../src/adapters/atk.mjs';
import {createDemoConnectionManifest} from '../src/adapters/demo-connection-manifest.mjs';
import {createATKCatalogBaseline} from '../src/adapters/atk-catalog-fingerprint.mjs';
import {Store} from '../src/persistence/store.mjs';
import {catalog} from './support/stdio-catalog.mjs';
import {loadATKJournalConfiguration} from '../src/adapters/atk-journal-config.mjs';
import {verifyReadOnlyIdentity} from '../src/adapters/atk-readonly-identity.mjs';
const entryPath=fileURLToPath(new URL('./support/fake-atk-stdio.mjs',import.meta.url));

// The runner isolates this file in its own process. Remove ambient application
// and exchange configuration before any client can inherit it; never read values.
before(()=>{
  const systemKeys=new Set(['PATH','SYSTEMROOT','WINDIR','TEMP','TMP','NODE_TEST_CONTEXT']);
  for(const key of Object.keys(process.env))if(!systemKeys.has(key.toUpperCase()))delete process.env[key];
});

test('read-only startup checks captured UID and permission through real client/fake stdio/store',{timeout:15000},async()=>{
  for(const [profile,expectedUid,ok] of [['readonly-perm','123',true],['readonly-perm','456',false],['readonly-write-perm','123',false]]){
    const directory=mkdtempSync(join(tmpdir(),'pactway-stdio-readonly-')),store=new Store(directory);
    const client=new ReadOnlyATK({nodePath:process.execPath,entryPath,profile});
    try{
      await client.connect();const supplied=config(profile),accountExpectation={schemaVersion:1,connectionHash:supplied.manifest.configHash,accountId:supplied.manifest.config.accountId,expectedUid};
      client.attachObservationJournal({store,...supplied,accountExpectation});
      if(ok){const result=await verifyReadOnlyIdentity(client,store,accountExpectation);assert.equal(result.readPermissionConfirmed,true);assert.equal(result.writeEnabled,false);}
      else{await assert.rejects(verifyReadOnlyIdentity(client,store,accountExpectation),{code:'ATK_READONLY_IDENTITY_REJECTED'});assert.equal(store.globalSafetyStatus().paused,true);assert.throws(()=>client.tools());}
      const rows=store.db.prepare('SELECT status FROM atk_tool_observations').all();assert.equal(rows.length,1);
      assert.equal(rows[0].status,ok?'APPLIED':'PENDING');assert.equal(store.hasUnappliedObservations(),!ok);
    }finally{await client.close();store.close();rmSync(directory,{recursive:true,force:true});}
  }
});
test('configured UID is checked on captured stdio response; mismatch remains pending and closes client',{timeout:15000},async()=>{
  for(const expectedUid of ['123','456']) {
    const directory=mkdtempSync(join(tmpdir(),'pactway-identity-')),store=new Store(directory);
    const client=new ReadOnlyATK({nodePath:process.execPath,entryPath});
    try {
      await client.connect();const supplied=config();
      client.attachObservationJournal({store,...supplied,accountExpectation:{schemaVersion:1,
        connectionHash:supplied.manifest.configHash,accountId:supplied.manifest.config.accountId,expectedUid}});
      if(expectedUid==='123') {
        const result=await client.callJournalledRead('account_get_config');
        assert.equal(result.actualAccountVerified,false);assert.equal(result.writeEnabled,false);
      } else {
        await assert.rejects(client.callReadTool('account_get_config'),{code:'ATK_ACCOUNT_IDENTITY_REJECTED'});
        await assert.rejects(client.callJournalledRead('account_get_config'),{code:'ATK_NOT_CONNECTED'});
        assert.equal(store.globalSafetyStatus().paused,true);
      }
      const rows=store.db.prepare('SELECT observation_id,status FROM atk_tool_observations').all();
      assert.equal(rows.length,1);assert.equal(rows[0].status,'PENDING');
      assert.equal(store.atkObservationSource(rows[0].observation_id).activeSession,expectedUid==='123');
    } finally {await client.close();store.close();rmSync(directory,{recursive:true,force:true});}
  }
});
function config(profile='demo') {
  const manifest=createDemoConnectionManifest({schemaVersion:1,id:'fixture',connectionVersion:'v1',accountId:'fixture-account',
    environment:'demo',instrument:'AVAX-USDT',profile,site:'tr',apiOrigin:'https://tr.okx.com',authMode:'isolated-demo-api-key',sourceTag:'MCP'});
  const baseline=createATKCatalogBaseline(manifest,{isolatedEntrySha256:createHash('sha256').update(readFileSync(entryPath)).digest('hex'),
    protocolVersion:'2025-06-18',tools:catalog});
  assert.equal(baseline.ok,true);
  return {manifest,approval:{baseline:baseline.baseline,approvedBaselineHash:baseline.baselineHash}};
}
test('actual stdio response is persisted before return; IDs/times/catalog come from client session',{timeout:15000},async()=>{
  const directory=mkdtempSync(join(tmpdir(),'pactway-stdio-')),store=new Store(directory);
  const client=new ReadOnlyATK({nodePath:process.execPath,entryPath});
  try {
    await client.connect();const attached=client.attachObservationJournal({store,...config()});
    assert.equal(attached.routeVerified,false);assert.equal(attached.actualAccountVerified,false);
    const args={label:'original'};
    const pending=client.callJournalledRead('account_get_config',args);args.label='changed';
    const result=await pending,saved=store.atkToolObservation(result.observationId);
    assert.equal(result.status,'PENDING');assert.equal(saved.status,'PENDING');
    assert.equal(saved.record.context.args.label,'original');
    assert.equal(saved.record.context.sessionId,attached.binding.sessionId);
    assert.equal(store.atkObservationSource(result.observationId).source,'REGISTERED_STDIO_CAPTURE');
    assert.equal(store.atkObservationSource(result.observationId).activeSession,true);
    assert.ok(saved.record.context.receivedAtMs>=saved.record.context.requestedAtMs);
    assert.equal(saved.record.payload.structuredContent.data.data[0].echo.label,'original');
    await client.callReadTool('account_get_config',{});
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM atk_tool_observations').get().n,2);
    await assert.rejects(client.callJournalledRead('spot_place_order',{}),{code:'ATK_READ_TOOL_DENIED'});
    await assert.rejects(client.callJournalledRead('account_get_config',{}, {taskId:null,intentId:null,callId:'forged'}),{code:'ATK_JOURNAL_OWNER'});
    assert.throws(()=>client.attachObservationJournal({store,...config()}),{code:'ATK_JOURNAL_STATE'});
    await client.close();
    assert.equal(store.atkObservationSource(result.observationId).activeSession,false);
  } finally {await client.close();store.close();rmSync(directory,{recursive:true,force:true});}
});
test('mismatched entry/catalog approval cannot attach capture',{timeout:15000},async()=>{
  const client=new ReadOnlyATK({nodePath:process.execPath,entryPath});
  try {
    await client.connect();const supplied=config();
    assert.throws(()=>client.attachObservationJournal({...config('different-profile'),store:{
      openATKCaptureSession(){throw new Error('must not register');},pauseGlobal(){}}}),{code:'ATK_JOURNAL_CONFIG'});
    supplied.approval.approvedBaselineHash='f'.repeat(64);
    assert.throws(()=>client.attachObservationJournal({...supplied,store:{openATKCaptureSession(){throw new Error('must not register');},pauseGlobal(){}}}),
      {code:'ATK_CATALOG_APPROVAL_HASH_MISMATCH'});
    await assert.rejects(client.callJournalledRead('account_get_config'),{code:'ATK_JOURNAL_REQUIRED'});
  } finally {await client.close();}
});
test('persistence failure pauses and closes transport without returning economic data',{timeout:15000},async()=>{
  const client=new ReadOnlyATK({nodePath:process.execPath,entryPath});let pauses=0,closed=false;
  try {
    await client.connect();client.attachObservationJournal({...config(),store:{openATKCaptureSession(){
      return {capture(){throw new Error('disk');},invalidate(){},close(){closed=true;}};
    },pauseGlobal(){pauses++;}}});
    await assert.rejects(client.callJournalledRead('account_get_config'),{code:'ATK_JOURNAL_CAPTURE_FAILED'});
    assert.equal(pauses,1);
    assert.equal(closed,true);
    await assert.rejects(client.callReadTool('account_get_config'),{code:'ATK_NOT_CONNECTED'});
  } finally {await client.close();}
});
test('catalog drift cannot permit subsequent calls',{timeout:15000},async()=>{
  const client=new ReadOnlyATK({nodePath:process.execPath,entryPath,profile:'drift'});
  const directory=mkdtempSync(join(tmpdir(),'pactway-drift-')),store=new Store(directory);
  try {
    await client.connect();client.attachObservationJournal({...config('drift'),store});
    // Same packet may contain both reply and notification. Either first-call
    // scheduling is valid; after drift has arrived no subsequent call may pass.
    try {await client.callJournalledRead('account_get_config');} catch(error) {assert.equal(error.code,'ATK_CATALOG_CHANGED');}
    await new Promise(resolve=>setTimeout(resolve,25));
    const saved=store.db.prepare('SELECT observation_id FROM atk_tool_observations').all();
    assert.equal(saved.length,1);
    assert.equal(store.atkObservationSource(saved[0].observation_id).activeSession,false);
    await assert.rejects(client.callJournalledRead('account_get_config'),{code:'ATK_CATALOG_CHANGED'});
  } finally {await client.close();store.close();rmSync(directory,{recursive:true,force:true});}
});

test('capture session registration failure closes transport and requests pause',{timeout:15000},async()=>{
  const client=new ReadOnlyATK({nodePath:process.execPath,entryPath});let pauses=0;
  try {
    await client.connect();
    assert.throws(()=>client.attachObservationJournal({...config(),store:{
      openATKCaptureSession(){throw new Error('disk');},pauseGlobal(){pauses++;},
    }}),{code:'ATK_JOURNAL_CAPTURE_FAILED'});
    assert.equal(pauses,1);
    await assert.rejects(client.callReadTool('account_get_config'),{code:'ATK_NOT_CONNECTED'});
  } finally {await client.close();}
});

test('operator config requires a complete bounded file pair and preserves explicit approval',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'pactway-journal-config-'));
  try {
    const supplied=config(),manifestPath=join(directory,'manifest.json'),approvalPath=join(directory,'approval.json');
    writeFileSync(manifestPath,JSON.stringify(supplied.manifest));writeFileSync(approvalPath,JSON.stringify(supplied.approval));
    // File JSON preserves the approved data, not in-memory null prototypes.
    assert.deepEqual(await loadATKJournalConfiguration({manifestPath,approvalPath}),
      JSON.parse(JSON.stringify({...supplied,accountExpectation:null})));
    assert.equal(await loadATKJournalConfiguration({}),null);
    const accountExpectationPath=join(directory,'account.json');
    const accountExpectation={schemaVersion:1,connectionHash:supplied.manifest.configHash,
      accountId:supplied.manifest.config.accountId,expectedUid:'123'};
    writeFileSync(accountExpectationPath,JSON.stringify(accountExpectation));
    assert.deepEqual((await loadATKJournalConfiguration({manifestPath,approvalPath,accountExpectationPath})).accountExpectation,accountExpectation);
    await assert.rejects(loadATKJournalConfiguration({accountExpectationPath}),/PAIR_REQUIRED/);
    writeFileSync(accountExpectationPath,JSON.stringify({...accountExpectation,accountId:'other-account'}));
    await assert.rejects(loadATKJournalConfiguration({manifestPath,approvalPath,accountExpectationPath}),/ATK_ACCOUNT_EXPECTATION/);
    await assert.rejects(loadATKJournalConfiguration({manifestPath}),/PAIR_REQUIRED/);
    await assert.rejects(loadATKJournalConfiguration({manifestPath:'relative.json',approvalPath}),/CONFIG_PATH/);
    writeFileSync(manifestPath,' '.repeat(16385));
    await assert.rejects(loadATKJournalConfiguration({manifestPath,approvalPath}),/CONFIG_SIZE/);
  } finally {rmSync(directory,{recursive:true,force:true});}
});
