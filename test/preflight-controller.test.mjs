// Controller behavior only: no real browser, model, ATK, exchange or network calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {startPreflightController,response} from './support/preflight-controller.mjs';
import {runReplayExample} from '../src/preflight/examples.mjs';

const now=1792231200000,hash='a'.repeat(64),candidateHash='b'.repeat(64),evidenceHash='c'.repeat(64),reportHash='d'.repeat(64);
const scope={instrument:'AVAX-USDT',side:'buy',tdMode:'cash',ordType:'limit'};
const limits={amountWholeDigits:12,amountFractionDigits:8,durationSecondsMin:60,durationSecondsMax:3600,evidenceMaxAgeMs:10000,evidenceMaxSkewMs:5000,
  policiesPerSession:20,checksPerSession:50,concurrentLiveChecks:1,modelPlanCallsPerCheck:1,modelPlanCallsPerSession:20,historyItems:50,modelPlanCallsGlobal:100};
const status={version:1,liveAvailable:true,plannerKind:'ollama',atkState:'READ_ONLY_CONNECTED',scope,limits,orderSubmissionEnabled:false,publication:'LOCAL_ONLY'};
const agentStatus={...status,agentAvailable:true,agentVersion:1};
const draft={id:'10000000-0000-4000-8000-000000000001',policy:{...scope,maxNotional:'100',maxPrice:'25',durationSeconds:'600'},policyHash:hash,status:'DRAFT',createdAtMs:now,validFromMs:now,expiresAtMs:now+600000};
const approved={...draft,status:'APPROVED',approvedByUserAtMs:now+1000};
const checks=[
  ['policy','Politika bağı ve geçerlilik zamanı'],['agent-plan','Salt okunur araç planı'],['scope','Sabit ürün kapsamı'],['price-cap','Fiyat üst sınırı'],
  ['notional-cap','Ücret hariç emir bedeli üst sınırı'],['evidence','Kanıt bütünlüğü, tazeliği ve aynı bağlantı bağı'],['instrument','Spot durumu ve listelenen enstrüman kuralları'],
  ['price-grid','Fiyat adımı'],['size-grid','Miktar adımı ve enstrüman sınırları']
].map(([id,label])=>({id,label,result:'PASS',reasonCode:'PASS'}));
const report={schemaVersion:1,mode:'LIVE_READ_ONLY',publication:'LOCAL_ONLY',policy:{schemaVersion:1,id:draft.id,...approved.policy,createdAtMs:now,validFromMs:now,expiresAtMs:now+600000},
  policyHash:hash,candidate:{...scope,price:'24.8',size:'4'},candidateHash,verdict:'ALLOW',reasonCodes:['PASS'],checks,
  sanitizedEvidence:{ticker:{source:'OKX_TR_DEMO_ATK',ageMs:1000}},evidenceHash,agentTrace:{plannerKind:'ollama',plan:{tools:['market_get_ticker','market_get_instruments']},modelCallCount:1,failureCode:null},
  checkedAtMs:now+2000,notChecked:[{code:'BALANCE','label':'Hesap bakiyesi'}],disclosure:'Yalnız kapsam dahilindeki kontroller geçti.',reportHash};
const completed={id:'20000000-0000-4000-8000-000000000001',state:'COMPLETED',mode:'LIVE_READ_ONLY',createdAtMs:now+1000,report};
const agentChecks=[...checks.slice(0,2),{id:'agent-review',label:'Model incelemesi ve sınırlı düzeltme',result:'PASS',reasonCode:'PASS'},...checks.slice(2)];
const agentReport={...report,candidate:{...scope,price:'24.7',size:'3.5'},checks:agentChecks,agentTrace:{version:1,plannerKind:'agent',
  plan:{tools:['market_get_ticker','market_get_instruments']},modelCallCount:2,failureCode:null,reviewerKind:'bounded',attempts:[
    {attempt:1,candidate:{...scope,price:'24.8',size:'4'},candidateHash:'e'.repeat(64),readFreshness:{tickerObservedAtMs:now,instrumentObservedAtMs:now,checkedAtMs:now,verified:true},reviewedReportHash:'f'.repeat(64),reviewedEvidenceHash:evidenceHash,reviewedVerdict:'BLOCK',decisionAtMs:now,action:'REVISE',reasonCode:'NORMALIZE_TO_RULES'},
    {attempt:2,candidate:{...scope,price:'24.7',size:'3.5'},candidateHash,readFreshness:{tickerObservedAtMs:now+1000,instrumentObservedAtMs:now+1000,checkedAtMs:now+1000,verified:true},reviewedReportHash:'1'.repeat(64),reviewedEvidenceHash:evidenceHash,reviewedVerdict:'ALLOW',decisionAtMs:now+1000,action:'ACCEPT',reasonCode:'WITHIN_LIMITS'}],
  finalGovernorRead:{evidenceHash,tickerObservedAtMs:now+1500,instrumentObservedAtMs:now+1500,checkedAtMs:now+1500}}};
const agentCompleted={...completed,source:'AGENT',report:agentReport};
const replayWithin=runReplayExample('within-limits');
const replayBreach=runReplayExample('limit-breach');
const boot=csrf=>({csrf});
const sessionBinding=createHash('sha256').update('Pactway/preflight/session/v1\0csrf-one').digest('hex');

function baseResponder({policy=null,onRequest}={}){return request=>{
  if(onRequest){const custom=onRequest(request);if(custom)return custom;}
  if(request.path==='/api/bootstrap')return response(boot('csrf-one'));
  if(request.path==='/api/preflight/status')return response(status);
  if(request.path==='/api/preflight/history')return response({policies:policy?[policy]:[],checks:[]});
  if(policy&&request.path==='/api/preflight/policies/'+policy.id)return response(policy);
};}

test('readiness uses short Turkish labels and never paints an unknown raw status code',async()=>{
  const known=await startPreflightController({respond:baseResponder()});
  assert.equal(known.get('atk-state').textContent,'Salt okuma bağlı');assert.equal(known.get('atk-state').title,'READ_ONLY_CONNECTED');
  assert.equal(known.get('planner-state').textContent,'Yerel Ollama');assert.equal(known.get('planner-state').title,'ollama');
  const unknownStatus={...status,liveAvailable:false,atkState:'RAW_PRIVATE_STATE',plannerKind:'future-provider'};
  const unknown=await startPreflightController({respond:request=>request.path==='/api/preflight/status'?response(unknownStatus):baseResponder()(request)});
  assert.equal(unknown.get('atk-state').textContent,'Durum bilinmiyor');assert.equal(unknown.get('atk-state').title,'');
  assert.equal(unknown.get('planner-state').textContent,'Durum bilinmiyor');assert.equal(unknown.get('planner-state').title,'');
});

