import { parseDecimal, formatDecimal } from '../domain/money.mjs';

/** Pure adapter boundary, NOT a discovered/verified ATK 1.4.8 tool schema.
 * Callers must bind actual tool fields and verify the fee sign convention first.
 * Unsupported/rebate fees stay in the observation journal; never assume zero.
 */
export function normalizeSpotFees({amount,currency,observed=false,signConvention}) {
  if(observed!==true)return {ok:true,feesComplete:false};
  if(!['negative-is-charge','positive-is-charge'].includes(signConvention))
    return {ok:false,code:'UNVERIFIED_FEE_SIGN'};
  if(!['USDT','AVAX'].includes(currency))return {ok:false,code:'UNSUPPORTED_FEE_CURRENCY'};
  let units;
  try {units=parseDecimal(amount);}catch{return {ok:false,code:'INVALID_FEE_AMOUNT'};}
  const charge=signConvention==='negative-is-charge'?-units:units;
  if(charge<0n)return {ok:false,code:'FEE_REBATE_REQUIRES_RECONCILIATION'};
  return {ok:true,feeQuote:currency==='USDT'?formatDecimal(charge):'0',
    feeBase:currency==='AVAX'?formatDecimal(charge):'0',feesComplete:true};
}
