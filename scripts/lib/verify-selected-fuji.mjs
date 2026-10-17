import {FUJI_PROFILE} from '../../src/audit/fuji-deployment-profile.mjs';
import {compileRegistry} from './fuji-build.mjs';
import {verifyFujiDeployment} from './fuji-deployment-check.mjs';

export async function selectedFujiArtifact() {
  const {artifact}=await compileRegistry({profile:FUJI_PROFILE.buildProfile});
  if(artifact.sourceSha256!==FUJI_PROFILE.sourceSha256)throw new Error('FUJI_APPROVED_SOURCE_CHANGED');
  return artifact;
}
export async function verifySelectedFuji({fetchImpl=fetch}={}) {
  const artifact=await selectedFujiArtifact();
  const result=await verifyFujiDeployment({artifact,...FUJI_PROFILE,fetchImpl});
  if(!result.verified || result.contractAddress!==FUJI_PROFILE.contractAddress)throw new Error('FUJI_SELECTED_DEPLOYMENT_UNVERIFIED');
  return {...result,buildProfile:FUJI_PROFILE.buildProfile,profile:FUJI_PROFILE.id};
}