test('mixed-version agent limits keep startup usable while capability remains unavailable',async()=>{
  for(const expandedLimits of [{...limits,modelCallsPerAgentCheck:2},{...limits,modelReviewCallsPerCheck:1,modelCallsPerAgentCheck:2}]){
    const mixed={...status,limits:expandedLimits,agentAvailable:false,agentVersion:1};
    const h=await startPreflightController({respond:request=>request.path==='/api/preflight/status'?response(mixed):baseResponder()(request)});
    assert.equal(h.get('boot-error').hidden,true);assert.equal(h.get('workspace').hidden,false);assert.equal(h.get('mode-agent').disabled,true);assert.equal(h.get('mode-direct').checked,true);
  }
});

test('create, server review, acknowledgement and approval unlock one immutable policy',async()=>{
  let record=null;
  const h=await startPreflightController({nowMs:now,respond:baseResponder({onRequest:request=>{
    if(request.path==='/api/preflight/history')return response({policies:record?[record]:[],checks:[]});
    if(request.path==='/api/preflight/policies'&&request.method==='POST'){record=draft;return response(record,{status:201});}
    if(request.path===`/api/preflight/policies/${draft.id}`)return response(record);
    if(request.path===`/api/preflight/policies/${draft.id}/approve`){record=approved;return response(record);}
  }})});
  h.fields.policy.get('maxNotional').value='100';h.fields.policy.get('maxPrice').value='25';h.fields.policy.get('durationSeconds').value='600';
  await h.fire('policy-form','submit');assert.equal(h.get('policy-review').hidden,false);assert.equal(h.get('policy-hash').textContent,hash);
  h.get('policy-ack').checked=true;await h.fire('policy-ack','change');assert.equal(h.get('approve-policy').disabled,false);
  await h.fire('approve-policy');assert.equal(h.get('approve-policy').hidden,true);assert.equal(h.get('run-check').disabled,false);
});

test('lost check response retries the exact stored UUID and body, then renders the report',async()=>{
  let attempts=0;
  const h=await startPreflightController({nowMs:now,respond:baseResponder({policy:approved,onRequest:request=>{
    if(request.path==='/api/preflight/checks'&&request.method==='POST')return ++attempts===1?{error:new Error('lost')}:response(completed,{status:202});
  }})});
  h.fields.candidate.get('price').value='24.8';h.fields.candidate.get('size').value='4';await h.fire('candidate-form','submit');
  assert.equal(h.get('uncertain').hidden,false);await h.fire('retry-pending');
  const posts=h.calls.filter(call=>call.path==='/api/preflight/checks');assert.equal(posts.length,2);assert.equal(posts[0].body,posts[1].body);
  assert.equal(h.get('report').hidden,false);assert.equal(h.get('verdict-code').textContent,'ALLOW');
});

test('agent capability selects bounded review by default and renders its action apart from verdict',async()=>{
  let postBody;
  const h=await startPreflightController({nowMs:now,respond:baseResponder({policy:approved,onRequest:request=>{
    if(request.path==='/api/preflight/status')return response(agentStatus);
    if(request.path==='/api/preflight/agent-checks'&&request.method==='POST'){postBody=request.body;return response(agentCompleted,{status:202});}
  }})});
  assert.equal(h.get('mode-agent').checked,true);assert.equal(h.get('mode-direct').checked,false);assert.equal(h.get('run-check').textContent,'Ajanla incele');
  h.fields.candidate.get('price').value='24.8';h.fields.candidate.get('size').value='4';await h.fire('candidate-form','submit');
  const submitted=JSON.parse(postBody);assert.equal(submitted.candidate.price,'24.8');assert.equal(submitted.candidate.size,'4');assert.equal(h.get('verdict-code').textContent,'ALLOW');assert.equal(h.get('agent-action').textContent,'ACCEPT');
  assert.equal(h.get('agent-decision').hidden,false);assert.equal(h.get('agent-candidate-diff').hidden,false);
  assert.equal(h.get('agent-candidate-original').children[0].children[1].textContent,'24.8 USDT/AVAX · 4 AVAX');
  assert.equal(h.get('agent-candidate-final').children[0].children[1].textContent,'24.7 USDT/AVAX · 3.5 AVAX');
});

test('legacy status visibly falls back to manual and never probes the agent endpoint',async()=>{
  const h=await startPreflightController({nowMs:now,respond:baseResponder({policy:approved,onRequest:request=>
    request.path==='/api/preflight/checks'&&request.method==='POST'?response(completed,{status:202}):undefined})});
  assert.equal(h.get('mode-agent').disabled,true);assert.equal(h.get('mode-direct').checked,true);assert.match(h.get('agent-mode-status').textContent,/doğrudan kontrol seçildi/);
  h.fields.candidate.get('price').value='24.8';h.fields.candidate.get('size').value='4';await h.fire('candidate-form','submit');
  assert.equal(h.calls.some(call=>call.path==='/api/preflight/agent-checks'),false);assert.equal(h.calls.filter(call=>call.path==='/api/preflight/checks'&&call.method==='POST').length,1);
});

test('lost agent response retries the same allowlisted path, UUID and body',async()=>{
  let attempts=0;
  const h=await startPreflightController({nowMs:now,respond:baseResponder({policy:approved,onRequest:request=>{
    if(request.path==='/api/preflight/status')return response(agentStatus);
    if(request.path==='/api/preflight/agent-checks'&&request.method==='POST')return ++attempts===1?{error:new Error('lost')}:response(agentCompleted,{status:202});
  }})});
  h.fields.candidate.get('price').value='24.8';h.fields.candidate.get('size').value='4';await h.fire('candidate-form','submit');await h.fire('retry-pending');
  const posts=h.calls.filter(call=>call.path==='/api/preflight/agent-checks');assert.equal(posts.length,2);assert.equal(posts[0].body,posts[1].body);
});

test('agent WAIT can never paint a stale green ALLOW verdict',async()=>{
  const waitAllow={...agentReport,agentTrace:{...agentReport.agentTrace,modelCallCount:1,attempts:[{...agentReport.agentTrace.attempts[0],action:'WAIT',reasonCode:'NO_FEASIBLE_CANDIDATE'}],finalGovernorRead:null}},invalid={...agentCompleted,report:waitAllow};
  const h=await startPreflightController({nowMs:now,respond:baseResponder({policy:approved,onRequest:request=>{
    if(request.path==='/api/preflight/status')return response(agentStatus);
    if(request.path==='/api/preflight/agent-checks'&&request.method==='POST'||request.path===`/api/preflight/checks/${completed.id}`)return response(invalid,{status:202});
  }})});
  h.fields.candidate.get('price').value='24.8';h.fields.candidate.get('size').value='4';await h.fire('candidate-form','submit');
  assert.equal(h.get('report').hidden,true);assert.notEqual(h.get('verdict-code').textContent,'ALLOW');
});

test('unavailable manual planner trace with two consumed calls preserves a known BLOCK without agent UI',async()=>{
  const blocked={...report,verdict:'BLOCK',reasonCodes:['PRICE_CAP_EXCEEDED'],sanitizedEvidence:null,agentTrace:{plannerKind:'unavailable',plan:{tools:[]},modelCallCount:2,failureCode:'PREFLIGHT_AGENT_UNAVAILABLE'}};
  const done={...completed,report:blocked};
  const h=await startPreflightController({nowMs:now,respond:baseResponder({policy:approved,onRequest:request=>request.path==='/api/preflight/checks'&&request.method==='POST'?response(done,{status:202}):undefined})});
  h.fields.candidate.get('price').value='24.8';h.fields.candidate.get('size').value='4';await h.fire('candidate-form','submit');
  assert.equal(h.get('report').hidden,false);assert.equal(h.get('verdict-code').textContent,'BLOCK');assert.equal(h.get('agent-decision').hidden,true);
});

