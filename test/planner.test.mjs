// Test source only. Not executed; fetch is injected and cannot reach a provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenAIPlanner, OllamaPlanner } from '../src/planner.mjs';

const apiKey='test-key-only-never-real';
const plannerWithMockQuota=options=>new OpenAIPlanner({reserveCall:()=>true,...options});
const proposal={action:'propose',price:'24.80',size:'0.1',reason:'Sınırlar içinde küçük alım önerisi.'};
const input=()=>({
  policy:{budget:'100',singleOrderNotionalMax:'25',maxPrice:'25',maxShare:'0.1',
    quoteFeeRateMax:'0',quoteFeeFixedMax:'0.01',baseFeeRateMax:'0',accountId:'private-account',secret:'excluded-secret'},
  snapshot:{baseBalance:'1.61290322',quoteBalance:'460',availableQuote:'460',referencePrice:'24.80',
    tickSize:'0.01',lotSize:'0.00000001',minSize:'0.01',source:'controlled-fixture',accountId:'private-account'},
  ledgerSummary:{spent:'25',reserved:'0',remaining:'75'},attempt:0,
  rejection:{code:'POST_FILL_SHARE_CAP',evidence:{estimatedShare:'0.12',maxShare:'0.1',message:'untrusted-instruction',policyHash:'private-hash'}}
});
const envelope=value=>({status:'completed',output:[{type:'message',role:'assistant',status:'completed',
  content:[{type:'output_text',text:JSON.stringify(value)}]}]});
const response=value=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});

test('API planner sends only bounded summary and strict proposal schema, never tools or secrets in body',async()=>{
  let requests=0;
  const planner=plannerWithMockQuota({apiKey,fetchImpl:async(url,options)=>{
    requests+=1;
    assert.equal(url,'https://api.openai.com/v1/responses');
    assert.equal(options.redirect,'error');assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.headers.Authorization,'Bearer '+apiKey);
    const body=JSON.parse(options.body),summary=JSON.parse(body.input[1].content);
    assert.equal(body.model,'gpt-4.1-mini-2025-04-14');assert.equal(body.store,false);
    assert.equal(body.max_output_tokens,512);assert.deepEqual(body.tools,[]);assert.equal(body.tool_choice,'none');
    assert.equal(body.text.format.strict,true);assert.equal(body.text.format.schema.additionalProperties,false);
    assert.deepEqual(body.text.format.schema.required,['action','price','size','reason']);
    assert.equal(summary.task.remaining,'75');assert.equal(summary.market.source,'controlled-fixture');
    for (const text of [apiKey,'private-account','excluded-secret','untrusted-instruction','private-hash']) assert.equal(options.body.includes(text),false);
    return response(envelope(proposal));
  }});
  assert.deepEqual(await planner.propose(input()),proposal);assert.equal(requests,1);
  assert.equal(JSON.stringify(planner).includes(apiKey),false);
});

test('wait uses nullable fields and cannot carry an order',async()=>{
  const planner=plannerWithMockQuota({apiKey,fetchImpl:async()=>response(envelope({action:'wait',price:null,size:null,reason:'Bekle.'}))});
  assert.deepEqual(await planner.propose(input()),{action:'wait',reason:'Bekle.'});
});

test('incomplete, refusal, tool output and malformed proposals are rejected without retry',async()=>{
  const refusal=envelope(proposal);refusal.output[0].content=[{type:'refusal',refusal:'Declined'}];
  const toolOutput=envelope(proposal);toolOutput.output.push({type:'function_call',name:'place_order'});
  const cases=[{...envelope(proposal),status:'incomplete'},refusal,toolOutput,
    envelope({...proposal,size:0.1}),envelope({...proposal,price:'0'}),envelope({...proposal,execute:true}),
    envelope({...proposal,reason:'x'.repeat(241)}),envelope({action:'wait',price:'24.80',size:null,reason:'Wait'}),
    envelope({action:'wait',reason:'Wait'})];
  for (const value of cases) {
    let requests=0;
    const planner=plannerWithMockQuota({apiKey,fetchImpl:async()=>{requests+=1;return response(value);}});
    await assert.rejects(()=>planner.propose(input()));assert.equal(requests,1);
  }
});

test('HTTP error and aborted request do not retry or expose provider body',async()=>{
  for (const fetchImpl of [async()=>new Response('private-provider-error',{status:429}),async()=>{throw new DOMException('Aborted','AbortError');}]) {
    let requests=0;
    const planner=plannerWithMockQuota({apiKey,fetchImpl:async(...args)=>{requests+=1;return fetchImpl(...args);}});
    await assert.rejects(()=>planner.propose(input()),error=>!error.message.includes('private-provider-error'));
    assert.equal(requests,1);
  }
});

