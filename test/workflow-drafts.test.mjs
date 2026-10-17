// Acceptance sources only: not executed. Provider responses are local stubs.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/persistence/store.mjs';
import {Engine} from '../src/engine.mjs';
import {FixturePlanner,PolicyPlanner} from '../src/planner.mjs';
import {OpenAIDraftExtractor} from '../src/extractor.mjs';
import {inspectDraftText} from '../src/domain/draft-fields.mjs';
import {hashCanonical} from '../src/domain/governor.mjs';
import {decodeRecoverySnapshot} from '../src/persistence/recovery-format.mjs';

const owner='local-operator';
const text='AVAX-USDT spot limit alım; bütçe 100 USDT; tek emir 25 USDT; birim fiyat 25 USDT/AVAX; AVAX payı %10; süre 10 dakika';
const fields={budget:'100',singleOrderNotionalMax:'25',maxPrice:'25',maxSharePercent:'10',durationSeconds:'600'};
const result=source=>{const {fields,unsupported}=inspectDraftText(source);return {fields,unsupported};};
const response=value=>new Response(JSON.stringify({status:'completed',output:[{type:'message',role:'assistant',status:'completed',
  content:[{type:'output_text',text:JSON.stringify(value)}]}]}));
function setup(fetchImpl=async()=>response(result(text))) {
  const directory=mkdtempSync(join(tmpdir(),'pactway-workflow-')),store=new Store(directory);
  const extractor=new OpenAIDraftExtractor({apiKey:'test-only-key-never-real',reserveCall:u=>store.reserveOwnedModelCall(100,u),fetchImpl});
  const engine=new Engine(store,new FixturePlanner(),{extractor});
  return {store,engine,directory,close(){store.close();rmSync(directory,{recursive:true,force:true});}};
}
test('extraction, edits and task transfer retain one workflow and its total-three quota',async()=>{
  const f=setup();
  try {
    const draft=f.engine.draft({text});
    assert.equal(draft.ready,false);assert.equal(draft.policy,null);
    const extracted=await f.engine.drafts.extract(owner,draft.id,{expectedRevision:draft.revision});
    assert.equal(extracted.ready,true);assert.deepEqual(extracted.fields,fields);
    assert.equal(extracted.usage.extraction,1);
    assert.throws(()=>f.engine.drafts.get('another-owner',draft.id),{code:'DRAFT_NOT_FOUND'});
    const edited=f.engine.drafts.edit(owner,draft.id,{expectedRevision:extracted.revision,fields:{maxPrice:'24'}});
    assert.equal(edited.workflowId,draft.id);assert.equal(edited.usage.total,1);
    assert.equal(edited.policy.expiresAtMs,extracted.policy.expiresAtMs);
    assert.notEqual(edited.policyHash,extracted.policyHash);
    assert.throws(()=>f.engine.approve({draftId:draft.id,policyHash:extracted.policyHash,acknowledgement:true}));
    const task=f.engine.approve({draftId:edited.id,policyHash:edited.policyHash,acknowledgement:true});
    assert.equal(task.policy.workflowId,draft.id);
    assert.equal(f.store.policyWorkflow(draft.id,owner).taskId,task.id);
    const usage={workflowId:draft.id,ownerId:owner,taskId:task.id,purpose:'proposal'};
    assert.equal(f.store.reserveOwnedModelCall(100,usage),true);
    assert.equal(f.store.reserveOwnedModelCall(100,usage),true);
    assert.equal(f.store.reserveOwnedModelCall(100,usage),false);
    assert.deepEqual({...f.store.modelWorkflowUsage(draft.id)},{total:3,extraction:1,proposal:2});
    assert.throws(()=>f.engine.drafts.edit(owner,draft.id,{expectedRevision:edited.revision,fields:{budget:'200'}}));
  } finally {f.close();}
});
test('unsupported conditions need explicit removal and missing units are never inferred',async()=>{
  const source='bütçe 100; tek emir 25 USDT; birim fiyat 25 USDT/AVAX; AVAX payı %10; günlük zarar %2';
  const f=setup(async()=>response(result(source)));
  try {
    const draft=f.engine.draft({text:source});
    const extracted=await f.engine.drafts.extract(owner,draft.id,{expectedRevision:draft.revision});
    assert.deepEqual(extracted.missing,['budget','durationSeconds']);
    assert.deepEqual(extracted.unresolved,['bütçe 100','günlük zarar %2']);
    assert.equal(extracted.ready,false);
    const edited=f.engine.drafts.edit(owner,draft.id,{expectedRevision:extracted.revision,fields:{budget:'100',durationSeconds:'600'}});
    assert.equal(edited.ready,false);
    const reviewed=f.engine.drafts.edit(owner,draft.id,{expectedRevision:edited.revision,removeConditions:edited.unresolved});
    assert.equal(reviewed.ready,true);assert.equal(reviewed.originalText,source);assert.equal(reviewed.usage.total,1);
  } finally {f.close();}
});
test('failed extraction consumes its slot; manual correction does not refund it',async()=>{
  let calls=0;const f=setup(async()=>{calls++;throw new Error('private-provider-response');});
  try {
    const draft=f.engine.draft({text});
    await assert.rejects(f.engine.drafts.extract(owner,draft.id,{expectedRevision:draft.revision}),{code:'EXTRACTION_NOT_APPLIED'});
    const failed=f.engine.drafts.get(owner,draft.id);
    assert.equal(failed.extractionState,'FAILED');assert.equal(failed.usage.total,1);
    assert.equal(JSON.stringify(failed).includes('private-provider-response'),false);
    await assert.rejects(f.engine.drafts.extract(owner,draft.id,{expectedRevision:failed.revision}));
    const edited=f.engine.drafts.edit(owner,draft.id,{expectedRevision:failed.revision,fields});
    assert.equal(edited.ready,true);assert.equal(edited.usage.total,1);assert.equal(calls,1);
  } finally {f.close();}
});
test('late extractor result cannot overwrite a concurrent edit',async()=>{
  let finish;const f=setup(()=>new Promise(resolve=>{finish=resolve;}));
  try {
    const draft=f.engine.draft({text}),pending=f.engine.drafts.extract(owner,draft.id,{expectedRevision:draft.revision});
    const running=f.engine.drafts.get(owner,draft.id);
    const edited=f.engine.drafts.edit(owner,draft.id,{expectedRevision:running.revision,fields:{...fields,maxPrice:'23'}});
    finish(response(result(text)));
    await assert.rejects(pending,{code:'EXTRACTION_NOT_APPLIED'});
    const latest=f.engine.drafts.get(owner,draft.id);
    assert.equal(latest.revision,edited.revision);assert.equal(latest.fields.maxPrice,'23');assert.equal(latest.usage.total,1);
  } finally {f.close();}
});
test('grounding refuses invented units, dropped clauses, tool fields and secret-like input',async()=>{
  const unknown=text+'; stop-loss %5';
  for(const value of [{...result(unknown),unsupported:[]},{...result(text),execute:true},
    {...result(text),fields:{...fields,budget:'999'}}]) {
    const f=setup(async()=>response(value));
    try {
      const draft=f.engine.draft({text:unknown});
      await assert.rejects(f.engine.drafts.extract(owner,draft.id,{expectedRevision:draft.revision}));
      assert.equal(f.engine.drafts.get(owner,draft.id).ready,false);
    } finally {f.close();}
  }
  const f=setup();
  try {
    const secretLike=['api_key=do-not-persist-this',JSON.stringify({apiKey:'not-a-real-credential'}),
      'OK-ACCESS-KEY: not-a-real-credential','seed phrase: not-a-real-recovery-value',
      'word '.repeat(11)+'word','0x'+'ab'.repeat(32)];
    for(const value of secretLike)assert.throws(()=>f.engine.draft({text:value}),{code:'DRAFT_SECRET_LIKE_TEXT'});
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM policy_workflows').get().n,0);
  } finally {f.close();}
});
test('policy snapshots are frozen and a planner cannot expand approved limits',async()=>{
  const f=setup();
  try {
    const draft=f.engine.draft(fields),before=hashCanonical(draft.policy);
    const planner=new PolicyPlanner({kind:'test',async propose(input){input.policy.budget='1000';return {action:'wait',reason:'wait'};}});
    await assert.rejects(planner.propose({policy:draft.policy,approvedPolicyHash:draft.policyHash}));
    assert.equal(hashCanonical(draft.policy),before);
  } finally {f.close();}
});
test('v3 recovery preserves owner/task binding and quota without resuming',async()=>{
  const f=setup(),target=setup();
  try {
    const draft=f.engine.draft({text});
    const extracted=await f.engine.drafts.extract(owner,draft.id,{expectedRevision:1});
    const task=f.engine.approve({draftId:draft.id,policyHash:extracted.policyHash,acknowledgement:true});
    f.store.pauseGlobal();const backup=f.store.exportRecoverySnapshot(Date.now());
    assert.equal(decodeRecoverySnapshot(backup).schemaVersion,4);
    target.store.restoreRecoverySnapshot(backup);
    assert.equal(target.store.policyWorkflow(draft.id,owner).taskId,task.id);
    assert.equal(target.store.modelWorkflowUsage(draft.id).total,1);
    assert.equal(target.store.globalSafetyStatus().paused,true);
    assert.throws(()=>target.store.reserveOwnedModelCall(100,{workflowId:draft.id,ownerId:owner,taskId:task.id,purpose:'proposal'}));
  } finally {target.close();f.close();}
});
test('v2 snapshots decode with no invented draft lineage',()=>{
  const f=setup();
  try {
    f.store.pauseGlobal();const {checksum,...body}=JSON.parse(f.store.exportRecoverySnapshot(Date.now()));
    body.schemaVersion=2;delete body.tables.policy_workflows;
    delete body.tables.preflight_policies;delete body.tables.preflight_checks;
    const decoded=decodeRecoverySnapshot(JSON.stringify({...body,checksum:hashCanonical(body)}));
    assert.deepEqual(decoded.tables.policy_workflows,[]);
  } finally {f.close();}
});
test('extractor sends no owner/workflow IDs and dispatches at most once',async()=>{
  let calls=0;
  const f=setup(async(url,options)=>{
    calls++;assert.equal(url,'https://api.openai.com/v1/responses');assert.equal(options.redirect,'error');
    const body=JSON.parse(options.body);
    assert.equal(body.store,false);assert.deepEqual(body.tools,[]);assert.equal(body.tool_choice,'none');
    assert.equal(body.text.format.strict,true);assert.equal(body.input[1].content,text);
    assert.equal(options.body.includes(owner),false);
    return response(result(text));
  });
  try {
    const draft=f.engine.draft({text});
    const extracted=await f.engine.drafts.extract(owner,draft.id,{expectedRevision:1});
    await assert.rejects(f.engine.drafts.extract(owner,draft.id,{expectedRevision:extracted.revision}));
    assert.equal(calls,1);assert.equal(extracted.usage.extraction,1);
  } finally {f.close();}
});