test('an active check blocks live and replay duplicates while GET recovery remains possible',async()=>{
  const queued={...completed,state:'RUNNING',report:null};
  const h=await startPreflightController({nowMs:now,respond:baseResponder({policy:approved,onRequest:request=>request.path==='/api/preflight/checks'&&request.method==='POST'?response(queued,{status:202}):undefined})});
  h.fields.candidate.get('price').value='24.8';h.fields.candidate.get('size').value='4';await h.fire('candidate-form','submit');
  assert.equal(h.get('run-check').disabled,true);assert.equal(h.get('replay-within').disabled,true);assert.equal(h.get('replay-breach').disabled,true);assert.equal(h.get('replay-stale').disabled,true);
  await h.fire('candidate-form','submit');assert.equal(h.calls.filter(call=>call.path==='/api/preflight/checks'&&call.method==='POST').length,1);assert.equal(h.get('result-step').hidden,false);assert.equal(h.get('live-candidate-step').hidden,true);
});

test('foreign-session pending bodies are discarded and cannot be posted into a fresh owner session',async()=>{
  const old=JSON.stringify({path:'/api/preflight/examples/within-limits',body:{clientRequestId:'old'},sessionBinding:'foreign:7'});
  const h=await startPreflightController({stored:[['pactway-preflight-pending-v1',old]],respond:baseResponder()});
  assert.equal(h.storage.has('pactway-preflight-pending-v1'),false);await h.fire('retry-pending');
  assert.equal(h.calls.some(call=>call.path.includes('/examples/')),false);
});

test('an invite-only 401 clears private state and opens only code-gated join',async()=>{
  const h=await startPreflightController({nowMs:now,respond:baseResponder({policy:approved,onRequest:request=>
    request.path==='/api/preflight/checks'&&request.method==='POST'?response({error:'SESSION_REQUIRED',inviteRequired:true},{status:401}):undefined})});
  h.fields.candidate.get('price').value='24.8';h.fields.candidate.get('size').value='4';await h.fire('candidate-form','submit');
  assert.equal(h.get('access').hidden,false);assert.equal(h.get('workspace').hidden,true);assert.equal(h.get('policy-review').hidden,true);
  assert.equal(h.get('invite-controls').hidden,false);assert.equal(h.get('join').disabled,true);
  assert.equal(h.get('live-access-notice').hidden,false);assert.match(h.get('access-error').textContent,/davet kodunu gir/);
  assert.equal(h.storage.has('pactway-preflight-pending-v1'),false);
});

test('invite gate validates, clears and retries the code without persisting it',async()=>{
  const wrong='wrong-invite-code-123456789',correct='correct-invite-code-1234567';let joined=false;
  const h=await startPreflightController({respond:request=>{
    if(request.path==='/api/bootstrap')return joined?response(boot('csrf-one')):response({error:'SESSION_REQUIRED',inviteRequired:true},{status:401});
    if(request.path==='/api/session/join'){
      const input=JSON.parse(request.body);if(input.inviteCode!==correct)return response({error:'Davet kodu geçersiz.'},{status:403});joined=true;return response(boot('csrf-one'));
    }
    if(request.path==='/api/preflight/status')return response(status);
    if(request.path==='/api/preflight/history')return response({policies:[],checks:[]});
  }});
  assert.equal(h.get('invite-controls').hidden,false);assert.equal(h.get('join').disabled,true);assert.equal(h.document.activeElement,h.get('invite-code'));
  h.get('invite-code').value='short';await h.fire('invite-code','input');assert.equal(h.get('join').disabled,true);
  assert.equal(h.calls.filter(call=>call.path==='/api/session/join').length,0);
  h.get('invite-code').value=wrong;await h.fire('invite-code','input');assert.equal(h.get('join').disabled,false);await h.fire('join');
  assert.equal(h.get('invite-code').value,'');assert.match(h.get('access-error').textContent,/geçersiz/);assert.equal(h.get('access').hidden,false);
  h.get('invite-code').value=correct;await h.fire('invite-code','input');await h.fire('join');
  const joins=h.calls.filter(call=>call.path==='/api/session/join');assert.equal(joins.length,2);assert.deepEqual(JSON.parse(joins[1].body),{inviteCode:correct});
  assert.equal(h.get('invite-code').value,'');assert.equal(h.get('access').hidden,true);assert.equal(h.get('workspace').hidden,false);assert.equal(h.get('live-access-notice').hidden,false);
  assert.equal([...h.storage.values()].some(value=>String(value).includes(wrong)||String(value).includes(correct)),false);
});

test('lost policy creation stays locked until a delayed history reconciliation permits explicit abandonment',async()=>{
  const h=await startPreflightController({nowMs:now,respond:baseResponder({onRequest:request=>request.path==='/api/preflight/policies'&&request.method==='POST'?{error:new Error('lost')}:undefined})});
  h.fields.policy.get('maxNotional').value='100';h.fields.policy.get('maxPrice').value='25';h.fields.policy.get('durationSeconds').value='600';await h.fire('policy-form','submit');
  assert.equal(h.get('policy-uncertain').hidden,false);assert.equal(h.get('create-policy').disabled,true);h.setNow(now+11000);await h.fire('reconcile-policy');
  assert.equal(h.get('abandon-policy').hidden,false);await h.fire('abandon-policy');assert.equal(h.get('create-policy').disabled,false);
});

test('null or stale evidence cannot be painted as ALLOW',async()=>{
  const invalid={...replayWithin,sanitizedEvidence:null,verdict:'ALLOW'};
  const invalidCheck={...completed,mode:'REPLAY',report:invalid};
  const h=await startPreflightController({respond:baseResponder({onRequest:request=>request.path==='/api/preflight/examples/within-limits'||request.path===`/api/preflight/checks/${completed.id}`?response(invalidCheck):undefined})});
  await h.fire('replay-within');
  assert.equal(h.get('report').hidden,true);assert.equal(h.get('verdict-code').textContent,'');
});

test('a known policy breach can render BLOCK without market evidence',async()=>{
  const blocked={...replayBreach,sanitizedEvidence:null};
  const h=await startPreflightController({respond:baseResponder({onRequest:request=>request.path==='/api/preflight/examples/limit-breach'?response({...completed,mode:'REPLAY',report:blocked}):undefined})});
  await h.fire('replay-breach');
  assert.equal(h.get('report').hidden,false);assert.equal(h.get('verdict-code').textContent,'BLOCK');
  assert.equal(h.get('evidence-summary').children[0].children[1].textContent,'Güvenilir kanıt üretilemedi');
});

