// Explicit loopback transport acceptance; not browser E2E or proxy/security acceptance.
// The test-only proxy drops a fully committed approval before sending any response.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer,request as httpRequest} from 'node:http';
import {createServer as createProbe} from 'node:net';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname,basename} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../../',import.meta.url));
const prefix='pactway-approval-loss-';
const approvalPath='/api/tasks/approve-and-enqueue';
const fields={budget:'100',singleOrderNotionalMax:'25',maxPrice:'25',maxSharePercent:'10',durationSeconds:'600'};

async function listen(server) {
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  return server.address().port;
}

function request(origin,path,{session,body}={}) {
  assert.ok(path.startsWith('/api/'));
  return new Promise((resolve,reject)=>{
    const req=httpRequest(origin+path,{method:body===undefined?'GET':'POST',agent:false,headers:{
      ...(session?{Cookie:session.cookie,'X-MG-CSRF':session.csrf}:{}),
      ...(body===undefined?{}:{Origin:origin,'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)})
    }},res=>{
      const chunks=[];
      res.on('data',chunk=>chunks.push(chunk));res.on('error',reject);
      res.on('end',()=>{
        try {resolve({status:res.statusCode,headers:res.headers,data:JSON.parse(Buffer.concat(chunks).toString('utf8'))});}
        catch(error){reject(error);}
      });
    });
    req.setTimeout(5000,()=>req.destroy(new Error('Loopback request timeout')));
    req.on('error',reject);req.end(body);
  });
}

async function fixture(t) {
  const directory=await mkdtemp(join(tmpdir(),prefix));
  let child,closed,proxy;
  const sockets=new Set(),upstreams=new Set();
  t.after(async()=>{
    for(const upstream of upstreams)upstream.destroy();
    for(const socket of sockets)socket.destroy();
    if(proxy?.listening)await new Promise(resolve=>proxy.close(resolve));
    if(child && child.exitCode===null && child.signalCode===null)child.kill();
    if(closed)await closed;
    const target=await realpath(directory),parent=await realpath(tmpdir());
    assert.equal(dirname(target),parent);
    assert.ok(basename(target).startsWith(prefix));
    await rm(target,{recursive:true,force:true,maxRetries:4,retryDelay:200});
  });
  const probe=createProbe(),port=await listen(probe);
  await new Promise(resolve=>probe.close(resolve));
  const env={};
  for(const key of ['SystemRoot','WINDIR','TEMP','TMP','LOCALAPPDATA'])if(process.env[key])env[key]=process.env[key];
  Object.assign(env,{MG_PORT:String(port),MG_DATA_DIR:directory,MG_PLANNER:'fixture',MG_EXECUTION_MODE:'fixture',MG_ATK_EXECUTION:'0'});
  child=spawn(process.execPath,['src/server.mjs'],{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  closed=new Promise(resolve=>child.once('close',resolve));
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('Fixture readiness timeout')),10000);
    child.stdout.on('data',data=>{if(data.toString().includes('Pactway fixture:')){clearTimeout(timer);resolve();}});
    child.stderr.on('data',()=>{});
    child.once('error',error=>{clearTimeout(timer);reject(error);});
    child.once('exit',()=>{clearTimeout(timer);reject(new Error('Fixture exited before readiness'));});
  });
  const upstreamOrigin='http://127.0.0.1:'+port;
  const observations={approvalBodies:[],dropped:null,errors:[]};
  let armed=false;
  proxy=createServer((incoming,outgoing)=>{
    // Fixed loopback destination and explicit API paths: this is not a general proxy.
    if(!/^\/api\/[a-zA-Z0-9/-]+$/.test(incoming.url)){outgoing.writeHead(400);outgoing.end();return;}
    const chunks=[];
    incoming.on('error',()=>outgoing.destroy());
    incoming.on('data',chunk=>chunks.push(chunk));
    incoming.on('end',()=>{
      const bytes=Buffer.concat(chunks);
      const isApproval=incoming.method==='POST' && incoming.url===approvalPath;
      if(isApproval)observations.approvalBodies.push(bytes.toString('utf8'));
      const drop=isApproval && armed;if(drop)armed=false;
      // Host/Origin rewriting is test scaffolding only, never evidence of a security boundary.
      const headers={...incoming.headers,host:'127.0.0.1:'+port};
      if(incoming.headers.origin)headers.origin=upstreamOrigin;
      const upstream=httpRequest(upstreamOrigin+incoming.url,{method:incoming.method,headers,agent:false},res=>{
        const responseChunks=[];
        res.on('data',chunk=>responseChunks.push(chunk));
        res.on('error',error=>{observations.errors.push(error.code??error.message);outgoing.destroy();});
        res.on('end',()=>{
          const responseBody=Buffer.concat(responseChunks);
          if(drop){
            // The server finished its commit and full 201 response; the client gets no headers/body.
            observations.dropped={status:res.statusCode,responseBytes:responseBody.length,headersSent:outgoing.headersSent};
            outgoing.destroy();return;
          }
          outgoing.writeHead(res.statusCode,res.headers);outgoing.end(responseBody);
        });
      });
      upstreams.add(upstream);upstream.once('close',()=>upstreams.delete(upstream));
      upstream.setTimeout(5000,()=>upstream.destroy(new Error('Loopback upstream timeout')));
      upstream.on('error',error=>{observations.errors.push(error.code??error.message);outgoing.destroy();});
      upstream.end(bytes);
    });
  });
  proxy.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));});
  const proxyPort=await listen(proxy);
  return {origin:'http://127.0.0.1:'+proxyPort,observations,arm:()=>{armed=true;}};
}

