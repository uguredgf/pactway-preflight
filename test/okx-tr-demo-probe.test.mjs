import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {probe,requestOptions,hiddenInput,httpFailureCode} from '../scripts/lib/okx-tr-demo-probe.mjs';
const credentials={apiKey:'fixture-api',secret:'fixture-secret',passphrase:'fixture-passphrase'},ms=1792200000000;
const envelope=data=>({code:'0',data:[data]});
function mock(account={uid:'123456789',perm:'read_only'}){
  const calls=[];return {calls,options:{now:()=>ms,read:async(path,headers)=>{
    calls.push({path,headers});return path.endsWith('/time')?envelope({ts:String(ms)}):envelope(account);
  }}};
}
test('probe sends exactly two GET reads, correct HMAC and demo-only fixed target',async()=>{
  const f=mock(),result=await probe(credentials,f.options);
  assert.equal(f.calls.length,2);assert.deepEqual(f.calls[0].headers,{});
  for(const c of f.calls){const o=requestOptions(c.path,c.headers);assert.equal(o.hostname,'tr.okx.com');assert.equal(o.method,'GET');assert.equal(o.headers['x-simulated-trading'],'1');assert.equal(o.rejectUnauthorized,true);}
  const timestamp=new Date(ms).toISOString();
  assert.equal(f.calls[1].headers['OK-ACCESS-SIGN'],createHmac('sha256',credentials.secret).update(timestamp+'GET/api/v5/account/config').digest('base64'));
  assert.equal(result.code,'DEMO_READ_PREFLIGHT_OK');assert.equal(result.identityMatched,false);assert.equal(result.writeEnabled,false);assert.equal(result.applicationConnected,false);
  for(const value of [...Object.values(credentials),'123456789'])assert.ok(!JSON.stringify(result).includes(value));
});
test('arbitrary paths, hosts, query strings and header overrides are refused',()=>{
  for(const path of ['/api/v5/trade/order','https://www.okx.com/api/v5/account/config','/api/v5/account/config?x=1'])assert.throws(()=>requestOptions(path));
  assert.throws(()=>requestOptions('/api/v5/public/time',{'OK-ACCESS-KEY':'no'}));
  assert.throws(()=>requestOptions('/api/v5/account/config',{'x-simulated-trading':'0'}));
});
test('write permissions, missing permission and malformed account fail closed',async()=>{
  for(const account of [{uid:'123',perm:'read_only,trade'},{uid:'123',perm:'read_only,withdraw'},{uid:'123'},{perm:'read_only'}])await assert.rejects(probe(credentials,mock(account).options));
});
test('stale or malformed server time prevents authenticated request',async()=>{
  for(const ts of ['invalid',String(ms-600000)]){
    let calls=0;await assert.rejects(probe(credentials,{now:()=>ms,read:async()=>{calls++;return envelope({ts});}}),{code:'CLOCK_INVALID'});assert.equal(calls,1);
  }
});
test('provider rejection is code-only and never retries or changes environment',async()=>{
  let calls=0;await assert.rejects(probe(credentials,{now:()=>ms,read:async()=>{calls++;return {code:'50101',msg:credentials.secret};}}),error=>error.code==='OKX_50101' && !String(error).includes(credentials.secret));assert.equal(calls,1);
});
test('bounded HTTP auth failures expose only allowlisted 501xx codes',async()=>{
  for(const [status,code] of [[401,'50101'],[400,'50102'],[401,'50113']]) {
    const body=Buffer.from(JSON.stringify({code,msg:credentials.secret,data:[{uid:'private'}]}));
    const result=httpFailureCode(status,body);assert.equal(result,'OKX_'+code);
    assert.doesNotMatch(result,/fixture-secret|private/);
  }
  for(const [status,body] of [[401,Buffer.from('{bad')],[401,Buffer.from(JSON.stringify({code:'51000',msg:credentials.secret}))],
    [401,Buffer.from(JSON.stringify({code:50101,msg:credentials.secret}))],[401,Buffer.alloc(8193,49)],
    [500,Buffer.from(JSON.stringify({code:'50101',msg:credentials.secret}))]])
    assert.equal(httpFailureCode(status,body),'HTTP_'+status);
  await assert.rejects(probe(credentials,{now:()=>ms,read:async()=>({code:'51000',msg:credentials.secret})}),
    error=>error.code==='PREFLIGHT_FAILED' && !String(error).includes(credentials.secret));
});
test('unexpected transport errors are sanitized without causes',async()=>{
  await assert.rejects(probe(credentials,{now:()=>ms,read:async()=>{throw Error(credentials.secret);}}),error=>error.code==='PREFLIGHT_FAILED' && !error.cause && !String(error).includes(credentials.secret));
});
test('invalid input never reaches transport',async()=>{
  for(const bad of [{...credentials,apiKey:'x\r\nInjected: yes'},{...credentials,secret:''},{...credentials,host:'other'}])await assert.rejects(probe(bad,{read:()=>assert.fail('no transport')}),{code:'INPUT_INVALID'});
});
test('hidden input handles backspace and refuses multiline paste, controls and oversize',()=>{
  assert.deepEqual(hiddenInput('abc','\x7fd\r'),{value:'abd',done:true});
  assert.deepEqual(hiddenInput('','abc'),{value:'abc',done:false});
  for(const chunk of ['first\nsecond','\x03','\x1b[A','a'.repeat(257),'\n'])assert.throws(()=>hiddenInput('',chunk));
});
test('CLI does not accept env/argument credentials or persist account output',()=>{
  const source=readFileSync(new URL('../scripts/check-okx-tr-demo.mjs',import.meta.url),'utf8');
  assert.match(source,/process\.argv\.length!==2/);assert.match(source,/!process\.stdin\.isTTY/);
  assert.match(source,/NODE_DEBUG/);assert.doesNotMatch(source,/writeFile|appendFile|OKX_API_KEY|JSON\.stringify/);
});

test('independent expected UID matches without disclosing it and mismatches fail closed',async()=>{
  const matched=await probe(credentials,{...mock().options,expectedUid:'123456789'});
  assert.equal(matched.identityMatched,true);assert.equal(matched.code,'DEMO_READ_UID_MATCHED');
  assert.ok(!JSON.stringify(matched).includes('123456789'));
  await assert.rejects(probe(credentials,{...mock().options,expectedUid:'987654321'}),{code:'UID_MISMATCH'});
  await assert.rejects(probe(credentials,{expectedUid:'invalid',read:()=>assert.fail('must not call')}),{code:'EXPECTED_UID_INVALID'});
});
