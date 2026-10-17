// Explicit live local-model acceptance against the separate, non-exchange preview.
// Creates one owned fixture task; never runs against the user's ATK port.
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
const DEFAULT_ORIGIN='http://127.0.0.1:18775';
const LOOPBACK_HOSTS=new Set(['127.0.0.1','localhost','[::1]']);
function checkedOrigin(value) {
  let url;
  try {url=new URL(value);} catch {throw new Error('invalid origin');}
  if(url.protocol!=='http:' || !LOOPBACK_HOSTS.has(url.hostname) || url.username || url.password ||
    url.pathname!=='/' || url.search || url.hash || !url.port)throw new Error('unsafe origin');
  const port=Number(url.port);
  if(!Number.isInteger(port) || port<1 || port>65535)throw new Error('invalid port');
  return url.origin;
}
function resolveOrigin(argv,environment) {
  let explicitOrigin,explicitPort;
  for(let index=0;index<argv.length;index++) {
    const argument=argv[index];
    if(argument==='--origin' || argument==='--port') {
      if(index+1>=argv.length)throw new Error('missing option value');
      if(argument==='--origin')explicitOrigin=argv[++index];
      else explicitPort=argv[++index];
    } else if(argument.startsWith('--origin='))explicitOrigin=argument.slice('--origin='.length);
    else if(argument.startsWith('--port='))explicitPort=argument.slice('--port='.length);
    else throw new Error('unknown option');
  }
  if(explicitOrigin!==undefined && explicitPort!==undefined)throw new Error('conflicting options');
  if(explicitPort!==undefined && !/^\d{1,5}$/.test(explicitPort))throw new Error('invalid port');
  const selected=explicitOrigin ?? (explicitPort===undefined ? (environment.MG_LOCAL_MODEL_APP_ORIGIN || DEFAULT_ORIGIN) : `http://127.0.0.1:${explicitPort}`);
  return checkedOrigin(selected);
}
let origin;
try {origin=resolveOrigin(process.argv.slice(2),process.env);} catch {console.error('LOCAL_MODEL_APP_ORIGIN_INVALID');process.exitCode=1;}
if(!origin)process.exit(1);
let cookie,csrf,taskId;
async function request(path,body) {
  const response=await fetch(origin+path,{method:body===undefined?'GET':'POST',redirect:'error',signal:AbortSignal.timeout(10000),
    headers:{...(cookie?{Cookie:cookie}:{}),...(body===undefined?{}:{Origin:origin,'Content-Type':'application/json','X-MG-CSRF':csrf})},
    ...(body===undefined?{}:{body:JSON.stringify(body)})});
  assert.ok(response.ok,'LOCAL_HTTP_REJECTED');
  if(!cookie)cookie=response.headers.get('set-cookie')?.split(';')[0];
  return response.json();
}
try {
  const bootstrap=await request('/api/bootstrap');csrf=bootstrap.csrf;
  assert.equal(bootstrap.status.executionMode,'fixture');assert.equal(bootstrap.status.plannerKind,'ollama');
  assert.equal(bootstrap.status.atk.state,'NOT_CONNECTED');assert.equal(bootstrap.status.atk.writeEnabled,false);
  const draft=await request('/api/policy/draft',{budget:'100',singleOrderNotionalMax:'25',maxPrice:'25',maxSharePercent:'10',durationSeconds:'600'});
  const task=await request('/api/tasks/approve-and-enqueue',{draftId:draft.id,expectedRevision:draft.revision,policyHash:draft.policyHash,acknowledgement:true});
  taskId=task.id;
  const started=Date.now();let result;
  do {
    await delay(500);result=await request('/api/tasks/'+taskId);
    if(['RELEASED','BLOCKED','CANCELLED'].includes(result.queueInfo.state) && !result.busy)break;
  }while(Date.now()-started<150000);
  console.log(JSON.stringify({stage:'MODEL_OBSERVED',elapsedMs:Date.now()-started,attempts:result.attempts,
    busy:result.busy,queue:result.queueInfo.state,decisions:result.receipts.map(receipt=>receipt.source.decision.kind)}));
  assert.equal(result.mode,'fixture');assert.equal(result.plannerKind,'ollama');assert.equal(result.busy,false);
  assert.ok(result.attempts>=1 && result.attempts<=3,'NO_VALID_LOCAL_PROPOSAL');
  assert.equal(result.auditVerified,true);
  const decisions=result.receipts.map(receipt=>receipt.source.decision.kind);
  assert.ok(!decisions.includes('PLANNER_UNAVAILABLE'),'LOCAL_MODEL_RESPONSE_FAILED');
  assert.ok(decisions.some(kind=>['VETO','ACCEPTED_AND_RESERVED','WAIT'].includes(kind)));
  console.log(JSON.stringify({result:'LOCAL_MODEL_APP_OK',elapsedMs:Date.now()-started,planner:result.plannerKind,
    execution:result.mode,attempts:result.attempts,auditVerified:result.auditVerified,decisions}));
}catch {console.error('LOCAL_MODEL_APP_FAILED');process.exitCode=1;}
finally {
  if(taskId)try {
    let task=await request('/api/tasks/'+taskId+'/stop',{});
    assert.equal(task.mode,'fixture');
    const until=Date.now()+65000;
    while(task.busy && Date.now()<until){await delay(500);task=await request('/api/tasks/'+taskId);}
    if(task.ledger.intents.some(intent=>!intent.settled))await request('/api/tasks/'+taskId+'/scenario',{kind:'confirm-cancel'});
    await request('/api/session/leave',{});
    console.log('LOCAL_FIXTURE_TEST_SESSION_CLOSED');
  }catch {console.error('LOCAL_FIXTURE_CLEANUP_REQUIRES_REVIEW');process.exitCode=1;}
}
