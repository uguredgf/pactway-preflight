import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname,basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {Store} from '../../src/persistence/store.mjs';
import {PreflightRepository} from '../../src/preflight/repository.mjs';
import {PreflightService} from '../../src/preflight/service.mjs';
import {runReplayExample} from '../../src/preflight/examples.mjs';

const root=fileURLToPath(new URL('../../',import.meta.url));
async function fixture(t) {
  const directory=await mkdtemp(join(tmpdir(),'pactway-preflight-http-')),probe=createServer();
  await new Promise((resolve,reject)=>{probe.once('error',reject);probe.listen(0,'127.0.0.1',resolve);});
  const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  const env={};for(const key of ['SystemRoot','WINDIR','TEMP','TMP','LOCALAPPDATA'])if(process.env[key])env[key]=process.env[key];
  Object.assign(env,{MG_PORT:String(port),MG_DATA_DIR:directory,MG_PLANNER:'fixture',MG_EXECUTION_MODE:'fixture',MG_ATK_EXECUTION:'0'});
  const child=spawn(process.execPath,['src/server.mjs'],{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  const exited=new Promise(resolve=>child.once('exit',resolve));
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill();await exited;
    const target=await realpath(directory),parent=await realpath(tmpdir());assert.equal(dirname(target),parent);
    assert.ok(basename(target).startsWith('pactway-preflight-http-'));await rm(target,{recursive:true,force:true});});
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('readiness timeout')),10000);
    child.stdout.on('data',data=>{if(data.toString().includes('Pactway fixture:')){clearTimeout(timer);resolve();}});
    child.stderr.on('data',()=>{});child.once('error',reject);child.once('exit',()=>reject(new Error('early exit')));});
  const origin='http://127.0.0.1:'+port;
  async function request(path,{method='GET',body,cookie,csrf,originHeader=origin}={}) {
    const response=await fetch(origin+path,{method,headers:{...(cookie?{Cookie:cookie}:{}),
      ...(method==='POST'?{...(originHeader?{Origin:originHeader}:{}),'Content-Type':'application/json','X-MG-CSRF':csrf}: {})},
      body:body===undefined?undefined:JSON.stringify(body),redirect:'error'});
    return {status:response.status,headers:response.headers,data:response.headers.get('content-type')?.includes('json')?await response.json():await response.text()};
  }
  const bootstrap=await request('/api/bootstrap');
  return {request,session:{cookie:bootstrap.headers.get('set-cookie').split(';')[0],csrf:bootstrap.data.csrf}};
}

