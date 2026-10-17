// Controller behavior only: no live chain, provider, browser or network calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import {startController} from './support/app-controller.mjs';

const failed={state:'DEPLOYMENT_VERIFICATION_FAILED',acceptanceTest:{state:'VERIFICATION_FAILED'}};
const verified={state:'DEPLOYMENT_VERIFIED',acceptanceTest:{state:'VERIFIED'}};
const status={executionMode:'fixture',extractorAvailable:false,safety:{paused:false},avalanche:failed};
const boot=csrf=>({csrf,status:{...status,avalanche:{...status.avalanche}},tasks:[],drafts:[]});
const reply=body=>({body});

test('Fuji retry is explicit, CSRF-bound and hides after verified evidence',async()=>{
  const h=await startController({respond:r=>r.path==='/api/bootstrap' || r.path==='/api/work'?reply(boot('fuji-csrf')):
    r.path==='/api/status'?reply(status):r.path==='/api/avalanche/refresh'?reply({avalanche:verified}):undefined});
  assert.equal(h.get('fuji-refresh').hidden,false);await h.fire('fuji-refresh','click');
  const request=h.calls.find(r=>r.path==='/api/avalanche/refresh');
  assert.equal(request.method,'POST');assert.equal(request.headers['X-MG-CSRF'],'fuji-csrf');assert.equal(request.body,'{}');
  assert.equal(request.signal.timeoutMs,30000);
  assert.match(h.get('fuji-state').textContent,/kontratı doğrulandı/);assert.equal(h.get('fuji-refresh').hidden,true);
});

test('late Fuji response from an expired session cannot update the replacement session',async()=>{
  let resolveFuji,expired=false;
  const response=new Promise(resolve=>{resolveFuji=resolve;});
  const h=await startController({respond:r=>r.path==='/api/bootstrap' || r.path==='/api/work'?reply(boot('old-csrf')):
    r.path==='/api/status' && expired?{status:401,body:{error:'Expired',inviteRequired:false}}:
    r.path==='/api/status'?reply(status):r.path==='/api/session/join'?reply(boot('new-csrf')):
    r.path==='/api/avalanche/refresh'?response:undefined});
  const pending=h.fire('fuji-refresh','click');await h.flush();expired=true;await h.poll();await h.fire('join-form','submit');
  resolveFuji(reply({avalanche:verified}));await pending;
  assert.match(h.get('fuji-state').textContent,/doğrulanamadı/);assert.equal(h.get('fuji-refresh').hidden,false);
});
