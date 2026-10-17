import {createHash,randomBytes} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {lstat,realpath,writeFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {dirname,isAbsolute,join,relative,resolve,sep} from 'node:path';
import {LOCAL_MODEL} from './local-model-setup.mjs';
import {osEnvironment} from './readonly-atk-setup.mjs';

export const SHARED_DEMO_PORT='18787';
export const CLOUDFLARED_SHA256='4d2490e74082c5d48dbfedaf92576fa5bd1702379ab88eb7faa0cfbe8dc891b6';
const failure=code=>Object.assign(new Error(code),{code});

function port(environment={}) {
  const value=environment.PACTWAY_SHARED_PORT??SHARED_DEMO_PORT;
  if(typeof value!=='string' || !/^[1-9][0-9]{3,4}$/.test(value) || String(Number(value))!==value
      || Number(value)<1024 || Number(value)>65535 || ['18774','18779','18783'].includes(value))throw failure('SHARED_PORT_INVALID');
  return value;
}

export function sharedLauncherConfiguration(argv=[],environment=process.env) {
  let cliPath;
  if(argv.length===2 && argv[0]==='--cloudflared')cliPath=argv[1];
  else if(argv.length===1 && argv[0].startsWith('--cloudflared='))cliPath=argv[0].slice('--cloudflared='.length);
  else if(argv.length)throw failure('SHARED_ARGUMENTS_INVALID');
  const local=environment.LOCALAPPDATA;
  if(typeof local!=='string' || !isAbsolute(local))throw failure('LOCAL_DATA_PATH_REQUIRED');
  const executablePath=cliPath || environment.PACTWAY_CLOUDFLARED_PATH || join(local,'Pactway','tools','cloudflared.exe');
  if(typeof executablePath!=='string' || !isAbsolute(executablePath))throw failure('CLOUDFLARED_PATH_INVALID');
  return Object.freeze({port:port(environment),executablePath:resolve(executablePath),localAppData:resolve(local)});
}

async function sha256(path) {
  const hash=createHash('sha256');
  await new Promise((resolveHash,reject)=>{
    const stream=createReadStream(path);stream.on('data',chunk=>hash.update(chunk));stream.once('error',reject);stream.once('end',resolveHash);
  });
  return hash.digest('hex');
}

export async function validateCloudflaredExecutable(configuration,{expectedDigest=CLOUDFLARED_SHA256}={}) {
  const {executablePath,localAppData}=configuration;
  const tools=resolve(localAppData,'Pactway','tools'),canonicalTools=await realpath(tools),canonical=await realpath(executablePath);
  const pathFromTools=relative(canonicalTools,canonical);
  if(pathFromTools.startsWith('..'+sep) || pathFromTools==='..' || isAbsolute(pathFromTools))throw failure('CLOUDFLARED_PATH_INVALID');
  const info=await lstat(executablePath);
  if(!info.isFile() || info.isSymbolicLink() || info.nlink!==1 || canonical.split(/[\\/]/).at(-1).toLowerCase()!=='cloudflared.exe')
    throw failure('CLOUDFLARED_PATH_INVALID');
  if(!/^[a-f0-9]{64}$/.test(expectedDigest) || await sha256(canonical)!==expectedDigest)throw failure('CLOUDFLARED_DIGEST_INVALID');
  return canonical;
}

export function parseQuickTunnelOrigin(output) {
  const matches=String(output).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com(?![a-z0-9.-])/ig);
  if(!matches)return null;
  for(const match of matches)try {
    const url=new URL(match);
    if(url.protocol==='https:' && /^[a-z0-9-]+\.trycloudflare\.com$/i.test(url.hostname)
        && url.username==='' && url.password==='' && url.pathname==='/' && !url.search && !url.hash)return url.origin;
  }catch {}
  return null;
}

export function generateSharedSecrets(bytes=randomBytes) {
  const inviteCode=bytes(32).toString('base64url'),operatorKey=bytes(32).toString('base64url');
  if(inviteCode.length<24 || operatorKey.length<24 || inviteCode===operatorKey)throw failure('SHARED_SECRET_GENERATION_FAILED');
  return {inviteCode,operatorKey};
}

export function sharedServerEnvironment(origin,secrets) {
  const url=new URL(origin);
  if(url.protocol!=='https:' || url.origin!==origin || !/^[a-z0-9-]+\.trycloudflare\.com$/i.test(url.hostname)
      || secrets?.inviteCode?.length<24 || secrets?.operatorKey?.length<24 || secrets.inviteCode===secrets.operatorKey)
    throw failure('SHARED_CONFIGURATION_INVALID');
  return {MG_PUBLIC_ORIGIN:origin,MG_INVITE_CODE:secrets.inviteCode,MG_OPERATOR_KEY:secrets.operatorKey,MG_PREFLIGHT_SHARED_DEMO:'1'};
}

export function sharedConnectorEnvironment(configuration,environment=process.env) {
  return {...osEnvironment(environment),LOCALAPPDATA:configuration.localAppData,PACTWAY_APP_PORT:configuration.port,PACTWAY_LOCAL_MODEL:LOCAL_MODEL};
}

export async function ensureSharedPortAvailable(applicationPort,{createServerImpl=createServer}={}) {
  if(typeof applicationPort!=='string' || !/^[1-9][0-9]{3,4}$/.test(applicationPort))throw failure('SHARED_PORT_INVALID');
  await new Promise((resolveAvailable,reject)=>{
    const probe=createServerImpl();let settled=false;
    const finish=error=>{if(settled)return;settled=true;error?reject(failure('SHARED_PORT_UNAVAILABLE')):resolveAvailable();};
    probe.once('error',finish);
    probe.listen({host:'127.0.0.1',port:Number(applicationPort),exclusive:true},()=>probe.close(error=>finish(error)));
  });
}

