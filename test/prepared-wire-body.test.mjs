// Source acceptance only; never calls SDK, signer, HTTP or a live account.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {hashPolicy,hashCanonical} from '../src/domain/governor.mjs';
import {createDemoConnectionManifest} from '../src/adapters/demo-connection-manifest.mjs';
import {prepareDemoWireBody,matchesPreparedWireBody} from '../src/adapters/prepared-wire-body.mjs';
function input() {
  const manifest=createDemoConnectionManifest({schemaVersion:1,id:'connection',connectionVersion:'v1',accountId:'account',
    environment:'demo',instrument:'AVAX-USDT',profile:'demo',site:'tr',apiOrigin:'https://tr.okx.com',authMode:'isolated-demo-api-key',sourceTag:'MCP'});
  const policy={id:'policy',taskId:'task',accountId:'account',environment:'demo',executionMode:'demo-prepared',
    instrument:'AVAX-USDT',side:'buy',tdMode:'cash',ordType:'limit',budget:'100',singleOrderNotionalMax:'25',
    maxPrice:'25',maxShare:'0.5',quoteFeeRateMax:'0.002',quoteFeeFixedMax:'0.01',baseFeeRateMax:'0.002',
    approvedAtMs:1000,expiresAtMs:11000,orderLifetimeMs:5000,snapshotMaxAgeMs:5000,snapshotMaxSkewMs:100,
    campaignId:'campaign',campaignVersion:1,campaignHash:'a'.repeat(64),connectionVersion:'v1'};
  const approvedPolicyHash=hashPolicy(policy),payload={instId:'AVAX-USDT',side:'buy',tdMode:'cash',ordType:'limit',px:'10',sz:'2'};
  const intent={id:'intent',clOrdId:'Pactway001',ordId:null,state:'PREPARED',settled:false,submissionAttempted:false,
    createdAtMs:1100,payload,payloadHash:hashCanonical(payload),policyHash:approvedPolicyHash,snapshotHash:'b'.repeat(64),
    initialReserve:'20.05',expectedFillQty:null,fills:[]};
  return {manifest,policy,approvedPolicyHash,intent,nowMs:1200};
}
test('bytes include client ID and tag while economic and full-body hashes remain distinct',()=>{
  const data=input(),result=prepareDemoWireBody(data);assert.equal(result.ok,true);
  assert.equal(result.bodyText,'{"instId":"AVAX-USDT","tdMode":"cash","side":"buy","ordType":"limit","sz":"2","px":"10","clOrdId":"Pactway001","tag":"MCP"}');
  assert.equal(result.commitment.bodySha256,createHash('sha256').update(result.bodyText,'utf8').digest('hex'));
  assert.equal(result.commitment.economicPayloadHash,data.intent.payloadHash);
  assert.notEqual(result.commitment.bodySha256,result.commitment.economicPayloadHash);
  assert.equal(result.dispatchAllowed,false);assert.equal(result.writeEnabled,false);assert.equal(Object.isFrozen(result.body),true);
  assert.equal(matchesPreparedWireBody(result,data,result.bodyText),true);
  assert.equal(matchesPreparedWireBody(result,data,result.bodyText+' '),false);
  assert.equal(matchesPreparedWireBody({...result,dispatchAllowed:true},data,result.bodyText),false);
});
test('changed economics, authority state and unsupported fields cannot prepare',()=>{
  for(const patch of [{state:'UNKNOWN'},{submissionAttempted:true},{settled:true},{ordId:'123'},
    {initialReserve:'20.04'},{clOrdId:'Pactway001\n'},{snapshotHash:'bad'},{extra:'unapproved'}]) {
    const data=input();Object.assign(data.intent,patch);assert.equal(prepareDemoWireBody(data).ok,false);
  }
  const data=input();data.intent.payload.tag='OTHER';data.intent.payloadHash=hashCanonical(data.intent.payload);
  assert.equal(prepareDemoWireBody(data).code,'WIRE_FIELDS');
});
test('expired intent, changed policy and wrong connection are blocked',()=>{
  const expired=input();expired.nowMs=6100;assert.equal(prepareDemoWireBody(expired).code,'WIRE_INTENT_EXPIRED');
  const policy=input();policy.policy.maxPrice='9';assert.equal(prepareDemoWireBody(policy).code,'WIRE_POLICY');
  const binding=input();binding.policy.connectionVersion='v2';binding.approvedPolicyHash=hashPolicy(binding.policy);
  assert.equal(prepareDemoWireBody(binding).code,'WIRE_BINDING');
});
test('accessors are not invoked and valid data is detached from later changes',()=>{
  const data=input();let reads=0;Object.defineProperty(data.intent,'clOrdId',{get(){reads++;return 'bad';}});
  assert.equal(prepareDemoWireBody(data).ok,false);assert.equal(reads,0);
  const original=input(),result=prepareDemoWireBody(original);original.intent.payload.px='99';
  assert.equal(result.body.px,'10');assert.equal(matchesPreparedWireBody(result,original,result.bodyText),false);
});
