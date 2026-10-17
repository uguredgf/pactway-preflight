import test from 'node:test';
import assert from 'node:assert/strict';
import { PreflightAgentReviewer } from '../src/preflight/agent-reviewer.mjs';

const policy = { id: 'p1', policy: { instrument: 'AVAX-USDT', side: 'buy', tdMode: 'cash', ordType: 'limit', maxNotional: '100', maxPrice: '25', durationSeconds: '60' } };
const candidate = { instrument: 'AVAX-USDT', side: 'buy', tdMode: 'cash', ordType: 'limit', price: '24.95', size: '1' };
const report = { verdict: 'BLOCK', reasonCodes: ['PRICE_OFF_GRID'], checks: [{ id: 'price-grid', result: 'BLOCK', reasonCode: 'PRICE_OFF_GRID' }], sanitizedEvidence: { ticker: { referencePrice: '24.95', reference: 'BEST_ASK' }, instrument: { instrument: { state: 'live', tickSz: '0.01', lotSz: '0.01', minSz: '0.1', maxLmtSz: '1000' } } } };
const envelope = content => new Response(JSON.stringify({ model: 'qwen3:4b-instruct', done: true, done_reason: 'stop', message: { role: 'assistant', content } }), { status: 200 });
const make = (content, reserveCall = () => true, fetchImpl) => new PreflightAgentReviewer({ model: 'qwen3:4b-instruct', reserveCall, fetchImpl: fetchImpl ?? (async () => envelope(content)) });
const input = { checkId: 'check-1', ownerId: 'owner-1', policyRecord: policy, initialCandidate: candidate, currentCandidate: candidate, report, attempt: 1 };

test('reviewer reserves before one local request and sends only sanitized read-only data', async () => {
  const events = [];
  const reviewer = make(JSON.stringify({ action: 'REVISE', candidate: { price: '24.94', size: '1' }, reasonCode: 'NORMALIZE_TO_RULES' }), value => { events.push(['reserve', value]); return true; }, async (url, options) => { events.push('fetch'); const body = JSON.parse(options.body); assert.equal(url, 'http://127.0.0.1:11434/api/chat'); assert.equal(body.think, false); assert.equal(body.options.temperature, 0); const sent = JSON.parse(body.messages[1].content); assert.equal(sent.policy.maxPrice, '25'); assert.equal(sent.report.verdict, 'BLOCK'); assert.equal(sent.market.tickSz, '0.01'); assert.equal(sent.serverDerived.revisionFeasible, true); assert.deepEqual(sent.serverDerived.suggestedCandidate,{price:'24.95',size:'1'}); assert.equal(sent.policyRecord, undefined); assert.equal(sent.report.sanitizedEvidence, undefined); return envelope(JSON.stringify({ action: 'REVISE', candidate: { price: '24.94', size: '1' }, reasonCode: 'NORMALIZE_TO_RULES' })); });
  assert.deepEqual(await reviewer.review(input), { action: 'REVISE', candidate: { price: '24.94', size: '1' }, reasonCode: 'NORMALIZE_TO_RULES' });
  assert.deepEqual(events.map(event => Array.isArray(event) ? event[0] : event), ['reserve', 'fetch']);
});

test('quota denial and remote endpoint never dispatch a request', async () => {
  let calls = 0;
  const reviewer = make('{}', () => false, async () => { calls++; });
  await assert.rejects(() => reviewer.review(input), error => error.code === 'PREFLIGHT_AGENT_LIMIT'); assert.equal(calls, 0);
  for (const url of ['https://example.com/api/chat', 'http://192.0.2.1/api/chat', 'http://127.0.0.1/api/chat?q=x']) assert.throws(() => new PreflightAgentReviewer({ url, model: 'qwen3:4b-instruct', reserveCall: () => true }), /PREFLIGHT_AGENT_CONFIGURATION/);
  for (const model of ['qwen:cloud', 'https://example.com/model', '']) assert.throws(() => new PreflightAgentReviewer({ model, reserveCall: () => true }), /PREFLIGHT_AGENT_CONFIGURATION/);
});

