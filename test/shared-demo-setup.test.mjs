import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {CLOUDFLARED_SHA256,SHARED_DEMO_PORT,ensureSharedPortAvailable,generateSharedSecrets,parseQuickTunnelOrigin,sharedConnectorEnvironment,
  sharedLauncherConfiguration,sharedServerEnvironment,startQuickTunnel,validateCloudflaredExecutable,writeSharedDemoState} from '../scripts/lib/shared-demo-setup.mjs';
import {waitForPublicOrigin} from '../scripts/lib/shared-demo-setup.mjs';

test('shared launcher accepts only a direct absolute cloudflared path and a fresh non-private port',()=>{
  const local=resolve(tmpdir(),'pactway-shared-config');
  assert.deepEqual(sharedLauncherConfiguration([],{LOCALAPPDATA:local}),{
    port:SHARED_DEMO_PORT,executablePath:join(local,'Pactway','tools','cloudflared.exe'),localAppData:local});
  assert.equal(sharedLauncherConfiguration(['--cloudflared',join(local,'Pactway','tools','cloudflared.exe')],{LOCALAPPDATA:local}).port,SHARED_DEMO_PORT);
  for(const argv of [['--other'],['--cloudflared'],['--cloudflared','relative.exe'],['a','b','c']])
    assert.throws(()=>sharedLauncherConfiguration(argv,{LOCALAPPDATA:local}),/SHARED_ARGUMENTS_INVALID|CLOUDFLARED_PATH_INVALID/);
  for(const reserved of ['18774','18779','18783'])assert.throws(()=>sharedLauncherConfiguration([],{LOCALAPPDATA:local,PACTWAY_SHARED_PORT:reserved}),/SHARED_PORT_INVALID/);
});

test('cloudflared executable must be the pinned regular file under LOCALAPPDATA tools',async t=>{
  const local=await mkdtemp(join(tmpdir(),'pactway-cloudflared-'));t.after(()=>rm(local,{recursive:true,force:true}));
  const tools=join(local,'Pactway','tools'),path=join(tools,'cloudflared.exe');await mkdir(tools,{recursive:true});await writeFile(path,'official fixture');
  const digest=createHash('sha256').update('official fixture').digest('hex');
  const config=sharedLauncherConfiguration(['--cloudflared',path],{LOCALAPPDATA:local});
  assert.equal(await validateCloudflaredExecutable(config,{expectedDigest:digest}),await import('node:fs/promises').then(fs=>fs.realpath(path)));
  await assert.rejects(validateCloudflaredExecutable(config,{expectedDigest:CLOUDFLARED_SHA256}),/CLOUDFLARED_DIGEST_INVALID/);
});

test('quick tunnel parser accepts only an official HTTPS quick-tunnel origin',()=>{
  assert.equal(parseQuickTunnelOrigin('INF https://silent-leaf-77.trycloudflare.com ready'),'https://silent-leaf-77.trycloudflare.com');
  for(const value of ['http://x.trycloudflare.com','https://trycloudflare.com','https://x.trycloudflare.com.evil.test','https://user@x.trycloudflare.com'])
    assert.equal(parseQuickTunnelOrigin(value),null);
});

test('shared port availability probe binds only loopback exclusively and rejects conflicts',async()=>{
  const calls=[];
  await ensureSharedPortAvailable('18787',{createServerImpl:()=>{
    const server=new EventEmitter();server.listen=(options,callback)=>{calls.push(options);queueMicrotask(callback);};
    server.close=callback=>callback();return server;
  }});
  assert.deepEqual(calls,[{host:'127.0.0.1',port:18787,exclusive:true}]);
  await assert.rejects(ensureSharedPortAvailable('18787',{createServerImpl:()=>{
    const server=new EventEmitter();server.listen=()=>queueMicrotask(()=>server.emit('error',Object.assign(new Error('used'),{code:'EADDRINUSE'})));
    return server;
  }}),/SHARED_PORT_UNAVAILABLE/);
});

test('shared secrets and child environment stay distinct, scoped and write-disabled',()=>{
  let call=0;const bytes=()=>Buffer.alloc(32,++call);
  const secrets=generateSharedSecrets(bytes),origin='https://demo-1.trycloudflare.com';
  assert.ok(secrets.inviteCode.length>=24);assert.ok(secrets.operatorKey.length>=24);assert.notEqual(secrets.inviteCode,secrets.operatorKey);
  assert.deepEqual(sharedServerEnvironment(origin,secrets),{MG_PUBLIC_ORIGIN:origin,MG_INVITE_CODE:secrets.inviteCode,
    MG_OPERATOR_KEY:secrets.operatorKey,MG_PREFLIGHT_SHARED_DEMO:'1'});
  const local=resolve(tmpdir(),'pactway-shared-env'),configuration={port:'18787',localAppData:local};
  const env=sharedConnectorEnvironment(configuration,{SystemRoot:'system',LOCALAPPDATA:local,OPENAI_API_KEY:'never',OKX_API_KEY:'never'});
  assert.equal(env.PACTWAY_APP_PORT,'18787');assert.equal(env.LOCALAPPDATA,local);assert.equal(env.OPENAI_API_KEY,undefined);assert.equal(env.OKX_API_KEY,undefined);
});

