import {bindCampaignPolicy} from './domain/campaign-task.mjs';
import {divDecimal,parseDecimal} from './domain/money.mjs';

const fail=()=>{throw Object.assign(new Error('DEMO_POLICY_CONFIGURATION'),{status:409});};
const keys=['campaignId','campaignHash','quoteFeeRateMax','quoteFeeFixedMax','baseFeeRateMax',
  'orderLifetimeMs','snapshotMaxAgeMs','snapshotMaxSkewMs'];

// Operator configuration, never HTTP input. No fee, account, campaign or time
// assumption is borrowed from the fixture. The reviewed draft pins this scope.
export function demoPolicyConfiguration(input) {
  if(!input || typeof input!=='object' || Array.isArray(input)
      || Object.keys(input).sort().join(',')!==[...keys].sort().join(',')
      || typeof input.campaignId!=='string' || !input.campaignId || input.campaignId.length>128
      || typeof input.campaignHash!=='string' || !/^[a-f0-9]{64}$/.test(input.campaignHash))fail();
  for(const key of ['quoteFeeRateMax','quoteFeeFixedMax','baseFeeRateMax'])
    if(typeof input[key]!=='string' || parseDecimal(input[key])<0n)fail();
  for(const key of ['quoteFeeRateMax','baseFeeRateMax'])if(parseDecimal(input[key])>parseDecimal('1'))fail();
  for(const key of ['orderLifetimeMs','snapshotMaxAgeMs','snapshotMaxSkewMs'])
    if(!Number.isSafeInteger(input[key]) || input[key]<1)fail();
  if(input.orderLifetimeMs>120000 || input.snapshotMaxAgeMs>15000 || input.snapshotMaxSkewMs>input.snapshotMaxAgeMs)fail();
  return Object.freeze({...input});
}

export function demoPolicyScope(store,configuration) {
  const scope=demoPolicyConfiguration(configuration),campaign=store.campaign(scope.campaignId);
  if(!campaign || campaign.configHash!==scope.campaignHash || campaign.paused || campaign.supersededBy)fail();
  return {...scope,executionMode:'demo-prepared'};
}

export function makeDemoPolicy(store,fields,context) {
  const {executionMode,...configuration}=context.policyContext??{};
  if(executionMode!=='demo-prepared')fail();
  const scope=demoPolicyScope(store,configuration),campaign=store.campaign(scope.campaignId);
  return bindCampaignPolicy({id:context.policyId,taskId:context.id,workflowId:context.workflowId,
    draftRevision:context.revision,executionMode,accountId:campaign.config.accountId,
    environment:'demo',instrument:'AVAX-USDT',side:'buy',tdMode:'cash',ordType:'limit',
    budget:fields.budget,singleOrderNotionalMax:fields.singleOrderNotionalMax,maxPrice:fields.maxPrice,
    maxShare:divDecimal(fields.maxSharePercent,'100'),quoteFeeRateMax:scope.quoteFeeRateMax,
    quoteFeeFixedMax:scope.quoteFeeFixedMax,baseFeeRateMax:scope.baseFeeRateMax,
    approvedAtMs:context.nowMs,expiresAtMs:context.createdAtMs+Number(fields.durationSeconds)*1000,
    orderLifetimeMs:scope.orderLifetimeMs,snapshotMaxAgeMs:scope.snapshotMaxAgeMs,snapshotMaxSkewMs:scope.snapshotMaxSkewMs},campaign);
}
