// Public transaction hash and addresses only. Never accepts a signing key.
import {compileRegistry} from './lib/fuji-build.mjs';
import {verifyFujiDeployment} from './lib/fuji-deployment-check.mjs';
try {
  const [transactionHash,owner,recorder,...extra]=process.argv.slice(2);
  if(!transactionHash || !owner || !recorder || extra.length)throw new Error('FUJI_PUBLIC_ARGUMENTS_REQUIRED');
  const {artifact}=await compileRegistry();
  const result=await verifyFujiDeployment({artifact,transactionHash,owner,recorder});
  console.log(JSON.stringify(result,null,2));if(!result.verified)process.exitCode=2;
}catch(error){
  console.error(/^FUJI_[A-Z_]+$/.test(error.message)?error.message:'FUJI_VERIFICATION_FAILED');process.exitCode=1;
}
