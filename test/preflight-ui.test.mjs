// Static frontend contract checks only. Live browser, ATK, model and HTTP acceptance run in the final QA phase.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const html=readFileSync(new URL('../preflight.html',import.meta.url),'utf8');
const app=readFileSync(new URL('../public/preflight.mjs',import.meta.url),'utf8');
const css=readFileSync(new URL('../public/preflight.css',import.meta.url),'utf8');

test('preflight is a single operational AVAX-USDT tool, not a broad trading terminal',()=>{
  assert.match(html,/<span>Pactway<\/span>/);
  assert.match(html,/<h1 class="letter-motion" id="readiness-title" aria-label="İşlem öncesi kontrol">/);
  assert.match(html,/AVAX-USDT · spot nakit · limit alım/);
  assert.match(html,/id="step-policy"[\s\S]*id="step-candidate"[\s\S]*id="step-result"/);
  assert.match(html,/En yüksek emir bedeli <span id="max-notional-help">USDT · ücret hariç/);
  assert.match(html,/Limit fiyatı <span id="candidate-price-help">USDT \/ AVAX/);
  assert.match(html,/Miktar <span id="candidate-size-help">AVAX/);
  assert.doesNotMatch(html,/>\s*(?:Emir gönder|Emri iptal et|Portföy|Bütçe kuyruğu)\s*</i);
  assert.doesNotMatch(html,/type="password"|API anahtarı.+<input|cüzdan bağla|Remix/i);
});

test('policy review is explicit, immutable and distinguishes validity from approval time',()=>{
  assert.match(html,/id="policy-ack"/);
  assert.match(html,/id="policy-ack-group">[\s\S]*id="policy-ack"/);
  assert.match(html,/<details id="policy-details"/);
  assert.match(html,/id="policy-summary"><\/dl>[\s\S]*<details id="policy-details"/);
  assert.match(html,/id="policy-expiry" role="status"/);
  assert.match(html,/id="policy-compact" hidden/);
  assert.match(html,/onaydan sonra politika değişmez/i);
  assert.match(app,/Geçerlilik başlangıcı/);
  assert.match(app,/Bitiş/);
  assert.doesNotMatch(app,/approvedAtMs/);
  assert.match(app,/approvedByUserAtMs/);
  assert.match(app,/const currentPolicy=\(\)=>approvedPolicy\(\)&&Number\.isSafeInteger\(policy\.expiresAtMs\)&&Date\.now\(\)<policy\.expiresAtMs/);
});

test('live check mutation is CSRF-bound, UUID-idempotent and keeps an uncertain request byte-stable',()=>{
  assert.match(app,/const pendingKey='pactway-preflight-pending-v1'/);
  assert.match(app,/crypto\.randomUUID\(\)/);
  assert.match(app,/'X-MG-CSRF':csrf/);
  assert.match(app,/setStored\(pendingKey,pending\)/);
  assert.match(app,/submitStable\(pending\.path,pending\.body\)/);
  assert.match(app,/policyId:policy\.id,policyHash:policy\.policyHash,candidate:/);
  assert.match(app,/\/api\/preflight\/checks/);
  assert.doesNotMatch(app,/\/order|place_order|submit_order|transfer/i);
});

test('agent review is capability gated, bounded and keeps manual checking available',()=>{
  assert.match(html,/id="mode-agent"[^>]*value="agent"[^>]*checked/);
  assert.match(html,/id="mode-direct"[^>]*value="direct"/);
  assert.match(app,/Fiyat ve miktar yalnız azaltılabilir; emir gönderilmez/);
  assert.match(html,/id="agent-decision"[^>]*hidden/);
  assert.match(html,/id="agent-candidate-original"/);assert.match(html,/id="agent-candidate-final"/);
  assert.match(app,/status\.agentAvailable===true/);assert.match(app,/status\.agentVersion/);
  assert.match(app,/\['\/api\/preflight\/checks','\/api\/preflight\/agent-checks'\]/);
  assert.match(app,/checkMode==='agent'&&agentCapable\(\)\?'\/api\/preflight\/agent-checks':'\/api\/preflight\/checks'/);
  assert.match(app,/value\.attempts\.length!==value\.modelCallCount/);assert.match(app,/first\.action==='REVISE'&&second\.action!=='REVISE'/);
});