test('expired policy stays editable through a new policy and never enables checking',async()=>{
  const expired={...approved,expiresAtMs:now-1};
  const h=await startPreflightController({nowMs:now,respond:baseResponder({policy:expired})});
  assert.equal(h.get('run-check').disabled,true);assert.equal(h.get('replace-policy').hidden,false);await h.fire('replace-policy');assert.equal(h.get('policy-form').hidden,false);
});

test('storage denial prevents policy and check mutations before POST',async()=>{
  const h=await startPreflightController({storageThrows:true,respond:baseResponder()});
  h.fields.policy.get('maxNotional').value='100';h.fields.policy.get('maxPrice').value='25';h.fields.policy.get('durationSeconds').value='600';await h.fire('policy-form','submit');
  assert.equal(h.calls.some(call=>call.path==='/api/preflight/policies'&&call.method==='POST'),false);
  const approvedHarness=await startPreflightController({storageThrows:true,nowMs:now,respond:baseResponder({policy:approved})});
  approvedHarness.fields.candidate.get('price').value='24.8';approvedHarness.fields.candidate.get('size').value='4';await approvedHarness.fire('candidate-form','submit');
  assert.equal(approvedHarness.calls.some(call=>call.path==='/api/preflight/checks'&&call.method==='POST'),false);
});

test('untrusted evidence text is rendered as text content, never executable markup',async()=>{
  const xss={...replayWithin,sanitizedEvidence:{source:'<img src=x onerror=alert(1)>',ageMs:1}};
  const replay={...completed,mode:'REPLAY',report:xss};
  const h=await startPreflightController({respond:baseResponder({onRequest:request=>request.path==='/api/preflight/examples/within-limits'?response(replay):undefined})});
  await h.fire('replay-within');const rendered=h.get('evidence-summary').children.flatMap(row=>row.children).map(item=>item.textContent);
  assert.ok(rendered.includes('<img src=x onerror=alert(1)>'));assert.equal(h.get('report').hidden,false);
});

test('editing live inputs never marks a cached replay fixture as stale',async()=>{
  const responder=baseResponder({policy:approved,onRequest:request=>request.path==='/api/preflight/examples/within-limits'?response({...completed,mode:'REPLAY',report:replayWithin}):undefined});
  const candidate=await startPreflightController({respond:responder});await candidate.fire('replay-within');
  assert.equal(candidate.get('report-stale').hidden,true);await candidate.fire('candidate-form','input');assert.equal(candidate.get('report-stale').hidden,true);
  const replacement=await startPreflightController({respond:responder});await replacement.fire('replay-within');await replacement.fire('replace-policy');
  assert.equal(replacement.get('report-stale').hidden,true);await replacement.fire('policy-form','input');assert.equal(replacement.get('report-stale').hidden,true);
});

test('a newly completed replay remains current after unrelated live-form edits',async()=>{
  const h=await startPreflightController({respond:baseResponder({onRequest:request=>request.path.startsWith('/api/preflight/examples/')?response({...completed,mode:'REPLAY',report:replayWithin}):undefined})});
  await h.fire('replay-within');await h.fire('candidate-form','input');assert.equal(h.get('report-stale').hidden,true);
  await h.fire('replay-breach');assert.equal(h.get('report-stale').hidden,true);assert.equal(h.get('report').hidden,false);
});

test('poll completion refreshes a RUNNING history card to its completed report without another POST',async()=>{
  let phase='RUNNING';
  const running={...completed,state:'RUNNING',report:null};
  const h=await startPreflightController({nowMs:now,respond:baseResponder({policy:approved,onRequest:request=>{
    if(request.path==='/api/preflight/checks'&&request.method==='POST')return response(running,{status:202});
    if(request.path===`/api/preflight/checks/${completed.id}`){phase='COMPLETED';return response(completed);}
    if(request.path==='/api/preflight/history')return response({policies:[approved],checks:[phase==='RUNNING'?running:completed]});
  }})});
  h.fields.candidate.get('price').value='24.8';h.fields.candidate.get('size').value='4';await h.fire('candidate-form','submit');
  assert.equal(h.get('history-list').children[0].children[0].textContent,'RUNNING');await h.runTimerByDelay(1500);
  assert.equal(h.get('history-list').children[0].children[0].textContent,'ALLOW');
  assert.ok(h.get('history-list').children[0].children.some(child=>child.textContent==='Raporu aç'));
  assert.equal(h.calls.filter(call=>call.path==='/api/preflight/checks'&&call.method==='POST').length,1);
});

test('a failed completion history refresh keeps the valid report visible and never repeats its POST',async()=>{
  let historyReads=0;
  const running={...completed,state:'RUNNING',report:null};
  const h=await startPreflightController({nowMs:now,respond:baseResponder({policy:approved,onRequest:request=>{
    if(request.path==='/api/preflight/checks'&&request.method==='POST')return response(running,{status:202});
    if(request.path===`/api/preflight/checks/${completed.id}`)return response(completed);
    if(request.path==='/api/preflight/history')return ++historyReads>=3?{error:new Error('history offline')}:response({policies:[approved],checks:[running]});
  }})});
  h.fields.candidate.get('price').value='24.8';h.fields.candidate.get('size').value='4';await h.fire('candidate-form','submit');await h.runTimerByDelay(1500);
  assert.equal(h.get('report').hidden,false);assert.equal(h.get('verdict-code').textContent,'ALLOW');
  assert.equal(h.calls.filter(call=>call.path==='/api/preflight/checks'&&call.method==='POST').length,1);
});

test('startup failure has a focused retry that can recover the whole workspace',async()=>{
  let statusReads=0;
  const h=await startPreflightController({respond:request=>{
    if(request.path==='/api/bootstrap')return response(boot('csrf-one'));
    if(request.path==='/api/preflight/history')return response({policies:[],checks:[]});
    if(request.path==='/api/preflight/status')return ++statusReads===1?{error:new Error('offline')}:response(status);
  }});
  assert.equal(h.get('boot-error').hidden,false);assert.equal(h.document.activeElement,h.get('retry-startup'));assert.equal(h.get('workspace').hidden,true);
  await h.fire('retry-startup');for(let attempt=0;attempt<20&&h.get('workspace').hidden;attempt++)await h.flush(5);
  assert.equal(h.get('boot-error').hidden,true);assert.equal(h.get('workspace').hidden,false);assert.equal(statusReads,2);
});

test('strict malformed status stays closed while typed unavailable status remains honestly usable',async()=>{
  const malformed=await startPreflightController({respond:request=>request.path==='/api/preflight/status'?response({...status,unexpected:true}):baseResponder()(request)});
  assert.equal(malformed.get('boot-error').hidden,false);assert.equal(malformed.get('workspace').hidden,true);
  const unavailable=await startPreflightController({respond:request=>request.path==='/api/preflight/status'?response({...status,liveAvailable:false,atkState:'DISCONNECTED',plannerKind:'unavailable'}):baseResponder()(request)});
  assert.match(unavailable.get('readiness-note').textContent,/hazır değil/);assert.equal(unavailable.get('create-policy').disabled,false);
});

