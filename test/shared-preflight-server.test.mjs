import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {request as httpRequest} from 'node:http';
import {createServer as createNetServer} from 'node:net';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {FUJI_PROFILE} from '../src/audit/fuji-deployment-profile.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const invite='invite-'+('a'.repeat(40)),operator='operator-'+('b'.repeat(40));
function baseEnvironment(overrides={}) {
  const env={};
  for(const key of ['SystemRoot','WINDIR','TEMP','TMP','LOCALAPPDATA'])if(process.env[key])env[key]=process.env[key];
  return {...env,MG_PREFLIGHT_SHARED_DEMO:'1',MG_PUBLIC_ORIGIN:'https://shared.example',
    MG_INVITE_CODE:invite,MG_OPERATOR_KEY:operator,MG_EXECUTION_MODE:'fixture',MG_PLANNER:'ollama',
    MG_OLLAMA_URL:'http://127.0.0.1:11434/api/chat',MG_OLLAMA_MODEL:'test-model',MG_ATK_EXECUTION:'0',
    MG_ATK_ISOLATED:'1',MG_ATK_NODE:process.execPath,MG_ATK_ENTRY:'missing-entry',
    MG_ATK_UPSTREAM_ENTRY:'missing-upstream',MG_ATK_BOOTSTRAP_ENTRY:'missing-bootstrap',
    MG_ATK_MANIFEST_FILE:'missing-manifest',MG_ATK_CATALOG_APPROVAL_FILE:'missing-approval',
    MG_ATK_ACCOUNT_EXPECTATION_FILE:'missing-account',OKX_API_KEY:'test-key',OKX_SECRET_KEY:'test-secret',
    OKX_PASSPHRASE:'test-passphrase',...overrides};
}
async function unusedPort() {
  const probe=createNetServer();
  await new Promise((resolve,reject)=>{probe.once('error',reject);probe.listen(0,'127.0.0.1',resolve);});
  const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));return port;
}
async function exitsBeforeListening(env) {
  const child=spawn(process.execPath,['src/server.mjs'],{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';child.stdout.on('data',data=>{stdout+=data;});child.stderr.on('data',data=>{stderr+=data;});
  const code=await Promise.race([
    new Promise(resolve=>child.once('exit',resolve)),
    new Promise((_,reject)=>setTimeout(()=>{child.kill();reject(new Error('shared server unexpectedly kept running'));},3000))
  ]);
  return {code,output:stdout+stderr};
}

test('shared Preflight startup fails closed unless every read-only boundary is explicit',async()=>{
  const cases=[
    ['invalid flag',{MG_PREFLIGHT_SHARED_DEMO:'0'}],
    ['missing public origin',{MG_PUBLIC_ORIGIN:''}],
    ['non-HTTPS origin',{MG_PUBLIC_ORIGIN:'http://shared.example'}],
    ['same visitor and operator secret',{MG_OPERATOR_KEY:invite}],
    ['non-fixture execution',{MG_EXECUTION_MODE:'demo-prepared'}],
    ['non-Ollama planner',{MG_PLANNER:'fixture'}],
    ['ATK write mode',{MG_ATK_EXECUTION:'1'}],
    ['non-isolated ATK',{MG_ATK_ISOLATED:'0'}],
    ['missing ATK entry',{MG_ATK_ENTRY:''}],
    ['Fuji configured',{MG_FUJI_PROFILE:FUJI_PROFILE.id}]
  ];
  for(const [name,override] of cases) {
    const result=await exitsBeforeListening(baseEnvironment(override));
    assert.notEqual(result.code,0,name);assert.doesNotMatch(result.output,/Pactway fixture:/,name);
  }
});

async function sharedFixture(t) {
  const directory=await mkdtemp(join(tmpdir(),'pactway-shared-preflight-')),port=await unusedPort();
  const env=baseEnvironment({MG_PORT:String(port),MG_DATA_DIR:directory});
  const child=spawn(process.execPath,['src/server.mjs'],{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});
  const exited=new Promise(resolve=>child.once('exit',resolve));
  t.after(async()=>{
    if(child.exitCode===null&&child.signalCode===null)child.send({type:'PACTWAY_SHUTDOWN'});await exited;
    const target=await realpath(directory),parent=await realpath(tmpdir());assert.equal(dirname(target),parent);
    assert.ok(basename(target).startsWith('pactway-shared-preflight-'));await rm(target,{recursive:true,force:true});
  });
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('shared readiness timeout')),10000);
    child.stdout.on('data',data=>{if(data.toString().includes('Pactway fixture:')){clearTimeout(timer);resolve();}});
    child.once('error',reject);child.once('exit',()=>reject(new Error('shared server exited early')));
  });
  async function request(path,{method='GET',body,cookie,csrf,operatorKey}={}) {
    const payload=body===undefined?null:Buffer.from(JSON.stringify(body));
    return new Promise((resolve,reject)=>{
      const request=httpRequest({hostname:'127.0.0.1',port,path,method,headers:{Host:'shared.example',
        ...(cookie?{Cookie:cookie}:{}),...(operatorKey?{'X-MG-Operator':operatorKey}:{}),
        ...(method==='POST'?{Origin:'https://shared.example','Content-Type':'application/json','X-MG-CSRF':csrf??'',
          'Content-Length':String(payload?.length??0)}:{})}},response=>{
        const chunks=[];response.on('data',chunk=>chunks.push(chunk));response.on('end',()=>{
          const text=Buffer.concat(chunks).toString('utf8'),type=response.headers['content-type']??'';
          resolve({status:response.statusCode,headers:response.headers,data:type.includes('json')?JSON.parse(text):text});
        });
      });
      request.once('error',reject);if(payload)request.write(payload);request.end();
    });
  }
  return {request,child,exited};
}
async function joinSession(request) {
  const response=await request('/api/session/join',{method:'POST',body:{inviteCode:invite}});
  assert.equal(response.status,200);assert.deepEqual(Object.keys(response.data).sort(),['csrf','expiresAtMs']);
  return {cookie:response.headers['set-cookie'][0].split(';')[0],csrf:response.data.csrf};
}

