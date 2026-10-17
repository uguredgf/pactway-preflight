import {hashCanonical,hashPolicy} from './governor.mjs';
import {createCampaign} from './campaign.mjs';
import {createLedger} from './ledger.mjs';
import {parseDecimal} from './money.mjs';
import {createTaskId} from '../audit/commitments.mjs';

function flat(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
      || ![Object.prototype,null].includes(Object.getPrototypeOf(input)) || Object.getOwnPropertySymbols(input).length)
    throw new TypeError('CAMPAIGN_TASK_INPUT');
  const descriptors=Object.getOwnPropertyDescriptors(input),result={};
  if (Object.keys(descriptors).length > 64) throw new TypeError('CAMPAIGN_TASK_INPUT');
  for (const [key,item] of Object.entries(descriptors)) {
    if (!Object.hasOwn(item,'value') || !['string','number','boolean'].includes(typeof item.value)
        || typeof item.value==='string' && item.value.length > 256 || key==='__proto__')
      throw new TypeError('CAMPAIGN_TASK_INPUT');
    result[key]=item.value;
  }
  return result;
}
function current(campaign) {
  // Internal persisted campaign input; reconstruct the config to reject extra fields.
  const config=flat(campaign.config),rebuilt=createCampaign(config);
  if (hashCanonical(config)!==rebuilt.configHash || campaign.configHash!==rebuilt.configHash
      || campaign.paused!==false || !Array.isArray(campaign.violations) || campaign.violations.length)
    throw new Error('CAMPAIGN_TASK_CAMPAIGN_UNAVAILABLE');
  return {config,hash:rebuilt.configHash};
}

/** Bind BEFORE showing the policy for approval. Changing campaign requires a new
 * policy hash. The supplied campaign is internal state, not account attestation.
 */
export function bindCampaignPolicy(policy,campaign) {
  const copied=flat(policy),bound=current(campaign),c=bound.config;
  if (copied.executionMode!=='demo-prepared' || copied.accountId!==c.accountId
      || copied.environment!==c.environment || copied.instrument!==c.instrument
      || ['campaignId','campaignVersion','campaignHash','connectionVersion'].some(key=>Object.hasOwn(copied,key)))
    throw new Error('CAMPAIGN_TASK_SCOPE');
  if (parseDecimal(copied.maxShare)>parseDecimal(c.maxShare) || parseDecimal(copied.budget)>parseDecimal(c.budget))
    throw new Error('CAMPAIGN_TASK_LIMIT');
  const result={...copied,campaignId:c.id,campaignVersion:c.version,campaignHash:bound.hash,connectionVersion:c.connectionVersion};
  hashPolicy(result);
  return Object.freeze(result);
}

/** Source preparation only. Owner authentication, durable draft consumption and
 * idempotent enqueue belong to the application boundary; never inferred here.
 * WAITING is intentional: approval preparation grants no runtime authority.
 */
export function prepareCampaignTask({policy,approvedPolicyHash,campaign,ownerId,nowMs}) {
  const copied=flat(policy),bound=current(campaign),c=bound.config;
  if (typeof ownerId!=='string' || ownerId.length<1 || ownerId.length>128 || ownerId.trim()!==ownerId
      || !Number.isSafeInteger(nowMs) || nowMs<0) throw new TypeError('CAMPAIGN_TASK_INPUT');
  if (hashPolicy(copied)!==approvedPolicyHash) throw new Error('CAMPAIGN_TASK_APPROVAL');
  if (nowMs<copied.approvedAtMs || nowMs>=copied.expiresAtMs) throw new Error('CAMPAIGN_TASK_EXPIRED');
  const base={...copied};
  for (const key of ['campaignId','campaignVersion','campaignHash','connectionVersion']) delete base[key];
  const rebound=bindCampaignPolicy(base,campaign);
  if (hashPolicy(rebound)!==approvedPolicyHash) throw new Error('CAMPAIGN_TASK_BINDING_CHANGED');
  return {id:copied.taskId,ownerId,auditTaskId:createTaskId(copied.taskId),campaignId:c.id,
    policy:copied,approvedPolicyHash,mode:'demo-prepared',busy:false,attempts:0,lastRejection:null,createdAtMs:nowMs,
    ledger:createLedger({taskId:copied.taskId,accountId:c.accountId,budget:copied.budget,spent:'0',phase:'WAITING'})};
}
