import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {FUJI_ACCEPTANCE_PROFILE,failedFujiAcceptance} from '../src/audit/fuji-acceptance-profile.mjs';
import {verifyFujiAcceptanceTest} from '../scripts/lib/verify-fuji-acceptance.mjs';

const p=FUJI_ACCEPTANCE_PROFILE;
const policy={verified:true,state:'policy-committed',transactionHash:p.policy.transactionHash,
  blockNumber:p.policy.blockNumber,blockHash:p.policy.blockHash,taskId:p.taskId,policyHash:p.policyHash};
const first={verified:true,state:'first-decision-recorded',transactionHash:p.firstReceipt.transactionHash,
  blockNumber:p.firstReceipt.blockNumber,blockHash:p.firstReceipt.blockHash,taskId:p.taskId,
  policyHash:p.policyHash,receiptHash:p.receiptHash,sequence:'1'};

test('fixed archived fixture hash and receipt evidence are pinned',async()=>{
  const bytes=await readFile(new URL('../'+p.publicationPath,import.meta.url));
  assert.equal(createHash('sha256').update(bytes).digest('hex'),p.publicationSha256);
  assert.equal(p.localReceiptCount,7);assert.equal(p.publishedReceiptCount,1);assert.equal(p.onlyFirstReceipt,true);
  assert.equal(Number.parseInt(p.policy.blockNumber.slice(2),16),59590472);
  assert.equal(Number.parseInt(p.firstReceipt.blockNumber.slice(2),16),59590500);
});

test('acceptance maps only the verified policy and first fixture receipt',async()=>{
  const calls=[];
  const result=await verifyFujiAcceptanceTest({verifyPolicy:async input=>{calls.push(input);return policy;},
    verifyFirstReceipt:async input=>{calls.push(input);return first;}});
  assert.deepEqual(result,{state:'VERIFIED',mode:'fixture',policyTx:p.policy.transactionHash,
    firstReceiptTx:p.firstReceipt.transactionHash,sequence:'1',onlyFirstReceipt:true,writeEnabled:false});
  assert.deepEqual(calls.map(call=>call.transactionHash),[p.policy.transactionHash,p.firstReceipt.transactionHash]);
  assert.equal(calls[0].publication,calls[1].publication);
});

test('pending or mismatched evidence cannot become acceptance success',async()=>{
  for(const changed of [{...policy,verified:false,state:'pending'},{...policy,blockHash:'0x'+'00'.repeat(32)}])
    await assert.rejects(verifyFujiAcceptanceTest({verifyPolicy:async()=>changed,verifyFirstReceipt:async()=>first}),/FUJI_ACCEPTANCE_UNVERIFIED/);
  await assert.rejects(verifyFujiAcceptanceTest({verifyPolicy:async()=>policy,
    verifyFirstReceipt:async()=>({...first,receiptHash:'0x'+'00'.repeat(32)})}),/FUJI_ACCEPTANCE_UNVERIFIED/);
});

test('acceptance failure stays nested and does not rewrite deployment truth',()=>{
  const deployment={state:'DEPLOYMENT_VERIFIED',publication:'TASK_RECEIPTS_NOT_VERIFIED',writeEnabled:false};
  const status={...deployment,acceptanceTest:failedFujiAcceptance()};
  assert.equal(status.state,'DEPLOYMENT_VERIFIED');assert.equal(status.publication,'TASK_RECEIPTS_NOT_VERIFIED');
  assert.deepEqual(status.acceptanceTest,{state:'VERIFICATION_FAILED',mode:'fixture',onlyFirstReceipt:true,writeEnabled:false});
  assert.deepEqual(failedFujiAcceptance('FUJI_RPC_RATE_LIMITED'),{state:'VERIFICATION_FAILED',mode:'fixture',
    onlyFirstReceipt:true,writeEnabled:false,reasonCode:'FUJI_RPC_RATE_LIMITED'});
  assert.equal(Object.hasOwn(failedFujiAcceptance('UNTRUSTED_RAW_ERROR'),'reasonCode'),false);
});

test('UI labels the evidence as an independent simulation test, not all task receipts',()=>{
  const source=readFileSync(new URL('../public/app.mjs',import.meta.url),'utf8');
  assert.match(source,/Bağımsız simülasyon testi: politika \+ ilk kayıt doğrulandı/);
  assert.match(source,/görev kayıtlarının zincir yayını ayrıca doğrulanmalıdır/);
});
