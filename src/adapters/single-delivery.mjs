/** Internal orchestration contract. Not installed in Server/Engine. A transport
 * must synchronously start ONE exact-byte attempt, with retries/redirects off,
 * and return a sanitized ATK observation record (not arbitrary HTTP bytes).
 * Store currently rejects every commit until independent evidence is connected.
 */
export function createSingleDelivery({store,transport,clock=Date.now}) {
  if(typeof transport!=='function' || typeof clock!=='function')throw new TypeError('Internal delivery dependencies required');
  return async function deliver(input) {
    // No await, timer or queue between final checks, durable commit and invocation.
    const ticket=store.commitDemoSubmission(input,clock);
    const unknown=()=>store.markDemoSubmissionUnknown(ticket.taskId,ticket.commitmentHash);
    let attempted=false,phase='DELIVERY';
    try {
      const nowMs=clock();
      if(!Number.isSafeInteger(nowMs) || nowMs<ticket.checkedAtMs || nowMs>=ticket.validUntilMs) {
        unknown();return {code:'DELIVERY_WINDOW_EXPIRED',attempted:false,retryAllowed:false};
      }
      attempted=true;
      const reply=transport(Object.freeze({method:'POST',apiOrigin:ticket.apiOrigin,path:ticket.path,
        demoHeader:'1',bodyText:ticket.bodyText,bodySha256:ticket.bodySha256}));
      const record=await reply;
      phase='JOURNAL';
      const captured=store.captureDemoDeliveryResponse(ticket.taskId,ticket.commitmentHash,record);
      phase='RECOVERY';
      // Journal first. Correlation/preview never turns an ACK into OPEN/FILLED.
      unknown();
      return {code:'DELIVERY_RESPONSE_JOURNALLED',observationId:captured.observationId,attempted:true,retryAllowed:false};
    } catch {
      // Even a synchronous throw may have touched the socket. Never release or retry.
      if(phase==='JOURNAL')store.pauseGlobal('STORAGE_UNCERTAIN');
      try {unknown();} catch {store.pauseGlobal('STORAGE_UNCERTAIN');}
      return {code:'DELIVERY_OUTCOME_UNKNOWN',attempted,retryAllowed:false};
    }
  };
}
