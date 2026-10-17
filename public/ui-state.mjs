// Display-only projections. Never a replacement for Store/SDK admission gates.
export const fieldLabels={budget:'Görev bütçesi · USDT',singleOrderNotionalMax:'Tek emir bedeli · USDT',
  maxPrice:'Birim fiyat · USDT/AVAX',maxSharePercent:'AVAX payı · %',durationSeconds:'Süre · saniye'};
export const fixtureMode=status=>status?.executionMode==='fixture';
export const knownMode=status=>['fixture','demo-prepared'].includes(status?.executionMode);
export const workPanelVisible=(counts,recoveryNeeded=false)=>Boolean(counts.tasks || counts.drafts || recoveryNeeded);
export function stopNotice(unconfirmedTaskId,currentTaskId){
  if(!unconfirmedTaskId)return '';
  return unconfirmedTaskId===currentTaskId
    ?'Durdurma isteği doğrulanmadı. Yeni iş kapalı; açık emir takibini kontrol et veya durdurmayı yeniden dene.'
    :'Başka bir görevde durdurma isteği doğrulanmadı ('+unconfirmedTaskId.slice(0,8)+'). Yeni iş kapalı. Görevler listesinden o kayda dönüp sonucu kontrol et.';
}
export function decimalText(value) {
  const source=String(value);
  if(!/^-?\d+(\.\d+)?$/.test(source))return 'Doğrulanamadı';
  const [whole,fraction='']=source.split('.');
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g,'.')+','+fraction.replace(/0+$/,'').padEnd(2,'0');
}
export function ratioPercent(value) {
  const source=String(value);if(!/^\d+(\.\d+)?$/.test(source))return 'Doğrulanamadı';
  const [whole,fraction='']=source.split('.'),padded=fraction.padEnd(2,'0');
  return decimalText((whole+padded.slice(0,2)).replace(/^0+(?=\d)/,'')+'.'+(padded.slice(2)||'0'));
}
export function canApprove(draft,now) {
  return !!(draft?.ready && !draft.taskId && draft.policy && draft.policyHash && !draft.missing?.length
    && !draft.unresolved?.length && draft.extractionState!=='RUNNING' && Number.isFinite(now)
    && now<Math.min(draft.validUntilMs,draft.policy.expiresAtMs));
}
export function makeApproval(draft) {
  return {draftId:draft.id,expectedRevision:draft.revision,policyHash:draft.policyHash,acknowledgement:true};
}
export function parsePending(value) {
  try {const p=JSON.parse(value);
    if(Object.keys(p).sort().join(',')!=='acknowledgement,draftId,expectedRevision,policyHash'
        || !/^[a-f0-9-]{36}$/.test(p.draftId) || !/^[a-f0-9]{64}$/.test(p.policyHash)
        || !Number.isSafeInteger(p.expectedRevision) || p.expectedRevision<1 || p.acknowledgement!==true)return null;
    return p;
  } catch {return null;}
}
// Local reminders only: restored IDs never grant ownership or authorize a request.
export function parsePendingStops(value) {
  try {
    const ids=JSON.parse(value);
    if(!Array.isArray(ids) || !ids.every(id=>typeof id==='string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id)))return [];
    return [...new Set(ids)];
  } catch {return [];}
}
export function taskDisplay(task) {
  const intent=task.ledger.intents.find(i=>!i.settled),queue=task.queueInfo?.state??task.queue?.state;
  const working=queue==='RUNNING' || task.busy;
  const uncertain=!!intent && ['UNKNOWN','SUBMITTING','CANCEL_PENDING'].includes(intent.state);
  const canStartNew=!intent && !working && !['QUEUED','BLOCKED'].includes(queue)
    && ['WAITING','STOPPED'].includes(task.ledger.phase);
  const label=intent?.state==='UNKNOWN'?'Emir sonucu belirsiz':task.ledger.stopRequested?
    (intent?'Durdurma kayıtlı · emir takibi sürüyor':'Durduruldu'):queue==='QUEUED'?'Sırada':working?
    (intent?'Emir takibi sürüyor':'Öneri ve kontroller sürüyor'):intent?'Emir takibi sürüyor':queue==='CANCELLED'?'Sıra kapatıldı':'Bekliyor';
  return {intent,queue,working,uncertain,canStartNew,label};
}
export class ReceiptCursor {
  #tasks=new Map();
  visit(taskId,receipts,{visible=true,connected=true}={}) {
    const hydrated=this.#tasks.has(taskId),seen=this.#tasks.get(taskId)??new Set(),animate=new Set();
    for(const receipt of receipts) {
      const key=taskId+':'+receipt.receiptHash;
      if(hydrated && !seen.has(key) && visible && connected)animate.add(key);
      seen.add(key);
    }
    this.#tasks.set(taskId,seen);return animate;
  }
  clear(){this.#tasks.clear();}
}
