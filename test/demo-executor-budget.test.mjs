// Source added only; not executed. All collaborators below are local stubs.
import test from 'node:test';
import assert from 'node:assert/strict';
import {DemoExecutor} from '../src/demo-executor.mjs';

function fixture(attempts) {
  const events=[];
  const state={id:'task',mode:'demo-prepared',submission:{intentId:'intent'},
    ledger:{intents:[{id:'intent',settled:false}]},demoPoll:{attempts,atMs:0}};
  const store={
    get:()=>structuredClone(state),
    update:(_id,operation)=>{operation(state);events.push('persist');},
    pauseGlobal:()=>{events.push('pause');},
  };
  const client={callJournalledRead:async()=>{events.push('read');throw new Error('STOP_AT_IDENTITY');}};
  return {state,events,executor:new DemoExecutor(store,client)};
}
test('poll budget is persisted before IO and the final pass activates safety',async()=>{
  for(const attempts of [0,119]) {
    const f=fixture(attempts);
    await assert.rejects(f.executor.poll('task'),/STOP_AT_IDENTITY/);
    assert.equal(f.state.demoPoll.attempts,attempts+1);
    assert.deepEqual(f.events,attempts===119?['persist','pause','read']:['persist','read']);
    await f.executor.close();
  }
});
test('exhausted and throttled polling cannot start another IO operation',async()=>{
  const exhausted=fixture(120);
  assert.equal((await exhausted.executor.poll('task')).code,'DEMO_OPERATOR_REVIEW_REQUIRED');
  assert.deepEqual(exhausted.events,[]);
  const throttled=fixture(1);throttled.state.demoPoll.atMs=Date.now();
  assert.equal((await throttled.executor.poll('task')).code,'DEMO_POLL_THROTTLED');
  assert.deepEqual(throttled.events,[]);
  await exhausted.executor.close();await throttled.executor.close();
});
test('demo proposal never falls back to a fixture planner',async()=>{
  let calls=0;
  const executor=new DemoExecutor({}, {},{planner:{kind:'fixture',async propose(){calls++;}}});
  await assert.rejects(executor.propose('task'),{code:'DEMO_MODEL_NOT_CONFIGURED'});
  assert.equal(calls,0);await executor.close();
});
