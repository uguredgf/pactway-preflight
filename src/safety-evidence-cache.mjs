import {hashPolicy} from './domain/governor.mjs';

/** Process-local evidence retained BEFORE storage fails. This is neither a
 * durable backup nor independently verified exchange identity/dispatch authority.
 */
export class SafetyEvidenceCache {
  #entries=new Map();
  rememberVerifiedTask(state) {
    if(hashPolicy(state.policy)!==state.approvedPolicyHash)throw new Error('Safety policy mismatch');
    const updates=[];
    for(const intent of state.ledger.intents.filter(item=>!item.settled)) {
      const value={taskId:state.id,intentId:intent.id,accountId:state.policy.accountId,
        connectionVersion:state.policy.connectionVersion ?? null,policyHash:state.approvedPolicyHash,
        clOrdId:intent.clOrdId,ordId:intent.ordId ?? null};
      for(const key of ['taskId','intentId','accountId','clOrdId'])
        if(typeof value[key]!=='string' || !value[key] || value[key].length>128)throw new Error('Safety identity invalid');
      if(value.ordId!==null && (typeof value.ordId!=='string' || !value.ordId || value.ordId.length>128))throw new Error('Safety order invalid');
      const key=JSON.stringify([value.taskId,value.intentId]),old=this.#entries.get(key);
      if(old && (old.accountId!==value.accountId || old.policyHash!==value.policyHash || old.clOrdId!==value.clOrdId
          || old.connectionVersion!==value.connectionVersion || old.ordId && old.ordId!==value.ordId))throw new Error('Safety identity changed');
      updates.push([key,Object.freeze(value)]);
    }
    if(this.#entries.size+updates.filter(([key])=>!this.#entries.has(key)).length>1024)throw new Error('Safety evidence limit');
    const active=new Set(updates.map(([key])=>key));
    for(const [key,value] of this.#entries)if(value.taskId===state.id && !active.has(key))this.#entries.delete(key);
    for(const [key,value] of updates)this.#entries.set(key,value);
  }
  recoveryWork() {
    return [...this.#entries.values()].map(value=>Object.freeze({...value,action:'QUERY',priority:0,
      dispatchAllowed:false,reason:'CACHED_IDENTITY_REQUIRES_VERIFIED_TRANSPORT',evidence:'PRE_FAILURE_LOCAL_AUDIT',
      cancellationConfirmed:false,settlementConfirmed:false}));
  }
}
