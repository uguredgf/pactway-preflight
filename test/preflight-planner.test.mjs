import test from 'node:test';
import assert from 'node:assert/strict';
import {PreflightOllamaPlanner} from '../src/preflight/planner.mjs';

const tools=['market_get_instruments','market_get_ticker'];
const usage={checkId:'11111111-1111-4111-8111-111111111111',ownerId:'22222222-2222-4222-8222-222222222222',
  policyHash:'a'.repeat(64),candidateHash:'b'.repeat(64)};
const envelope=content=>({done:true,done_reason:'stop',message:{role:'assistant',content}});
const jsonResponse=value=>new Response(JSON.stringify(value),{status:200,headers:{'Content-Type':'application/json'}});

test('planner reserves one durable call before a bounded local request and accepts only the two read tools',async()=>{
  const events=[];
  const planner=new PreflightOllamaPlanner({model:'qwen3:4b-instruct',reserveCall:value=>{
    events.push('reserved');assert.deepEqual(value,{checkId:usage.checkId,ownerId:usage.ownerId});return true;
  },fetchImpl:async(url,options)=>{
    events.push('fetch');assert.equal(url,'http://127.0.0.1:11434/api/chat');
    assert.equal(options.redirect,'error');assert.ok(options.signal instanceof AbortSignal);
    const body=JSON.parse(options.body);
    assert.equal(body.model,'qwen3:4b-instruct');assert.equal(body.stream,false);
    assert.equal(body.think,false);assert.equal(body.options.num_predict,64);
    assert.equal(body.format.additionalProperties,false);
    assert.equal(Object.hasOwn(JSON.parse(body.messages[1].content),'apiKey'),false);
    return jsonResponse(envelope(JSON.stringify({tools})));
  }});
  assert.deepEqual(await planner.createPlan(usage),{tools});
  assert.deepEqual(events,['reserved','fetch']);
});

test('quota rejection never dispatches a model request',async()=>{
  let calls=0;
  const planner=new PreflightOllamaPlanner({model:'qwen3:4b-instruct',reserveCall:()=>false,
    fetchImpl:async()=>{calls++;throw Error('must not call');}});
  await assert.rejects(()=>planner.createPlan(usage),error=>error.code==='PREFLIGHT_PLAN_LIMIT');
  assert.equal(calls,0);
});

test('untrusted model plans cannot supply args, tools, verdicts or duplicate steps',async()=>{
  for(const content of [
    JSON.stringify({tools:['spot_place_order','market_get_ticker']}),
    JSON.stringify({tools:['market_get_ticker','market_get_ticker']}),
    JSON.stringify({tools,args:{instId:'BTC-USDT',demo:false}}),
    JSON.stringify({tools,verdict:'ALLOW'}),
    JSON.stringify({tools:[]}),
    '{',
  ]){
    let reservations=0,requests=0;
    const planner=new PreflightOllamaPlanner({model:'qwen3:4b-instruct',reserveCall:()=>{reservations++;return true;},
      fetchImpl:async()=>{requests++;return jsonResponse(envelope(content));}});
    await assert.rejects(()=>planner.createPlan(usage),error=>error.code==='PREFLIGHT_PLAN_INVALID');
    assert.equal(reservations,1);assert.equal(requests,1);
  }
});

test('truncated, tool-call, oversized and non-JSON responses fail closed without fallback',async()=>{
  const valid=envelope(JSON.stringify({tools}));
  for(const response of [
    ()=>jsonResponse({...valid,done_reason:'length'}),
    ()=>jsonResponse({...valid,done:false}),
    ()=>jsonResponse({...valid,message:{...valid.message,tool_calls:[{name:'spot_place_order'}]}}),
    ()=>jsonResponse({...valid,padding:'x'.repeat(65537)}),
    ()=>new Response('not json',{status:200}),
  ]){
    let requests=0;
    const planner=new PreflightOllamaPlanner({model:'qwen3:4b-instruct',reserveCall:()=>true,
      fetchImpl:async()=>{requests++;return response();}});
    await assert.rejects(()=>planner.createPlan(usage),error=>error.code==='PREFLIGHT_PLAN_INVALID');
    assert.equal(requests,1);
  }
});

test('network or HTTP failure is unavailable rather than a substitute cloud/fixture plan',async()=>{
  for(const fetchImpl of [async()=>{throw Error('private network detail');},async()=>new Response('',{status:503})]){
    const planner=new PreflightOllamaPlanner({model:'qwen3:4b-instruct',reserveCall:()=>true,fetchImpl});
    await assert.rejects(()=>planner.createPlan(usage),error=>error.code==='PREFLIGHT_PLAN_UNAVAILABLE'
      && !error.message.includes('private network detail'));
  }
});

test('planner configuration permits only local HTTP chat endpoints and non-cloud models',()=>{
  const options={model:'qwen3:4b-instruct',reserveCall:()=>true};
  for(const url of ['https://example.com/api/chat','http://192.0.2.1/api/chat','http://127.0.0.1/api/generate',
    'http://user:pass@127.0.0.1/api/chat','http://127.0.0.1/api/chat?secret=x'])
    assert.throws(()=>new PreflightOllamaPlanner({...options,url}));
  for(const model of ['qwen:cloud','https://example.com/model',''])
    assert.throws(()=>new PreflightOllamaPlanner({...options,model}));
});