test('committed approval response lost at loopback proxy: immutable retries remain exactly once',async t=>{
  const f=await fixture(t);
  const bootstrap=await request(f.origin,'/api/bootstrap');
  assert.equal(bootstrap.status,200);
  assert.equal(bootstrap.data.status.executionMode,'fixture');
  assert.equal(bootstrap.data.status.plannerKind,'fixture');
  assert.equal(bootstrap.data.status.extractorAvailable,false);
  assert.equal(bootstrap.data.status.atk.state,'NOT_CONNECTED');
  assert.equal(bootstrap.data.status.atk.writeEnabled,false);
  assert.equal(bootstrap.data.status.avalanche.state,'NOT_DEPLOYED');
  const session={cookie:bootstrap.headers['set-cookie'][0].split(';')[0],csrf:bootstrap.data.csrf};
  const draft=await request(f.origin,'/api/policy/draft',{session,body:JSON.stringify(fields)});
  assert.equal(draft.status,200);
  const immutableBody=JSON.stringify({draftId:draft.data.id,expectedRevision:draft.data.revision,policyHash:draft.data.policyHash,acknowledgement:true});
  let originalTask;
  await t.test('client sees connection reset despite committed upstream 201',async()=>{
    f.arm();
    await assert.rejects(request(f.origin,approvalPath,{session,body:immutableBody}),{code:'ECONNRESET'});
    assert.equal(f.observations.dropped.status,201);
    assert.ok(f.observations.dropped.responseBytes>0);
    assert.equal(f.observations.dropped.headersSent,false);
    const work=await request(f.origin,'/api/work',{session});
    assert.equal(work.status,200);assert.equal(work.data.tasks.length,1);
    originalTask=work.data.tasks[0];assert.equal(originalTask.id,draft.data.id);
  });
  await t.test('fresh bootstrap with same owner and concurrent byte-identical retries return the same task',async()=>{
    // Models an HTTP client reconnect, not browser refresh/sessionStorage E2E.
    const reconnect=await request(f.origin,'/api/bootstrap',{session});
    assert.equal(reconnect.status,200);assert.equal(reconnect.data.csrf,session.csrf);
    assert.equal(reconnect.data.tasks.length,1);
    const results=await Promise.all([1,2].map(()=>request(f.origin,approvalPath,{session,body:immutableBody})));
    for(const result of results){
      assert.equal(result.status,200);assert.equal(result.data.approvalReplayed,true);
      assert.equal(result.data.id,originalTask.id);
      assert.equal(result.data.policy.expiresAtMs,draft.data.policy.expiresAtMs);
    }
    assert.deepEqual(f.observations.approvalBodies,[immutableBody,immutableBody,immutableBody]);
  });
  await t.test('one persisted task and one verified approval receipt survive transport recovery',async()=>{
    const work=await request(f.origin,'/api/work',{session});
    assert.equal(work.status,200);assert.equal(work.data.tasks.length,1);
    assert.equal(work.data.tasks[0].id,originalTask.id);
    const audit=await request(f.origin,'/api/tasks/'+originalTask.id+'/audit',{session});
    assert.equal(audit.status,200);assert.equal(audit.data.verified,true);assert.equal(audit.data.publication,'LOCAL_ONLY');
    assert.equal(audit.data.receipts.filter(r=>r.source.decision.kind==='POLICY_APPROVED_AND_QUEUED').length,1);
    assert.deepEqual(f.observations.errors,[]);
  });
});
