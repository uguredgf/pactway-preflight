// Local fake SDK catalog for future transport tests, not an OKX schema claim.
export const catalog=['market_get_ticker','market_get_orderbook','market_get_instruments','account_get_config',
  'account_get_balance','account_get_trade_fee','spot_get_order','spot_get_orders','spot_get_fills'].map(name=>({
    name,inputSchema:{type:'object',properties:{demo:{type:'boolean'},instId:{type:'string'},label:{type:'string'}},additionalProperties:true},
    annotations:{readOnlyHint:true,destructiveHint:false}}));
