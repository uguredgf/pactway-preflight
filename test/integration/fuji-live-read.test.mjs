// Explicit opt-in integration: starts an isolated fixture server, reads public Fuji RPC,
// performs no wallet/signing/transaction action, and closes via IPC. Not in npm test.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {mkdtemp,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {FUJI_PROFILE} from '../../src/audit/fuji-deployment-profile.mjs';

test('isolated server separately verifies deployment and the archived first-receipt acceptance fixture', {timeout:55000},async t=>{
  const root=fileURLToPath(new URL('../../',import.meta.url));
  const directory=await mkdtemp(join(tmpdir(),'pactway-fuji-http-'));
  const probe=createServer();
  await new Promise((resolve,reject)=>{probe.once('error',reject);probe.listen(0,'127.0.0.1',resolve);});
  const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  const env={};
  for(const key of ['SystemRoot','WINDIR','TEMP','TMP'])if(process.env[key])env[key]=process.env[key];
  Object.assign(env,{MG_PORT:String(port),MG_DATA_DIR:directory,MG_PLANNER:'fixture',MG_EXECUTION_MODE:'fixture',MG_ATK_EXECUTION:'0',MG_FUJI_PROFILE:FUJI_PROFILE.id});
  const child=spawn(process.execPath,['src/server.mjs'],{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});
  const exited=new Promise(resolve=>child.once('exit',resolve));
  t.after(async()=>{
    if(child.connected)child.send({type:'PACTWAY_SHUTDOWN'});
    const result=await Promise.race([exited.then(code=>({code})),delay(35000,undefined,{ref:false}).then(()=>({timeout:true}))]);
    if(result.timeout){child.kill();await exited;assert.fail('Graceful shutdown timed out');}
    assert.equal(result.code,0);
    await assert.rejects(access(join(directory,'owner.lock')),{code:'ENOENT'});
  });
  child.stderr.on('data',()=>{});
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('Server readiness timeout')),10000);
    child.stdout.on('data',chunk=>{if(chunk.toString().includes('Pactway fixture:')){clearTimeout(timer);resolve();}});
    child.once('error',error=>{clearTimeout(timer);reject(error);});
    child.once('exit',()=>{clearTimeout(timer);reject(new Error('Server exited'));});
  });
  const origin='http://127.0.0.1:'+port;
  const bootstrap=await fetch(origin+'/api/bootstrap',{signal:AbortSignal.timeout(5000)});
  assert.equal(bootstrap.status,200);
  const cookie=bootstrap.headers.get('set-cookie').split(';')[0];
  let status=(await bootstrap.json()).status;
  const deadline=Date.now()+35000;
  while((status.avalanche.state==='VERIFYING_DEPLOYMENT'
      || status.avalanche.acceptanceTest?.state==='VERIFYING') && Date.now()<deadline){
    await delay(250);
    const response=await fetch(origin+'/api/status',{headers:{Cookie:cookie},signal:AbortSignal.timeout(5000)});
    assert.equal(response.status,200);status=await response.json();
  }
  assert.equal(status.avalanche.state,'DEPLOYMENT_VERIFIED');
  assert.equal(status.avalanche.contractAddress,FUJI_PROFILE.contractAddress);
  assert.equal(status.avalanche.publication,'TASK_RECEIPTS_NOT_VERIFIED');
  assert.equal(status.avalanche.writeEnabled,false);
  assert.deepEqual(status.avalanche.acceptanceTest,{state:'VERIFIED',mode:'fixture',
    policyTx:'0xb5fad2b9b143c705772e573a487006ac39131aef35704c16d020e54a147c5fd6',
    firstReceiptTx:'0xee5c74fb2da7962600c99dea50e9d4f6e02201eb36ab96ef25db85e6dd8921df',
    sequence:'1',onlyFirstReceipt:true,writeEnabled:false});
  assert.equal(status.atk.writeEnabled,false);assert.equal(status.atk.state,'NOT_CONNECTED');
  assert.equal(status.executionMode,'fixture');assert.equal(status.plannerKind,'fixture');
});
