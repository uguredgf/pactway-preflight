// Acceptance source only; not executed. No browser, server, provider or SDK IO.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {canApprove,makeApproval,parsePending,taskDisplay,ReceiptCursor,decimalText,ratioPercent,knownMode,fixtureMode,workPanelVisible,stopNotice} from '../public/ui-state.mjs';
import {eventLabel,eventMessage,governorMessage,requestMessage} from '../public/messages.mjs';

const draft=()=>({id:'12345678-1234-1234-1234-123456789abc',revision:2,policyHash:'a'.repeat(64),
  ready:true,taskId:null,missing:[],unresolved:[],extractionState:'COMPLETED',validUntilMs:5000,policy:{expiresAtMs:4000}});
const task=()=>({busy:false,ledger:{phase:'WAITING',stopRequested:false,intents:[]},queueInfo:{state:'QUEUED'}});

test('failed text extraction has actionable Turkish copy without implying retry',()=>{
  assert.equal(requestMessage('EXTRACTION_NOT_APPLIED'),
    'Metindeki alanlar güvenilir biçimde çıkarılamadı. Aynı taslağın alanlarını elle düzenleyebilirsin.');
  assert.equal(requestMessage('OTHER_CODE'),null);
});

test('empty records stay hidden except when uncertain draft creation needs recovery',()=>{
  assert.equal(workPanelVisible({tasks:0,drafts:0}),false);
  assert.equal(workPanelVisible({tasks:1,drafts:0}),true);
  assert.equal(workPanelVisible({tasks:0,drafts:1}),true);
  assert.equal(workPanelVisible({tasks:0,drafts:0},true),true);
});
test('unconfirmed stop remains associated with its task when viewing another task',()=>{
  assert.equal(stopNotice(null,'task-b'),'');
  assert.match(stopNotice('task-a','task-a'),/^Durdurma isteği doğrulanmadı/);
  assert.match(stopNotice('task-a','task-b'),/Başka bir görevde.*task-a/);
  assert.match(stopNotice('task-a',null),/Görevler listesinden/);
});
test('jury layout keeps budget visible and removes duplicate graphics without losing controls',()=>{
  const html=readFileSync(new URL('../app.html',import.meta.url),'utf8');
  const app=readFileSync(new URL('../public/app.mjs',import.meta.url),'utf8');
  assert.doesNotMatch(html,/data-graphic-motion/);
  assert.doesNotMatch(app,/inspectorLayout|compactInspector|\.inspector-panel/);
  assert.equal((html.match(/id="opening-graphic"/g)??[]).length,1);
  assert.ok(html.indexOf('id="policy-form"')<html.indexOf('id="opening-graphic"'),'Mobile DOM reaches form before decorative controls');
  assert.ok(html.indexOf('id="budget"')<html.indexOf('id="limits"'));
  assert.match(html,/<details><summary>Onaylı sınırlar<\/summary>/);
  assert.match(html,/<details><summary>Tam politika ve teknik ayrıntılar<\/summary><p class="meta" id="draft-usage">/);
  assert.match(app,/mode==='text' && !appStatus\?\.extractorAvailable/);
  assert.match(app,/workPanelVisible\(workCounts,creationUncertain\)/);
  assert.match(html,/id="text-draft-button"[^>]*>1\/2 · Metni incelemeye aç/);
  assert.match(html,/id="extract-draft"[^>]*>2\/2 · Metinden alanları çıkar · 1 çağrı/);
  assert.ok(html.indexOf('id="extract-draft"')<html.indexOf('id="draft-editor"'),'Local extraction action precedes collapsed editor');
  assert.match(html,/class="dialog-actions extraction-actions"/);
  assert.match(html,/id="join-button">Demo oturumunu aç/);
  assert.match(html,/Cüzdan: gerekmez/);
  assert.match(html,/id="task-chain-scope">Avalanche'a gönderilmedi/);
  assert.match(html,/id="market-context"[^>]*aria-labelledby="market-title"[^>]*hidden/);
  assert.match(html,/id="market-refresh">Piyasa verisini getir/);
  assert.match(html,/Bu gözlem görev fiyatını, bütçeyi veya simülasyon sonucunu otomatik değiştirmez/);
  assert.match(app,/api\('\/api\/market\/refresh',\{\}\)/);
  assert.match(app,/value\.orderSubmissionEnabled===false && value\.executionMode==='fixture'/);
  assert.match(app,/status\.atk\.marketReadAvailable===true/);
  assert.match(html,/id="fuji-refresh" hidden>Fuji kanıtını yeniden doğrula/);
  assert.match(app,/api\('\/api\/avalanche\/refresh',\{\}, \{timeoutMs:30000\}\)/);
  assert.match(html,/id="task-text"[^>]*placeholder="AVAX-USDT spot limit alım; bütçe 100 USDT; tek emir 25 USDT; birim fiyat 25 USDT\/AVAX; AVAX payı %10; süre 10 dakika"/);
  const ids=new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]));
  const dynamic=new Set(['order-unconfirmed']);
  for(const match of app.matchAll(/\$\('#([\w-]+)'\)/g))assert.ok(ids.has(match[1]) || dynamic.has(match[1]),'Missing UI target '+match[1]);
});
test('approval display is closed for missing data, unsupported conditions, expiry and consumed drafts',()=>{
  assert.equal(canApprove(draft(),3000),true);
  for(const patch of [{ready:false},{policy:null},{policyHash:null},{taskId:'used'},{missing:['durationSeconds']},
    {unresolved:['günlük zarar %2']},{extractionState:'RUNNING'}])assert.equal(canApprove({...draft(),...patch},3000),false);
  for(const now of [4000,5000,NaN])assert.equal(canApprove(draft(),now),false);
  assert.equal(canApprove(null,3000),false);
});
test('pending approval retains only the immutable request, never a token or a fresh key',()=>{
  const input=makeApproval(draft());assert.deepEqual(parsePending(JSON.stringify(input)),input);
  assert.equal(parsePending(JSON.stringify({...input,csrf:'not-allowed'})),null);
  assert.equal(parsePending(JSON.stringify({...input,expectedRevision:0})),null);
  assert.equal(parsePending(JSON.stringify({...input,acknowledgement:false})),null);
  assert.equal(parsePending('broken'),null);
});
test('queue RUNNING with WAITING ledger is active, not permission to start a new task',()=>{
  const t=task();assert.equal(taskDisplay(t).canStartNew,false);
  t.queueInfo.state='RUNNING';assert.equal(taskDisplay(t).working,true);assert.equal(taskDisplay(t).canStartNew,false);
  t.queueInfo.state='RELEASED';assert.equal(taskDisplay(t).canStartNew,true);
  t.ledger.intents=[{state:'UNKNOWN',settled:false}];assert.equal(taskDisplay(t).canStartNew,false);
  assert.equal(taskDisplay(t).uncertain,true);assert.match(taskDisplay(t).label,/belirsiz/);
  t.ledger.stopRequested=true;assert.match(taskDisplay(t).label,/belirsiz/);
});
test('receipt identity, not rerender count, controls motion; hydration and offline history never animate',()=>{
  const c=new ReceiptCursor(),receipt=hash=>({receiptHash:hash});
  assert.equal(c.visit('task',[receipt('first')]).size,0);
  assert.deepEqual([...c.visit('task',[receipt('first'),receipt('second')])],['task:second']);
  assert.equal(c.visit('task',[receipt('first'),receipt('second')]).size,0);
  assert.equal(c.visit('other',[receipt('first')]).size,0);
  assert.equal(c.visit('task',[receipt('first'),receipt('second'),receipt('third')],{connected:false}).size,0);
  assert.equal(c.visit('task',[receipt('third')]).size,0);
  assert.equal(c.visit('task',[receipt('fourth')],{visible:false}).size,0);
  assert.equal(c.visit('task',[receipt('fourth')]).size,0);
});
test('economic display keeps sub-cent fees and large decimals without Number rounding',()=>{
  assert.equal(decimalText('100.00000001'),'100,00000001');
  assert.equal(decimalText('999999999999.99999999'),'999.999.999.999,99999999');
  assert.equal(decimalText('-0.00000001'),'-0,00000001');
  assert.equal(ratioPercent('0.00000001'),'0,000001');
  assert.equal(ratioPercent('0.002'),'0,20');assert.equal(ratioPercent('1'),'100,00');
  assert.equal(decimalText(undefined),'Doğrulanamadı');
});
test('unknown modes never default to fixture and message fallbacks do not assert execution',()=>{
  assert.equal(knownMode({executionMode:'live'}),false);assert.equal(fixtureMode(null),false);
  assert.equal(fixtureMode({executionMode:'demo-prepared'}),false);
  assert.equal(eventLabel('UNRECOGNIZED'),'Görev kaydı güncellendi');
  assert.match(eventMessage('DEMO_ATTEMPT_COMMITTED'),/ayrıca doğrulan/);
  assert.match(eventMessage('DEMO_CANCEL_ATTEMPT_COMMITTED'),/kesinleşmedi/);
  assert.match(governorMessage('NEW_CODE'),/tamamlayamadı/);
});
test('product entry uses external same-origin assets and single-approval API, not the preview simulator',()=>{
  const html=readFileSync(new URL('../app.html',import.meta.url),'utf8');
  const app=readFileSync(new URL('../public/app.mjs',import.meta.url),'utf8');
  const server=readFileSync(new URL('../src/server.mjs',import.meta.url),'utf8');
  assert.doesNotMatch(html,/<script(?![^>]*\bsrc=)[^>]*>|\son\w+=|\sstyle=/i);
  assert.doesNotMatch(html,/homepage-demo\.js|https?:\/\//);
  assert.match(app,/api\/tasks\/approve-and-enqueue/);assert.doesNotMatch(app,/api\('\/api\/tasks',/);
  assert.match(app,/receiptCursor\.visit/);assert.match(app,/task\.mode!=='fixture'/);
  assert.match(server,/\/ui-state\.mjs/);assert.match(server,/font\/woff2/);
  assert.match(server,/listPolicyWorkflows\(session\.ownerId\)/);
});
