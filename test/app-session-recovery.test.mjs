// Controller behavior only: no real browser, cookies, provider, or network.
import test from 'node:test';
import assert from 'node:assert/strict';
import {startController} from './support/app-controller.mjs';

const status={executionMode:'fixture',extractorAvailable:false,safety:{paused:false},accessMode:'INVITED_VISITORS'};
const boot=(csrf='initial-csrf')=>({csrf,status,tasks:[],drafts:[]});
const reply=body=>({body});
const expired=()=>({status:401,body:{error:'Oturum sona erdi.',inviteRequired:true}});
const posts=h=>h.calls.filter(r=>r.method==='POST');
async function setup(respond=()=>undefined){
  return startController({respond:r=>respond(r)??(
    r.path==='/api/bootstrap' || r.path==='/api/work'?reply(boot()):r.path==='/api/status'?reply(status):undefined)});
}

test('in-flight logout stays locked across polling and prevents new draft creation',async()=>{
  let resolveLeave;
  const response=new Promise(resolve=>{resolveLeave=resolve;});
  const h=await setup(r=>r.path==='/api/session/leave'?response:undefined);
  const leaving=h.fire('leave-session','click');await h.flush();await h.poll();
  assert.equal(h.get('leave-session').disabled,true);
  assert.equal(h.get('draft-button').disabled,true);
  await h.fire('policy-form','submit');assert.equal(posts(h).length,1);
  const repeat=h.fire('leave-session','click');await h.flush();assert.equal(posts(h).length,1);
  resolveLeave(reply({ok:true}));await Promise.all([leaving,repeat]);
  assert.equal(h.get('visitor-access').hidden,false);
  assert.match(h.get('notice').textContent,/Etkin oturum yok/);
  assert.doesNotMatch(h.get('notice').textContent,/Çıkış isteği bekleniyor/);
});

test('late logout response cannot log out a newly joined session after expiry',async()=>{
  let resolveLeave;
  const response=new Promise(resolve=>{resolveLeave=resolve;});
  const h=await setup(r=>{
    if(r.path==='/api/session/leave')return response;
    if(r.path==='/api/status')return expired();
    if(r.path==='/api/session/join')return reply(boot('new-csrf'));
  });
  const leaving=h.fire('leave-session','click');await h.flush();await h.poll();
  await h.fire('join-form','submit');
  assert.equal(h.get('visitor-access').hidden,true);
  resolveLeave(reply({ok:true}));await leaving;
  assert.equal(h.get('visitor-access').hidden,true);
  assert.equal(h.get('setup').hidden,false);
  assert.doesNotMatch(h.get('toast').textContent,/Oturum kapatıldı/);
});

test('lost logout with a still-readable session keeps new work locked until explicit retry',async()=>{
  let attempts=0;
  const h=await setup(r=>r.path==='/api/session/leave'?
    (++attempts===1?{error:Error('Lost')}:reply({ok:true})):undefined);
  await h.fire('leave-session','click');await h.poll();
  assert.equal(h.get('visitor-access').hidden,true);
  assert.equal(h.get('draft-button').disabled,true);
  assert.equal(h.get('leave-session').disabled,false);
  assert.match(h.get('notice').textContent,/Çıkış.*doğrulanmadı/);
  assert.equal(posts(h).length,1);
  await h.fire('leave-session','click');assert.equal(posts(h).length,2);
  assert.equal(h.get('visitor-access').hidden,false);
});

test('lost logout followed by authenticated 401 clears private UI without false success toast',async()=>{
  const h=await setup(r=>r.path==='/api/session/leave'?{error:Error('Lost')}:
    r.path==='/api/status'?expired():undefined);
  await h.fire('leave-session','click');await h.poll();
  assert.equal(h.get('visitor-access').hidden,false);assert.equal(h.get('setup').hidden,true);
  assert.match(h.get('notice').textContent,/Etkin oturum yok/);
  assert.doesNotMatch(h.get('toast').textContent,/Oturum kapatıldı/);assert.equal(posts(h).length,1);
});

