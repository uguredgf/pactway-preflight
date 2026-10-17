import {governorMessage,eventLabel,eventMessage,orderLabels,requestMessage} from './messages.mjs';
import {fieldLabels,fixtureMode,knownMode,canApprove,makeApproval,parsePending,parsePendingStops,taskDisplay,ReceiptCursor,decimalText,ratioPercent,workPanelVisible,stopNotice} from './ui-state.mjs';
const $=selector=>document.querySelector(selector);
const money=decimalText,percent=ratioPercent;
const marketReadReady=status=>status?.atk?.state==='READ_ONLY_CONNECTED' && status.atk.marketReadAvailable===true
  && status.atk.orderSubmissionEnabled===false;
let csrf='', task=null, draft=null, actionBusy=false, toastTimer, polling=false, screenEpoch=0, invitedMode=false;
let connected=false,lastSeenMs=0,draftBusy=false,approvalBusy=false,accessShown=false,bootstrapBusy=false;
let sessionEpoch=0,joinBusy=false,leaveBusy=false,leaveUncertain=false;
const sessionClosing=()=>leaveBusy || leaveUncertain;
const pendingActions=new Set();
const draftsNeedingRead=new Set();
let appStatus=null,draftMutation=false,draftReadBusy=false,draftDirty=false,creationUncertain=false,initialFields=false;
let marketBusy=false,fujiBusy=false,marketObservation=null;
let workCounts={tasks:0,drafts:0};
const saved={get:key=>{try{return sessionStorage.getItem(key);}catch{return null;}},
  set:(key,value)=>{try{sessionStorage.setItem(key,value);return true;}catch{return false;}},
  remove:key=>{try{sessionStorage.removeItem(key);}catch{}}};
let pendingApproval=parsePending(saved.get('mg-pending-approval'));
const pendingStops=new Set(parsePendingStops(saved.get('mg-pending-stops')));
const stopStorageWarning='Tarayıcı saklama alanı kapalı. Durdurma sonucunu doğrulamadan sayfayı kapatma; yenileme bekleyen isteği hatırlamayabilir.';
function savePendingStops(){
  if(!pendingStops.size){saved.remove('mg-pending-stops');return true;}
  const persisted=saved.set('mg-pending-stops',JSON.stringify([...pendingStops]));
  if(!persisted)showError(stopStorageWarning);
  return persisted;
}
const receiptCursor=new ReceiptCursor();
let serverTimeMs=0,serverClockAt=performance.now();
const serverNow=()=>serverTimeMs?serverTimeMs+performance.now()-serverClockAt:NaN;
const clock=value=>new Date(value).toLocaleTimeString('tr-TR',{timeZone:'Europe/Istanbul',hour:'2-digit',minute:'2-digit',second:'2-digit'});
const text=(element,value)=>{if(element.textContent!==value)element.textContent=value;};
const rendered=new Map();

