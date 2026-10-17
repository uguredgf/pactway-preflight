// Controller behavior only: no real provider, browser, model or network calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import {startController} from './support/app-controller.mjs';

const status={executionMode:'fixture',extractorAvailable:false,safety:{paused:false},
  atk:{state:'READ_ONLY_CONNECTED',marketReadAvailable:true,orderSubmissionEnabled:false}};
const boot=csrf=>({csrf,status,tasks:[],drafts:[]});
const reply=body=>({body});
const observation={state:'LIVE_READ_ONLY',source:'OKX_TR_DEMO_ATK',instrument:'AVAX-USDT',bid:'24.95',ask:'25.05',last:'25',spread:'0.10',
  exchangeTimestampMs:1000,observedAtMs:1001,ageMs:1,freshness:'EXCHANGE_TIMESTAMP_CHECKED',cached:false,
  evidence:'JOURNALLED_AND_VALIDATED',orderSubmissionEnabled:false,executionMode:'fixture'};

async function setup(marketReply){
  return startController({respond:r=>r.path==='/api/bootstrap' || r.path==='/api/work'?reply(boot('market-csrf')):
    r.path==='/api/status'?reply(status):r.path==='/api/market/refresh'?marketReply(r):undefined});
}

test('read-only market observation is explicit, authenticated and never mutates task fields',async()=>{
  const h=await setup(()=>reply(observation));
  const original=h.get('policy-form').elements.namedItem('maxPrice').value;
  await h.fire('market-refresh','click');
  const request=h.calls.find(r=>r.path==='/api/market/refresh');
  assert.equal(request.method,'POST');assert.equal(request.headers['X-MG-CSRF'],'market-csrf');assert.equal(request.body,'{}');
  assert.equal(h.get('market-values').hidden,false);assert.equal(h.get('market-bid').textContent,'24,95 USDT');
  assert.match(h.get('market-evidence').textContent,/emir yetkisi yok/);
  assert.equal(h.get('policy-form').elements.namedItem('maxPrice').value,original);
});

test('untrusted or failed refresh removes the previous observation instead of leaving stale prices',async()=>{
  let attempt=0;
  const h=await setup(()=>++attempt===1?reply(observation):reply({...observation,orderSubmissionEnabled:true}));
  await h.fire('market-refresh','click');assert.equal(h.get('market-values').hidden,false);
  await h.fire('market-refresh','click');
  assert.equal(h.get('market-values').hidden,true);assert.equal(h.get('market-evidence').hidden,true);
  assert.match(h.get('market-status').textContent,/doğrulanamadı.*gösterilmiyor/);
});

test('stale, future-skewed and internally inconsistent quotes are rejected',async()=>{
  for(const invalid of [
    {...observation,ageMs:10001},
    {...observation,exchangeTimestampMs:4000,observedAtMs:4000,ageMs:0},
    {...observation,ask:'24.90'},
    {...observation,spread:'0.11'},
    {...observation,last:'0'}
  ]){
    const h=await setup(()=>reply(invalid));
    await h.fire('market-refresh','click');
    assert.equal(h.get('market-values').hidden,true);
    assert.match(h.get('market-status').textContent,/doğrulanamadı.*gösterilmiyor/);
  }
});

test('a displayed quote expires as server-referenced time advances',async()=>{
  const h=await setup(()=>reply(observation));
  await h.fire('market-refresh','click');assert.equal(h.get('market-values').hidden,false);
  h.tick(11000);
  assert.equal(h.get('market-values').hidden,true);assert.equal(h.get('market-evidence').hidden,true);
  assert.match(h.get('market-status').textContent,/10 saniyeyi geçti/);
});

test('disconnect and a late response from a replaced session cannot expose an old quote',async()=>{
  let resolveMarket,expired=false;
  const response=new Promise(resolve=>{resolveMarket=resolve;});
  const h=await startController({respond:r=>r.path==='/api/bootstrap' || r.path==='/api/work'?reply(boot('old-csrf')):
    r.path==='/api/status' && expired?{status:401,body:{error:'Expired',inviteRequired:false}}:
    r.path==='/api/status'?reply(status):r.path==='/api/session/join'?reply(boot('new-csrf')):
    r.path==='/api/market/refresh'?response:undefined});
  const pending=h.fire('market-refresh','click');await h.flush();expired=true;await h.poll();await h.fire('join-form','submit');
  resolveMarket(reply(observation));await pending;
  assert.equal(h.get('market-values').hidden,true);assert.equal(h.get('market-evidence').hidden,true);
  await h.window.fire('offline');assert.match(h.get('market-status').textContent,/Bağlantı doğrulanamadı/);
});