function fakeSpawn(calls,{url='https://quiet-sun-1.trycloudflare.com'}={}) {
  return (file,args,options)=>{
    const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.pid=4321;child.exitCode=null;child.signalCode=null;
    child.kill=signal=>{child.signalCode=signal || 'SIGTERM';queueMicrotask(()=>child.emit('exit',null,child.signalCode));return true;};
    calls.push({file,args,options,child});queueMicrotask(()=>child.stderr.write('INF '+url+' ready\n'));return child;
  };
}

test('quick tunnel uses direct argv, sanitized environment, captures URL and shuts down child',async()=>{
  const calls=[],tunnel=await startQuickTunnel({executablePath:'C:\\tools\\cloudflared.exe',port:'18787',environment:{SystemRoot:'system',SECRET:'never'},spawnImpl:fakeSpawn(calls)});
  assert.equal(tunnel.origin,'https://quiet-sun-1.trycloudflare.com');assert.equal(tunnel.pid,4321);
  assert.deepEqual(calls[0].args,['tunnel','--no-autoupdate','--protocol','http2','--url','http://127.0.0.1:18787']);assert.equal(calls[0].options.shell,false);
  assert.deepEqual(calls[0].options.env,{SystemRoot:'system'});assert.equal(calls[0].options.stdio.join(','),'ignore,pipe,pipe');
  await tunnel.stop();assert.equal(tunnel.isRunning(),false);
});

test('public readiness requires a real successful HTTPS response and retries boundedly',async()=>{
  let calls=0;
  await waitForPublicOrigin('https://ready-1.trycloudflare.com',{delayMs:0,attempts:3,timeoutMs:1000,fetchImpl:async()=>{
    calls++;if(calls===1)throw new Error('not propagated');return new Response('',{status:calls===2?502:200});
  }});
  assert.equal(calls,3);
  await assert.rejects(waitForPublicOrigin('https://ready-1.trycloudflare.com',{delayMs:0,attempts:2,timeoutMs:1000,
    fetchImpl:async()=>new Response('',{status:502})}),{code:'SHARED_PUBLIC_HTTP_502'});
});

test('public readiness reports only sanitized DNS and timeout reasons',async()=>{
  const dnsError=Object.assign(new TypeError('getaddrinfo private-host ENOTFOUND'),{cause:{code:'ENOTFOUND'}});
  await assert.rejects(waitForPublicOrigin('https://ready-1.trycloudflare.com',{delayMs:0,attempts:2,timeoutMs:1000,
    fetchImpl:async()=>{throw dnsError;}}),error=>error.code==='SHARED_PUBLIC_DNS_PENDING' && !error.message.includes('private-host'));
  const timeoutError=Object.assign(new Error('private timeout detail'),{cause:{code:'UND_ERR_CONNECT_TIMEOUT'}});
  await assert.rejects(waitForPublicOrigin('https://ready-1.trycloudflare.com',{delayMs:0,attempts:1,timeoutMs:1000,
    fetchImpl:async()=>{throw timeoutError;}}),{code:'SHARED_PUBLIC_CONNECT_TIMEOUT'});
});

test('public readiness enforces its total time budget without exposing failed content',async()=>{
  let clock=0,calls=0;
  await assert.rejects(waitForPublicOrigin('https://ready-1.trycloudflare.com',{attempts:30,delayMs:2000,timeoutMs:6000,
    now:()=>clock,sleep:async ms=>{clock+=ms;},fetchImpl:async()=>{calls++;return new Response('private upstream body',{status:503});}}),
  error=>error.code==='SHARED_PUBLIC_HTTP_503' && !error.message.includes('private upstream body'));
  assert.equal(clock,6000);assert.equal(calls,3);
});

test('public readiness survives a 65-second negative DNS cache but never passes 90 seconds',async()=>{
  let clock=0,calls=0;
  await waitForPublicOrigin('https://ready-1.trycloudflare.com',{attempts:46,delayMs:2000,timeoutMs:90000,
    now:()=>clock,sleep:async ms=>{clock+=ms;},fetchImpl:async()=>{
      calls++;if(clock<65000)throw Object.assign(new TypeError('hidden host'),{cause:{code:'ENOTFOUND'}});
      return new Response('',{status:200});
    }});
  assert.equal(clock,66000);assert.equal(calls,34);
  clock=0;
  await assert.rejects(waitForPublicOrigin('https://ready-1.trycloudflare.com',{attempts:60,delayMs:2000,timeoutMs:90000,
    now:()=>clock,sleep:async ms=>{clock+=ms;},fetchImpl:async()=>{throw Object.assign(new TypeError('hidden host'),{cause:{code:'ENOTFOUND'}});}}),
  {code:'SHARED_PUBLIC_DNS_PENDING'});
  assert.equal(clock,90000);
});

test('shared handoff contains no invite, operator or credentials',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'pactway-shared-state-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const dataDirectory=join(directory,'data'),path=await writeSharedDemoState(directory,{origin:'https://state-1.trycloudflare.com',port:'18787',serverPid:111,tunnelPid:222,dataDirectory});
  const text=await readFile(path,'utf8'),state=JSON.parse(text);
  assert.deepEqual(Object.keys(state).sort(),['dataDirectory','origin','port','schemaVersion','serverPid','startedAt','status','tunnelPid'].sort());
  assert.doesNotMatch(text,/invite|operator|api.?key|secret/i);assert.equal(state.origin,'https://state-1.trycloudflare.com');
});
