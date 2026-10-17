import { parseDecimal, formatDecimal } from './money.mjs';
import { hashCanonical } from './governor.mjs';
import { ledgerSummary } from './ledger.mjs';

// One compact persisted campaign record; two economic scopes still exist.
export function createCampaign(config) {
  for(const key of ['id','accountId','connectionVersion'])if(typeof config[key]!=='string' || !config[key])throw new TypeError('Campaign identity required');
  if(!Number.isSafeInteger(config.version) || config.version<1 || config.environment!=='demo')throw new TypeError('Campaign version/demo required');
  if(config.instrument!=='AVAX-USDT' || parseDecimal(config.budget)<=0n || parseDecimal(config.maxShare)<=0n || parseDecimal(config.maxShare)>parseDecimal('1'))
    throw new TypeError('Unsupported campaign scope');
  const bound={id:config.id,version:config.version,accountId:config.accountId,connectionVersion:config.connectionVersion,
    environment:config.environment,instrument:config.instrument,budget:config.budget,maxShare:config.maxShare};
  if(config.carriedSpent!==undefined) {
    if(parseDecimal(config.carriedSpent)<0n || parseDecimal(config.carriedSpent)>parseDecimal(config.budget))
      throw new Error('Invalid carried campaign spending');
    bound.carriedSpent=formatDecimal(parseDecimal(config.carriedSpent));
  }
  return {config:bound,configHash:hashCanonical(bound),paused:false,violations:[],summary:null,ownedIntents:[]};
}

export function projectCampaign(campaign,states) {
  if(hashCanonical(campaign.config)!==campaign.configHash)throw new Error('Campaign configuration hash mismatch');
  let spent=parseDecimal(campaign.config.carriedSpent ?? '0'),reserved=0n;const violations=[],ownedIntents=[],tradeOwners=new Map(),taskIds=new Set();
  for(const state of states) {
    if(taskIds.has(state.id))throw new Error('Campaign task identity repeated');
    taskIds.add(state.id);
    const policy=state.policy,config=campaign.config;
    if(state.campaignId!==config.id || policy.campaignId!==config.id || policy.campaignVersion!==config.version
      || policy.campaignHash!==campaign.configHash || policy.accountId!==config.accountId
      || policy.environment!==config.environment || policy.instrument!==config.instrument
      || policy.connectionVersion!==config.connectionVersion || parseDecimal(policy.maxShare)>parseDecimal(config.maxShare)
      || state.ledger.taskId!==state.id || state.ledger.accountId!==config.accountId
      || parseDecimal(state.ledger.budget)!==parseDecimal(policy.budget))
      throw new Error('Task does not match the approved campaign');
    if(parseDecimal(state.ledger.initialSpent)!==0n)throw new Error('New campaign tasks must start at zero spending');
    const summary=ledgerSummary(state.ledger);
    spent+=parseDecimal(summary.spent);reserved+=parseDecimal(summary.reserved);
    if(summary.violation)violations.push({code:'TASK_LEDGER_VIOLATION',taskId:state.id});
    for(const intent of state.ledger.intents) {
      const ownerKey=JSON.stringify([state.id,intent.id]);
      const localTrades=new Set();
      for(const fill of intent.fills) {
        if(typeof fill.tradeId!=='string' || !fill.tradeId || localTrades.has(fill.tradeId))
          throw new Error('Campaign trade identity missing or repeated');
        localTrades.add(fill.tradeId);
        const previous=tradeOwners.get(fill.tradeId);
        if(previous && previous!==ownerKey)throw new Error('Campaign trade ID belongs to another intent');
        tradeOwners.set(fill.tradeId,ownerKey);
      }
      if(ownedIntents.some(item=>item.clOrdId===intent.clOrdId || intent.ordId && item.ordId===intent.ordId))
        throw new Error('Campaign order identity reused');
      ownedIntents.push({taskId:state.id,intentId:intent.id,clOrdId:intent.clOrdId,ordId:intent.ordId,settled:intent.settled});
    }
  }
  const remaining=parseDecimal(campaign.config.budget)-spent-reserved;
  if(remaining<0n)violations.push({code:'CAMPAIGN_BUDGET_EXCEEDED'});
  if(ownedIntents.filter(item=>!item.settled).length>1)violations.push({code:'CONCURRENT_CAMPAIGN_INTENTS'});
  return {...campaign,paused:campaign.paused || violations.length>0,
    violations:[...new Map([...(campaign.violations ?? []),...violations].map(item=>[JSON.stringify(item),item])).values()],
    summary:{budget:campaign.config.budget,spent:formatDecimal(spent),reserved:formatDecimal(reserved),
      remaining:formatDecimal(remaining),violation:violations.length>0},ownedIntents};
}

/** Historical fills from another visitor in this SAME campaign are owned.
 * A list of known IDs alone does not prove completeness, account balances or
 * absence of transfers. The real snapshot adapter must validate those too.
 */
export function hasForeignActivity({campaign,orders=[],fills=[],otherActivity=[],complete=false,accountId,instrument}) {
  if(complete!==true || accountId!==campaign.config.accountId || instrument!==campaign.config.instrument || otherActivity.length)return true;
  const known=campaign.ownedIntents ?? [];
  return [...orders,...fills].some(row=>row.accountId!==undefined && row.accountId!==accountId
    || row.instrument!==undefined && row.instrument!==instrument || !known.some(intent=>
    (row.clOrdId || row.ordId) && (!row.clOrdId || row.clOrdId===intent.clOrdId)
      && (!row.ordId || row.ordId===intent.ordId)));
}
