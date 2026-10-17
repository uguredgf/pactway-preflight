import {normalizeDemoBalance} from '../adapters/atk-market-account.mjs';
import {projectCampaign} from './campaign.mjs';
import {hashCanonical} from './governor.mjs';
import {parseDecimal,formatDecimal} from './money.mjs';

const fail=code=>{throw new Error(code);};
function amount(value) {
  if(typeof value!=='string' || value.length>64 || value.trim()!==value)fail('BALANCE_AMOUNT_INVALID');
  const units=parseDecimal(value);if(units<0n)fail('BALANCE_AMOUNT_INVALID');return units;
}
function economics(campaign,states) {
  projectCampaign(campaign,states); // Re-check every task/account/order/trade binding.
  if(states.some(s=>s.busy || ['QUEUED','RUNNING','BLOCKED'].includes(s.queue?.state)
      || s.ledger.intents.some(i=>!i.settled)))fail('BALANCE_EXECUTION_UNSETTLED');
  const fills=[];
  for(const state of states)for(const intent of state.ledger.intents)for(const fill of intent.fills) {
    if(fill.feesComplete!==true)fail('BALANCE_FEES_INCOMPLETE');
    const qty=amount(fill.baseQty),quote=amount(fill.quoteNotional),baseFee=amount(fill.feeBase),quoteFee=amount(fill.feeQuote);
    if(baseFee>qty)fail('BALANCE_BASE_FEE_UNSUPPORTED');
    fills.push({taskId:state.id,intentId:intent.id,tradeId:fill.tradeId,baseNet:formatDecimal(qty-baseFee),quoteCost:formatDecimal(quote+quoteFee)});
  }
  return fills.sort((a,b)=>a.tradeId.localeCompare(b.tradeId));
}
function observed(campaign,balanceRecord,options) {
  const view=normalizeDemoBalance(balanceRecord,options);
  if(!view.ok)fail(view.code);
  if(view.binding.accountId!==campaign.config.accountId)fail('BALANCE_ACCOUNT_MISMATCH');
  // Total cash, never available balance: reserving funds is not a transfer.
  return {binding:view.binding,atMs:view.timing.receivedAtMs,
    balances:{AVAX:view.balances.AVAX.cash,USDT:view.balances.USDT.cash},
    references:[{id:view.sourceObservationId,hash:view.sourcePayloadHash},{id:view.configObservationId,hash:view.configPayloadHash}]};
}

/** Internal checkpoint, pinned once by Store. Hash is integrity, not provenance.
 * Baseline contains cumulative known fills so pre-baseline buys are not counted twice.
 */
export function createBalanceCheckpoint({campaign,states,balanceRecord,options}) {
  const checkpoint={schemaVersion:1,campaignHash:campaign.configHash,connectionVersion:campaign.config.connectionVersion,
    ...observed(campaign,balanceRecord,options),fills:economics(campaign,states)};
  return {...checkpoint,checkpointHash:hashCanonical(checkpoint)};
}

export function reconcileCampaignBalances({campaign,states,baseline,balanceRecord,options}) {
  try {
    const {checkpointHash,...body}=baseline;
    if(hashCanonical(body)!==checkpointHash || body.schemaVersion!==1 || body.campaignHash!==campaign.configHash
        || body.connectionVersion!==campaign.config.connectionVersion)fail('BALANCE_CHECKPOINT_MISMATCH');
    const current=createBalanceCheckpoint({campaign,states,balanceRecord,options});
    if(current.atMs<=body.atMs)fail('BALANCE_OBSERVATION_NOT_NEWER');
    // A new session is allowed, a different connection/catalog/entry/account is not.
    for(const key of ['connectionHash','catalogHash','isolatedEntrySha256','accountId'])
      if(current.binding[key]!==body.binding[key])fail('BALANCE_BINDING_CHANGED');
    const known=new Map();
    for(const fill of body.fills) {
      if(known.has(fill.tradeId))fail('BALANCE_CHECKPOINT_DUPLICATE');
      known.set(fill.tradeId,fill);
    }
    let baseDelta=0n,quoteDelta=0n;
    for(const fill of current.fills) {
      const old=known.get(fill.tradeId);
      if(old && (old.taskId!==fill.taskId || old.intentId!==fill.intentId))fail('BALANCE_FILL_OWNER_CHANGED');
      baseDelta+=amount(fill.baseNet)-(old?amount(old.baseNet):0n);
      quoteDelta-=amount(fill.quoteCost)-(old?amount(old.quoteCost):0n);
      known.delete(fill.tradeId);
    }
    if(known.size)fail('BALANCE_PRIOR_FILL_MISSING');
    const expected={AVAX:amount(body.balances.AVAX)+baseDelta,USDT:amount(body.balances.USDT)+quoteDelta};
    if(expected.AVAX<0n || expected.USDT<0n)fail('BALANCE_EXPECTATION_NEGATIVE');
    const difference={AVAX:formatDecimal(amount(current.balances.AVAX)-expected.AVAX),
      USDT:formatDecimal(amount(current.balances.USDT)-expected.USDT)};
    const matched=difference.AVAX==='0' && difference.USDT==='0';
    return {ok:true,status:matched?'MATCHED_KNOWN_FILLS':'UNEXPLAINED_BALANCE_CHANGE',requiresPause:!matched,
      baselineHash:checkpointHash,currentHash:current.checkpointHash,references:current.references,
      expected:{AVAX:formatDecimal(expected.AVAX),USDT:formatDecimal(expected.USDT)},actual:current.balances,difference,
      ready:false,foreignActivity:'UNKNOWN',coverageVerified:false};
  } catch(error) {
    return {ok:false,status:'BALANCE_RECONCILIATION_UNCERTAIN',requiresPause:true,
      code:typeof error?.message==='string' && /^[A-Z_]+$/.test(error.message)?error.message:'BALANCE_INPUT_INVALID',
      ready:false,foreignActivity:'UNKNOWN',coverageVerified:false};
  }
}
