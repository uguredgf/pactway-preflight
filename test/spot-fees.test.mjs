// Test sources only; not run. Actual ATK field bindings/signs remain unverified.
import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeSpotFees} from '../src/adapters/spot-fees.mjs';
test('a known one-currency fee supplies an explicit zero only for the other supported currency',()=>{
  assert.deepEqual(normalizeSpotFees({amount:'-0.01',currency:'USDT',observed:true,signConvention:'negative-is-charge'}),
    {ok:true,feeQuote:'0.01',feeBase:'0',feesComplete:true});
  assert.deepEqual(normalizeSpotFees({amount:'-0.001',currency:'AVAX',observed:true,signConvention:'negative-is-charge'}),
    {ok:true,feeQuote:'0',feeBase:'0.001',feesComplete:true});
  assert.equal(normalizeSpotFees({amount:'-0.01',currency:'USDT',observed:true}).ok,false);
  assert.equal(normalizeSpotFees({amount:'0.01',currency:'USDT',observed:true,signConvention:'negative-is-charge'}).code,'FEE_REBATE_REQUIRES_RECONCILIATION');
  assert.equal(normalizeSpotFees({amount:'-0.01',currency:'OTHER',observed:true,signConvention:'negative-is-charge'}).ok,false);
  assert.deepEqual(normalizeSpotFees({}),{ok:true,feesComplete:false});
});
