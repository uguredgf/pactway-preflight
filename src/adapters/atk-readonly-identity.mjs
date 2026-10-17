import {compareDemoAccountIdentity,openATKObservation} from './atk-market-account.mjs';

// Verify the SAME durable, directly captured identity response; never trust a
// REST preflight report or an arbitrary caller-supplied UID as capture evidence.
export async function verifyReadOnlyIdentity(client,store,accountExpectation) {
  try {
    const receipt=await client.callJournalledRead('account_get_config',{});
    const binding=client.journalContext(),saved=store.atkToolObservation(receipt.observationId);
    const source=store.atkObservationSource(receipt.observationId);
    if(source?.source!=='REGISTERED_STDIO_CAPTURE' || source.activeSession!==true)throw new Error();
    const identity=compareDemoAccountIdentity(saved?.record,{expectedBinding:binding,accountExpectation,
      nowMs:Date.now(),maxAgeMs:15000,maxSkewMs:1000});
    const opened=openATKObservation(saved?.record,{expectedTool:'account_get_config',expectedBinding:binding});
    if(!identity.ok || !opened.ok || opened.rows.length!==1 || opened.rows[0].perm!=='read_only')throw new Error();
    store.consumeReadOnlyEvidence({observationId:receipt.observationId,expectedBinding:binding,
      expectedTool:'account_get_config',expectedArgs:{},expectedPayloadHash:saved.record.payloadHash,
      action:'READ_ONLY_IDENTITY_VERIFIED'});
    return Object.freeze({accountExpectationState:'CAPTURED_UID_MATCHED',readPermissionConfirmed:true,writeEnabled:false});
  }catch{
    try{store.pauseGlobal('SAFETY_PROCESSING_FAILED');}finally{await client.close();}
    throw Object.assign(new Error('ATK_READONLY_IDENTITY_REJECTED'),{code:'ATK_READONLY_IDENTITY_REJECTED'});
  }
}
