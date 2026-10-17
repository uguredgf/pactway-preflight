const FALLBACK_CODES=new Set(['FUJI_RPC_HTTP','FUJI_POLICY_RPC_HTTP','FUJI_DECISION_RPC_HTTP']);

/** Maps only the public RPC rate-limit boundary. Response bodies and headers never escape. */
export async function requireFujiRpcHttp(response,fallbackCode='FUJI_RPC_HTTP') {
  if(response?.ok===true)return response;
  try {await response?.body?.cancel();}catch {}
  if(!FALLBACK_CODES.has(fallbackCode))throw new TypeError('FUJI_RPC_HTTP_CODE');
  const code=response?.status===429?'FUJI_RPC_RATE_LIMITED':fallbackCode;
  throw Object.assign(new Error(code),{code});
}
