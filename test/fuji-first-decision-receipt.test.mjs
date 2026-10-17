import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {FUJI_PROFILE} from '../src/audit/fuji-deployment-profile.mjs';
import {ZERO_HASH} from '../src/audit/commitments.mjs';
import {selectedFujiArtifact} from '../scripts/lib/verify-selected-fuji.mjs';
import {addressWord,expectedRuntime} from '../scripts/lib/fuji-build.mjs';
import {DECISION_RECORDED_TOPIC,verifyFujiFirstDecisionReceipt} from '../scripts/lib/fuji-first-decision-receipt.mjs';

const publication=JSON.parse(await readFile(new URL('../exports/fuji-publication-IDtXJk/publication.json',import.meta.url),'utf8'));
const artifact=await selectedFujiArtifact(),first=publication.firstReceipt;
const txHash='0x'+'a4'.repeat(32),blockHash='0x'+'b5'.repeat(32),blockNumber='0x345';
const deployBlockHash='0x'+'c6'.repeat(32),deployBlockNumber='0x123';
const sequenceTopic='0x'+'1'.padStart(64,'0');
const eventData=first.previousHash+first.eventDigest.slice(2);
const taskResult='0x'+first.policyHash.slice(2)+first.receiptHash.slice(2)+'1'.padStart(64,'0')+'1'.padStart(64,'0');
const trueWord='0x'+'1'.padStart(64,'0');

function fixture() {
  const decisionReceipt={transactionHash:txHash,from:publication.appendDecision.from,to:FUJI_PROFILE.contractAddress,
    blockHash,blockNumber,status:'0x1',logs:[{address:FUJI_PROFILE.contractAddress,transactionHash:txHash,
      blockHash,blockNumber,removed:false,topics:[DECISION_RECORDED_TOPIC,first.taskId,sequenceTopic,first.receiptHash],data:eventData}]};
  const decisionTransaction={hash:txHash,from:publication.appendDecision.from,to:FUJI_PROFILE.contractAddress,
    value:'0x0',input:publication.appendDecision.data,blockHash,blockNumber};
  const decisionBlock={hash:blockHash,number:blockNumber,transactions:[txHash]};
  const deployReceipt={transactionHash:FUJI_PROFILE.transactionHash,from:FUJI_PROFILE.owner,to:null,
    contractAddress:FUJI_PROFILE.contractAddress,blockHash:deployBlockHash,blockNumber:deployBlockNumber,status:'0x1'};
  const deployTransaction={hash:FUJI_PROFILE.transactionHash,from:FUJI_PROFILE.owner,to:null,value:'0x0',
    input:artifact.bytecode+addressWord(FUJI_PROFILE.recorder),blockHash:deployBlockHash,blockNumber:deployBlockNumber};
  const deployBlock={hash:deployBlockHash,number:deployBlockNumber,transactions:[FUJI_PROFILE.transactionHash]};
  return {decisionReceipt,decisionTransaction,decisionBlock,deployReceipt,deployTransaction,deployBlock};
}

function mock(mutate=()=>{}) {
  const f=fixture();mutate(f);let chainCalls=0;const calls=[];
  const fetchImpl=async(url,options)=>{
    assert.equal(url,'https://api.avax-test.network/ext/bc/C/rpc');assert.equal(options.redirect,'error');
    const {id,method,params=[]}=JSON.parse(options.body);calls.push({method,params});let result;
    if(method==='eth_chainId')result=chainCalls++===0?'0xa869':(f.chainId??'0xa869');
    else if(method==='eth_getTransactionReceipt')result=params[0]===FUJI_PROFILE.transactionHash?f.deployReceipt:f.decisionReceipt;
    else if(method==='eth_getTransactionByHash')result=params[0]===FUJI_PROFILE.transactionHash?f.deployTransaction:f.decisionTransaction;
    else if(method==='eth_getBlockByNumber')result=params[0]===deployBlockNumber?f.deployBlock:f.decisionBlock;
    else if(method==='eth_getCode')result=expectedRuntime(artifact,FUJI_PROFILE);
    else if(method==='eth_call') {
      const data=params[0].data;
      if(data==='0x'+artifact.methodIdentifiers['tasks(bytes32)']+first.taskId.slice(2))result=f.taskResult??taskResult;
      else if(data==='0x'+artifact.methodIdentifiers['recordedReceipts(bytes32)']+first.receiptHash.slice(2))result=f.recordedResult??trueWord;
      else result='0x'+addressWord(FUJI_PROFILE.owner);
    } else assert.fail(`unexpected RPC method ${method}`);
    return new Response(JSON.stringify({jsonrpc:'2.0',id,result}));
  };
  return {f,calls,fetchImpl};
}