test('expiry clock disables the action, updates visible state and stale submits explain recovery',async()=>{
  const short={...approved,expiresAtMs:now+1000,policy:{...approved.policy,durationSeconds:'60'}};
  const h=await startPreflightController({nowMs:now,respond:baseResponder({policy:short})});
  assert.equal(h.get('run-check').disabled,false);assert.match(h.get('policy-expiry').textContent,/1 saniye/);
  h.setNow(now+1000);await h.runTimerByDelay(1000);assert.equal(h.get('run-check').disabled,true);assert.match(h.get('policy-expiry').textContent,/Süre doldu/);
  h.fields.candidate.get('price').value='24';h.fields.candidate.get('size').value='1';await h.fire('candidate-form','submit');
  assert.match(h.get('global-error-copy').textContent,/süresi doldu/);assert.equal(h.document.activeElement,h.get('replace-policy'));assert.equal(h.calls.some(call=>call.path==='/api/preflight/checks'&&call.method==='POST'),false);
});

test('decimal validation rejects zero and excess precision inline before any mutation',async()=>{
  const h=await startPreflightController({respond:baseResponder()});
  h.fields.policy.get('maxNotional').value='0.000';h.fields.policy.get('maxPrice').value='25.000000001';h.fields.policy.get('durationSeconds').value='59';await h.fire('policy-form','submit');
  assert.equal(h.get('max-notional-error').hidden,false);assert.match(h.get('max-notional-error').textContent,/sıfırdan büyük/);assert.equal(h.get('max-price-error').hidden,false);assert.equal(h.get('duration-seconds-error').hidden,false);assert.equal(h.document.activeElement,h.get('max-notional'));
  assert.equal(h.calls.some(call=>call.path==='/api/preflight/policies'&&call.method==='POST'),false);
});

test('notional preview uses exact sixteen-place arithmetic and policy breaches are warnings only',async()=>{
  const large={...approved,policy:{...approved.policy,maxNotional:'100',maxPrice:'25'}};
  const h=await startPreflightController({respond:baseResponder({policy:large,onRequest:request=>request.path==='/api/preflight/checks'&&request.method==='POST'?response(completed):undefined})});
  h.fields.candidate.get('price').value='999999999999.99999999';h.fields.candidate.get('size').value='0.00000001';
  await h.fire('candidate-form','input',{target:h.get('candidate-price')});assert.equal(h.get('candidate-notional').textContent,'9999.9999999999999999 USDT');assert.match(h.get('candidate-margin').textContent,/sınırını aşıyor/);
  await h.fire('candidate-form','submit');assert.equal(h.calls.filter(call=>call.path==='/api/preflight/checks'&&call.method==='POST').length,1);
});

test('submitting state appears immediately, locks inputs and keeps mode switching closed',async()=>{
  let release;
  const h=await startPreflightController({respond:baseResponder({policy:approved,onRequest:request=>request.path==='/api/preflight/checks'&&request.method==='POST'?new Promise(resolve=>{release=()=>resolve(response(completed));}):undefined})});
  h.fields.candidate.get('price').value='24.8';h.fields.candidate.get('size').value='4';await h.fire('candidate-form','submit');
  assert.equal(h.get('pending').hidden,false);assert.match(h.get('pending-title').textContent,/gönderiliyor/);assert.equal(h.get('candidate-price').disabled,true);assert.equal(h.get('candidate-form').getAttribute('aria-busy'),'true');assert.equal(h.get('view-examples').disabled,true);
  release();await h.flush();assert.equal(h.get('report').hidden,false);assert.equal(h.get('candidate-price').disabled,false);
});

test('poll GET failure retains durable authority and retry never repeats the POST',async()=>{
  let getReads=0;
  const running={...completed,state:'RUNNING',report:null};
  const h=await startPreflightController({respond:baseResponder({policy:approved,onRequest:request=>{
    if(request.path==='/api/preflight/checks'&&request.method==='POST')return response(running,{status:202});
    if(request.path===`/api/preflight/checks/${completed.id}`)return ++getReads===1?{error:new Error('offline')}:response(completed);
    if(request.path==='/api/preflight/history')return response({policies:[approved],checks:[running]});
  }})});
  h.fields.candidate.get('price').value='24.8';h.fields.candidate.get('size').value='4';await h.fire('candidate-form','submit');await h.runTimerByDelay(1500);
  assert.equal(h.get('poll-recovery').hidden,false);assert.equal(h.storage.has('pactway-preflight-active-check-v1'),true);assert.equal(h.get('view-examples').disabled,true);
  await h.fire('retry-poll');assert.equal(h.get('report').hidden,false);assert.equal(h.storage.has('pactway-preflight-active-check-v1'),false);assert.equal(h.calls.filter(call=>call.path==='/api/preflight/checks'&&call.method==='POST').length,1);
});

test('uncertain approval locks replacement until a policy reread confirms the commit',async()=>{
  let record=draft,approvePosts=0;
  const h=await startPreflightController({respond:baseResponder({onRequest:request=>{
    if(request.path==='/api/preflight/history')return response({policies:[record],checks:[]});
    if(request.path===`/api/preflight/policies/${draft.id}/approve`){approvePosts++;record=approved;return {error:new Error('lost')};}
    if(request.path===`/api/preflight/policies/${draft.id}`)return response(record);
  }})});
  h.get('policy-ack').checked=true;await h.fire('policy-ack','change');await h.fire('approve-policy');assert.equal(h.get('approval-uncertain').hidden,false);assert.equal(h.get('replace-policy').disabled,true);assert.equal(h.get('run-check').disabled,true);
  await h.fire('retry-approval');assert.equal(h.get('approval-uncertain').hidden,true);assert.equal(h.get('replace-policy').disabled,false);assert.equal(h.get('run-check').disabled,false);assert.equal(approvePosts,1);
});

test('live and example reports stay independently cached and switching performs no request',async()=>{
  const exampleCheck={...completed,mode:'REPLAY',report:replayWithin};
  const h=await startPreflightController({respond:baseResponder({policy:approved,onRequest:request=>{
    if(request.path==='/api/preflight/checks'&&request.method==='POST')return response(completed);
    if(request.path==='/api/preflight/examples/within-limits')return response(exampleCheck);
  }})});
  h.fields.candidate.get('price').value='24.8';h.fields.candidate.get('size').value='4';await h.fire('candidate-form','submit');assert.equal(h.get('verdict-code').textContent,'ALLOW');assert.match(h.get('report-context').textContent,/Canlı kontrol/);
  await h.fire('view-examples');await h.fire('replay-within');assert.match(h.get('report-context').textContent,/Kayıtlı örnek/);const before=h.calls.length;
  await h.fire('view-live');assert.match(h.get('report-context').textContent,/Canlı kontrol/);await h.fire('view-examples');assert.match(h.get('report-context').textContent,/Kayıtlı örnek/);assert.equal(h.calls.length,before);
});

