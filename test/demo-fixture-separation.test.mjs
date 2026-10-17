// Not run. No SDK, server, credentials or network; local collaborator stubs only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {Engine} from '../src/engine.mjs';

function fixture(intentState) {
  const task={id:'demo',mode:'demo-prepared',policy:{executionMode:'demo-prepared'},
    ledger:{phase:'RUNNING',stopRequested:false,intents:[{id:'intent',state:intentState,settled:false}]}};
  let writes=0;
  const store={get:()=>structuredClone(task),update:(_id,operation)=>{writes++;operation(task);},
    captureObservation:()=>{writes++;throw new Error('Fixture journal must not be reached');}};
  const engine=new Engine(store,{});
  engine.view=()=>structuredClone(task);
  return {task,engine,writes:()=>writes};
}
test('fixture controls cannot manufacture demo fills or release demo reserves',()=>{
  const f=fixture('OPEN');
  for(const kind of ['partial','unknown','confirm-cancel'])assert.throws(()=>f.engine.scenario('demo',kind));
  assert.throws(()=>f.engine.observeFill('demo','intent',{feesComplete:true}));
  assert.equal(f.writes(),0);
});
test('demo stop preserves uncertainty and exchange state until dedicated reconciliation',()=>{
  for(const state of ['UNKNOWN','SUBMITTING','OPEN','PARTIAL','CANCEL_PENDING']) {
    const f=fixture(state);f.engine.stop('demo');
    assert.equal(f.task.ledger.stopRequested,true);
    assert.equal(f.task.ledger.phase,'STOP_REQUESTED');
    assert.equal(f.task.ledger.intents[0].state,state);
    assert.equal(f.task.ledger.intents[0].settled,false);
    assert.equal(f.writes(),1);
  }
});