test('stored recovery state is session-bound with WebCrypto without persisting the CSRF token',()=>{
  assert.match(app,/crypto\.subtle\.digest\('SHA-256'/);
  assert.match(app,/sessionBinding:sessionMarker/);
  assert.match(app,/value\.sessionBinding===sessionMarker/);
  assert.doesNotMatch(app,/sessionBinding:csrf|setStored\([^\n]+csrf/);
  assert.doesNotMatch(app,/2166136261|16777619|Math\.imul/);
});

test('replays are visibly separate and use the same strict report renderer',()=>{
  for(const name of ['within-limits','limit-breach','stale-evidence'])assert.match(html,new RegExp(`data-example="${name}"`));
  assert.match(html,/id="view-live" aria-pressed="true"/);
  assert.match(html,/id="view-examples" aria-pressed="false"/);
  assert.match(html,/id="view-history" aria-pressed="false"/);
  assert.match(html,/ÖRNEK MODU/);
  assert.match(html,/canlı piyasa bağlantısını veya yerel planlayıcıyı kullanmaz/);
  assert.match(html,/class="report-context-band">[\s\S]*id="report-context"[\s\S]*id="return-live"/);
  assert.match(app,/\/api\/preflight\/examples\//);
  assert.match(app,/function renderReport\(report,checkId/);
  assert.match(app,/report\.mode==='REPLAY'/);
});

test('reports disclose advisory scope, local publication and sanitized evidence only',()=>{
  for(const verdict of ['ALLOW','BLOCK','INSUFFICIENT_DATA'])assert.match(html,new RegExp(verdict));
  assert.match(html,/ALLOW yatırım tavsiyesi veya gerçekleşme garantisi değildir/);
  assert.match(html,/Raporlar yalnız yerel kayıttır/);
  assert.match(html,/<details id="report-technical">[\s\S]*id="report-checks-details"[\s\S]*id="evidence-summary"[\s\S]*id="not-checked"[\s\S]*id="disclosure"[\s\S]*<\/details>/);
  assert.match(html,/id="report-checks-details"/);
  assert.match(html,/id="report-checks-details"><summary>Kontrol listesi<\/summary>/);
  assert.doesNotMatch(html,/Dokuz kontrol/);
  assert.match(html,/class="technical-details"/);
  assert.match(app,/report\.sanitizedEvidence===null\?report\.verdict!=='ALLOW':isRecord\(report\.sanitizedEvidence\)/);
  assert.match(app,/hash\(report\.evidenceHash\)/);
  assert.match(app,/typeof report\.disclosure==='string'/);
  assert.doesNotMatch(app,/innerHTML|outerHTML|insertAdjacentHTML/);
});

test('visible reports disclose when form inputs no longer match their snapshot',()=>{
  assert.match(html,/id="report-stale"[^>]*hidden>Önceki sonuç · güncel girdiler ve geçerlilik süresi için yeni kontrol gerekir/);
  assert.match(html,/id="result-empty"><p>Henüz görüntülenecek rapor yok\.<\/p>/);
  assert.match(app,/function markReportStale\(\)\{if\(lastLiveReport\)/);
  assert.match(app,/\$\('#candidate-form'\)\.addEventListener\('input',event=>\{markReportStale\(\)/);
  assert.match(app,/\$\('#report-stale'\)\.hidden=!entry\.stale/);
});

test('form fields expose precise help and inline error targets without browser number coercion',()=>{
  for(const id of ['max-notional','max-price','duration-seconds','candidate-price','candidate-size']){
    assert.match(html,new RegExp(`id="${id}"[^>]+aria-describedby="${id}-help ${id}-error"`));
    assert.match(html,new RegExp(`id="${id}-error" role="alert" hidden`));
  }
  assert.doesNotMatch(html,/type="number"/);
  assert.match(html,/id="candidate-notional"/);
  assert.match(html,/id="candidate-margin"/);
});

test('startup, approval and polling failures have explicit recovery controls',()=>{
  for(const id of ['boot-error','retry-startup','approval-uncertain','retry-approval','poll-recovery','retry-poll','refresh-status'])assert.match(html,new RegExp(`id="${id}"`));
  assert.match(html,/id="pending"[\s\S]*id="uncertain"[\s\S]*id="result-empty"[\s\S]*id="report"/);
});

test('progressive workflow exposes one focusable task surface and compact approved context',()=>{
  assert.match(html,/id="workspace" tabindex="-1"/);
  assert.match(html,/id="workflow-nav" hidden/);
  for(const [id,step] of [['step-policy','policy'],['step-candidate','candidate'],['step-result','result']])assert.match(html,new RegExp(`id="${id}" data-step="${step}"`));
  assert.match(html,/id="workflow-summary" hidden[\s\S]*id="workflow-policy-summary"[\s\S]*id="workflow-expiry"/);
  assert.match(html,/id="live-policy-step"[\s\S]*id="live-candidate-step"[^>]*hidden[\s\S]*id="result-step"[^>]*hidden/);
  assert.match(html,/id="candidate-title" tabindex="-1"/);
  assert.match(html,/id="result-title" tabindex="-1"/);
  assert.match(html,/id="edit-candidate" type="button" hidden/);
  assert.match(css,/\.workspace\{display:block;width:min\(100%,760px\)/);
});

test('readiness and history stay out of the primary task until requested',()=>{
  assert.match(html,/<details id="connection-details">[\s\S]*id="atk-state"[\s\S]*id="planner-state"[\s\S]*id="refresh-status"[\s\S]*<\/details>/);
  assert.match(html,/id="history-section" hidden/);
  assert.match(html,/id="history-empty" hidden>Bu oturumda henüz kayıt yok/);
});

test('layout preserves touch targets, responsive flow and reduced motion',()=>{
  assert.match(css,/min-height:44px/);
  assert.match(css,/@media\(max-width:720px\)/);
  assert.match(css,/@media\(prefers-reduced-motion:reduce\)/);
  assert.match(css,/grid-template-columns:1fr/);
  assert.match(css,/\.readiness dl div\{display:block/);
  assert.match(css,/\.readiness dd\{[^}]*text-align:left/);
  assert.match(css,/\[hidden\]\{display:none!important\}/);
  assert.match(css,/\*\{box-sizing:border-box;letter-spacing:0\}/);
  assert.doesNotMatch(css,/letter-spacing:(?!0)|font-size:clamp/);
  assert.doesNotMatch(css,/font-size:(?:10|11)px/);
});

test('operational title has per-letter hover motion without duplicating its accessible name',()=>{
  const titles=[...html.matchAll(/<h1 class="letter-motion" id="(?:access|readiness)-title" aria-label="İşlem öncesi kontrol">([\s\S]*?)<\/h1>/g)];
  assert.equal(titles.length,2);
  for(const [,content] of titles){
    assert.equal((content.match(/<span class="motion-word" aria-hidden="true">/g)??[]).length,3);
    assert.equal((content.match(/<span>[^<]<\/span>/gu)??[]).length,18);
  }
  assert.match(css,/@media\(hover:hover\) and \(pointer:fine\)/);
  assert.match(css,/\.motion-word>span:nth-child\(4n\+1\):hover\{transform:translate\(-1px,-2px\) rotate\(-2deg\)\}/);
  assert.match(css,/\.motion-word>span\{transition:none!important;transform:none!important;will-change:auto\}/);
  assert.doesNotMatch(css,/\.letter-motion:hover[^\{]*\{/);
});