test('rendered results focus the heading, expose natural reasons and retain raw codes as detail',async()=>{
  const h=await startPreflightController({respond:baseResponder({onRequest:request=>request.path==='/api/preflight/examples/limit-breach'?response({...completed,mode:'REPLAY',report:replayBreach}):undefined})});
  await h.fire('replay-breach');assert.equal(h.document.activeElement,h.get('result-title'));assert.equal(h.get('report').getAttribute('aria-live'),'polite');
  assert.doesNotMatch(h.get('reason-list').children[0].textContent,/PRICE_CAP_EXCEEDED/);assert.ok(h.get('reason-list').children.some(item=>item.title==='PRICE_CAP_EXCEEDED'));
});

test('a session 401 wipes both cached modes and never reopens hidden private views',async()=>{
  let deny=false;
  const h=await startPreflightController({respond:baseResponder({onRequest:request=>{
    if(request.path==='/api/preflight/examples/within-limits')return response({...completed,mode:'REPLAY',report:replayWithin});
    if(deny&&request.path==='/api/preflight/status')return response({error:'SESSION_REQUIRED',inviteRequired:false},{status:401});
  }})});
  await h.fire('replay-within');deny=true;await h.fire('refresh-status');assert.equal(h.get('access').hidden,false);assert.equal(h.get('workspace').hidden,true);assert.equal(h.get('report').hidden,true);assert.equal(h.storage.has('pactway-preflight-pending-v1'),false);assert.equal(h.storage.has('pactway-preflight-active-check-v1'),false);
});

test('a late 401 from an older epoch cannot erase a newly opened session',async()=>{
  let statusReads=0,releaseOld;
  const h=await startPreflightController({respond:request=>{
    if(request.path==='/api/bootstrap')return response(boot('csrf-'+statusReads));
    if(request.path==='/api/preflight/status'){statusReads++;if(statusReads===2)return new Promise(resolve=>{releaseOld=()=>resolve(response({error:'SESSION_REQUIRED',inviteRequired:false},{status:401}));});return response(status);}
    if(request.path==='/api/preflight/history')return response({policies:statusReads<3?[approved]:[],checks:[]});
    if(request.path==='/api/preflight/policies/'+approved.id)return response(approved);
    if(request.path==='/api/preflight/checks'&&request.method==='POST')return response({error:'SESSION_REQUIRED',inviteRequired:false},{status:401});
    if(request.path==='/api/session/join')return response(boot('csrf-new'));
  }});
  await h.fire('refresh-status');h.fields.candidate.get('price').value='24';h.fields.candidate.get('size').value='1';await h.fire('candidate-form','submit');assert.equal(h.get('access').hidden,false);
  await h.fire('join');assert.equal(h.get('workspace').hidden,false);releaseOld();await h.flush();assert.equal(h.get('workspace').hidden,false);assert.equal(h.get('access').hidden,true);
});

test('a sibling startup response cannot repaint history after a 401 clears the session',async()=>{
  const h=await startPreflightController({respond:request=>{
    if(request.path==='/api/bootstrap')return response(boot('csrf-one'));
    if(request.path==='/api/preflight/status')return response({error:'SESSION_REQUIRED',inviteRequired:false},{status:401});
    if(request.path==='/api/preflight/history')return new Promise(resolve=>setImmediate(()=>resolve(response({policies:[approved],checks:[completed]}))));
  }});
  assert.equal(h.get('access').hidden,false);assert.equal(h.get('workspace').hidden,true);assert.equal(h.get('history-list').children.length,0);assert.equal(h.get('policy-review').hidden,true);
});

test('history cannot switch durable recovery to a different running check',async()=>{
  const other={...completed,id:'30000000-0000-4000-8000-000000000002',state:'RUNNING',report:null};
  const running={...completed,state:'RUNNING',report:null};
  const h=await startPreflightController({respond:baseResponder({policy:approved,onRequest:request=>{
    if(request.path==='/api/preflight/checks'&&request.method==='POST')return response(running,{status:202});
    if(request.path==='/api/preflight/history')return response({policies:[approved],checks:[running,other]});
  }})});
  h.fields.candidate.get('price').value='24';h.fields.candidate.get('size').value='1';await h.fire('candidate-form','submit');
  const cards=h.get('history-list').children.filter(card=>card.children.some(child=>child.textContent===running.id.slice(0,12)||child.textContent===other.id.slice(0,12)));
  const activeCard=cards.find(card=>card.children.some(child=>child.textContent===running.id.slice(0,12))),otherCard=cards.find(card=>card.children.some(child=>child.textContent===other.id.slice(0,12)));
  assert.equal(activeCard.children.at(-1).disabled,false);assert.equal(otherCard.children.at(-1).disabled,true);await otherCard.children.at(-1).fire('click');await h.flush();
  assert.equal(h.calls.some(call=>call.path===`/api/preflight/checks/${other.id}`),false);assert.match(h.storage.get('pactway-preflight-active-check-v1'),new RegExp(completed.id));
});

test('an ALLOW replay with no reason codes gets one calm natural summary',async()=>{
  const h=await startPreflightController({respond:baseResponder({onRequest:request=>request.path==='/api/preflight/examples/within-limits'?response({...completed,mode:'REPLAY',report:replayWithin}):undefined})});
  await h.fire('replay-within');assert.equal(h.get('reason-list').children.length,1);assert.equal(h.get('reason-list').children[0].textContent,'Kapsam dahilindeki 9 kontrol geçti.');assert.equal(h.get('reason-list').children[0].title,'PASS');
});

test('editing a live form marks only its cached live report as a previous snapshot',async()=>{
  const h=await startPreflightController({respond:baseResponder({policy:approved,onRequest:request=>request.path==='/api/preflight/checks'&&request.method==='POST'?response(completed):undefined})});
  h.fields.candidate.get('price').value='24.8';h.fields.candidate.get('size').value='4';await h.fire('candidate-form','submit');assert.equal(h.get('report-stale').hidden,true);
  h.fields.candidate.get('price').value='24.7';await h.fire('candidate-form','input',{target:h.get('candidate-price')});assert.equal(h.get('report-stale').hidden,false);
});

test('opening a replay report from history selects examples without starting another request',async()=>{
  const replayCheck={...completed,mode:'REPLAY',report:replayWithin};
  const h=await startPreflightController({respond:baseResponder({onRequest:request=>{
    if(request.path==='/api/preflight/history')return response({policies:[],checks:[replayCheck]});
    if(request.path===`/api/preflight/checks/${replayCheck.id}`)return response(replayCheck);
  }})});
  const open=h.get('history-list').children[0].children.at(-1);await open.fire('click');await h.flush();assert.equal(h.get('replays').hidden,false);assert.equal(h.get('live-policy-step').hidden,true);assert.match(h.get('report-context').textContent,/Kayıtlı örnek/);
  assert.equal(h.calls.filter(call=>call.method==='POST').length,0);
});

