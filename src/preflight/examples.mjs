import {approvePolicy,createPolicy,evaluatePreflight} from './domain.mjs';

const CHECKED_AT_MS=1792231200000; // 2026-10-17T10:00:00.000Z
const BINDING=Object.freeze({accountId:'replay-account',catalogHash:'a'.repeat(64),connectionHash:'b'.repeat(64),
  isolatedEntrySha256:'c'.repeat(64),sessionId:'replay-session'});
const policyInput=Object.freeze({instrument:'AVAX-USDT',side:'buy',tdMode:'cash',ordType:'limit',
  maxNotional:'25',maxPrice:'25',durationSeconds:'600'});
const candidate=price=>Object.freeze({instrument:'AVAX-USDT',side:'buy',tdMode:'cash',ordType:'limit',price,size:'0.4'});
const evidence=observedAtMs=>Object.freeze({
  ticker:Object.freeze({sourceObservationId:'replay-ticker',sourcePayloadHash:'d'.repeat(64),binding:BINDING,
    observedAtMs,exchangeTimestampMs:observedAtMs,referencePrice:'24.95',reference:'BEST_ASK'}),
  instrument:Object.freeze({sourceObservationId:'replay-instrument',sourcePayloadHash:'e'.repeat(64),binding:BINDING,
    observedAtMs,instrument:Object.freeze({instId:'AVAX-USDT',instType:'SPOT',baseCcy:'AVAX',quoteCcy:'USDT',state:'live',
      tickSz:'0.01',lotSz:'0.01',minSz:'0.1',maxLmtSz:'1000'})}),
});

export const REPLAY_EXAMPLES=Object.freeze(['within-limits','limit-breach','stale-evidence']);

export function runReplayExample(name) {
  if(!REPLAY_EXAMPLES.includes(name))throw new RangeError('PREFLIGHT_REPLAY_NAME');
  const draft=createPolicy(policyInput,`replay-${name}`,CHECKED_AT_MS-1000);
  const policyRecord=approvePolicy(draft,draft.policyHash,CHECKED_AT_MS-1000);
  const price=name==='limit-breach'?'25.01':'25';
  const observedAtMs=name==='stale-evidence'?CHECKED_AT_MS-10001:CHECKED_AT_MS-1000;
  return evaluatePreflight({mode:'REPLAY',policyRecord,candidate:candidate(price),evidence:evidence(observedAtMs),
    agentTrace:{plannerKind:'replay',plan:{tools:[]},modelCallCount:0,failureCode:null},checkedAtMs:CHECKED_AT_MS});
}