test('shared Preflight exposes only its UI, session and owned API surface',async t=>{
  const f=await sharedFixture(t);
  assert.equal((await f.request('/api/bootstrap')).status,401);
  assert.equal((await f.request('/api/bootstrap')).data.inviteRequired,true);
  for(const path of ['/','/preflight.html','/preflight.css','/preflight.mjs',
    '/fonts/instrument-sans-latin-wght-normal.woff2'])assert.equal((await f.request(path)).status,200,path);
  for(const path of ['/legacy','/app.html','/app.mjs','/api/status','/api/work','/api/tasks',
    '/api/policy/draft','/api/operator/recovery','/api/market/refresh','/api/avalanche/refresh'])
    assert.equal((await f.request(path,{operatorKey:operator})).status,404,path);
  for(const path of ['/api/tasks','/api/operator/pause','/api/market/refresh','/api/avalanche/refresh'])
    assert.equal((await f.request(path,{method:'POST',body:{},operatorKey:operator})).status,404,path+' POST');
  assert.equal((await f.request('/api/preflight/status',{method:'PUT'})).status,404);

  const first=await joinSession(f.request),second=await joinSession(f.request);
  const bootstrap=await f.request('/api/bootstrap',{cookie:first.cookie});
  assert.equal(bootstrap.status,200);assert.deepEqual(Object.keys(bootstrap.data).sort(),['csrf','expiresAtMs']);
  const input={instrument:'AVAX-USDT',side:'buy',tdMode:'cash',ordType:'limit',maxNotional:'25',maxPrice:'25',durationSeconds:'600'};
  assert.equal((await f.request('/api/preflight/policies',{method:'POST',body:input,cookie:first.cookie,csrf:'wrong'})).status,403);
  const created=await f.request('/api/preflight/policies',{method:'POST',body:input,cookie:first.cookie,csrf:first.csrf});
  assert.equal(created.status,201);assert.equal((await f.request('/api/preflight/policies/'+created.data.id,{cookie:second.cookie})).status,404);
  assert.equal((await f.request('/api/preflight/policies/'+created.data.id+'/approve',{method:'POST',
    body:{policyHash:created.data.policyHash,acknowledgement:true},cookie:second.cookie,csrf:second.csrf})).status,404);
  assert.equal((await f.request('/api/session/leave',{method:'POST',body:{},cookie:first.cookie,csrf:first.csrf})).status,200);
  assert.equal((await f.request('/api/bootstrap',{cookie:first.cookie})).status,401);
});
