// Independent operator input, never inferred from the response being checked.
// A matching UID is only a consistency check, not provenance or route proof.
export function copyAccountExpectation(input,connectionHash,accountId) {
  if(!input || typeof input!=='object' || Array.isArray(input)
      || ![Object.prototype,null].includes(Object.getPrototypeOf(input))
      || Object.getOwnPropertySymbols(input).length)throw new Error('ATK_ACCOUNT_EXPECTATION');
  const descriptors=Object.getOwnPropertyDescriptors(input);
  if(Object.keys(descriptors).sort().join(',')!=='accountId,connectionHash,expectedUid,schemaVersion'
      || Object.values(descriptors).some(item=>!Object.hasOwn(item,'value')))throw new Error('ATK_ACCOUNT_EXPECTATION');
  const value=Object.fromEntries(Object.entries(descriptors).map(([key,item])=>[key,item.value]));
  if(value.schemaVersion!==1 || value.connectionHash!==connectionHash || value.accountId!==accountId
      || typeof connectionHash!=='string' || !/^[a-f0-9]{64}$/.test(connectionHash)
      || typeof accountId!=='string' || !/^[A-Za-z0-9_-]{1,128}$/.test(accountId)
      || typeof value.expectedUid!=='string' || !/^[0-9]{1,64}$/.test(value.expectedUid))
    throw new Error('ATK_ACCOUNT_EXPECTATION');
  return Object.freeze(value);
}