function node(tag,text,className='') { const element=document.createElement(tag); if (text!==undefined) element.textContent=text; element.className=className; return element; }
function announce(message) { $('#toast').textContent=message; $('#toast').hidden=false; clearTimeout(toastTimer); toastTimer=setTimeout(()=>$('#toast').hidden=true,4000); }
function showError(message) {$('#action-error-copy').textContent=message;$('#action-error').hidden=false;}
function clearError() {$('#action-error').hidden=true;}
function clearMarket(message='İstek üzerine tek piyasa gözlemi alınır. Görev yürütmesi simülasyon olarak kalır.') {
  marketObservation=null;
  $('#market-values').hidden=true;$('#market-evidence').hidden=true;
  for(const id of ['market-bid','market-ask','market-last','market-spread'])text($('#'+id),'—');
  text($('#market-status'),message);
}
function validMarketObservation(value) {
  const decimal=input=>typeof input==='string' && /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(input);
  const bid=Number(value?.bid),ask=Number(value?.ask),last=Number(value?.last),spread=Number(value?.spread);
  const now=serverNow(),timestampAge=Number.isFinite(now)?now-value?.exchangeTimestampMs:NaN;
  const tolerance=Math.max(1e-9,Math.abs(ask-bid)*1e-9);
  return value?.state==='LIVE_READ_ONLY' && value.source==='OKX_TR_DEMO_ATK' && value.instrument==='AVAX-USDT'
    && ['bid','ask','last','spread'].every(key=>decimal(value[key]))
    && [bid,ask,last].every(number=>Number.isFinite(number) && number>0)
    && Number.isFinite(spread) && spread>=0 && ask>=bid && Math.abs((ask-bid)-spread)<=tolerance
    && Number.isSafeInteger(value.exchangeTimestampMs) && value.exchangeTimestampMs>0
    && Number.isSafeInteger(value.observedAtMs) && value.observedAtMs>0
    && Number.isSafeInteger(value.ageMs) && value.ageMs>=0 && value.ageMs<=10000
    && value.exchangeTimestampMs<=value.observedAtMs+2000
    && (!Number.isFinite(now) || (value.observedAtMs<=now+2000 && timestampAge>=-2000 && timestampAge<=10000))
    && Math.abs((value.observedAtMs-value.exchangeTimestampMs)-value.ageMs)<=2000
    && value.freshness==='EXCHANGE_TIMESTAMP_CHECKED' && value.evidence==='JOURNALLED_AND_VALIDATED'
    && value.orderSubmissionEnabled===false && value.executionMode==='fixture' && typeof value.cached==='boolean';
}
function updateMarketFreshness() {
  if(!marketObservation)return;
  const now=serverNow(),ageMs=Number.isFinite(now)?Math.max(marketObservation.ageMs,now-marketObservation.exchangeTimestampMs):marketObservation.ageMs;
  if(ageMs>10000){clearMarket('Piyasa gözlemi 10 saniyeyi geçti; güncel fiyat için yeniden al.');return;}
  const age=ageMs<1000?'1 saniyeden yeni':Math.ceil(ageMs/1000)+' saniyelik';
  text($('#market-status'),'AVAX-USDT · '+clock(marketObservation.exchangeTimestampMs)+' Türkiye · '+age+(marketObservation.cached?' · doğrulanmış önbellek':''));
}
function renderMarket(value) {
  if(!validMarketObservation(value))throw new Error('Piyasa gözlemi doğrulanamadı.');
  marketObservation=value;
  text($('#market-bid'),money(value.bid)+' USDT');text($('#market-ask'),money(value.ask)+' USDT');
  text($('#market-last'),money(value.last)+' USDT');text($('#market-spread'),money(value.spread)+' USDT');
  updateMarketFreshness();
  text($('#market-evidence'),'Kaynak: OKX TR Demo ATK · borsa zamanı kontrol edildi · gözlem günlüğe kaydedildi · emir yetkisi yok');
  $('#market-values').hidden=false;$('#market-evidence').hidden=false;
}
function renderFuji(avalanche) {
  const fujiText=({NOT_DEPLOYED:'Bu oturumda Fuji kontratı yapılandırılmadı · yerel kayıt zincir yayını değildir.',
    VERIFYING_DEPLOYMENT:'Fuji kontratının kodu ve dağıtımı kontrol ediliyor.',
    DEPLOYMENT_VERIFIED:'Fuji kontratı doğrulandı · görev kayıtlarının zincir yayını ayrıca doğrulanmalıdır.',
    DEPLOYMENT_VERIFICATION_FAILED:'Fuji kontratı doğrulanamadı · zincir yayını başarılı sayılmadı.'})[avalanche?.state]
    || 'Zincir yayını burada bağımsız olarak doğrulanmadı.';
  const acceptanceText=({VERIFIED:' Bağımsız simülasyon testi: politika + ilk kayıt doğrulandı.',
    VERIFYING:' Bağımsız simülasyon testi kontrol ediliyor.',
    VERIFICATION_FAILED:' Bağımsız simülasyon testi doğrulanamadı.'})[avalanche?.acceptanceTest?.state] || '';
  $('#fuji-state').textContent=fujiText+acceptanceText;
  $('#fuji-refresh').hidden=avalanche?.state!=='DEPLOYMENT_VERIFICATION_FAILED';
  $('#fuji-refresh').disabled=fujiBusy || !connected || !csrf || sessionClosing();
}
async function api(path,input,{timeoutMs=10000}={}) {
  const requestSession=sessionEpoch;
  if(input!==undefined && sessionClosing() && path!=='/api/session/leave' && !/^\/api\/tasks\/[a-f0-9-]{36}\/stop$/.test(path))
    throw Object.assign(new Error('Çıkış sonucu doğrulanmadan yeni işlem başlatılamaz.'),{status:409});
  let response,result;
  try {
    response=await fetch(path,{method:input===undefined?'GET':'POST',cache:'no-store',signal:AbortSignal.timeout(timeoutMs),
      headers:input===undefined?{}:{'Content-Type':'application/json','X-MG-CSRF':csrf},
      ...(input===undefined?{}:{body:JSON.stringify(input)})});
    result=await response.json();
    if(!result || typeof result!=='object' || Array.isArray(result))throw new Error('Geçersiz yanıt');
    const serverTime=Number(response.headers.get('X-MG-Server-Time'));
    if(!Number.isSafeInteger(serverTime) || serverTime<=0)throw new Error('Sunucu zaman referansı yok');
    if(requestSession===sessionEpoch){serverTimeMs=serverTime;serverClockAt=performance.now();}
  } catch {
    if(requestSession===sessionEpoch)connection(false);
    throw Object.assign(new Error('Sunucu yanıtı doğrulanamadı. İstek ulaşmış olabilir; sonuç bilinmiyor.'),{unconfirmed:true});
  }
  if (!response.ok) throw Object.assign(new Error(requestMessage(result.error) || result.error || 'İstek tamamlanamadı.'),{status:response.status,result,
    unconfirmed:response.status>=500 || response.status===408});return result;
}
function draftCurrent(){return !draftDirty && !draftsNeedingRead.has(draft?.id) && canApprove(draft,serverNow());}
function approvalAvailability(){
  const valid=draftCurrent(),busy=approvalBusy || draftMutation || draftReadBusy || !!pendingApproval;
  const needsRead=draftsNeedingRead.has(draft?.id),locked=busy || needsRead;
  $('#ack').disabled=!valid || locked;
  $('#approve').disabled=!connected || !csrf || approvalBusy || draftMutation || draftReadBusy || (!pendingApproval && (pendingStops.size || !valid || !$('#ack').checked || appStatus?.safety?.paused || !knownMode(appStatus)));
  text($('#approve'),pendingApproval?'Aynı onayın sonucunu kontrol et':approvalBusy?'Onay kaydediliyor…':'Onayla ve sıraya al');
  $('#close-approval').disabled=busy;
  $('#save-draft').disabled=!connected || locked || !draft || !!draft.taskId || serverNow()>=draft.validUntilMs || appStatus?.safety?.paused;
  $('#extract-draft').hidden=!draft?.originalText || !appStatus?.extractorAvailable;
  $('#extract-draft').disabled=!connected || locked || !draft || draft.extractionState!=='NOT_REQUESTED' || draft.taskId || serverNow()>=draft.validUntilMs || appStatus?.safety?.paused;
  $('#refresh-draft').disabled=!connected || draftMutation || draftReadBusy || approvalBusy || !draft;
  for(const input of $('#draft-edit-form').querySelectorAll('input'))input.disabled=locked || !!draft?.taskId;
  if(draft && !valid && !pendingApproval)$('#ack').checked=false;
  if(needsRead && !draftMutation && !draftReadBusy)
    text($('#draft-status'),'Son değişikliğin sonucu doğrulanmadı. Güncel taslağı yeniden oku; eski politika onaylanamaz.');
  if(draft && !pendingApproval && serverNow()>=Math.min(draft.validUntilMs,draft.policy?.expiresAtMs??draft.validUntilMs))
    text($('#draft-status'),'İnceleme veya görev süresi doldu; onay kapalı. Süreyi değiştirmek yeni politika incelemesi gerektirir.');
  if(sessionClosing())for(const id of ['approve','ack','save-draft','extract-draft'])$('#'+id).disabled=true;
}
function taskControls(){
  if(!task)return;
  const {intent,working,canStartNew}=taskDisplay(task),phase=task.ledger.phase,queued=task.queueInfo?.state==='QUEUED';
  $('#stop').disabled=pendingActions.has('stop') || (task.ledger.stopRequested && intent?.state!=='UNKNOWN');
  const blocked=task.auditVerified!==true || task.summary.violation || task.observationBlocked;
  $('#advance').hidden=!!task.approvalRequest || task.mode!=='fixture';
  $('#advance').disabled=blocked || !!pendingStops.size || !connected || actionBusy || task.busy || queued || task.queueInfo?.state==='RUNNING' || phase!=='RUNNING' || Boolean(intent) || !(serverNow()<task.policy.expiresAtMs);
  text($('#advance'),queued?'Sıra bekleniyor':task.busy?'Asistan öneri hazırlıyor':'Görevi çalıştır →');
  $('#leave-session').disabled=!connected || !!pendingStops.size || actionBusy || working || Boolean(intent) || !!pendingApproval || draftMutation || draftReadBusy || approvalBusy;
  $('#scenario').hidden=task.mode!=='fixture' || !fixtureMode(appStatus);
  $('#partial').disabled=!connected || actionBusy || !intent || !['OPEN','PARTIAL'].includes(intent.state);
  $('#unknown').disabled=!connected || actionBusy || !intent || intent.state==='UNKNOWN' || task.ledger.stopRequested;
  $('#confirm-cancel').disabled=!connected || actionBusy || !intent || intent.state!=='CANCEL_PENDING';
  $('#new-task').hidden=!canStartNew;$('#new-task').disabled=!connected || !!pendingStops.size || actionBusy || !!pendingApproval;
  $('#download-audit').disabled=!connected;
  document.documentElement.dataset.motionState=!connected?'offline':blocked || pendingStops.size || appStatus?.safety?.paused || intent?.state==='UNKNOWN' || task.ledger.stopRequested?'blocked':working?'active':'idle';
  if(sessionClosing())for(const id of ['advance','partial','unknown','confirm-cancel','new-task'])$('#'+id).disabled=true;
  if(leaveBusy)$('#leave-session').disabled=true;
}
function connection(ok){
  connected=ok;
  text($('#connection'),ok?'Uygulama bağlı'+(lastSeenMs?' · son ekran kaydı '+clock(lastSeenMs):''):'Bağlantı doğrulanamadı'+(lastSeenMs?' · son ekran kaydı '+clock(lastSeenMs):''));
  $('#connection').classList.toggle('online',ok);
  const modeNotice=!knownMode(appStatus)?'Yürütme modu doğrulanmadı; yeni işlem kapalı.':fixtureMode(appStatus)?
    'Yerel simülasyon · Gerçek para kullanılmaz, borsaya emir gönderilmez.':
    'Demo borsa modu · sanal fon. Onaylı görev, son güvenlik kontrolleri geçerse emir gönderebilir. Bağlantı veya onay, gerçekleşme kanıtı değildir.';
  const unconfirmedStopFor=pendingStops.has(task?.id)?task.id:pendingStops.values().next().value;
  text($('#notice'),stopNotice(unconfirmedStopFor,task?.id) || (sessionClosing()?
    leaveBusy?'Çıkış isteği bekleniyor; yeni işlem kapalı.':'Çıkış sonucu doğrulanmadı; yeni işlem kapalı. Bağlantı gelince çıkışı yeniden dene.':!ok?
    'Bağlantı yok; son gözlem gösteriliyor. Yeni işlem kapalı. Durdurmayı deneyebilirsin; sunucu yanıtı gelmeden başarı sayılmaz.':
    appStatus?.safety?.paused?'Sistem duraklatıldı. Yeni iş kapalı; açık emirlerin sorgu/iptal takibi ayrı sürer.':modeNotice));
  $('#notice').classList.toggle('attention',Boolean(unconfirmedStopFor || sessionClosing() || !ok || appStatus?.safety?.paused));
  $('#saved-work').hidden=!csrf || !workPanelVisible(workCounts,creationUncertain);
  $('#market-refresh').disabled=!ok || marketBusy || !marketReadReady(appStatus);
  $('#fuji-refresh').disabled=!ok || fujiBusy || !csrf || sessionClosing();
  if(!ok && !marketBusy)clearMarket('Bağlantı doğrulanamadı; önceki piyasa gözlemi gösterilmiyor.');
  for(const id of ['draft-button','text-draft-button'])$('#'+id).disabled=!ok || !csrf || !!pendingStops.size || draftBusy || !!pendingApproval || creationUncertain || !knownMode(appStatus) || appStatus?.safety?.paused;
  for(const id of ['saved-tasks','saved-drafts','refresh-work'])$('#'+id).disabled=!ok || !csrf || actionBusy || draftBusy || approvalBusy || draftMutation || draftReadBusy || !!pendingApproval;
  $('#leave-session').disabled=!ok || !!pendingStops.size || !!pendingApproval || draftMutation || approvalBusy;
  if(!ok)document.documentElement.dataset.motionState='offline';else if(!task)document.documentElement.dataset.motionState='idle';
  taskControls();approvalAvailability();
  if(sessionClosing())for(const id of ['draft-button','text-draft-button','saved-tasks','saved-drafts'])$('#'+id).disabled=true;
  if(leaveBusy)$('#leave-session').disabled=true;
}
function showAccess(inviteRequired=true) {
  sessionEpoch++;leaveBusy=false;leaveUncertain=false;joinBusy=false;
  accessShown=true;pendingActions.clear();draftsNeedingRead.clear();pendingStops.clear();savePendingStops();
  connected=false;document.documentElement.dataset.motionState='blocked';
  invitedMode=inviteRequired;
  screenEpoch+=1;csrf='';task=null;draft=null;actionBusy=false;rendered.clear();receiptCursor.clear();saved.remove('mg-task-id');saved.remove('mg-draft-id');
  pendingApproval=null;saved.remove('mg-pending-approval');$('#saved-work').hidden=true;creationUncertain=false;
  if($('#approval').open)$('#approval').close();$('#events').replaceChildren();
  $('#workspace').hidden=true;$('#setup').hidden=true;$('.intro').hidden=true;
  $('#visitor-access').hidden=false;$('#leave-session').hidden=true;$('#draft-button').disabled=true;
  $('#invite-code').required=inviteRequired;$('#invite-code').parentElement.hidden=!inviteRequired;
  $('#visitor-description').textContent=inviteRequired?'Davet kodu yalnız demo çalışma alanını açar; cüzdan veya API anahtarı değildir. Görevlerin bu oturuma aittir.':'Cüzdan veya API anahtarı gerekmez. Bu adım yalnız bu tarayıcıya ait yeni bir demo çalışma alanı açar; eski görevlerin sahipliğini devralmaz.';
  $('#join-button').textContent=inviteRequired?'Davet koduyla demoyu aç →':'Demo oturumunu aç →';
  $('#market-context').hidden=true;marketBusy=false;fujiBusy=false;$('#fuji-refresh').hidden=true;clearMarket();
  $('#connection').textContent='Oturum bekleniyor';$('#connection').classList.remove('online');
  text($('#notice'),'Etkin oturum yok; yeni işlem için oturuma katıl. Açık emir varsa güvenlik takibi ayrıca sürer.');
  $('#notice').classList.add('attention');
}
function pairs(target,rows) { target.replaceChildren(...rows.map(([key,value])=>{const row=node('div');row.append(node('dt',key),node('dd',value));return row;})); }
function limits(policy) { return [
  ['Yürütme',policy.executionMode==='fixture'?'Yerel fixture':'Demo borsa · sanal fon'],
  ['Hesap kapsamı',policy.accountId],...(policy.campaignId?[['Kampanya / sürüm',policy.campaignId+' / '+policy.campaignVersion]]:[]),
  ['Görev bütçesi',money(policy.budget)+' USDT'],['Tek emir bedeli',money(policy.singleOrderNotionalMax)+' USDT'],
  ['Birim fiyat',money(policy.maxPrice)+' USDT'],['Tahmini pay',percent(policy.maxShare)+'%'],
  ['Emir türü','Spot · alım · limit'],['Taslak başlangıcı',clock(policy.approvedAtMs)+' · Türkiye'],
  ['Görev bitişi',clock(policy.expiresAtMs)+' · Türkiye'],['İptal istenecek süre',policy.orderLifetimeMs/1000+' saniye · kesinleşme süresi değildir'],
  ['Veri yaşı üst sınırı',policy.snapshotMaxAgeMs/1000+' saniye'],['Veri zaman farkı',policy.snapshotMaxSkewMs/1000+' saniye'],
  ['USDT ücret sınırı','Alım bedelinin %'+percent(policy.quoteFeeRateMax)+' + '+policy.quoteFeeFixedMax+' USDT'],
  ['AVAX ücret sınırı','Alım miktarının %'+percent(policy.baseFeeRateMax)],['Tamamlanma','Kısmi sonuç kabul edilir']
]; }
function eventCard(receipt) {
  const decision=receipt.source.decision;
  const li=node('li',undefined,'event'+(decision.kind==='VETO'?' veto':decision.kind==='ACCEPTED_AND_RESERVED'?' accepted':''));
  li.dataset.motionStage=['POLICY_APPROVED','POLICY_APPROVED_AND_QUEUED'].includes(decision.kind)?'0':decision.kind==='VETO' || decision.kind==='DEMO_MODEL_VETO' || decision.kind==='ACCEPTED_AND_RESERVED'?'2':decision.proposal?'1':'3';
  const mark=node('span',decision.kind==='VETO'?'!':decision.kind==='ACCEPTED_AND_RESERVED'?'✓':'·','event-node'); mark.setAttribute('aria-hidden','true');
  const body=node('div',undefined,'event-body');
  const time=node('time',clock(decision.atMs)); time.dateTime=new Date(decision.atMs).toISOString();body.append(time);
  const detail=node('details'); const summary=node('summary',eventLabel(decision.kind)); detail.append(summary);
  if (decision.proposal?.size) {
    detail.append(node('div',money(decision.proposal.size)+' AVAX × '+money(decision.proposal.price)+' USDT/AVAX önerisi','amount'));
  }
  if (decision.governor?.evidence?.estimatedShare) detail.append(node('p','Tahmini pay %'+percent(decision.governor.evidence.estimatedShare)+' · üst sınır %'+percent(task.policy.maxShare)));
  if (decision.kind==='VETO') detail.append(node('p',governorMessage(decision.governor?.code)));
  if (decision.kind!=='VETO') detail.append(node('p',eventMessage(decision.kind)));
  if(decision.kind==='DEMO_MODEL_VETO')detail.append(node('p',governorMessage(decision.code)));
  if(decision.executionCode)detail.append(node('p',eventMessage(decision.executionCode)));
  if (decision.reasonSource==='model' && decision.message) detail.append(node('p','Asistan açıklaması: '+decision.message));
  if (decision.proposal?.reason) detail.append(node('p','Asistan açıklaması: '+decision.proposal.reason));
  const technical=node('details',undefined,'event-technical');technical.append(node('summary','Teknik kayıt'),node('pre',JSON.stringify(decision,null,2)),node('p','Kayıt #'+receipt.sequence+' · '+receipt.receiptHash,'hash'));detail.append(technical);
  detail.open=['VETO','ACCEPTED_AND_RESERVED','FIXTURE_ORDER_OPEN'].includes(decision.kind);body.append(detail);li.append(mark,body);return li;
}
function render(next) {
  if (task?.id===next.id && task.revision>next.revision) return;
  const animations=receiptCursor.visit(next.id,next.receipts,{visible:!document.hidden,connected});
  if (task?.id!==next.id) { rendered.clear(); $('#events').replaceChildren(); }
  task=next; saved.set('mg-task-id',task.id);
  lastSeenMs=serverNow();if(task.ledger.stopRequested && pendingStops.delete(task.id))savePendingStops();
  $('#setup').hidden=true; $('.intro').hidden=true; $('#workspace').hidden=false;
  const {intent,label:state}=taskDisplay(task),phase=task.ledger.phase;
  const queued=task.queueInfo?.state==='QUEUED';
  text($('#task-state'),state);$('#task-state').classList.toggle('amber',intent?.state==='UNKNOWN' || phase==='STOP_REQUESTED');
  $('#task-summary').textContent=intent?'Yeni öneriler kapalı · '+money(task.summary.reserved)+' USDT ayrılmış tutar tutuluyor':'Açık emir kaydı yok · '+money(task.summary.remaining)+' USDT bütçe kaldı';
  $('#queue-status').textContent=queued?'Sıran: '+task.queueInfo.position+(task.queueInfo.waitingForReconciliation?' · Önceki emir sonucu kontrol bekliyor; başlangıç zamanı veremiyoruz.':' · Görevi beklerken durdurabilirsin.'):intent?'Emir, gerçekleşme ve ücret kayıtları eşleşene kadar yürütme sırası bu görevde kalır.':'';
  pairs($('#limits'),limits(task.policy)); pairs($('#budget'),[['Harcanan',money(task.summary.spent)+' USDT'],['Ayrılan',money(task.summary.reserved)+' USDT'],['Kalan bütçe',money(task.summary.remaining)+' USDT']]);
  const order=intent??task.ledger.intents.at(-1);
  $('#order-state').textContent=order?(order.settled?'Emir kayıtları uzlaştırıldı; gerçekleşmiş harcama korunuyor.':orderLabels[order.state]??'Emir durumu kontrol bekliyor.'):'Gönderilmiş emir kaydı yok.';
  pairs($('#order-details'),order?[['Client emir kimliği',order.clOrdId],['Borsa emir kimliği',order.ordId??'Henüz doğrulanmadı'],['Limit fiyat',order.payload.px+' USDT/AVAX'],['Miktar',order.payload.sz+' AVAX']]:[]);
  const warning=task.summary.violation || task.observationBlocked || task.auditVerified!==true || intent?.state==='UNKNOWN';
  $('#task-warning').hidden=!warning;
  $('#task-warning').textContent=task.summary.violation?'Gözlenen maliyet sınırlarla uyuşmuyor. Harcama silinmedi; yeni gönderim kapalı. Açık emrin takibi ve operatör kontrolü gerekiyor.':task.observationBlocked?
    'Bir gerçekleşme gözlemi harcama kaydıyla eşleştirilemedi. Gösterilen tutarlar eksik olabilir; yeni gönderim kapalı. Operatör kontrolü gerekiyor.':task.auditVerified!==true?
    'Yerel karar kaydı doğrulanamadı. Bu, emrin iptal edildiği anlamına gelmez. Yeni gönderim kapalı; operatör kontrolü gerekiyor.':'Emir sonucu belirsiz. Yeniden gönderim yapılmaz; ayrılan tutar korunur. Bağlantı veya durdurma yanıtı, emrin iptal edildiğini kanıtlamaz.';
  $('#policy-hash').textContent='Onay hash’i: '+task.approvedPolicyHash;
  $('#audit-status').textContent=task.auditVerified?'Yerel kayıt zincirinin hashleri tutarlı':'Yerel kayıt doğrulanamadı';
  $('#task-chain-scope').textContent='Bu görevin kaydı Avalanche\'a gönderilmedi. Fuji kontratı yalnız ayrı arşiv kanıtıdır.';
  $('#planner-label').textContent=task.plannerKind==='fixture'?'Kontrollü senaryo · LLM yok':task.plannerKind==='openai'?'API model · öneri yetkisi':'Yerel model · öneri yetkisi';
  connection(true);
  for (const receipt of task.receipts) if (!rendered.has(receipt.receiptHash)) {
    const key=task.id+':'+receipt.receiptHash,card=eventCard(receipt);card.dataset.eventId=key;
    if(animations.has(key))card.classList.add('new');rendered.set(receipt.receiptHash,card);$('#events').append(card);
  }
}
async function taskAction(action,input={}) {
  if (!task || sessionClosing() && action!=='stop' || action==='run' && pendingStops.size || pendingActions.has(action) || actionBusy && action!=='stop' || !connected && action!=='stop') return;
  const id=task.id, epoch=screenEpoch,alreadyPending=pendingStops.has(id);
  pendingActions.add(action);actionBusy=true;let stopPersisted=true;
  // Remember before dispatch: navigation/reload can happen while the response is in flight.
  if(action==='stop'){pendingStops.add(id);stopPersisted=savePendingStops();}
  connection(connected);
  try { const next=await api(`/api/tasks/${id}/${action}`,input);if(epoch!==screenEpoch || task?.id!==id)return;render(next);announce(eventLabel(next.receipts.at(-1)?.source.decision.kind)); }
  catch(error) { if(epoch===screenEpoch){
    if(action==='stop'){
      if(error.unconfirmed)connection(false);
      else if(!alreadyPending){pendingStops.delete(id);savePendingStops();}
    }
    if(error.status===401)showAccess(error.result.inviteRequired);
    showError(error.message+(stopPersisted?'':' '+stopStorageWarning));
  } }
  finally { if(epoch===screenEpoch){pendingActions.delete(action);actionBusy=pendingActions.size>0;connection(connected);} }
}
function displayDraft(next) {
  if(draft?.id===next.id && draft.revision>next.revision)return;
  const opening=!$('#approval').open || draft?.id!==next.id;
  const reconciled=draftsNeedingRead.delete(next.id);
  if(opening || reconciled)$('#approval-error').textContent='';
  draft=next;draftDirty=false;saved.set('mg-draft-id',draft.id);$('#ack').checked=false;
  $('#approval-scope').textContent=draft.policy?.executionMode==='demo-prepared' || draft.policyContext?.executionMode==='demo-prepared'
    ?'Demo borsa · sanal fon. Tek onay görevi kuyruğa alır; kontroller geçerse en fazla bir emir denemesi yapılır.'
    :'Yerel fixture · borsaya emir gönderilmez. Tek onay görevi örnek yürütücünün sırasına alır.';
  $('#draft-status').textContent=draft.taskId?'Bu taslak bir göreve bağlandı. Yeni görev oluşturmaz.':
    serverNow()>=draft.validUntilMs?'Taslak inceleme süresi doldu.':draft.ready?'Politika incelemeye hazır.':
    'Onay kapalı. Eksikler: '+(draft.missing.map(k=>fieldLabels[k]??k).join(', ') || 'yok')+' · Desteklenmeyen koşul: '+draft.unresolved.length+' · Çıkarım: '+draft.extractionState;
  $('#draft-usage').textContent='Workflow: '+draft.id+' · sürüm '+draft.revision+' · kullanılan '+(draft.usage?.total??0)+'/3 · çıkarım '+(draft.usage?.extraction??0)+'/1. Düzenleme kotayı veya başlangıç zamanını yenilemez.';
  $('#edit-fields').replaceChildren(...Object.entries(fieldLabels).map(([key,title])=>{
    const label=node('label',title),input=node('input');input.name=key;input.type='number';input.value=draft.fields[key]??'';
    input.min=key==='durationSeconds'?'1':'0.00000001';input.step=key==='durationSeconds'?'1':'any';input.inputMode=key==='durationSeconds'?'numeric':'decimal';
    if(key==='durationSeconds')input.max='86400';if(key==='maxSharePercent')input.max='100';label.append(input);return label;
  }));
  $('#unsupported-list').replaceChildren(...draft.unresolved.map(clause=>{
    const label=node('label',undefined,'ack'),input=node('input');input.type='checkbox';input.value=clause;input.name='removeCondition';
    label.append(input,node('span','Şu koşuldan vazgeçiyorum: '+clause));return label;
  }));
  $('#unsupported-fields').hidden=!draft.unresolved.length;$('#draft-editor').open=!draft.ready;
  $('#source-text').hidden=!draft.originalText;$('#original-text').textContent=draft.originalText??'';
  pairs($('#approval-limits'),draft.policy?limits(draft.policy):[]);
  $('#approval-hash').textContent=draft.policyHash?'Tam politika hash’i: '+draft.policyHash:'Tam politika henüz oluşmadı.';
  $('#approval-document').textContent=draft.policy?JSON.stringify(draft.policy,null,2):'Eksik alan ve koşullar çözülmeden politika oluşturulmaz.';
  $('#approval-expiry').textContent='İnceleme sonu: '+clock(draft.validUntilMs)+(draft.policy?' · Görev bitişi: '+clock(draft.policy.expiresAtMs):'')+' · Türkiye saati';
  if(!$('#approval').open)$('#approval').showModal();approvalAvailability();
  // A sticky heading can retain the previous dialog's scroll offset on mobile.
  // New/reopened reviews must expose scope and missing-condition warnings first.
  if(opening){$('#approval-title').focus({preventScroll:true});$('#approval').scrollTop=0;}
}
async function createDraft(input) {
  if(!connected || sessionClosing() || pendingStops.size || draftBusy || pendingApproval || creationUncertain || !knownMode(appStatus) || appStatus?.safety?.paused)return;
  const epoch=screenEpoch;draftBusy=true;connection(connected);
  try {const next=await api('/api/policy/draft',input);if(epoch!==screenEpoch)return;
    $('#approval-error').textContent='';displayDraft(next);$('#approval-title').focus();void refreshWork();
  } catch(error){if(epoch===screenEpoch){creationUncertain=!!error.unconfirmed;
    if(error.status===401)showAccess(error.result.inviteRequired);
    showError(error.unconfirmed?'Taslak sonucu bilinmiyor. Yeni taslak oluşturmadan önce “Kayıtları yenile” ile sunucudaki taslakları kontrol et.':error.message);}}
  finally {draftBusy=false;connection(connected);}
}
$('#policy-form').addEventListener('submit',event=>{event.preventDefault();void createDraft(Object.fromEntries(new FormData(event.currentTarget)));});
$('#text-form').addEventListener('submit',event=>{event.preventDefault();void createDraft({text:$('#task-text').value});});
for(const mode of ['numeric','text'])$('#'+mode+'-mode').addEventListener('click',()=>{
  if(mode==='text' && !appStatus?.extractorAvailable)return;
  $('#policy-form').hidden=mode!=='numeric';$('#text-form').hidden=mode!=='text';
  for(const id of ['numeric','text'])$('#'+id+'-mode').setAttribute('aria-pressed',String(id===mode));
});
async function readDraft(id) {
  if(draftReadBusy)return;draftReadBusy=true;approvalAvailability();
  const epoch=screenEpoch;
  try {const next=await api('/api/policy/drafts/'+id);if(epoch!==screenEpoch)return;
    if(next.taskId){const state=await api('/api/tasks/'+next.taskId);if(epoch!==screenEpoch)return;finishApproval(state);return;}
    displayDraft(next);connection(true);
  } catch(error){if(epoch===screenEpoch && error.status===401)showAccess(error.result.inviteRequired);throw error;}
  finally{draftReadBusy=false;approvalAvailability();}
}
async function mutateDraft(action,input) {
  if(!draft || sessionClosing() || draftMutation || draftReadBusy || approvalBusy || pendingApproval || draftsNeedingRead.has(draft.id) || !connected)return;
  const epoch=screenEpoch,id=draft.id;draftMutation=true;
  draftsNeedingRead.add(id);$('#ack').checked=false;approvalAvailability();
  try {const next=await api(`/api/policy/drafts/${id}/${action}`,input);if(epoch===screenEpoch && draft?.id===id)displayDraft(next);}
  catch(error){if(epoch===screenEpoch){if(error.status===401)showAccess(error.result.inviteRequired);else{
    $('#approval-error').textContent=error.message+' Güncel taslağı yeniden oku; otomatik yeniden çıkarım yapılmaz.';
    // GET-only reconciliation; never repeats the mutating request or spends another slot.
    try{
      await readDraft(id);
      if(epoch===screenEpoch && draft?.id===id && !draftsNeedingRead.has(id))
        $('#approval-error').textContent=(error.unconfirmed?'':error.message+' ')+'Güncel taslak okundu. Politikayı yeniden incele; değişiklik isteği otomatik tekrarlanmadı.';
    }catch{}}}}
  finally{draftMutation=false;approvalAvailability();}
}
$('#draft-edit-form').addEventListener('submit',event=>{
  event.preventDefault();const fields={};for(const key of Object.keys(fieldLabels)){
    const value=event.currentTarget.elements.namedItem(key).value;fields[key]=value===''?null:value;
  }
  void mutateDraft('edit',{expectedRevision:draft.revision,fields,
    removeConditions:[...$('#unsupported-list').querySelectorAll('input:checked')].map(el=>el.value)});
});
$('#draft-edit-form').addEventListener('input',()=>{
  draftDirty=true;$('#ack').checked=false;
  $('#draft-status').textContent='Kaydedilmemiş değişiklik var. Önce aynı taslağı güncelle; ardından yeni tam politikayı incele.';
  approvalAvailability();
});
$('#extract-draft').addEventListener('click',()=>void mutateDraft('extract',{expectedRevision:draft.revision}));
$('#refresh-draft').addEventListener('click',()=>{if(draft)void readDraft(draft.id).catch(error=>showError(error.message));});
$('#ack').addEventListener('change',approvalAvailability);
$('#close-approval').addEventListener('click',()=>{if(!pendingApproval && !approvalBusy && !draftMutation && !draftReadBusy)$('#approval').close();});
$('#approval').addEventListener('cancel',event=>{if(pendingApproval || approvalBusy || draftMutation || draftReadBusy)event.preventDefault();});
$('#approval').addEventListener('close',()=>{draft=null;approvalAvailability();});
function finishApproval(next) {
  pendingApproval=null;saved.remove('mg-pending-approval');saved.remove('mg-draft-id');
  screenEpoch++;draft=null;$('#approval').close();render(next);$('#task-title').focus();void refreshWork();
}
$('#approve').addEventListener('click',async()=>{
  if(!connected || sessionClosing() || approvalBusy || draftMutation || draftReadBusy || (!pendingApproval && (pendingStops.size || !draftCurrent() || !$('#ack').checked || appStatus?.safety?.paused || !knownMode(appStatus))))return;
  const epoch=screenEpoch;pendingApproval??=makeApproval(draft);
  if(!saved.set('mg-pending-approval',JSON.stringify(pendingApproval)))showError('Tarayıcı saklama alanı kapalı. Yanıt kaybolursa sayfayı kapatmadan aynı onayı kontrol et; kayıtlar sunucuda kalır.');
  approvalBusy=true;approvalAvailability();
  try {const next=await api('/api/tasks/approve-and-enqueue',pendingApproval);if(epoch!==screenEpoch || !csrf)return;
    finishApproval(next);announce(next.approvalReplayed?'Mevcut görev bulundu; yeniden başlatılmadı.':'Onay kaydedildi ve görev sıraya alındı.');
  } catch(error){if(epoch===screenEpoch){if(error.status===401)showAccess(error.result.inviteRequired);else{
    $('#approval-error').textContent=error.unconfirmed?'Onay sonucu bilinmiyor. Aynı onayın sonucunu kontrol et; yeni görev oluşturma.':error.message;
    if(!error.unconfirmed){pendingApproval=null;saved.remove('mg-pending-approval');$('#ack').checked=false;
      if(draft)try{await readDraft(draft.id);}catch{}}
  }}}finally{approvalBusy=false;connection(connected);}
});
$('#advance').addEventListener('click',()=>taskAction('run'));
$('#stop').addEventListener('click',()=>taskAction('stop'));
$('#partial').addEventListener('click',()=>taskAction('scenario',{kind:'partial'}));
$('#unknown').addEventListener('click',()=>taskAction('scenario',{kind:'unknown'}));
$('#confirm-cancel').addEventListener('click',()=>taskAction('scenario',{kind:'confirm-cancel'}));
$('#new-task').addEventListener('click',async()=>{
  if(!task || sessionClosing() || !taskDisplay(task).canStartNew || pendingApproval || pendingStops.size)return;
  if (task?.ledger.phase==='WAITING' && !task.ledger.stopRequested) { await taskAction('stop');if(task?.ledger.phase!=='STOPPED')return; }
  if(!taskDisplay(task).canStartNew || pendingApproval || pendingStops.size)return;
  screenEpoch+=1;task=null;actionBusy=false;rendered.clear();saved.remove('mg-task-id');$('#workspace').hidden=true;$('#setup').hidden=false;$('.intro').hidden=false;$('#policy-form input').focus();
  document.documentElement.dataset.motionState=connected?'idle':'offline';
});
$('#market-refresh').addEventListener('click',async()=>{
  if(marketBusy || !connected || !csrf || sessionClosing() || !marketReadReady(appStatus))return;
  const epoch=sessionEpoch;
  marketBusy=true;$('#market-refresh').disabled=true;clearMarket('OKX TR demo piyasa gözlemi alınıyor…');
  try{const observation=await api('/api/market/refresh',{});if(epoch===sessionEpoch && csrf)renderMarket(observation);}
  catch(error){if(epoch===sessionEpoch)clearMarket(error.message+' Önceki piyasa gözlemi gösterilmiyor.');}
  finally{if(epoch===sessionEpoch){marketBusy=false;$('#market-refresh').disabled=!connected || !marketReadReady(appStatus);}}
});
$('#fuji-refresh').addEventListener('click',async()=>{
  if(fujiBusy || !connected || !csrf || sessionClosing() || appStatus?.avalanche?.state!=='DEPLOYMENT_VERIFICATION_FAILED')return;
  const epoch=sessionEpoch;fujiBusy=true;$('#fuji-refresh').disabled=true;
  try{const result=await api('/api/avalanche/refresh',{}, {timeoutMs:30000});if(epoch===sessionEpoch && csrf && result?.avalanche){appStatus.avalanche=result.avalanche;renderFuji(result.avalanche);}}
  catch(error){if(epoch===sessionEpoch && error.result?.avalanche){appStatus.avalanche=error.result.avalanche;renderFuji(error.result.avalanche);}if(epoch===sessionEpoch)showError(error.message);}
  finally{if(epoch===sessionEpoch){fujiBusy=false;renderFuji(appStatus?.avalanche);}}
});
$('#download-audit').addEventListener('click',async()=>{
  if (!task)return;
  const id=task.id,epoch=screenEpoch;
  try { const bundle=await api(`/api/tasks/${id}/audit`);if(epoch!==screenEpoch)return;const url=URL.createObjectURL(new Blob([JSON.stringify(bundle,null,2)],{type:'application/json'}));
    const link=node('a');link.href=url;link.download='pactway-'+id+'.json';document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
  } catch(error) { showError(error.message); }
});
function renderStatus(status) {
  appStatus=status;
  $('#mode').textContent=!knownMode(status)?'Mod doğrulanmadı':fixtureMode(status)?'Simülasyon':'Demo borsa · sanal fon';
  $('#text-mode').disabled=!status.extractorAvailable;
  $('#text-availability').hidden=!!status.extractorAvailable;
  $('#text-availability').textContent='Metinden alan çıkarma bu sürümde kapalı. Alanlarla doldurarak ilerleyebilirsin.';
  $('#atk-state').textContent=status.atk?.state==='DEMO_EXECUTION_CONNECTED'?'Demo yürütme bağlantısı kuruldu; her gönderim ayrıca kontrol edilir.':
    status.atk?.state==='READ_ONLY_CONNECTED'?'Salt okuma bağlantısı; bu bağlantı emir göndermez.':'Bağlantı doğrulanmadı. Önceki emirlerin sonucu hakkında çıkarım yapılamaz.';
  const marketAvailable=marketReadReady(status);
  $('#market-context').hidden=!marketAvailable;$('#market-refresh').disabled=!connected || marketBusy || !marketAvailable;
  if(!marketAvailable)clearMarket('Salt okunur OKX TR bağlantısı yok; piyasa gözlemi alınamaz.');
  renderFuji(status.avalanche);
  $('#account-note').textContent=fixtureMode(status)?'Yerel örnek hesap: yaklaşık 500 USDT değer, başlangıç AVAX payı %8. Borsa bakiyesi değildir.':
    'Ortak demo hesap. Bu ekranda güncel bakiye iddiası yok; hesap, kampanya ve ücret sınırları tam politikada gösterilir.';
  if(!initialFields && knownMode(status)) {
    initialFields=true;if(fixtureMode(status))for(const [key,value] of Object.entries({budget:'100',singleOrderNotionalMax:'25',maxPrice:'25',maxSharePercent:'10',durationSeconds:'600'}))
      $('#policy-form').elements.namedItem(key).value=value;
  }
  connection(connected);
}
function workOptions(boot) {
  workCounts={tasks:boot.tasks.length,drafts:(boot.drafts??[]).length};
  $('#saved-work').hidden=!workPanelVisible(workCounts,creationUncertain);
  for(const [target,rows,label] of [['saved-tasks',boot.tasks,'Görev'],['saved-drafts',boot.drafts??[],'Taslak']]) {
    const select=$('#'+target),prior=select.value;
    select.parentElement.hidden=rows.length===0;
    select.replaceChildren(node('option',label+' seç'));
    select.firstChild.value='';
    for(const row of rows){const option=node('option',row.id.slice(0,8)+' · '+(row.phase??(row.ready?'İncelemeye hazır':'Eksik alan / koşul')));option.value=row.id;select.append(option);}
    select.value=prior;
  }
}
async function refreshWork() {
  const epoch=screenEpoch;
  try {const boot=await api('/api/work');if(epoch!==screenEpoch)return;
    workOptions(boot);creationUncertain=false;connection(true);
  } catch(error){if(epoch===screenEpoch){if(error.status===401)showAccess(error.result.inviteRequired);else showError(error.message);}}
}
$('#refresh-work').addEventListener('click',()=>void refreshWork());
$('#dismiss-error').addEventListener('click',clearError);
$('#saved-tasks').addEventListener('change',async event=>{
  const id=event.target.value;if(!id || sessionClosing() || pendingApproval || actionBusy || draftReadBusy)return;const epoch=++screenEpoch;
  try{const next=await api('/api/tasks/'+id);if(epoch===screenEpoch)render(next);}catch(error){if(epoch===screenEpoch){if(error.status===401)showAccess(error.result.inviteRequired);showError(error.message);}}
});
$('#saved-drafts').addEventListener('change',event=>{if(event.target.value && !sessionClosing() && !pendingApproval && !actionBusy && !draftReadBusy){screenEpoch++;void readDraft(event.target.value).catch(error=>showError(error.message));}});
async function acceptSession(boot) {
  sessionEpoch++;leaveBusy=false;leaveUncertain=false;
  accessShown=false;
  // The authenticated owner-scoped list is the authority, not local storage.
  const ownedIds=new Set(boot.tasks.map(row=>row.id));
  for(const id of pendingStops)if(!ownedIds.has(id))pendingStops.delete(id);
  savePendingStops();
  invitedMode=boot.status.accessMode==='INVITED_VISITORS';
  csrf=boot.csrf;$('#visitor-access').hidden=true;$('#leave-session').hidden=false;
  $('#setup').hidden=false;$('.intro').hidden=false;$('#join-error').textContent='';
  renderStatus(boot.status);workOptions(boot);connection(true);
  if(pendingApproval) {
    try{
      await readDraft(pendingApproval.draftId);
      // Recovery may find a task committed after the bootstrap snapshot was read.
      // finishApproval already selected it; stale boot.tasks must not replace it.
      if(!pendingApproval)return;
    }catch(error){if(error.status===404){pendingApproval=null;saved.remove('mg-pending-approval');}else throw error;}
    if(pendingApproval){$('#approval-error').textContent='Önceki onayın sonucu doğrulanmalı. Aynı onayı kontrol etmek yeni görev oluşturmaz.';approvalAvailability();return;}
  }
  const local=saved.get('mg-task-id'),id=boot.tasks.some(t=>t.id===local)?local:boot.tasks[0]?.id,epoch=screenEpoch;
  if(!id)connection(true);
  if(id)try {const restored=await api('/api/tasks/'+id);if(epoch===screenEpoch)render(restored);}
  catch(error){if(epoch===screenEpoch){if(error.status===404)saved.remove('mg-task-id');if(error.status===401)showAccess(error.result.inviteRequired);else showError(error.message);}}
  const draftId=saved.get('mg-draft-id');
  if(!id && draftId && (boot.drafts??[]).some(d=>d.id===draftId))await readDraft(draftId);
}
$('#join-form').addEventListener('submit',async event=>{
  event.preventDefault();if(joinBusy || !accessShown || sessionClosing())return;
  const epoch=sessionEpoch;joinBusy=true;$('#join-button').disabled=true;$('#join-error').textContent='';
  try {const boot=await api('/api/session/join',{inviteCode:$('#invite-code').value});if(epoch!==sessionEpoch)return;
    $('#invite-code').value='';await acceptSession(boot);}
  catch(error){if(epoch===sessionEpoch)$('#join-error').textContent=error.message;}
  finally{joinBusy=false;$('#join-button').disabled=false;}
});
$('#leave-session').addEventListener('click',async()=>{
  if(!csrf || !connected || leaveBusy || pendingStops.size || pendingApproval || actionBusy || draftBusy || draftMutation || draftReadBusy || approvalBusy)return;
  const epoch=sessionEpoch;leaveBusy=true;connection(connected);
  try {await api('/api/session/leave',{});if(epoch!==sessionEpoch)return;showAccess(invitedMode);announce('Oturum kapatıldı.');}
  catch(error){if(epoch===sessionEpoch){
    if(error.status===401)showAccess(error.result.inviteRequired);
    else leaveUncertain=leaveUncertain || !!error.unconfirmed;
    showError(error.message);
  }}
  finally{if(epoch===sessionEpoch){leaveBusy=false;connection(connected);}}
});
async function bootstrap() {
  if(bootstrapBusy)return;bootstrapBusy=true;
  try {
    await acceptSession(await api('/api/bootstrap'));
  } catch(error) {
    if(error.status===401){showAccess(error.result.inviteRequired);return;}
    connection(false);
  }
  finally {bootstrapBusy=false;}
}
await bootstrap();
async function poll(){
  if(polling || document.hidden)return;
  if(!csrf){if(!accessShown)await bootstrap();return;}
  polling=true;const id=task?.id,epoch=screenEpoch;
  try {
    const status=await api('/api/status');if(epoch!==screenEpoch)return;renderStatus(status);
    if(pendingApproval && !draft && !draftReadBusy && !approvalBusy) {
      try {await readDraft(pendingApproval.draftId);}
      catch(error){if(error.status===404){pendingApproval=null;saved.remove('mg-pending-approval');showError('Önceki onayın taslağı bu oturuma ait değil veya bulunamadı. Mevcut görevleri kontrol et.');}else throw error;}
      if(epoch!==screenEpoch)return;
    }
    if(id){const next=await api(`/api/tasks/${id}`);if(epoch===screenEpoch && (!task || task.id===id))render(next);}
    if(epoch===screenEpoch)connection(true);
  } catch(error) { if(epoch===screenEpoch){if(error.status===401)showAccess(error.result.inviteRequired);else connection(false);} }
  finally {polling=false;}
}
setInterval(()=>{void poll();},2000);
setInterval(()=>{if(!document.hidden){approvalAvailability();taskControls();updateMarketFreshness();}},1000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden)void poll();});
window.addEventListener('offline',()=>connection(false));
window.addEventListener('online',()=>void poll());
