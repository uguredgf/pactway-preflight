// Explicit local HTTP acceptance. Not included in the source-only test/*.test.mjs glob.
// Starts only the existing fixture server on loopback with an allowlisted environment.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {request as httpRequest} from 'node:http';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname,basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';

const root=fileURLToPath(new URL('../../',import.meta.url));
const fields={budget:'100',singleOrderNotionalMax:'25',maxPrice:'25',maxSharePercent:'10',durationSeconds:'600'};
const approval=d=>({draftId:d.id,expectedRevision:d.revision,policyHash:d.policyHash,acknowledgement:true});

async function fixture(t) {
  const directory=await mkdtemp(join(tmpdir(),'pactway-http-acceptance-'));
  const probe=createServer();
  await new Promise((resolve,reject)=>{probe.once('error',reject);probe.listen(0,'127.0.0.1',resolve);});
  const port=probe.address().port;
  await new Promise(resolve=>probe.close(resolve));
  const env={};
  for(const key of ['SystemRoot','WINDIR','TEMP','TMP','LOCALAPPDATA'])if(process.env[key])env[key]=process.env[key];
  Object.assign(env,{MG_PORT:String(port),MG_DATA_DIR:directory,MG_PLANNER:'fixture',MG_EXECUTION_MODE:'fixture',MG_ATK_EXECUTION:'0'});
  const child=spawn(process.execPath,['src/server.mjs'],{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  const exited=new Promise(resolve=>child.once('exit',resolve));
  t.after(async()=>{
    if(child.exitCode===null && child.signalCode===null)child.kill();
    await exited;
    const target=await realpath(directory),parent=await realpath(tmpdir());
    assert.equal(dirname(target),parent);
    assert.ok(basename(target).startsWith('pactway-http-acceptance-'));
    await rm(target,{recursive:true,force:true,maxRetries:4,retryDelay:200});
  });
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('Fixture server readiness timeout')),10000);
    const done=()=>{clearTimeout(timer);resolve();};
    child.stdout.on('data',data=>{if(data.toString().includes('Pactway fixture:'))done();});
    child.stderr.on('data',()=>{}); // Drain without exposing environment or file paths.
    child.once('error',error=>{clearTimeout(timer);reject(error);});
    child.once('exit',()=>{clearTimeout(timer);reject(new Error('Fixture server exited before readiness'));});
  });
  const origin='http://127.0.0.1:'+port;
  async function request(path,{session,body,method=body===undefined?'GET':'POST',headers={},discardResponse=false}={}) {
    assert.ok(path.startsWith('/api/') || path==='/');
    // Raw HTTP preserves explicit Host for the host-boundary negative test.
    // Node fetch may normalize/replace it, which would not exercise that boundary.
    return new Promise((resolve,reject)=>{
      const request=httpRequest(origin+path,{method,headers:{
        ...(session?{Cookie:session.cookie,'X-MG-CSRF':session.csrf}:{}),
        ...(method==='POST'?{Origin:origin,'Content-Type':'application/json'}:{}),...headers}},response=>{
        // Deliberately discard the committed approval's response body; the client
        // must recover through the exact original request, not create a new task.
        if(discardResponse){response.destroy();resolve({status:response.statusCode,discarded:true});return;}
        const chunks=[];response.on('data',chunk=>chunks.push(chunk));response.on('error',reject);
        response.on('end',()=>{
          try {
            const content=Buffer.concat(chunks).toString('utf8'),headers=new Headers();
            for(const [key,value] of Object.entries(response.headers))for(const item of Array.isArray(value)?value:[value])if(item!==undefined)headers.append(key,item);
            resolve({status:response.statusCode,headers,data:headers.get('content-type')?.includes('application/json')?JSON.parse(content):content});
          }catch(error){reject(error);}
        });
      });
      request.setTimeout(5000,()=>request.destroy(new Error('Local HTTP timeout')));request.on('error',reject);
      request.end(body===undefined?undefined:JSON.stringify(body));
    });
  }
  async function session() {
    const r=await request('/api/bootstrap');assert.equal(r.status,200);
    return {cookie:r.headers.get('set-cookie').split(';')[0],csrf:r.data.csrf,bootstrap:r};
  }
  async function draft(owner,input=fields) {
    const r=await request('/api/policy/draft',{session:owner,body:input});assert.equal(r.status,200);return r.data;
  }
  async function waitTask(owner,id,predicate) {
    const until=Date.now()+6000;
    do {const r=await request('/api/tasks/'+id,{session:owner});assert.equal(r.status,200);if(predicate(r.data))return r.data;await delay(100);}while(Date.now()<until);
    throw new Error('Fixture task condition timeout');
  }
  return {request,session,draft,waitTask,origin};
}