test('a 401 clears derived form state and releases busy so a fresh session can join',async()=>{
  let deny=true,joins=0;
  const h=await startPreflightController({respond:baseResponder({policy:approved,onRequest:request=>{
    if(request.path==='/api/preflight/checks'&&request.method==='POST'&&deny)return response({error:'SESSION_REQUIRED',inviteRequired:false},{status:401});
    if(request.path==='/api/session/join'){deny=false;joins++;return response(boot('csrf-new'));}
    if(!deny&&request.path==='/api/preflight/history')return response({policies:[],checks:[]});
  }})});
  h.fields.candidate.get('price').value='24.12345678';h.fields.candidate.get('size').value='2';await h.fire('candidate-form','input',{target:h.get('candidate-price')});
  assert.notEqual(h.get('candidate-notional').textContent,'— USDT');h.fields.candidate.get('price').value='0.000';await h.fire('candidate-form','submit');assert.equal(h.get('candidate-price-error').hidden,false);
  h.fields.candidate.get('price').value='24';await h.fire('candidate-form','submit');assert.equal(h.get('access').hidden,false);assert.equal(h.get('candidate-notional').textContent,'— USDT');assert.equal(h.get('candidate-margin').textContent,'—');assert.equal(h.get('candidate-price-error').hidden,true);assert.equal(h.fields.candidate.get('price').value,'');
  await h.fire('join');await h.flush(30);assert.equal(joins,1);assert.equal(h.get('workspace').hidden,false);assert.equal(h.get('access').hidden,true);
});

test('historical live reports warn when their policy differs or has expired',async()=>{
  const oldReport={...report,policy:{...report.policy,id:'old-policy',expiresAtMs:now-1}},oldCheck={...completed,id:'30000000-0000-4000-8000-000000000003',report:oldReport};
  const h=await startPreflightController({nowMs:now,respond:baseResponder({policy:approved,onRequest:request=>{
    if(request.path==='/api/preflight/history')return response({policies:[approved],checks:[oldCheck]});
    if(request.path===`/api/preflight/checks/${oldCheck.id}`)return response(oldCheck);
  }})});
  const open=h.get('history-list').children.find(card=>card.children.some(child=>child.textContent===oldCheck.id.slice(0,12))).children.at(-1);
  await open.fire('click');await h.flush();assert.equal(h.get('report').hidden,false);assert.equal(h.get('report-stale').hidden,false);
  assert.equal(h.get('report-mode').textContent,'LIVE_READ_ONLY · salt okunur');
});

test('replay reports never inherit live policy expiry staleness',async()=>{
  const h=await startPreflightController({nowMs:now,respond:baseResponder({policy:{...approved,expiresAtMs:now-1},onRequest:request=>request.path==='/api/preflight/examples/within-limits'?response({...completed,mode:'REPLAY',report:replayWithin}):undefined})});
  await h.fire('replay-within');assert.equal(h.get('report-stale').hidden,true);assert.equal(h.get('report-mode').textContent,'REPLAY · kayıtlı örnek');
});

test('live workflow starts at the first eligible step and navigation never submits',async()=>{
  const blank=await startPreflightController({nowMs:now,respond:baseResponder()});
  assert.equal(blank.get('live-policy-step').hidden,false);assert.equal(blank.get('live-candidate-step').hidden,true);assert.equal(blank.get('step-policy').getAttribute('aria-current'),'step');assert.equal(blank.get('step-candidate').disabled,true);
  const h=await startPreflightController({nowMs:now,respond:baseResponder({policy:approved})});
  assert.equal(h.get('live-policy-step').hidden,true);assert.equal(h.get('live-candidate-step').hidden,false);assert.equal(h.get('step-candidate').getAttribute('aria-current'),'step');assert.equal(h.get('workflow-summary').hidden,false);
  const before=h.calls.length;await h.fire('step-policy');assert.equal(h.get('live-policy-step').hidden,false);assert.equal(h.get('step-policy').getAttribute('aria-current'),'step');assert.equal(h.get('step-candidate').getAttribute('aria-current'),null);assert.equal(h.calls.length,before);
});

test('explicit approval advances to the candidate step and focuses its heading',async()=>{
  let record=draft;
  const h=await startPreflightController({nowMs:now,respond:baseResponder({onRequest:request=>{
    if(request.path==='/api/preflight/history')return response({policies:[record],checks:[]});
    if(request.path===`/api/preflight/policies/${draft.id}`)return response(record);
    if(request.path===`/api/preflight/policies/${draft.id}/approve`){record=approved;return response(record);}
  }})});
  h.get('policy-ack').checked=true;await h.fire('policy-ack','change');await h.fire('approve-policy');
  assert.equal(h.get('live-candidate-step').hidden,false);assert.equal(h.get('live-policy-step').hidden,true);assert.equal(h.document.activeElement,h.get('candidate-title'));
});

test('history is an empty-state view and switching views preserves live input without writes',async()=>{
  const h=await startPreflightController({nowMs:now,respond:baseResponder()});h.fields.policy.get('maxNotional').value='40';const before=h.calls.length;
  await h.fire('view-history');assert.equal(h.get('workspace').hidden,true);assert.equal(h.get('history-section').hidden,false);assert.equal(h.get('history-empty').hidden,false);assert.equal(h.get('workflow-nav').hidden,true);
  assert.equal(h.calls.length,before);await h.fire('refresh-status');assert.equal(h.get('workspace').hidden,true);assert.equal(h.get('history-section').hidden,false);await h.fire('refresh-history');assert.equal(h.get('workspace').hidden,true);assert.equal(h.get('history-section').hidden,false);
  await h.fire('view-live');assert.equal(h.get('workspace').hidden,false);assert.equal(h.get('live-policy-step').hidden,false);assert.equal(h.fields.policy.get('maxNotional').value,'40');assert.equal(h.calls.some(call=>call.method==='POST'),false);
});

test('history refresh leaves newly rendered record actions enabled',async()=>{
  const h=await startPreflightController({nowMs:now,respond:baseResponder({policy:approved})});await h.fire('view-history');await h.fire('refresh-history');
  assert.equal(h.get('history-list').children.length,1);assert.equal(h.get('history-list').children[0].children.at(-1).disabled,false);
});

test('expired policy reloads to review while timer expiry leaves an open candidate panel and focus in place',async()=>{
  const expired=await startPreflightController({nowMs:now,respond:baseResponder({policy:{...approved,expiresAtMs:now-1}})});
  assert.equal(expired.get('live-policy-step').hidden,false);assert.equal(expired.get('live-candidate-step').hidden,true);assert.equal(expired.get('step-candidate').disabled,true);assert.match(expired.get('workflow-expiry').textContent,/Süre doldu/);
  const short=await startPreflightController({nowMs:now,respond:baseResponder({policy:{...approved,expiresAtMs:now+1000}})});short.get('candidate-price').focus();short.setNow(now+1000);await short.runTimerByDelay(1000);
  assert.equal(short.get('live-candidate-step').hidden,false);assert.equal(short.document.activeElement,short.get('candidate-price'));assert.equal(short.get('step-candidate').disabled,true);assert.match(short.get('workflow-expiry').textContent,/Süre doldu/);
  await short.fire('view-history');await short.fire('view-live');assert.equal(short.get('live-policy-step').hidden,false);assert.equal(short.get('live-candidate-step').hidden,true);
});

