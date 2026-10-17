import test from 'node:test';
import assert from 'node:assert/strict';
import {FUJI_PROFILE,fujiEnvironment} from '../src/audit/fuji-deployment-profile.mjs';
import {selectedFujiArtifact,verifySelectedFuji} from '../scripts/lib/verify-selected-fuji.mjs';
import {compileRegistry,addressWord,expectedRuntime} from '../scripts/lib/fuji-build.mjs';
import {prepareFujiPublication} from '../scripts/lib/fuji-publication.mjs';
import {createTaskId,createPolicyCommitment,createDecisionReceipt} from '../src/audit/commitments.mjs';

test('explicit Fuji profile pins the approved CRLF source and unoptimized build',async()=>{
  const artifact=await selectedFujiArtifact();
  assert.equal(artifact.sourceSha256,FUJI_PROFILE.sourceSha256);
  assert.deepEqual(artifact.settings.optimizer,{enabled:false,runs:200});
  assert.equal(artifact.buildProfile,'remix-unoptimized-crlf');
  assert.notEqual(artifact.bytecode,(await compileRegistry()).artifact.bytecode);
  await assert.rejects(compileRegistry({profile:'anything'}),/PROFILE_INVALID/);
  assert.deepEqual(fujiEnvironment({MG_FUJI_PROFILE:FUJI_PROFILE.id}),{});
  assert.deepEqual(fujiEnvironment({PACTWAY_FUJI_PROFILE:FUJI_PROFILE.id}),{MG_FUJI_PROFILE:FUJI_PROFILE.id});
  assert.throws(()=>fujiEnvironment({PACTWAY_FUJI_PROFILE:'mainnet'}),/PROFILE_INVALID/);
});

test('selected deployment verifies read-only and rejects a different contract',async()=>{
  const artifact=await selectedFujiArtifact(),p=FUJI_PROFILE,blockHash='0x'+'ab'.repeat(32),blockNumber='0x12';
  let address=p.contractAddress;
  const fetchImpl=async(url,options)=>{
    assert.equal(url,'https://api.avax-test.network/ext/bc/C/rpc');
    const {method,id}=JSON.parse(options.body);
    const values={eth_chainId:'0xa869',
      eth_getTransactionReceipt:{transactionHash:p.transactionHash,from:p.owner,to:null,contractAddress:address,blockHash,blockNumber,status:'0x1'},
      eth_getTransactionByHash:{hash:p.transactionHash,from:p.owner,to:null,value:'0x0',blockHash,blockNumber,input:artifact.bytecode+addressWord(p.recorder)},
      eth_getBlockByNumber:{hash:blockHash,number:blockNumber,transactions:[p.transactionHash]},
      eth_getCode:expectedRuntime(artifact,p),eth_call:'0x'+addressWord(p.owner)};
    assert.ok(Object.hasOwn(values,method));
    return new Response(JSON.stringify({jsonrpc:'2.0',id,result:values[method]}));
  };
  assert.equal((await verifySelectedFuji({fetchImpl})).verified,true);
  address='0x'+'11'.repeat(20);
  await assert.rejects(verifySelectedFuji({fetchImpl}),/SELECTED_DEPLOYMENT_UNVERIFIED/);
});

function audit() {
  const policyCommitment=createPolicyCommitment({taskId:createTaskId('fixture-publication-test'),policy:{mode:'fixture'}});
  const receipt=createDecisionReceipt({...policyCommitment,sequence:1,decision:{kind:'APPROVED',mode:'fixture'}});
  return {policyCommitment,receipts:[receipt],expectedHead:{sequence:'1',receiptHash:receipt.receiptHash}};
}
test('publication is stable unsigned zero-value calldata for the selected registry, with preserved audit',async()=>{
  const source=audit(),bundle=await prepareFujiPublication(source),artifact=await selectedFujiArtifact();
  assert.deepEqual(bundle,await prepareFujiPublication(source));
  assert.equal(bundle.state,'UNSIGNED_NOT_PUBLISHED');assert.deepEqual(bundle.audit,source);
  for(const call of [bundle.commitPolicy,bundle.appendDecision]) {
    assert.equal(call.chainId,43113);assert.equal(call.to,FUJI_PROFILE.contractAddress);
    assert.equal(call.from,FUJI_PROFILE.owner);assert.equal(call.value,'0x0');
  }
  assert.equal(bundle.commitPolicy.data,'0x'+artifact.methodIdentifiers['commitPolicy(bytes32,bytes32)']+source.policyCommitment.taskId.slice(2)+source.policyCommitment.policyHash.slice(2));
  assert.equal(bundle.appendDecision.data.length,2+8+64*5);
  assert.equal(bundle.appendDecision.data.slice(74,138),'1'.padStart(64,'0'));
  source.receipts[0].source.decision.kind='TAMPERED';
  assert.equal(bundle.firstReceipt.source.decision.kind,'APPROVED');
});
test('tampering, missing head, missing tail and credential-bearing sources cannot be prepared',async()=>{
  const original=audit();
  for(const mutate of [a=>{a.receipts[0].source.decision.kind='changed';},a=>{delete a.expectedHead;},
    a=>{a.receipts=[];},a=>{a.expectedHead.sequence='2';},a=>{a.policyCommitment.source.policy.apiKey='never';}]) {
    const copy=structuredClone(original);mutate(copy);await assert.rejects(prepareFujiPublication(copy));
  }
});
