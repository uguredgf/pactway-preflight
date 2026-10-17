import {parseDecimal,formatDecimal} from './money.mjs';

export const DRAFT_FIELDS=Object.freeze(['budget','singleOrderNotionalMax','maxPrice','maxSharePercent','durationSeconds']);
const fail=code=>{throw Object.assign(new Error(code),{code,status:400});};
const SECRET_ASSIGNMENT=/(?:^|[\s{[(,;])["']?(?:api[_ -]?key|secret[_ -]?key|passphrase|private[_ -]?key|access[_ -]?token|refresh[_ -]?token|mnemonic|seed(?:[_ -]?phrase)?|recovery[_ -]?phrase|ok-access-(?:key|sign|passphrase))["']?\s*[:=]/iu;
const RAW_PRIVATE_KEY=/(?:^|[^0-9a-f])(?:0x)?[0-9a-f]{64}(?:$|[^0-9a-f])/iu;
function mnemonicLike(text) {
  const words=text.trim().split(/\s+/);
  return [12,15,18,21,24].includes(words.length) && words.every(word=>/^[a-z]{2,}$/i.test(word));
}
export function draftFields(input,{partial=false}={}) {
  if(!input || typeof input!=='object' || Array.isArray(input) || Object.keys(input).some(k=>!DRAFT_FIELDS.includes(k)))fail('DRAFT_FIELDS');
  const result={};
  for(const key of DRAFT_FIELDS) {
    const value=input[key];
    if(value===undefined && partial)continue;
    if(value===null){result[key]=null;continue;}
    if(typeof value!=='string' || !/^(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,8})?$/.test(value))fail('DRAFT_AMOUNT');
    const amount=parseDecimal(value);
    if(amount<=0n || key==='maxSharePercent' && amount>parseDecimal('100'))fail('DRAFT_AMOUNT');
    if(key==='durationSeconds' && (!/^[1-9][0-9]*$/.test(value) || Number(value)>86400))fail('DRAFT_DURATION');
    result[key]=formatDecimal(amount);
  }
  return result;
}
export function safeDraftText(text) {
  if(typeof text!=='string' || !text.trim() || text.length>2000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text))fail('DRAFT_TEXT');
  // Refuse common credential forms before persistence or provider dispatch.
  // This remains a guardrail, not a classifier for arbitrary private prose.
  if(/\bsk-[A-Za-z0-9_-]{8,}|\bBearer\s+\S+|-----BEGIN [^-\r\n]*PRIVATE KEY-----/i.test(text)
      || SECRET_ASSIGNMENT.test(text) || RAW_PRIVATE_KEY.test(text) || mnemonicLike(text))fail('DRAFT_SECRET_LIKE_TEXT');
  return text.trim();
}

/** Deliberately narrow Turkish clause grammar. Unmatched clauses survive as
 * blockers; the model cannot invent a missing unit or erase a condition. */
export function inspectDraftText(input) {
  const text=safeDraftText(input),fields=Object.fromEntries(DRAFT_FIELDS.map(key=>[key,null])),unsupported=[],evidence={};
  const number='([0-9]{1,12}(?:[.,][0-9]{1,8})?)';
  const rules=[
    ['budget',new RegExp('^(?:toplam )?bütçe\\s*:?\\s*'+number+'\\s+USDT$','iu')],
    ['singleOrderNotionalMax',new RegExp('^tek emir(?: bedeli)?\\s*:?\\s*'+number+'\\s+USDT$','iu')],
    ['maxPrice',new RegExp('^(?:azami )?birim fiyat\\s*:?\\s*'+number+'\\s+USDT/AVAX$','iu')],
    ['maxSharePercent',new RegExp('^(?:azami )?AVAX payı\\s*:?\\s*%'+number+'$','iu')],
    ['durationSeconds',/^süre\s*:?\s*([1-9][0-9]{0,4})\s+(saniye|dakika|saat)$/iu],
  ];
  const clauses=text.split(/[;\n]+/).map(s=>s.trim()).filter(Boolean);
  if(clauses.length>20)fail('DRAFT_TEXT');
  for(const clause of clauses) {
    if(/^AVAX-USDT spot limit alım$/iu.test(clause))continue;
    let found=false;
    for(const [key,pattern] of rules) {
      const match=pattern.exec(clause);if(!match)continue;
      found=true;
      if(evidence[key]){unsupported.push(clause);break;}
      let value=match[1].replace(',','.').replace(/^0+(?=\d)/,'');
      if(key==='durationSeconds')value=String(Number(value)*({saniye:1,dakika:60,saat:3600}[match[2].toLocaleLowerCase('tr-TR')]));
      try {fields[key]=draftFields({[key]:value},{partial:true})[key];evidence[key]=clause;}
      catch {unsupported.push(clause);}
      break;
    }
    if(!found)unsupported.push(clause);
  }
  return {fields,unsupported,evidence};
}
