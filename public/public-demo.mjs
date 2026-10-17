import {PUBLIC_REPLAY_EXAMPLES} from './examples.mjs';

const $=selector=>document.querySelector(selector);
const text=(element,value)=>{element.textContent=String(value??'');};
const node=(tag,value,className)=>{const element=document.createElement(tag);if(value!==undefined)text(element,value);if(className)element.className=className;return element;};
const verdictCopy={
  ALLOW:'Yalnız kapsam dahilindeki kontroller geçti. Bu bir alım veya kâr önerisi değildir.',
  BLOCK:'Bilinen bir politika ya da enstrüman kuralı ihlal edildi. Emir gönderilmedi.',
  INSUFFICIENT_DATA:'Güvenilir ve taze kanıtla kontrol tamamlanamadı. Emir gönderilmedi.'
};
const reasonLabels={
  PASS:'Kontrol geçti',WITHIN_LIMITS:'Öneri mevcut sınırlar içinde',PRICE_CAP_EXCEEDED:'Fiyat üst sınırı aşıldı',
  EVIDENCE_STALE_OR_FUTURE:'Kanıt eski veya gelecek zamanlı',POLICY_NOT_CURRENT:'Politika artık geçerli değil',
  AGENT_PLAN_UNAVAILABLE:'Salt okunur araç planı kullanılamadı',CANDIDATE_SCOPE_MISMATCH:'Öneri sabit kapsam dışında',
  NOTIONAL_CAP_EXCEEDED:'Emir bedeli üst sınırı aşıldı',EVIDENCE_UNAVAILABLE:'Güvenilir kanıt yok',
  EVIDENCE_BINDING_MISMATCH:'Kanıt farklı bağlantıya ait',EVIDENCE_TIME_SKEW:'Kanıt zamanları uyuşmuyor',
  INSTRUMENT_SCOPE_MISMATCH:'Enstrüman kuralları kapsamla uyuşmuyor',INSTRUMENT_NOT_LIVE:'Enstrüman canlı işleme açık değil',
  INSTRUMENT_RULES_INVALID:'Enstrüman kuralları geçersiz',INSTRUMENT_RULES_UNAVAILABLE:'Enstrüman kuralları alınamadı',
  PRICE_OFF_GRID:'Fiyat izin verilen adıma uymuyor',SIZE_OFF_GRID:'Miktar izin verilen adıma uymuyor',
  SIZE_BELOW_MINIMUM:'Miktar minimumun altında',SIZE_ABOVE_MAXIMUM:'Miktar maksimumun üstünde',
  INSUFFICIENT_EVIDENCE:'Karar için yeterli kanıt yok'
};
const labels={
  'within-limits':'Sınırlar içinde','limit-breach':'Limit ihlali','stale-evidence':'Eski veri'
};
let currentName=null;