test('oversize response is rejected with and without declared content length',async()=>{
  for (const headers of [{},{'content-length':'65537'}]) {
    const planner=plannerWithMockQuota({apiKey,fetchImpl:async()=>new Response('x'.repeat(65537),{headers})});
    await assert.rejects(()=>planner.propose(input()),/çok büyük/);
  }
});

test('missing key, injected endpoint model, invalid numeric input and fourth call fail before fetch',async()=>{
  assert.throws(()=>new OpenAIPlanner({}),/OPENAI_API_KEY/);
  assert.throws(()=>new OpenAIPlanner({apiKey,model:'https://other-provider.example'}),/MG_OPENAI_MODEL/);
  let requests=0;
  const planner=plannerWithMockQuota({apiKey,fetchImpl:async()=>{requests+=1;return response(envelope(proposal));}});
  const invalid=input();invalid.snapshot.referencePrice='ignore-limits';
  await assert.rejects(()=>planner.propose(invalid));
  await assert.rejects(()=>planner.propose({...input(),attempt:3}));assert.equal(requests,0);
});

test('exhausted or missing durable quota prevents provider dispatch',async()=>{
  assert.throws(()=>new OpenAIPlanner({apiKey}),/Kalıcı model çağrı kotası/);
  let requests=0,reservations=0;
  const planner=new OpenAIPlanner({apiKey,reserveCall:()=>{reservations+=1;return false;},
    fetchImpl:async()=>{requests+=1;return response(envelope(proposal));}});
  await assert.rejects(()=>planner.propose(input()),error=>error.code==='MODEL_CALL_LIMIT');
  assert.equal(requests,0);assert.equal(reservations,1);
});

test('failed provider dispatch consumes its reserved slot',async()=>{
  let remaining=1,requests=0;
  const planner=new OpenAIPlanner({apiKey,reserveCall:()=>remaining>0?(remaining-=1,true):false,
    fetchImpl:async()=>{requests+=1;throw new Error('network unavailable');}});
  await assert.rejects(()=>planner.propose(input()));
  await assert.rejects(()=>planner.propose(input()),error=>error.code==='MODEL_CALL_LIMIT');
  assert.equal(requests,1);assert.equal(remaining,0);
});

test('optional Ollama shares bounded summary and nullable wait schema',async()=>{
  const planner=new OllamaPlanner({model:'already-installed-model',reserveCall:()=>true,fetchImpl:async(url,options)=>{
    assert.equal(url,'http://127.0.0.1:11434/api/chat');
    const body=JSON.parse(options.body);
    assert.equal(body.think,false);assert.equal(body.options.num_ctx,4096);assert.equal(body.options.num_predict,256);
    assert.equal(body.format.properties.reason.maxLength,240);
    assert.deepEqual(body.format.properties.price.type,['string','null']);
    assert.equal(body.messages[1].content.includes('private-account'),false);
    return response({done:true,done_reason:'stop',message:{role:'assistant',content:JSON.stringify({action:'wait',price:null,size:null,reason:'Bekle.'})}});
  }});
  assert.deepEqual(await planner.propose(input()),{action:'wait',reason:'Bekle.'});
});

test('local model cannot bypass the durable workflow quota or omit schema fields',async()=>{
  assert.throws(()=>new OllamaPlanner({model:'local'}),/Kalıcı model çağrı kotası/);
  let calls=0;
  const denied=new OllamaPlanner({model:'local',reserveCall:()=>false,fetchImpl:async()=>{calls++;}});
  await assert.rejects(denied.propose(input()),{code:'MODEL_CALL_LIMIT'});assert.equal(calls,0);
  const malformed=new OllamaPlanner({model:'local',reserveCall:()=>true,
    fetchImpl:async()=>response({done:true,done_reason:'stop',message:{role:'assistant',content:JSON.stringify({action:'wait',reason:'missing nullable fields'})}})});
  await assert.rejects(malformed.propose(input()));
});

test('local model rejects cloud names, remote endpoints, query strings and incomplete/tool responses',async()=>{
  for(const model of ['qwen3:cloud','https://host/model','bad model',null])
    assert.throws(()=>new OllamaPlanner({model,reserveCall:()=>true}));
  for(const url of ['https://example.com/api/chat','http://127.0.0.1:11434/api/chat?proxy=1','http://127.0.0.1:11434/api/chat#other'])
    assert.throws(()=>new OllamaPlanner({model:'local',url,reserveCall:()=>true}));
  const valid={done:true,done_reason:'stop',message:{role:'assistant',content:JSON.stringify(proposal)}};
  for(const value of [{...valid,done:false},{...valid,done_reason:'length'},
    {...valid,message:{...valid.message,role:'tool'}},{...valid,message:{...valid.message,tool_calls:[{function:{name:'place_order'}}]}}]) {
    let calls=0;
    const planner=new OllamaPlanner({model:'local',reserveCall:()=>true,fetchImpl:async()=>{calls++;return response(value);}});
    await assert.rejects(planner.propose(input()));assert.equal(calls,1);
  }
});