export async function startQuickTunnel({executablePath,port:applicationPort,environment={},spawnImpl=spawn,timeoutMs=30000}) {
  let child;
  try {
    child=spawnImpl(executablePath,['tunnel','--no-autoupdate','--protocol','http2','--url','http://127.0.0.1:'+applicationPort],{
      cwd:dirname(executablePath),env:osEnvironment(environment),windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']});
  }catch {throw failure('CLOUDFLARED_START_FAILED');}
  let resolveClosed;
  const closed=new Promise(resolveClose=>{resolveClosed=resolveClose;});
  child.once('exit',(code,signal)=>resolveClosed({code,signal}));
  child.once('error',()=>resolveClosed({code:null,signal:null,error:true}));
  const origin=await new Promise((resolveOrigin,reject)=>{
    let output='',settled=false,timer;
    const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolveOrigin(value);};
    const inspect=chunk=>{
      if(settled)return;
      output+=(Buffer.isBuffer(chunk)?chunk.toString('utf8'):String(chunk));
      if(Buffer.byteLength(output,'utf8')>65536)return finish(failure('CLOUDFLARED_OUTPUT_INVALID'));
      const parsed=parseQuickTunnelOrigin(output);if(parsed)finish(null,parsed);
    };
    child.stdout?.on('data',inspect);child.stderr?.on('data',inspect);
    child.once('error',()=>finish(failure('CLOUDFLARED_START_FAILED')));
    child.once('exit',()=>finish(failure('CLOUDFLARED_STOPPED')));
    timer=setTimeout(()=>finish(failure('CLOUDFLARED_START_TIMEOUT')),timeoutMs);
  }).catch(async error=>{if(child.exitCode===null && child.signalCode===null)child.kill();await closed;throw error;});
  let stopping=false;
  const stop=async()=>{
    if(stopping)return closed;stopping=true;
    if(child.exitCode===null && child.signalCode===null)child.kill('SIGTERM');
    await new Promise(resolveStop=>{
      const timer=setTimeout(resolveStop,5000);
      closed.then(()=>{clearTimeout(timer);resolveStop();});
    });
    if(child.exitCode===null && child.signalCode===null)child.kill();
    return closed;
  };
  return {origin,pid:child.pid,closed,stop,isRunning:()=>child.exitCode===null && child.signalCode===null};
}

function readinessFailure(error) {
  const code=error?.cause?.code || error?.code;
  if(code==='ENOTFOUND' || code==='EAI_AGAIN')return 'SHARED_PUBLIC_DNS_PENDING';
  if(code==='ETIMEDOUT' || code==='UND_ERR_CONNECT_TIMEOUT' || error?.name==='TimeoutError')return 'SHARED_PUBLIC_CONNECT_TIMEOUT';
  if(code==='ECONNRESET')return 'SHARED_PUBLIC_CONNECTION_RESET';
  if(typeof code==='string' && /CERT|TLS|SSL/.test(code))return 'SHARED_PUBLIC_TLS_FAILED';
  return 'SHARED_PUBLIC_NETWORK_UNAVAILABLE';
}

export async function waitForPublicOrigin(origin,{fetchImpl=fetch,attempts=46,delayMs=2000,timeoutMs=90000,
  requestTimeoutMs=5000,now=Date.now,sleep=ms=>new Promise(resolveDelay=>setTimeout(resolveDelay,ms))}={}) {
  if(parseQuickTunnelOrigin(origin)!==origin || !Number.isSafeInteger(attempts) || attempts<1 || attempts>60
      || !Number.isSafeInteger(delayMs) || delayMs<0 || delayMs>5000
      || !Number.isSafeInteger(timeoutMs) || timeoutMs<1000 || timeoutMs>120000
      || !Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs<100 || requestTimeoutMs>10000
      || typeof now!=='function' || typeof sleep!=='function')throw failure('SHARED_READINESS_INVALID');
  const deadline=now()+timeoutMs;let lastFailure='SHARED_PUBLIC_NETWORK_UNAVAILABLE';
  for(let attempt=0;attempt<attempts && now()<deadline;attempt++) {
    try {
      const remaining=deadline-now();
      const response=await fetchImpl(origin+'/',{method:'GET',redirect:'error',
        signal:AbortSignal.timeout(Math.max(1,Math.min(requestTimeoutMs,remaining)))});
      await response.body?.cancel();
      if(response.status===200)return;
      lastFailure=Number.isInteger(response.status) && response.status>=100 && response.status<=599
        ?'SHARED_PUBLIC_HTTP_'+response.status:'SHARED_PUBLIC_HTTP_UNEXPECTED';
    }catch(error) {lastFailure=readinessFailure(error);}
    const remaining=deadline-now();
    if(attempt+1<attempts && delayMs && remaining>0)await sleep(Math.min(delayMs,remaining));
  }
  throw failure(lastFailure);
}

export async function writeSharedDemoState(directory,{origin,port:applicationPort,serverPid,tunnelPid,dataDirectory}) {
  if(!isAbsolute(directory) || !isAbsolute(dataDirectory) || !Number.isInteger(serverPid) || !Number.isInteger(tunnelPid)
      || !/^[1-9][0-9]{3,4}$/.test(applicationPort) || parseQuickTunnelOrigin(origin)!==origin)
    throw failure('SHARED_STATE_INVALID');
  const path=join(directory,'shared-live.json');
  const state={schemaVersion:1,status:'READY',origin,port:Number(applicationPort),serverPid,tunnelPid,dataDirectory,startedAt:new Date().toISOString()};
  await writeFile(path,JSON.stringify(state,null,2),{flag:'wx',mode:0o600});
  return path;
}