function addDefinition(list,label,value) {
  const row=node('div');row.append(node('dt',label),node('dd',value));list.append(row);
}
function scalarEntries(value,prefix='',rows=[]) {
  if(rows.length>=14)return rows;
  if(value===null||['string','number','boolean'].includes(typeof value)){rows.push([prefix||'değer',String(value)]);return rows;}
  if(Array.isArray(value)){value.slice(0,8).forEach((item,index)=>scalarEntries(item,`${prefix}[${index}]`,rows));return rows;}
  if(value&&typeof value==='object')for(const [key,item] of Object.entries(value))scalarEntries(item,prefix?`${prefix}.${key}`:key,rows);
  return rows;
}
function safeTime(value) {
  return new Intl.DateTimeFormat('tr-TR',{dateStyle:'medium',timeStyle:'short',timeZone:'UTC'}).format(new Date(value))+' UTC';
}
function reasonItems(report) {
  const codes=report.reasonCodes.length?report.reasonCodes:report.verdict==='ALLOW'?['PASS']:[];
  return codes.map(code=>{const item=node('li',reasonLabels[code]??'Sabit kontrol sonucu');item.title=code;return item;});
}
function renderReport(name) {
  const report=PUBLIC_REPLAY_EXAMPLES[name];if(!report)return;
  currentName=name;
  $('#result-empty').hidden=true;$('#report').hidden=false;$('#report-stale').hidden=true;
  text($('#report-context'),'Kayıtlı örnek · Bu sonuç canlı piyasa, yerel model veya kişisel hesap kullanmaz.');
  $('#report-context').hidden=false;$('#return-live').hidden=true;$('#edit-candidate').hidden=true;
  const verdict=$('#verdict');verdict.className='verdict '+(report.verdict==='ALLOW'?'allow':report.verdict==='BLOCK'?'block':'insufficient');
  text($('#verdict-code'),report.verdict);text($('#verdict-meaning'),verdictCopy[report.verdict]);
  text($('#report-mode'),'REPLAY · kayıtlı örnek');text($('#checked-at'),safeTime(report.checkedAtMs));
  $('#report-inputs').replaceChildren();
  addDefinition($('#report-inputs'),'Örnek politikası',`Azami ${report.policy.maxNotional} USDT · ${report.policy.maxPrice} USDT/AVAX · ${report.policy.durationSeconds} sn`);
  addDefinition($('#report-inputs'),'Örnek önerisi',`${report.candidate.price} USDT/AVAX · ${report.candidate.size} AVAX`);
  $('#agent-decision').hidden=true;$('#reason-list').replaceChildren(...reasonItems(report));
  $('#check-list').replaceChildren(...report.checks.map(check=>{const row=node('li'),marker=check.result==='PASS'?['✓','pass']:check.result==='BLOCK'?['×','failed']:['?','unknown'];row.title=check.reasonCode;row.append(node('span',marker[0],marker[1]),node('span',`${check.label} · ${reasonLabels[check.reasonCode]??'Kontrol sonucu'}`));return row;}));
  $('#evidence-summary').replaceChildren();
  if(report.sanitizedEvidence===null)addDefinition($('#evidence-summary'),'Kanıt','Güvenilir kanıt üretilemedi');
  else for(const [label,value] of scalarEntries(report.sanitizedEvidence))addDefinition($('#evidence-summary'),label,value);
  addDefinition($('#evidence-summary'),'evidenceHash',report.evidenceHash);
  text($('#report-policy-hash'),report.policyHash);text($('#candidate-hash'),report.candidateHash);text($('#report-hash'),report.reportHash);
  $('#agent-trace').replaceChildren(...scalarEntries(report.agentTrace).map(([label,value])=>node('li',`${label}: ${value}`)));
  $('#not-checked').replaceChildren(...report.notChecked.map(item=>node('li',item.label)));
  text($('#disclosure'),report.disclosure);$('#report-technical').open=false;
  $('#result-title').focus();
}
function downloadReport() {
  if(!currentName)return;const report=PUBLIC_REPLAY_EXAMPLES[currentName];
  const url=URL.createObjectURL(new Blob([JSON.stringify(report,null,2)],{type:'application/json'}));
  const link=node('a');link.href=url;link.download=`pactway-preflight-replay-${currentName}.json`;document.body.append(link);link.click();link.remove();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}

$('#access').hidden=true;$('#boot-error').hidden=true;$('#global-error').hidden=true;
$('#readiness').hidden=false;$('#view-controls').hidden=false;$('#workflow-nav').hidden=true;$('#workflow-summary').hidden=true;
$('#view-live').hidden=true;$('#view-history').hidden=true;$('#view-examples').setAttribute('aria-pressed','true');
$('#view-examples').setAttribute('aria-selected','true');$('#view-examples').disabled=true;
$('#replays').hidden=false;$('#workspace').hidden=false;$('#live-policy-step').hidden=true;$('#live-candidate-step').hidden=true;
$('#result-step').hidden=false;$('#history-section').hidden=true;$('#pending').hidden=true;$('#uncertain').hidden=true;$('#poll-recovery').hidden=true;
$('#report').hidden=true;$('#result-empty').hidden=false;$('#refresh-status').hidden=true;
text($('#connection'),'Statik örnek modu');$('#connection').className='connection';
text($('#readiness-note'),'Canlı bağlantı bu yayında kapalı · kayıtlı örnekler');
text($('#atk-state'),'Yerel uygulamada');text($('#planner-state'),'Yerel uygulamada');
text($('.product-intro p'),'AVAX-USDT · kayıtlı kontrol örnekleri · emir yetkisi yok');
for(const button of document.querySelectorAll('[data-example]'))button.addEventListener('click',()=>renderReport(button.dataset.example));
$('#download-report').addEventListener('click',downloadReport);
for(const [name,label] of Object.entries(labels)){const button=$(`[data-example="${name}"]`);if(button)button.setAttribute('aria-label',`${label} kayıtlı örneğini aç`);}