test('preflight HTTP exposes the new product while preserving legacy and owner/CSRF boundaries',async t=>{
  const f=await fixture(t),auth={cookie:f.session.cookie,csrf:f.session.csrf};
  assert.match((await f.request('/')).data,/Pactway Preflight/);
  assert.match((await f.request('/legacy')).data,/Pactway/);
  const status=await f.request('/api/preflight/status',{cookie:auth.cookie});
  assert.equal(status.status,200);assert.equal(status.data.liveAvailable,false);assert.equal(status.data.orderSubmissionEnabled,false);
  assert.deepEqual(status.data.scope,{instrument:'AVAX-USDT',side:'buy',tdMode:'cash',ordType:'limit'});
  assert.equal((await f.request('/api/preflight/policies',{method:'POST',body:{},cookie:auth.cookie,csrf:'wrong'})).status,403);

  const policyBody={instrument:'AVAX-USDT',side:'buy',tdMode:'cash',ordType:'limit',maxNotional:'25',maxPrice:'25',durationSeconds:'600'};
  assert.equal((await f.request('/api/preflight/policies',{method:'POST',body:policyBody,...auth,
    originHeader:'https://foreign.example'})).status,403);
  assert.equal((await f.request('/api/preflight/policies',{method:'POST',body:policyBody,...auth,originHeader:''})).status,403);
  for(const bad of [{...policyBody,extra:true},{...policyBody,maxNotional:25}]) {
    const response=await f.request('/api/preflight/policies',{method:'POST',body:bad,...auth});
    assert.equal(response.status,400);assert.equal(response.data.code,'PREFLIGHT_INPUT_INVALID');
  }
  const draft=(await f.request('/api/preflight/policies',{method:'POST',body:policyBody,...auth})).data;
  assert.equal((await f.request('/api/preflight/policies/'+draft.id.toUpperCase(),{cookie:auth.cookie})).status,400);
  assert.equal((await f.request('/api/preflight/policies/'+draft.id+'/approve',{
    method:'POST',body:{policyHash:'0'.repeat(64),acknowledgement:true},...auth})).status,400);
  assert.equal((await f.request('/api/preflight/policies/'+draft.id+'/approve',{
    method:'POST',body:{policyHash:draft.policyHash,acknowledgement:false},...auth})).status,400);
  const approved=(await f.request('/api/preflight/policies/'+draft.id+'/approve',{
    method:'POST',body:{policyHash:draft.policyHash,acknowledgement:true},...auth})).data;
  assert.equal(approved.status,'APPROVED');
  const checkBody={policyId:approved.id,policyHash:approved.policyHash,
    candidate:{instrument:'AVAX-USDT',side:'buy',tdMode:'cash',ordType:'limit',price:'25',size:'0.4'},clientRequestId:randomUUID()};
  const uppercase=await f.request('/api/preflight/checks',{method:'POST',body:{...checkBody,
    clientRequestId:checkBody.clientRequestId.toUpperCase()},...auth});
  assert.equal(uppercase.status,400);assert.equal(uppercase.data.code,'PREFLIGHT_INPUT_INVALID');
  const first=await f.request('/api/preflight/checks',{method:'POST',body:checkBody,...auth});
  assert.equal(first.status,202);const replay=await f.request('/api/preflight/checks',{method:'POST',body:checkBody,...auth});
  assert.equal(replay.status,202);assert.equal(replay.data.id,first.data.id);
  const conflict=await f.request('/api/preflight/checks',{method:'POST',body:{...checkBody,
    candidate:{...checkBody.candidate,size:'0.5'}},...auth});
  assert.equal(conflict.status,409);assert.equal(conflict.data.code,'PREFLIGHT_IDEMPOTENCY_CONFLICT');
  assert.equal((await f.request('/api/preflight/agent-checks',{method:'POST',body:checkBody,...auth})).status,409);
  let result;
  for(let attempt=0;attempt<20;attempt++){
    result=await f.request('/api/preflight/checks/'+first.data.id,{cookie:auth.cookie});
    if(result.data.state==='COMPLETED')break;await new Promise(resolve=>setTimeout(resolve,20));
  }
  assert.equal(result.data.report.verdict,'INSUFFICIENT_DATA');assert.equal(result.data.report.sanitizedEvidence,null);
  assert.equal((await f.request('/api/preflight/checks/'+first.data.id+'/report',{cookie:auth.cookie})).status,200);
  const agentBody={...checkBody,clientRequestId:randomUUID()};
  assert.equal((await f.request('/api/preflight/agent-checks',{method:'POST',body:agentBody,cookie:auth.cookie,csrf:'wrong'})).status,403);
  const agent=await f.request('/api/preflight/agent-checks',{method:'POST',body:agentBody,...auth});
  assert.equal(agent.status,202);assert.equal(agent.data.source,'AGENT');
  let agentResult;
  for(let attempt=0;attempt<20;attempt++){
    agentResult=await f.request('/api/preflight/checks/'+agent.data.id,{cookie:auth.cookie});
    if(agentResult.data.state==='COMPLETED')break;await new Promise(resolve=>setTimeout(resolve,20));
  }
  assert.equal(agentResult.data.report.verdict,'INSUFFICIENT_DATA');
  assert.equal(agentResult.data.report.agentTrace.failureCode,'PREFLIGHT_LIVE_UNAVAILABLE');
  const exampleId=randomUUID(),exampleBody={clientRequestId:exampleId};
  const example=await f.request('/api/preflight/examples/within-limits',{method:'POST',body:exampleBody,...auth});
  const exampleRetry=await f.request('/api/preflight/examples/within-limits',{method:'POST',body:exampleBody,...auth});
  assert.equal(example.status,200);assert.equal(example.data.mode,'REPLAY');assert.equal(example.data.report.verdict,'ALLOW');
  assert.equal(exampleRetry.data.id,example.data.id);
  const history=await f.request('/api/preflight/history',{cookie:auth.cookie});
  assert.equal(history.data.policies.length,1);assert.equal(history.data.policies[0].status,'APPROVED');
  assert.equal(history.data.checks.length,3);

  const secondBootstrap=await f.request('/api/bootstrap'),second={cookie:secondBootstrap.headers.get('set-cookie').split(';')[0],
    csrf:secondBootstrap.data.csrf};
  assert.equal((await f.request('/api/preflight/history',{cookie:second.cookie})).data.policies.length,0);
  assert.equal((await f.request('/api/preflight/policies/'+approved.id,{cookie:second.cookie})).status,404);
  assert.equal((await f.request('/api/preflight/policies/'+approved.id+'/approve',{
    method:'POST',body:{policyHash:approved.policyHash,acknowledgement:true},...second})).status,404);
  assert.equal((await f.request('/api/preflight/checks/'+first.data.id,{cookie:second.cookie})).status,404);
  assert.equal((await f.request('/api/preflight/checks/'+first.data.id+'/report',{cookie:second.cookie})).status,404);
  assert.equal((await f.request('/api/preflight/checks/'+agent.data.id,{cookie:second.cookie})).status,404);
});

