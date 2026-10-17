// Public transaction hash and immutable publication JSON only. Never signs,
// submits, retries, or accepts credentials.
import {readFile,stat} from 'node:fs/promises';
import {verifyFujiFirstDecisionReceipt} from './lib/fuji-first-decision-receipt.mjs';

try {
  const [transactionHash,path,...extra]=process.argv.slice(2);
  if(!transactionHash || !path || extra.length || (await stat(path)).size>1048576)throw new Error('FUJI_DECISION_PUBLIC_ARGUMENTS_REQUIRED');
  const publication=JSON.parse(await readFile(path,'utf8'));
  const result=await verifyFujiFirstDecisionReceipt({transactionHash,publication});
  console.log(JSON.stringify(result,null,2));
  if(!result.verified)process.exitCode=2;
} catch(error) {
  console.error(/^FUJI_DECISION_[A-Z_]+$/.test(error?.message)?error.message:'FUJI_DECISION_VERIFICATION_FAILED');
  process.exitCode=1;
}