test('stored LIVE and REPLAY uncertain requests reopen only their result recovery view',async()=>{
  const livePending={path:'/api/preflight/checks',body:{policyId:approved.id,policyHash:hash,candidate:{...scope,price:'24',size:'1'},clientRequestId:'40000000-0000-4000-8000-000000000001'},sessionBinding};
  const live=await startPreflightController({nowMs:now,stored:[['pactway-preflight-pending-v1',JSON.stringify(livePending)]],respond:baseResponder({policy:approved})});
  assert.equal(live.get('result-step').hidden,false);assert.equal(live.get('uncertain').hidden,false);assert.equal(live.get('live-policy-step').hidden,true);assert.equal(live.get('view-live').getAttribute('aria-pressed'),'true');
  const replayPending={path:'/api/preflight/examples/within-limits',body:{clientRequestId:'40000000-0000-4000-8000-000000000002'},sessionBinding};
  const replay=await startPreflightController({nowMs:now,stored:[['pactway-preflight-pending-v1',JSON.stringify(replayPending)]],respond:baseResponder({policy:approved})});
  assert.equal(replay.get('result-step').hidden,false);assert.equal(replay.get('uncertain').hidden,false);assert.equal(replay.get('replays').hidden,false);assert.equal(replay.get('workflow-nav').hidden,true);assert.equal(replay.get('view-examples').getAttribute('aria-pressed'),'true');
});

test('a 401 clears progressive navigation and policy summary state',async()=>{
  let statusReads=0;const h=await startPreflightController({nowMs:now,respond:baseResponder({policy:approved,onRequest:request=>request.path==='/api/preflight/status'&&++statusReads>1?response({error:'SESSION_REQUIRED',inviteRequired:false},{status:401}):undefined})});
  assert.equal(h.get('workflow-summary').hidden,false);await h.fire('refresh-status');assert.equal(h.get('access').hidden,false);assert.equal(h.get('workflow-nav').hidden,true);assert.equal(h.get('workflow-summary').hidden,true);assert.equal(h.get('workflow-policy-summary').textContent,'');assert.equal(h.get('workflow-expiry').textContent,'');
});

test('uncertain retry and poll recovery never expose a previous cached verdict',async()=>{
  let posts=0,getFails=false;
  const h=await startPreflightController({nowMs:now,respond:baseResponder({policy:approved,onRequest:request=>{
    if(request.path==='/api/preflight/checks'&&request.method==='POST'){posts++;if(posts===1)return response(completed);if(posts===2)return {error:new Error('lost')};getFails=true;return response({...completed,state:'RUNNING',report:null},{status:202});}
    if(getFails&&request.path===`/api/preflight/checks/${completed.id}`)return {error:new Error('offline')};
  }})});
  h.fields.candidate.get('price').value='24.8';h.fields.candidate.get('size').value='4';await h.fire('candidate-form','submit');assert.equal(h.get('report').hidden,false);
  h.fields.candidate.get('price').value='24.7';await h.fire('candidate-form','submit');assert.equal(h.get('uncertain').hidden,false);assert.equal(h.get('report').hidden,true);assert.equal(h.get('result-empty').hidden,true);
  await h.fire('retry-pending');assert.equal(h.get('pending').hidden,false);await h.runTimerByDelay(1500);assert.equal(h.get('poll-recovery').hidden,false);assert.equal(h.get('report').hidden,true);assert.equal(h.get('result-empty').hidden,true);
});

test('a nested history-policy 401 cannot repopulate prior-session reconciliation state',async()=>{
  let fresh=false;
  const h=await startPreflightController({nowMs:now,respond:request=>{
    if(request.path==='/api/bootstrap')return response(boot(fresh?'csrf-new':'csrf-one'));
    if(request.path==='/api/preflight/status')return response(status);
    if(request.path==='/api/preflight/history')return response(fresh?{policies:[],checks:[]}:{policies:[approved],checks:[]});
    if(!fresh&&request.path===`/api/preflight/policies/${approved.id}`)return response({error:'SESSION_REQUIRED',inviteRequired:false},{status:401});
    if(request.path==='/api/session/join'){fresh=true;return response(boot('csrf-new'));}
    if(fresh&&request.path==='/api/preflight/policies'&&request.method==='POST')return {error:new Error('lost')};
  }});
  assert.equal(h.get('access').hidden,false);assert.equal(h.get('history-list').children.length,0);await h.fire('join');
  h.fields.policy.get('maxNotional').value='100';h.fields.policy.get('maxPrice').value='25';h.fields.policy.get('durationSeconds').value='600';await h.fire('policy-form','submit');
  const marker=JSON.parse(h.storage.get('pactway-preflight-policy-pending-v1'));assert.deepEqual(marker.knownPolicyIds,[]);
});

test('malformed completion retains the active id and exposes GET-only report recovery',async()=>{
  const running={...completed,state:'RUNNING',report:null},invalid={...completed,report:{...report,reportHash:'invalid'}};
  const h=await startPreflightController({nowMs:now,respond:baseResponder({policy:approved,onRequest:request=>{
    if(request.path==='/api/preflight/checks'&&request.method==='POST')return response(running,{status:202});
    if(request.path===`/api/preflight/checks/${completed.id}`)return response(invalid);
  }})});
  h.fields.candidate.get('price').value='24.8';h.fields.candidate.get('size').value='4';await h.fire('candidate-form','submit');await h.runTimerByDelay(1500);
  assert.equal(h.get('report').hidden,true);assert.equal(h.get('pending').hidden,true);assert.equal(h.get('poll-recovery').hidden,false);assert.match(h.storage.get('pactway-preflight-active-check-v1'),new RegExp(completed.id));assert.equal(h.calls.filter(call=>call.path==='/api/preflight/checks'&&call.method==='POST').length,1);
});

test('startup preserves a fast completed active report in its LIVE or REPLAY result view',async()=>{
  async function startWithActive(mode){
    const active={id:completed.id,mode,sessionBinding},done=mode==='REPLAY'?{...completed,mode,report:replayWithin}:completed;
    return startPreflightController({nowMs:now,stored:[['pactway-preflight-active-check-v1',JSON.stringify(active)]],respond:request=>{
      if(request.path==='/api/bootstrap')return response(boot('csrf-one'));
      if(request.path==='/api/preflight/status')return new Promise(resolve=>setImmediate(()=>resolve(response(status))));
      if(request.path==='/api/preflight/history')return response({policies:[approved],checks:[]});
      if(request.path===`/api/preflight/policies/${approved.id}`)return response(approved);
      if(request.path===`/api/preflight/checks/${completed.id}`)return response(done);
    }});
  }
  const live=await startWithActive('LIVE_READ_ONLY');assert.equal(live.get('report').hidden,false);assert.equal(live.get('result-step').hidden,false);assert.equal(live.get('live-candidate-step').hidden,true);assert.equal(live.get('report-mode').textContent,'LIVE_READ_ONLY · salt okunur');
  const replay=await startWithActive('REPLAY');assert.equal(replay.get('report').hidden,false);assert.equal(replay.get('result-step').hidden,false);assert.equal(replay.get('replays').hidden,false);assert.equal(replay.get('report-mode').textContent,'REPLAY · kayıtlı örnek');
});