test('a real server restart completes interrupted checks without repeating external work',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'pactway-preflight-process-restart-')),probe=createServer();
  await new Promise((resolve,reject)=>{probe.once('error',reject);probe.listen(0,'127.0.0.1',resolve);});
  const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  const ownerId=randomUUID(),token='a'.repeat(64),tokenHash=createHash('sha256').update(token).digest('hex');
  let store=new Store(directory),repository=new PreflightRepository(store),child=null;
  store.saveSession({tokenHash,ownerId,csrf:'e'.repeat(64),expiresAtMs:Date.now()+3600000});
  const service=new PreflightService({repository,getRuntime:()=>{throw new Error('seed runtime must not run');}});
  const policyInput={instrument:'AVAX-USDT',side:'buy',tdMode:'cash',ordType:'limit',
    maxNotional:'25',maxPrice:'25',durationSeconds:'600'};
  const draft=service.createPolicy(ownerId,policyInput),policy=service.approvePolicy(ownerId,draft.id,
    {policyHash:draft.policyHash,acknowledgement:true});
  const policyRecord=Object.fromEntries(['id','policy','policyHash','status','createdAtMs','validFromMs','expiresAtMs']
    .map(key=>[key,policy[key]]));
  const candidate={instrument:'AVAX-USDT',side:'buy',tdMode:'cash',ordType:'limit',price:'25',size:'0.4'};
  const liveInput={policyId:policy.id,policyHash:policy.policyHash,candidate,clientRequestId:randomUUID()};
  const live=repository.createCheck(ownerId,{...liveInput,policyRecord},{idempotencyInput:liveInput}).record;
  repository.markRunning(ownerId,live.id);repository.reservePlanCall(ownerId,live.id);
  const replayName='within-limits',replayInput={clientRequestId:randomUUID(),name:replayName};
  const replay=repository.createCheck(ownerId,replayInput,{mode:'REPLAY'}).record;repository.markRunning(ownerId,replay.id);
  store.pauseGlobal('OPERATOR_PAUSE');await service.close();store.close();store=null;

  const env={};for(const key of ['SystemRoot','WINDIR','TEMP','TMP','LOCALAPPDATA'])if(process.env[key])env[key]=process.env[key];
  Object.assign(env,{MG_PORT:String(port),MG_DATA_DIR:directory,MG_PLANNER:'fixture',MG_EXECUTION_MODE:'fixture',MG_ATK_EXECUTION:'0'});
  child=spawn(process.execPath,['src/server.mjs'],{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});
  const exited=new Promise(resolve=>child.once('exit',resolve));
  t.after(async()=>{
    if(child && child.exitCode===null&&child.signalCode===null)child.send({type:'PACTWAY_SHUTDOWN'});if(child)await exited;
    if(store)store.close();const target=await realpath(directory),parent=await realpath(tmpdir());
    assert.equal(dirname(target),parent);assert.ok(basename(target).startsWith('pactway-preflight-process-restart-'));
    await rm(target,{recursive:true,force:true});
  });
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('restart readiness timeout')),10000);
    child.stdout.on('data',data=>{if(data.toString().includes('Pactway fixture:')){clearTimeout(timer);resolve();}});
    child.stderr.on('data',()=>{});child.once('error',reject);child.once('exit',()=>reject(new Error('restart early exit')));});
  const origin='http://127.0.0.1:'+port,cookie=`mg-session-${port}=${token}`;
  const get=async path=>{const response=await fetch(origin+path,{headers:{Cookie:cookie}});return {status:response.status,data:await response.json()};};
  const liveHttp=await get('/api/preflight/checks/'+live.id),replayHttp=await get('/api/preflight/checks/'+replay.id);
  assert.equal(liveHttp.status,200);assert.equal(liveHttp.data.state,'COMPLETED');
  assert.equal(liveHttp.data.report.verdict,'INSUFFICIENT_DATA');
  assert.equal(liveHttp.data.report.agentTrace.failureCode,'PREFLIGHT_PROCESS_RESTARTED');
  assert.equal(replayHttp.status,200);assert.deepEqual(replayHttp.data.report,runReplayExample(replayName));

  child.send({type:'PACTWAY_SHUTDOWN'});await exited;child=null;store=new Store(directory);
  assert.equal(store.db.prepare("SELECT used FROM model_call_budget WHERE provider='preflight-ollama'").get().used,1);
  assert.equal(store.globalSafetyStatus().reason,'OPERATOR_PAUSE');assert.equal(store.readOnlySafetyStatus().allowed,false);
});
