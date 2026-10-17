import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {FUJI_PROFILE} from '../src/audit/fuji-deployment-profile.mjs';
import {ZERO_HASH} from '../src/audit/commitments.mjs';
import {selectedFujiArtifact} from '../scripts/lib/verify-selected-fuji.mjs';
import {addressWord,expectedRuntime} from '../scripts/lib/fuji-build.mjs';
import {POLICY_COMMITTED_TOPIC,verifyFujiPolicyReceipt} from '../scripts/lib/fuji-policy-receipt.mjs';

const publication=JSON.parse(await readFile(new URL('../exports/fuji-publication-IDtXJk/publication.json',import.meta.url),'utf8'));
const artifact=await selectedFujiArtifact();
const txHash='0x'+'a1'.repeat(32),blockHash='0x'+'b2'.repeat(32),blockNumber='0x234';
const deployBlockHash='0x'+'c3'.repeat(32),deployBlockNumber='0x123';
const taskId=publication.commitPolicy.args.taskId,policyHash=publication.commitPolicy.args.policyHash;
const input=publication.commitPolicy.data;
const taskResult='0x'+policyHash.slice(2)+ZERO_HASH.slice(2)+'0'.repeat(64)+'1'.padStart(64,'0');

function fixture() {
  const policyReceipt={transactionHash:txHash,from:FUJI_PROFILE.owner,to:FUJI_PROFILE.contractAddress,
    blockHash,blockNumber,status:'0x1',logs:[{address:FUJI_PROFILE.contractAddress,transactionHash:txHash,
      blockHash,blockNumber,removed:false,topics:[POLICY_COMMITTED_TOPIC,taskId,policyHash],data:'0x'}]};
  const policyTransaction={hash:txHash,from:FUJI_PROFILE.owner,to:FUJI_PROFILE.contractAddress,value:'0x0',input,
    blockHash,blockNumber};
  const policyBlock={hash:blockHash,number:blockNumber,transactions:[txHash]};
  const deployReceipt={transactionHash:FUJI_PROFILE.transactionHash,from:FUJI_PROFILE.owner,to:null,
    contractAddress:FUJI_PROFILE.contractAddress,blockHash:deployBlockHash,blockNumber:deployBlockNumber,status:'0x1'};
  const deployTransaction={hash:FUJI_PROFILE.transactionHash,from:FUJI_PROFILE.owner,to:null,value:'0x0',
    input:artifact.bytecode+addressWord(FUJI_PROFILE.recorder),blockHash:deployBlockHash,blockNumber:deployBlockNumber};
  const deployBlock={hash:deployBlockHash,number:deployBlockNumber,transactions:[FUJI_PROFILE.transactionHash]};
  return {policyReceipt,policyTransaction,policyBlock,deployReceipt,deployTransaction,deployBlock};
}

function mock(mutate=()=>{}) {
  const f=fixture();mutate(f);const calls=[];let chainCalls=0;
  const fetchImpl=async(url,options)=>{
    assert.equal(url,'https://api.avax-test.network/ext/bc/C/rpc');
    assert.equal(options.method,'POST');assert.equal(options.redirect,'error');
    const {id,method,params=[]}=JSON.parse(options.body);calls.push({method,params});
    let result;
    if(method==='eth_chainId')result=chainCalls++===0?'0xa869':(f.chainId??'0xa869');
    else if(method==='eth_getTransactionReceipt')result=params[0]===FUJI_PROFILE.transactionHash?f.deployReceipt:f.policyReceipt;
    else if(method==='eth_getTransactionByHash')result=params[0]===FUJI_PROFILE.transactionHash?f.deployTransaction:f.policyTransaction;
    else if(method==='eth_getBlockByNumber')result=params[0]===deployBlockNumber?f.deployBlock:f.policyBlock;
    else if(method==='eth_getCode')result=expectedRuntime(artifact,FUJI_PROFILE);
    else if(method==='eth_call')result=params[0].data==='0x'+artifact.methodIdentifiers['tasks(bytes32)']+taskId.slice(2)
      ?(f.taskResult??taskResult):'0x'+addressWord(FUJI_PROFILE.owner);
    else assert.fail(`unexpected RPC method ${method}`);
    return new Response(JSON.stringify({jsonrpc:'2.0',id,result}));
  };
  return {f,calls,fetchImpl};
}

test('verifies exact zero-value policy commit, event, canonical block, and task state',async()=>{
  const m=mock();const result=await verifyFujiPolicyReceipt({transactionHash:txHash,publication,fetchImpl:m.fetchImpl});
  assert.equal(result.verified,true);assert.equal(result.state,'policy-committed');
  assert.equal(result.taskId,taskId);assert.equal(result.policyHash,policyHash);
  assert.equal(m.calls.filter(call=>call.method==='eth_call').length,3);
});

test('pending is reported and is never success',async()=>{
  const m=mock(f=>{f.policyReceipt=null;});
  assert.deepEqual(await verifyFujiPolicyReceipt({transactionHash:txHash,publication,fetchImpl:m.fetchImpl}),
    {verified:false,state:'pending',chainId:43113,transactionHash:txHash});
  assert.equal(m.calls.at(-1).method,'eth_getTransactionReceipt');
});

for(const [name,mutate,code] of [
  ['wrong chain',f=>{f.chainId='0xa86a';},'FUJI_POLICY_WRONG_CHAIN'],
  ['wrong sender',f=>{f.policyReceipt.from='0x'+'11'.repeat(20);},'FUJI_POLICY_RECEIPT_MISMATCH'],
  ['wrong contract',f=>{f.policyReceipt.to='0x'+'22'.repeat(20);},'FUJI_POLICY_RECEIPT_MISMATCH'],
  ['wrong input',f=>{f.policyTransaction.input='0x1234';},'FUJI_POLICY_TRANSACTION_MISMATCH'],
  ['nonzero value',f=>{f.policyTransaction.value='0x1';},'FUJI_POLICY_TRANSACTION_MISMATCH'],
  ['reverted receipt',f=>{f.policyReceipt.status='0x0';},'FUJI_POLICY_REVERTED'],
  ['wrong event',f=>{f.policyReceipt.logs[0].topics[2]=ZERO_HASH;},'FUJI_POLICY_EVENT_MISMATCH'],
  ['reorged block',f=>{f.policyBlock.hash='0x'+'44'.repeat(32);},'FUJI_POLICY_BLOCK_MISMATCH'],
  ['wrong task state',f=>{f.taskResult='0x'+ZERO_HASH.slice(2).repeat(4);},'FUJI_POLICY_TASK_MISMATCH']
])test(`${name} cannot verify`,async()=>{
  const m=mock(mutate);
  await assert.rejects(verifyFujiPolicyReceipt({transactionHash:txHash,publication,fetchImpl:m.fetchImpl}),new RegExp(code));
});

test('tampered canonical source is rejected before RPC',async()=>{
  const changed=structuredClone(publication);changed.audit.policyCommitment.source.policy.instrument='TAMPERED';
  let calls=0;
  await assert.rejects(verifyFujiPolicyReceipt({transactionHash:txHash,publication:changed,
    fetchImpl:async()=>{calls++;}}),/FUJI_POLICY_SOURCE_INVALID/);
  assert.equal(calls,0);
});
