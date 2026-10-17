import {performance} from 'node:perf_hooks';
import {LOCAL_MODEL} from './lib/local-model-setup.mjs';
import {PreflightAgentReviewer} from '../src/preflight/agent-reviewer.mjs';
import {approvePolicy,createPolicy,evaluatePreflight} from '../src/preflight/domain.mjs';

const CHECKED_AT_MS=1792231200000;
const FORBIDDEN_PROMPT_FIELDS=['binding','bindingHash','sourceObservationId','sourcePayloadHash','evidenceHash',
  'reportHash','accountId','sessionId','apiKey','credential','secret','password'];
const EXPECTED_PROMPT_FIELDS=['attempt','currentCandidate','initialCandidate','market','policy','report','serverDerived'];
const policyInput={instrument:'AVAX-USDT',side:'buy',tdMode:'cash',ordType:'limit',
  maxNotional:'25',maxPrice:'25',durationSeconds:'600'};
const binding={accountId:'fixture-account',catalogHash:'a'.repeat(64),connectionHash:'b'.repeat(64),
  isolatedEntrySha256:'c'.repeat(64),sessionId:'fixture-session'};
const evidence={
  ticker:{sourceObservationId:'fixture-ticker',sourcePayloadHash:'d'.repeat(64),binding,
    observedAtMs:CHECKED_AT_MS-1000,exchangeTimestampMs:CHECKED_AT_MS-1000,
    referencePrice:'24.95',reference:'BEST_ASK'},
  instrument:{sourceObservationId:'fixture-instrument',sourcePayloadHash:'e'.repeat(64),binding,
    observedAtMs:CHECKED_AT_MS-1000,instrument:{instId:'AVAX-USDT',instType:'SPOT',baseCcy:'AVAX',
      quoteCcy:'USDT',state:'live',tickSz:'0.01',lotSz:'0.01',minSz:'0.1',maxLmtSz:'1000'}},
};
const candidate=(price,size)=>({instrument:'AVAX-USDT',side:'buy',tdMode:'cash',ordType:'limit',price,size});
const cases=[
  {name:'allow',candidate:candidate('25','0.4'),expectedAction:'ACCEPT'},
  {name:'offgrid-overcap',candidate:candidate('25.009','0.4'),expectedAction:'REVISE'},
  {name:'impossible-below-min',candidate:candidate('24.95','0.05'),expectedAction:'WAIT'},
];

const draft=createPolicy(policyInput,'fixture-local-agent-smoke',CHECKED_AT_MS-1000);
const policyRecord=approvePolicy(draft,draft.policyHash,CHECKED_AT_MS-1000);
let reservations=0,requests=0;

function inspectRequest(options) {
  const body=JSON.parse(options.body);
  if(body.model!==LOCAL_MODEL || body.stream!==false || body.think!==false || body.options?.temperature!==0
      || !Array.isArray(body.messages) || body.messages.length!==2 || body.messages[0]?.role!=='system'
      || body.messages[1]?.role!=='user')throw new Error('PREFLIGHT_AGENT_SMOKE_MODEL_ARGUMENTS');
  const prompt=body.messages[1].content,parsed=JSON.parse(prompt);
  if(Object.keys(parsed).sort().join(',')!==EXPECTED_PROMPT_FIELDS.join(','))
    throw new Error('PREFLIGHT_AGENT_SMOKE_PROMPT_FIELDS');
  const encoded=JSON.stringify(parsed);
  if(FORBIDDEN_PROMPT_FIELDS.some(field=>encoded.toLowerCase().includes(field.toLowerCase())))
    throw new Error('PREFLIGHT_AGENT_SMOKE_PROMPT_LEAK');
}

const reviewer=new PreflightAgentReviewer({model:LOCAL_MODEL,reserveCall:()=>{reservations++;return true;},
  fetchImpl:async(url,options)=>{requests++;inspectRequest(options);return fetch(url,options);}});

const results=[];
for(const item of cases) {
  const report=evaluatePreflight({mode:'REPLAY',policyRecord,candidate:item.candidate,evidence,
    agentTrace:{plannerKind:'replay',plan:{tools:[]},modelCallCount:0,failureCode:null},checkedAtMs:CHECKED_AT_MS});
  const started=performance.now();
  try {
    const response=await reviewer.review({checkId:`fixture-smoke-${item.name}`,ownerId:'fixture-smoke-owner',
      policyRecord,initialCandidate:item.candidate,currentCandidate:item.candidate,report,attempt:1});
    results.push({case:item.name,independentVerdict:report.verdict,independentReasonCodes:report.reasonCodes,
      expectedAction:item.expectedAction,response,matched:response.action===item.expectedAction,
      latencyMs:Math.round(performance.now()-started)});
  } catch(error) {
    results.push({case:item.name,independentVerdict:report.verdict,independentReasonCodes:report.reasonCodes,
      expectedAction:item.expectedAction,errorCode:error?.code??'PREFLIGHT_AGENT_SMOKE_FAILED',matched:false,
      latencyMs:Math.round(performance.now()-started)});
  }
}

const passed=results.every(result=>result.matched) && reservations===cases.length && requests===cases.length;
console.log(JSON.stringify({proofSource:'FIXTURE_MARKET_PROOF',modelExecution:'REAL_LOCAL_OLLAMA',liveATK:false,
  model:LOCAL_MODEL,sanitizedPromptVerified:true,results,reservations,requests,passed},null,2));
if(!passed)process.exitCode=1;
