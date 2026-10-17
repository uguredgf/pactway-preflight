const fail=code=>{throw Object.assign(new Error(code),{code,status:409});};

// The owner-scoped workflow UUID IS the idempotency key. No second random key
// can turn a consumed draft into a fresh task or reset its model budget.
export function approvalRequest(input,ownerId) {
  if(!input || typeof input!=='object' || Array.isArray(input)
      || Object.keys(input).sort().join(',')!=='acknowledgement,draftId,expectedRevision,policyHash'
      || !/^[a-f0-9-]{36}$/.test(input.draftId) || !Number.isSafeInteger(input.expectedRevision)
      || input.expectedRevision<1 || typeof input.policyHash!=='string' || input.policyHash.length>128
      || input.acknowledgement!==true || typeof ownerId!=='string' || !ownerId)fail('APPROVAL_INPUT');
  return {protocol:'APPROVE_AND_ENQUEUE_V1',ownerId,draftId:input.draftId,
    expectedRevision:input.expectedRevision,policyHash:input.policyHash,acknowledgement:true};
}

export function checkApprovalDraft(request,draft,nowMs) {
  if(draft.taskId || !draft.ready || draft.id!==request.draftId || draft.ownerId!==request.ownerId
      || draft.revision!==request.expectedRevision || draft.policyHash!==request.policyHash
      || !draft.policy || nowMs<draft.createdAtMs || nowMs>=Math.min(draft.validUntilMs,draft.policy.expiresAtMs))
    fail('APPROVAL_DRAFT_CHANGED');
}
