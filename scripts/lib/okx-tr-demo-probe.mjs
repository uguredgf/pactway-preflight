// Standalone diagnostic, NOT an ATK/runtime authorization or journal source.
import https from 'node:https';
import {createHmac} from 'node:crypto';

const TIME='/api/v5/public/time',CONFIG='/api/v5/account/config';
const HTTP_ERROR_LIMIT=8192;
const fail=code=>Object.assign(new Error(code),{code});
const credential=value=>typeof value==='string' && /^[\x21-\x7e]{1,256}$/.test(value);
const safeProviderCode=code=>typeof code==='string' && /^501\d{2}$/.test(code)?'OKX_'+code:null;
export function httpFailureCode(status,body) {
  const fallback='HTTP_'+status;
  if(![400,401].includes(status) || !Buffer.isBuffer(body) || body.length<1 || body.length>HTTP_ERROR_LIMIT)return fallback;
  try {
    const envelope=JSON.parse(body.toString('utf8'));
    return envelope && typeof envelope==='object' && !Array.isArray(envelope)
      ?safeProviderCode(envelope.code) || fallback:fallback;
  } catch {return fallback;}
}
export function requestOptions(path,headers={}) {
  if(![TIME,CONFIG].includes(path))throw fail('PATH_DENIED');
  const allowed=path===CONFIG?['OK-ACCESS-KEY','OK-ACCESS-SIGN','OK-ACCESS-TIMESTAMP','OK-ACCESS-PASSPHRASE']:[];
  if(Object.keys(headers).some(key=>!allowed.includes(key)) || allowed.some(key=>!credential(headers[key])))throw fail('HEADERS_DENIED');
  return {protocol:'https:',hostname:'tr.okx.com',port:443,path,method:'GET',
    rejectUnauthorized:true,agent:false,headers:{...headers,'x-simulated-trading':'1',Accept:'application/json'}};
}
export function readJSON(path,headers) {
  const options=requestOptions(path,headers);
  return new Promise((resolve,reject)=>{
    let finished=false,request,timer;
    const finish=(error,value)=>{if(finished)return;finished=true;clearTimeout(timer);error?reject(error):resolve(value);};
    timer=setTimeout(()=>{finish(fail('TIMEOUT'));request?.destroy();},10000);
    try {
      request=https.request(options,response=>{
        // No redirect following or fallback to a different site/environment.
        const status=response.statusCode || 0;
        if(status!==200 && ![400,401].includes(status)){
          response.resume();finish(fail('HTTP_'+status));request.destroy();return;
        }
        const chunks=[];let size=0;
        response.on('data',chunk=>{
          size+=chunk.length;
          const limit=status===200?65536:HTTP_ERROR_LIMIT;
          if(size>limit){finish(fail(status===200?'RESPONSE_TOO_LARGE':'HTTP_'+status));request.destroy();return;}
          chunks.push(chunk);
        });
        response.on('error',()=>finish(fail('NETWORK_ERROR')));
        response.on('aborted',()=>finish(fail('NETWORK_ERROR')));
        response.on('end',()=>{
          if(finished)return;
          const body=Buffer.concat(chunks);
          if(status!==200){finish(fail(httpFailureCode(status,body)));return;}
          try{finish(null,JSON.parse(body.toString('utf8')));}
          catch{finish(fail('RESPONSE_INVALID'));}
        });
      });
      request.on('error',()=>finish(fail('NETWORK_ERROR')));request.end();
    }catch{finish(fail('NETWORK_ERROR'));request?.destroy();}
  });
}
function row(envelope) {
  if(typeof envelope?.code!=='string' || !/^\d{1,6}$/.test(envelope.code))throw fail('RESPONSE_INVALID');
  if(envelope.code!=='0')throw fail(safeProviderCode(envelope.code) || 'PROVIDER_REJECTED');
  if(!Array.isArray(envelope.data) || envelope.data.length!==1 || !envelope.data[0] || typeof envelope.data[0]!=='object')throw fail('RESPONSE_INVALID');
  return envelope.data[0];
}
export async function probe(credentials,{read=readJSON,now=Date.now,expectedUid}={}) {
  if(expectedUid!==undefined && (typeof expectedUid!=='string' || !/^[0-9]{1,64}$/.test(expectedUid)))throw fail('EXPECTED_UID_INVALID');
  if(!credentials || Object.keys(credentials).sort().join(',')!=='apiKey,passphrase,secret'
      || Object.values(credentials).some(value=>!credential(value)))throw fail('INPUT_INVALID');
  try {
    const start=now(),clock=row(await read(TIME,{}));
    if(typeof clock.ts!=='string' || !/^\d{13}$/.test(clock.ts) || now()-start>5000
        || Math.abs(Number(clock.ts)-now())>300000)throw fail('CLOCK_INVALID');
    const timestamp=new Date(Number(clock.ts)).toISOString();
    const signature=createHmac('sha256',credentials.secret).update(timestamp+'GET'+CONFIG).digest('base64');
    const account=row(await read(CONFIG,{'OK-ACCESS-KEY':credentials.apiKey,'OK-ACCESS-PASSPHRASE':credentials.passphrase,
      'OK-ACCESS-TIMESTAMP':timestamp,'OK-ACCESS-SIGN':signature}));
    if(typeof account.uid!=='string' || !/^\d{1,32}$/.test(account.uid))throw fail('ACCOUNT_INVALID');
    if(account.perm!=='read_only')throw fail('READ_ONLY_NOT_CONFIRMED');
    if(expectedUid!==undefined && account.uid!==expectedUid)throw fail('UID_MISMATCH');
    return {code:expectedUid===undefined?'DEMO_READ_PREFLIGHT_OK':'DEMO_READ_UID_MATCHED',site:'tr',demoHeaderSent:true,permission:'read_only',
      identityMatched:expectedUid!==undefined,applicationConnected:false,writeEnabled:false};
  }catch(error){
    // Never echo provider messages, URLs, raw account details or exception causes.
    const code=String(error?.code || '');
    if(/^(OKX_501\d{2}|HTTP_\d{1,3}|TIMEOUT|NETWORK_ERROR|RESPONSE_TOO_LARGE|RESPONSE_INVALID|CLOCK_INVALID|ACCOUNT_INVALID|READ_ONLY_NOT_CONFIRMED|UID_MISMATCH)$/.test(code))throw fail(code);
    throw fail('PREFLIGHT_FAILED');
  }
}

// Pure hidden-input reducer, shared by the CLI and tests. Multiline paste and
// terminal escape sequences are rejected rather than spilling into another prompt.
export function hiddenInput(value,chunk) {
  for(let i=0;i<chunk.length;i++) {
    const char=chunk[i];
    if(char==='\x03')throw fail('CANCELLED');
    if(char==='\r' || char==='\n'){
      if(chunk.slice(i).replace(/[\r\n]/g,'') || !credential(value))throw fail('INPUT_INVALID');
      return {value,done:true};
    }
    if(char==='\x08' || char==='\x7f'){value=value.slice(0,-1);continue;}
    if(!/^[\x21-\x7e]$/.test(char) || value.length>=256)throw fail('INPUT_INVALID');
    value+=char;
  }
  return {value,done:false};
}
