// Only public state reads. This is not a transaction receipt/event verification.
import {readFile,stat} from 'node:fs/promises';
import {FUJI_PROFILE} from '../src/audit/fuji-deployment-profile.mjs';
import {FUJI_RPC_URL} from '../src/audit/fuji.mjs';
import {readBoundedJson} from '../src/io/bounded-json.mjs';
import {canonicalJson,ZERO_HASH} from '../src/audit/commitments.mjs';
import {prepareFujiPublication} from './lib/fuji-publication.mjs';
import {selectedFujiArtifact,verifySelectedFuji} from './lib/verify-selected-fuji.mjs';

try {
  const path=process.argv[2];
  if(!path || process.argv.length!==3 || (await stat(path)).size>1048576)throw new Error('FUJI_PACKAGE_INVALID');
  const saved=JSON.parse(await readFile(path,'utf8')),prepared=await prepareFujiPublication(saved.audit);
  for(const key of Object.keys(prepared))if(canonicalJson(prepared[key])!==canonicalJson(saved[key]))throw new Error('FUJI_PACKAGE_MISMATCH');
  await verifySelectedFuji();
  const artifact=await selectedFujiArtifact();
  const response=await fetch(FUJI_RPC_URL,{method:'POST',redirect:'error',signal:AbortSignal.timeout(10000),
    headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_call',
      params:[{to:FUJI_PROFILE.contractAddress,data:'0x'+artifact.methodIdentifiers['tasks(bytes32)']+prepared.commitPolicy.args.taskId.slice(2)},'latest']})});
  if(!response.ok)throw new Error('FUJI_RPC_HTTP');
  const data=await readBoundedJson(response,{maxBytes:8192});
  if(data.id!==1 || data.jsonrpc!=='2.0' || data.error || !/^0x[0-9a-fA-F]{256}$/.test(data.result))throw new Error('FUJI_TASK_RESPONSE_INVALID');
  const words=data.result.slice(2).toLowerCase().match(/.{64}/g),policyHash='0x'+words[0],head='0x'+words[1],sequence=BigInt('0x'+words[2]).toString(),committed=BigInt('0x'+words[3]);
  let state;
  if(committed===0n && policyHash===ZERO_HASH && head===ZERO_HASH && sequence==='0')state='POLICY_NOT_COMMITTED';
  else if(committed===1n && policyHash===prepared.commitPolicy.args.policyHash && sequence==='0' && head===ZERO_HASH)state='POLICY_PRESENT_FIRST_RECEIPT_MISSING';
  else if(committed===1n && policyHash===prepared.commitPolicy.args.policyHash && sequence==='1' && head===prepared.firstReceipt.receiptHash)state='FIRST_RECEIPT_PRESENT';
  else throw new Error('FUJI_TASK_STATE_REQUIRES_REVIEW');
  console.log(JSON.stringify({state,chainId:43113,contractAddress:FUJI_PROFILE.contractAddress,
    taskId:prepared.commitPolicy.args.taskId,sequence,writeEnabled:false,
    scope:'Latest RPC state only; transaction receipt and event verification remains separate.'},null,2));
} catch(error) {
  console.error(/^FUJI_[A-Z_]+$/.test(error?.message)?error.message:'FUJI_PUBLICATION_CHECK_FAILED');process.exitCode=1;
}
