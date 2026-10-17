import {createHash} from 'node:crypto';
import {draftIsolatedDemoEntry} from './atk-isolated-session-draft.mjs';

function replace(source,from,to) {
  const at=source.indexOf(from);
  if(at<0 || source.indexOf(from,at+from.length)!==-1)throw new Error('ATK_EXECUTION_ANCHOR');
  return source.slice(0,at)+to+source.slice(at+from.length);
}

// Transform ONLY the pinned, isolated SDK source. No IO, eval or launch here.
// The child retains upstream signing and result envelopes, but its write handler
// accepts only the exact body committed by the parent and has no resend path.
export function draftExecutionDemoEntry(manifest,upstream) {
  const isolated=draftIsolatedDemoEntry(manifest,upstream);
  if(!isolated.ok)return isolated;
  try {
    let source=isolated.source;
    source=replace(source,'config.readOnly !== true','config.readOnly !== false');
    source=replace(source,'    readOnly: true,','    readOnly: false,');
    const args=['--profile',manifest.config.profile,'--demo','--site',manifest.config.site,'--modules',
      'market,spot,account','--read-only','--no-log'];
    source=replace(source,JSON.stringify(args),JSON.stringify(args.filter(arg=>arg!=='--read-only')));
    source=replace(source,'  const tools = buildTools(config);',`  const tools = buildTools(config).filter(tool =>
    ${JSON.stringify(['market_get_ticker','market_get_orderbook','market_get_instruments','account_get_config',
      'account_get_balance','account_get_trade_fee','spot_get_order','spot_get_orders','spot_get_fills',
      'spot_get_algo_orders','spot_place_order','spot_cancel_order'])}.includes(tool.name));
  const attempted = new Set();
  const cancelled = new Set();`);
    source=replace(source,'      const response = await tool.handler(request.params.arguments ?? {}, {',String.raw`      if (tool.isWrite) {
        const args = mandateGuardOwnRecord(request.params.arguments,
          ["instId","tdMode","side","ordType","sz","px","clOrdId","ordId","_pactway"]);
        const packet = mandateGuardOwnRecord(args._pactway,["bodyText","expiresAtMs"]);
        const now = Date.now();
        if (typeof packet.bodyText !== "string" || packet.bodyText.length > 4096
            || !Number.isSafeInteger(packet.expiresAtMs) || packet.expiresAtMs <= now
            || packet.expiresAtMs > now + 300000) mandateGuardDeny();
        const body = JSON.parse(packet.bodyText);
        const place = toolName === "spot_place_order";
        if (!place && toolName !== "spot_cancel_order") mandateGuardDeny();
        const expected = place ? {instId:args.instId,tdMode:args.tdMode,side:args.side,ordType:args.ordType,
          sz:args.sz,px:args.px,clOrdId:args.clOrdId,tag:"MCP"}
          : {instId:args.instId,ordId:args.ordId,clOrdId:args.clOrdId};
        if (JSON.stringify(expected) !== packet.bodyText || JSON.stringify(body) !== packet.bodyText
            || args.instId !== "AVAX-USDT" || !/^[A-Za-z0-9]{1,32}$/.test(args.clOrdId)) mandateGuardDeny();
        if (place && (args.tdMode !== "cash" || args.side !== "buy" || args.ordType !== "limit"
            || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,8})?$/.test(args.px)
            || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,8})?$/.test(args.sz)
            || Number(args.px) <= 0 || Number(args.sz) <= 0)) mandateGuardDeny();
        if (!place && (typeof args.ordId !== "string" || !/^[1-9][0-9]{0,63}$/.test(args.ordId))) mandateGuardDeny();
        const used = place ? attempted : cancelled;
        if (used.has(args.clOrdId) || used.size >= 10000) mandateGuardDeny();
        used.add(args.clOrdId); // A failure after this point is never retried.
        const path = place ? "/api/v5/trade/order" : "/api/v5/trade/cancel-order";
        mandateGuardPackets.set(packet.bodyText,{path,expiresAtMs:packet.expiresAtMs});
        try {
          const reply = await client.privatePost(path,body,undefined,false);
          return successResult(toolName,normalizeResponse(reply),buildCapabilitySnapshot(config));
        } finally { mandateGuardPackets.delete(packet.bodyText); }
      }
      const response = await tool.handler(request.params.arguments ?? {}, {`);
    source=replace(source,'function mandateGuardFixedFetch(directDispatcher) {',
      'const mandateGuardPackets = new Map();\nfunction mandateGuardFixedFetch(directDispatcher) {');
    source=replace(source,'options.method !== "GET"\n        || options.body !== void 0',
      '!['+JSON.stringify('GET')+','+JSON.stringify('POST')+'].includes(options.method)\n        || (options.method === "GET" && options.body !== void 0)');
    source=replace(source,'    // No options spread: unknown fetch knobs, redirection and inherited dispatchers never pass through.',String.raw`    if (options.method === "POST") {
      const packet = mandateGuardPackets.get(options.body);
      if (!packet || target.search || target.pathname !== packet.path || Date.now() >= packet.expiresAtMs)
        mandateGuardDeny();
      mandateGuardPackets.delete(options.body); // Exact body may enter fetch once.
      return undiciFetch2(target.href, {method:"POST",headers,body:options.body,
        signal:options.signal,redirect:"error",dispatcher:directDispatcher});
    }
    // No options spread: unknown fetch knobs, redirection and inherited dispatchers never pass through.`);
    return Object.freeze({ok:true,code:'ATK_EXECUTION_ENTRY_PREPARED',source,
      connectionHash:manifest.configHash,isolatedDerivedSha256:createHash('sha256').update(source,'utf8').digest('hex'),
      verification:'PINNED_EXECUTION_SOURCE_ONLY',writeEnabled:false});
  } catch {return Object.freeze({ok:false,code:'ATK_EXECUTION_ANCHOR',writeEnabled:false});}
}
