const keys=['accountId','catalogHash','connectionHash','isolatedEntrySha256','sessionId'];
export function captureBinding(input) {
  if(!input || typeof input!=='object' || Array.isArray(input)
      || ![Object.prototype,null].includes(Object.getPrototypeOf(input)) || Object.getOwnPropertySymbols(input).length)
    throw new Error('ATK_CAPTURE_BINDING');
  const descriptors=Object.getOwnPropertyDescriptors(input);
  if(Object.keys(descriptors).sort().join(',')!==keys.join(',')
      || Object.values(descriptors).some(item=>!Object.hasOwn(item,'value')))throw new Error('ATK_CAPTURE_BINDING');
  const result=Object.fromEntries(keys.map(key=>[key,descriptors[key].value]));
  for(const key of keys) {
    const pattern=['accountId','sessionId'].includes(key)?/^[A-Za-z0-9_-]{1,128}$/:/^[a-f0-9]{64}$/;
    if(typeof result[key]!=='string' || /[\r\n]/.test(result[key]) || !pattern.test(result[key]))throw new Error('ATK_CAPTURE_BINDING');
  }
  return Object.freeze(result);
}
export function captureBindingMatches(binding,context) {
  return keys.every(key=>binding[key]===context[key]);
}