test('local HTTP acceptance: real server, separate cookies, fixture only',async t=>{
  const f=await fixture(t),a=await f.session(),b=await f.session();
  let draft,task;
  await t.test('isolated fixture mode and HTTP document/cookie protections',async()=>{
    assert.notEqual(a.cookie,b.cookie);assert.notEqual(a.csrf,b.csrf);
    const status=a.bootstrap.data.status;
    assert.equal(status.executionMode,'fixture');assert.equal(status.plannerKind,'fixture');
    assert.equal(status.extractorAvailable,false);assert.equal(status.atk.state,'NOT_CONNECTED');
    assert.equal(status.atk.writeEnabled,false);assert.equal(status.atk.orderSubmissionEnabled,false);
    assert.equal(status.atk.transferEnabled,false);assert.equal(status.avalanche.state,'NOT_DEPLOYED');
    const cookie=a.bootstrap.headers.get('set-cookie');assert.match(cookie,new RegExp('^mg-session-'+new URL(f.origin).port+'='));
    assert.match(cookie,/HttpOnly/);assert.match(cookie,/SameSite=Strict/);assert.match(cookie,/Path=\//);
    const doc=await f.request('/');assert.equal(doc.status,200);
    assert.equal(doc.headers.get('x-content-type-options'),'nosniff');
    assert.match(doc.headers.get('content-security-policy'),/connect-src 'self'/);
    assert.match(doc.headers.get('content-security-policy'),/frame-ancestors 'none'/);
  });
  await t.test('unauthenticated, foreign-origin and invalid CSRF requests are rejected',async()=>{
    assert.equal((await f.request('/api/work')).status,401);
    assert.equal((await f.request('/api/policy/draft',{session:a,body:fields,headers:{Origin:'https://untrusted.invalid'}})).status,403);
    assert.equal((await f.request('/api/policy/draft',{session:a,body:fields,headers:{'X-MG-CSRF':b.csrf}})).status,403);
    assert.equal((await f.request('/api/policy/draft',{session:a,body:fields,headers:{Origin:''}})).status,403);
    assert.equal((await f.request('/api/work',{session:a,headers:{'Sec-Fetch-Site':'cross-site'}})).status,403);
    assert.equal((await f.request('/api/work',{session:a,headers:{Host:'untrusted.invalid'}})).status,403);
    assert.equal((await f.request('/api/operator/recovery',{session:a})).status,404);
    assert.equal((await f.request('/api/market/refresh',{body:{}})).status,401);
    assert.equal((await f.request('/api/market/refresh',{session:a,body:{},headers:{'X-MG-CSRF':b.csrf}})).status,403);
    assert.equal((await f.request('/api/market/refresh',{session:a,body:{}})).status,409);
    assert.equal((await f.request('/api/avalanche/refresh',{session:a,body:{}})).status,409);
    assert.equal((await f.request('/api/policy/draft',{session:a,body:fields,headers:{'Content-Type':'text/plain'}})).status,415);
  });
  await t.test('drafts are owner scoped; stale review and unchecked approval create no task',async()=>{
    draft=await f.draft(a);
    assert.equal((await f.request('/api/policy/drafts/'+draft.id,{session:b})).status,404);
    assert.equal((await f.request('/api/policy/drafts/'+draft.id+'/edit',{session:b,body:{expectedRevision:draft.revision,fields:{maxPrice:'24'}}})).status,404);
    const edit=await f.request('/api/policy/drafts/'+draft.id+'/edit',{session:a,body:{expectedRevision:draft.revision,fields:{maxPrice:'25'}}});assert.equal(edit.status,200);
    const stale=await f.request('/api/tasks/approve-and-enqueue',{session:a,body:approval(draft)});assert.ok(stale.status>=400);
    draft=edit.data;
    assert.ok((await f.request('/api/tasks/approve-and-enqueue',{session:a,body:{...approval(draft),acknowledgement:false}})).status>=400);
    assert.deepEqual((await f.request('/api/work',{session:a})).data.tasks,[]);
    assert.deepEqual((await f.request('/api/work',{session:b})).data.drafts,[]);
  });
  await t.test('discarded approval response and concurrent retry return one task and one approval receipt',async()=>{
    const lost=await f.request('/api/tasks/approve-and-enqueue',{session:a,body:approval(draft),discardResponse:true});
    assert.equal(lost.status,201);assert.equal(lost.discarded,true);
    const results=await Promise.all([1,2].map(()=>f.request('/api/tasks/approve-and-enqueue',{session:a,body:approval(draft)})));
    assert.deepEqual(results.map(r=>r.status),[200,200]);
    assert.ok(results.every(r=>r.data.approvalReplayed===true));
    assert.equal(results[0].data.id,results[1].data.id);task=results[0].data;
    assert.equal((await f.request('/api/work',{session:a})).data.tasks.length,1);
    const audit=await f.request('/api/tasks/'+task.id+'/audit',{session:a});
    assert.equal(audit.data.receipts.filter(r=>r.source.decision.kind==='POLICY_APPROVED_AND_QUEUED').length,1);
    assert.equal(audit.data.verified,true);assert.equal(audit.data.publication,'LOCAL_ONLY');
  });
  await t.test('foreign owner cannot read task/audit, stop, run, mutate or replay approval',async()=>{
    for(const suffix of ['', '/audit'])assert.equal((await f.request('/api/tasks/'+task.id+suffix,{session:b})).status,404);
    for(const suffix of ['/stop','/run','/scenario'])assert.equal((await f.request('/api/tasks/'+task.id+suffix,{session:b,body:{kind:'unknown'}})).status,404);
    assert.equal((await f.request('/api/tasks/approve-and-enqueue',{session:b,body:approval(draft)})).status,404);
    assert.deepEqual((await f.request('/api/work',{session:b})).data.tasks,[]);
  });
  await t.test('capacity rejection preserves draft; explicit retry after a slot opens admits exactly once',async()=>{
    task=await f.waitTask(a,task.id,value=>value.queueInfo.state==='BLOCKED');
    assert.equal(task.ledger.intents.length,1);
    const waiting=[];
    for(let index=0;index<3;index++) {
      const owner=await f.session(),d=await f.draft(owner);
      const r=await f.request('/api/tasks/approve-and-enqueue',{session:owner,body:approval(d)});
      assert.equal(r.status,201);assert.equal(r.data.queueInfo.state,'QUEUED');assert.equal(r.data.queueInfo.position,index+1);
      waiting.push({owner,id:r.data.id});
    }
    const owner=await f.session(),d=await f.draft(owner);
    const rejected=await Promise.all([1,2].map(()=>f.request('/api/tasks/approve-and-enqueue',{session:owner,body:approval(d)})));
    for(const r of rejected) {
      assert.equal(r.status,409);assert.equal(r.data.code,'QUEUE_CAPACITY_EXCEEDED');
      assert.match(r.data.error,/Üç bekleyen görev kapasitesi dolu/);assert.match(r.data.error,/Otomatik tekrar yapılmaz/);
      assert.deepEqual(Object.keys(r.data).sort(),['code','error']);
    }
    assert.deepEqual((await f.request('/api/work',{session:owner})).data.tasks,[]);
    assert.deepEqual((await f.request('/api/policy/drafts/'+d.id,{session:owner})).data,d);
    assert.equal((await f.request('/api/tasks/'+d.id+'/audit',{session:owner})).status,404);
    const stopped=await f.request('/api/tasks/'+waiting[0].id+'/stop',{session:waiting[0].owner,body:{}});
    assert.equal(stopped.status,200);assert.equal(stopped.data.queueInfo.state,'CANCELLED');
    // Free capacity alone must not consume the rejected draft or enqueue it.
    assert.deepEqual((await f.request('/api/work',{session:owner})).data.tasks,[]);
    const retries=await Promise.all([1,2].map(()=>f.request('/api/tasks/approve-and-enqueue',{session:owner,body:approval(d)})));
    assert.deepEqual(retries.map(r=>r.status).sort(),[200,201]);
    for(const r of retries) {
      assert.equal(r.data.id,d.id);assert.equal(r.data.queueInfo.state,'QUEUED');
      assert.equal(r.data.queueInfo.position,3);assert.equal(r.data.policy.expiresAtMs,d.policy.expiresAtMs);
      assert.equal(r.data.ledger.intents.length,0);assert.equal(r.data.summary.reserved,'0');
    }
    const audit=await f.request('/api/tasks/'+d.id+'/audit',{session:owner});
    assert.equal(audit.data.verified,true);
    assert.equal(audit.data.receipts.filter(r=>r.source.decision.kind==='POLICY_APPROVED_AND_QUEUED').length,1);
    assert.equal((await f.request('/api/work',{session:owner})).data.tasks.length,1);
  });
  await t.test('partial fill, UNKNOWN, stop and retry preserve spend/reserve without resubmission',async()=>{
    const route='/api/tasks/'+task.id;
    const partial=await f.request(route+'/scenario',{session:a,body:{kind:'partial'}});assert.equal(partial.status,200);
    assert.notEqual(partial.data.summary.spent,'0');assert.notEqual(partial.data.summary.reserved,'0');
    const unknown=await f.request(route+'/scenario',{session:a,body:{kind:'unknown'}});assert.equal(unknown.status,200);
    assert.equal(unknown.data.ledger.intents[0].state,'UNKNOWN');
    const stop=await f.request(route+'/stop',{session:a,body:{}});assert.equal(stop.status,200);
    assert.equal(stop.data.ledger.intents[0].state,'CANCEL_PENDING');
    assert.equal(stop.data.summary.spent,partial.data.summary.spent);assert.equal(stop.data.summary.reserved,partial.data.summary.reserved);
    const replay=await f.request('/api/tasks/approve-and-enqueue',{session:a,body:approval(draft)});assert.equal(replay.status,200);
    assert.equal(replay.data.ledger.intents.length,1);assert.equal(replay.data.summary.reserved,partial.data.summary.reserved);
    assert.equal((await f.request('/api/session/leave',{session:a,body:{}})).status,409);
    const settled=await f.request(route+'/scenario',{session:a,body:{kind:'confirm-cancel'}});assert.equal(settled.status,200);
    assert.equal(settled.data.summary.reserved,'0');assert.equal(settled.data.summary.spent,partial.data.summary.spent);
  });
  await t.test('logout invalidates old cookie; new session cannot inherit old owner data',async()=>{
    const leave=await f.request('/api/session/leave',{session:a,body:{}});assert.equal(leave.status,200);
    assert.match(leave.headers.get('set-cookie'),/Max-Age=0/);
    assert.equal((await f.request('/api/work',{session:a})).status,401);
    const fresh=await f.session();assert.deepEqual(fresh.bootstrap.data.tasks,[]);assert.deepEqual(fresh.bootstrap.data.drafts,[]);
    assert.equal((await f.request('/api/tasks/'+task.id,{session:fresh})).status,404);
  });
});

test('same-host fixture ports retain independent browser sessions when one logs out',async t=>{
  const first=await fixture(t),second=await fixture(t);
  const firstSession=await first.session(),secondSession=await second.session();
  assert.notEqual(new URL(first.origin).port,new URL(second.origin).port);
  assert.notEqual(firstSession.cookie.split('=')[0],secondSession.cookie.split('=')[0]);

  // Browsers send host-scoped cookies to both ports. Each server must select only
  // its namespaced cookie from the shared header.
  const browserCookie=`${firstSession.cookie}; ${secondSession.cookie}`;
  const firstBrowser={...firstSession,cookie:browserCookie};
  const secondBrowser={...secondSession,cookie:browserCookie};
  assert.equal((await first.request('/api/work',{session:firstBrowser})).status,200);
  assert.equal((await second.request('/api/work',{session:secondBrowser})).status,200);

  const logout=await first.request('/api/session/leave',{session:firstBrowser,body:{}});
  assert.equal(logout.status,200);
  assert.match(logout.headers.get('set-cookie'),new RegExp('^'+firstSession.cookie.split('=')[0]+'=;'));
  assert.equal((await first.request('/api/work',{session:firstBrowser})).status,401);
  assert.equal((await second.request('/api/work',{session:secondBrowser})).status,200);
});