test('verifies exact first decision calldata, event, task head, and recorded receipt',async()=>{
  const m=mock();const result=await verifyFujiFirstDecisionReceipt({transactionHash:txHash,publication,fetchImpl:m.fetchImpl});
  assert.equal(result.verified,true);assert.equal(result.state,'first-decision-recorded');
  assert.equal(result.receiptHash,first.receiptHash);assert.equal(result.sequence,'1');
  assert.equal(m.calls.filter(call=>call.method==='eth_call').length,4);
});

test('pending is not success',async()=>{
  const m=mock(f=>{f.decisionReceipt=null;});
  assert.equal((await verifyFujiFirstDecisionReceipt({transactionHash:txHash,publication,fetchImpl:m.fetchImpl})).state,'pending');
});

for(const [name,mutate,code] of [
  ['wrong chain',f=>{f.chainId='0xa86a';},'FUJI_DECISION_WRONG_CHAIN'],
  ['wrong sender',f=>{f.decisionReceipt.from='0x'+'11'.repeat(20);},'FUJI_DECISION_RECEIPT_MISMATCH'],
  ['wrong contract',f=>{f.decisionReceipt.to='0x'+'22'.repeat(20);},'FUJI_DECISION_RECEIPT_MISMATCH'],
  ['wrong calldata',f=>{f.decisionTransaction.input='0x1234';},'FUJI_DECISION_TRANSACTION_MISMATCH'],
  ['nonzero value',f=>{f.decisionTransaction.value='0x1';},'FUJI_DECISION_TRANSACTION_MISMATCH'],
  ['revert',f=>{f.decisionReceipt.status='0x0';},'FUJI_DECISION_REVERTED'],
  ['wrong event',f=>{f.decisionReceipt.logs[0].data=ZERO_HASH+ZERO_HASH.slice(2);},'FUJI_DECISION_EVENT_MISMATCH'],
  ['reorg',f=>{f.decisionBlock.hash='0x'+'33'.repeat(32);},'FUJI_DECISION_BLOCK_MISMATCH'],
  ['wrong task head',f=>{f.taskResult='0x'+ZERO_HASH.slice(2).repeat(4);},'FUJI_DECISION_TASK_MISMATCH'],
  ['receipt not recorded',f=>{f.recordedResult='0x'+'0'.repeat(64);},'FUJI_DECISION_RECORDED_MISMATCH']
])test(`${name} cannot verify`,async()=>{
  const m=mock(mutate);
  await assert.rejects(verifyFujiFirstDecisionReceipt({transactionHash:txHash,publication,fetchImpl:m.fetchImpl}),new RegExp(code));
});

test('tampered source receipt is rejected before RPC',async()=>{
  const changed=structuredClone(publication);changed.audit.receipts[0].source.decision.kind='TAMPERED';let calls=0;
  await assert.rejects(verifyFujiFirstDecisionReceipt({transactionHash:txHash,publication:changed,
    fetchImpl:async()=>{calls++;}}),/FUJI_DECISION_SOURCE_INVALID/);
  assert.equal(calls,0);
});