test('definitive logout refusal retains the session and does not retry automatically',async()=>{
  const h=await setup(r=>r.path==='/api/session/leave'?{status:409,body:{error:'Açık emir uzlaştırılmalı.'}}:undefined);
  await h.fire('leave-session','click');await h.poll();
  assert.equal(h.get('visitor-access').hidden,true);assert.equal(h.get('draft-button').disabled,false);
  assert.match(h.get('action-error-copy').textContent,/Açık emir/);assert.equal(posts(h).length,1);
});

test('repeated join submissions send one request and keep the button locked',async()=>{
  let resolveJoin;
  const response=new Promise(resolve=>{resolveJoin=resolve;});
  const h=await setup(r=>r.path==='/api/bootstrap'?expired():r.path==='/api/session/join'?response:undefined);
  const first=h.fire('join-form','submit');await h.flush();
  const second=h.fire('join-form','submit');await h.flush();
  assert.equal(posts(h).length,1);assert.equal(h.get('join-button').disabled,true);
  resolveJoin(reply(boot()));await Promise.all([first,second]);
  assert.equal(h.get('visitor-access').hidden,true);
});

test('lost join never claims success or automatically retries during polling',async()=>{
  const h=await setup(r=>r.path==='/api/bootstrap'?expired():
    r.path==='/api/session/join'?{error:Error('Lost')}:undefined);
  await h.fire('join-form','submit');await h.poll();
  assert.equal(h.get('visitor-access').hidden,false);
  assert.match(h.get('join-error').textContent,/sonuç bilinmiyor/);
  assert.equal(h.get('join-button').disabled,false);assert.equal(posts(h).length,1);
});

test('late failed read from the previous session cannot mark the new session offline',async()=>{
  let resolveRead;
  const response=new Promise(resolve=>{resolveRead=resolve;});
  const h=await setup(r=>{
    if(r.path==='/api/work')return response;
    if(r.path==='/api/session/leave')return reply({ok:true});
    if(r.path==='/api/session/join')return reply(boot('new-csrf'));
  });
  await h.fire('refresh-work','click');await h.fire('leave-session','click');await h.fire('join-form','submit');
  resolveRead({error:Error('Old connection failed')});await h.flush();
  assert.match(h.get('connection').textContent,/^Uygulama bağlı/);
  assert.equal(h.get('draft-button').disabled,false);
});

test('late failed logout cannot change new session status or its CSRF token',async()=>{
  let resolveLeave,leaves=0,expiredOld=false;
  const response=new Promise(resolve=>{resolveLeave=resolve;});
  const h=await setup(r=>{
    if(r.path==='/api/session/leave')return ++leaves===1?response:reply({ok:true});
    if(r.path==='/api/status' && expiredOld)return expired();
    if(r.path==='/api/session/join')return reply(boot('replacement-csrf'));
  });
  const first=h.fire('leave-session','click');await h.flush();expiredOld=true;await h.poll();
  await h.fire('join-form','submit');
  resolveLeave({error:Error('Old logout lost')});await first;
  assert.match(h.get('connection').textContent,/^Uygulama bağlı/);
  assert.equal(h.get('draft-button').disabled,false);
  await h.fire('leave-session','click');
  assert.equal(posts(h).at(-1).headers['X-MG-CSRF'],'replacement-csrf');
});

test('a refusal after an earlier lost logout does not erase the earlier uncertainty',async()=>{
  let attempts=0;
  const h=await setup(r=>r.path==='/api/session/leave'?
    (++attempts===1?{error:Error('Lost')}:{status:409,body:{error:'Still unresolved'}}):undefined);
  await h.fire('leave-session','click');await h.poll();await h.fire('leave-session','click');
  assert.match(h.get('notice').textContent,/Çıkış sonucu doğrulanmadı/);
  assert.equal(h.get('draft-button').disabled,true);assert.equal(posts(h).length,2);
});
