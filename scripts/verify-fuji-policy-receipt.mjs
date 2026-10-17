// Public transaction hash and immutable publication JSON only. Never signs,
// submits, retries, or accepts credentials.
import {readFile,stat} from 'node:fs/promises';
import {verifyFujiPolicyReceipt} from './lib/fuji-policy-receipt.mjs';

try {
  const [transactionHash,path,...extra]=process.argv.slice(2);
  if(!transactionHash || !path || extra.length || (await stat(path)).size>1048576)throw new Error('FUJI_POLICY_PUBLIC_ARGUMENTS_REQUIRED');
  const publication=JSON.parse(await readFile(path,'utf8'));
  const result=await verifyFujiPolicyReceipt({transactionHash,publication});
  console.log(JSON.stringify(result,null,2));
  if(!result.verified)process.exitCode=2;
} catch(error) {
  console.error(/^FUJI_POLICY_[A-Z_]+$/.test(error?.message)?error.message:'FUJI_POLICY_VERIFICATION_FAILED');
  process.exitCode=1;
}