test('malformed, injected, unavailable, and non-stop responses fail closed without retries', async () => {
  for (const content of [JSON.stringify({ action: 'WAIT', candidate: null, reasonCode: 'INSUFFICIENT_EVIDENCE', extra: true }), JSON.stringify({ action: 'ACCEPT', candidate: null, reasonCode: 'WITHIN_LIMITS' }), '{']) {
    let reservations = 0, requests = 0;
    const reviewer = make(content, () => { reservations++; return true; }, async () => { requests++; return envelope(content); });
    if (content.includes('"ACCEPT"')) await assert.rejects(() => reviewer.review(input), error => error.code === 'PREFLIGHT_AGENT_INVALID');
    else await assert.rejects(() => reviewer.review(input), error => error.code === 'PREFLIGHT_AGENT_INVALID');
    assert.equal(reservations, 1); assert.equal(requests, 1);
  }
  const unavailable = make('{}', () => true, async () => { throw new Error('network detail'); });
  await assert.rejects(() => unavailable.review(input), error => error.code === 'PREFLIGHT_AGENT_UNAVAILABLE' && !error.message.includes('network detail'));
  let requests = 0;
  const httpFailure = make('{}', () => true, async () => { requests++; return new Response('', { status: 503 }); });
  await assert.rejects(() => httpFailure.review(input), error => error.code === 'PREFLIGHT_AGENT_UNAVAILABLE');
  assert.equal(requests, 1);
  const nonStop = make('{}', () => true, async () => new Response(JSON.stringify({ done: false, done_reason: 'length', message: { role: 'assistant', content: '{}' } })));
  await assert.rejects(() => nonStop.review(input), error => error.code === 'PREFLIGHT_AGENT_INVALID');
  const injectedEnvelope = make('{}', () => true, async () => new Response(JSON.stringify({ model: 'qwen3:4b-instruct', done: true, done_reason: 'stop', message: { role: 'assistant', content: '{}', tool_calls: [] } })));
  await assert.rejects(() => injectedEnvelope.review(input), error => error.code === 'PREFLIGHT_AGENT_INVALID');
});

test('accept requires ALLOW and revise candidate is canonical, bounded, and on grid', async () => {
  const accept = make(JSON.stringify({ action: 'ACCEPT', candidate: null, reasonCode: 'WITHIN_LIMITS' }));
  await assert.rejects(() => accept.review(input), error => error.code === 'PREFLIGHT_AGENT_INVALID');
  const revise = make(JSON.stringify({ action: 'REVISE', candidate: { price: '24.94', size: '0.1' }, reasonCode: 'NORMALIZE_TO_RULES' }));
  assert.deepEqual(await revise.review(input), { action: 'REVISE', candidate: { price: '24.94', size: '0.1' }, reasonCode: 'NORMALIZE_TO_RULES' });
  const formatted = make(JSON.stringify({ action: 'REVISE', candidate: { price: '24.940', size: '0.100' }, reasonCode: 'NORMALIZE_TO_RULES' }));
  assert.deepEqual(await formatted.review(input), { action: 'REVISE', candidate: { price: '24.94', size: '0.1' }, reasonCode: 'NORMALIZE_TO_RULES' });
  const bad = make(JSON.stringify({ action: 'REVISE', candidate: { price: '024.94', size: '1' }, reasonCode: 'NORMALIZE_TO_RULES' }));
  await assert.rejects(() => bad.review(input), error => error.code === 'PREFLIGHT_AGENT_INVALID');
});

test('candidate presence follows the exact action contract', async () => {
  for (const output of [
    { action: 'REVISE', candidate: null, reasonCode: 'NORMALIZE_TO_RULES' },
    { action: 'WAIT', candidate: { price: '24.94', size: '1' }, reasonCode: 'INSUFFICIENT_EVIDENCE' },
    { action: 'ACCEPT', candidate: { price: '24.94', size: '1' }, reasonCode: 'WITHIN_LIMITS' }
  ]) {
    const reviewer = make(JSON.stringify(output));
    await assert.rejects(() => reviewer.review({ ...input, report: { ...report, verdict: 'ALLOW' } }), error => error.code === 'PREFLIGHT_AGENT_INVALID');
  }
  const wait = make(JSON.stringify({ action: 'WAIT', candidate: null, reasonCode: 'INSUFFICIENT_EVIDENCE' }));
  assert.deepEqual(await wait.review(input), { action: 'WAIT', candidate: null, reasonCode: 'INSUFFICIENT_EVIDENCE' });
  const secondRevision = make(JSON.stringify({ action: 'REVISE', candidate: { price: '24.94', size: '1' }, reasonCode: 'NORMALIZE_TO_RULES' }));
  await assert.rejects(() => secondRevision.review({ ...input, attempt: 2 }), error => error.code === 'PREFLIGHT_AGENT_INVALID');
});
