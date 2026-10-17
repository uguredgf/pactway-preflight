import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {readFileSync} from 'node:fs';
import {buildPublicDemo,generatePublicReplayFixtures} from '../scripts/build-public-demo.mjs';

test('Vercel sends only a temporary root redirect to the current shared origin and preserves clean replay fallback',()=>{
  const config=JSON.parse(readFileSync(new URL('../vercel.json',import.meta.url),'utf8'));
  assert.equal(config.cleanUrls,true);
  assert.deepEqual(config.redirects,[{source:'/',destination:'https://reports-alive-session-distributed.trycloudflare.com/',permanent:false}]);
  assert.equal(config.redirects[0].permanent,false);
  assert.match(config.redirects[0].destination,/^https:\/\/reports-alive-session-distributed\.trycloudflare\.com\/$/);
  assert.doesNotMatch(config.redirects[0].destination,/invite|secret|operator|api/i);
  assert.deepEqual(config.rewrites,[{source:'/examples',destination:'/index'}]);
  assert.doesNotMatch(JSON.stringify(config),/destination":\s*"\/api\//);
});

test('public build contains only the current replay surface and deterministic examples',async()=>{
  const output=await mkdtemp(join(tmpdir(),'pactway-public-demo-'));
  try {
    const result=await buildPublicDemo(output);
    assert.deepEqual(result.files.sort(),['examples.mjs','fonts/instrument-sans-latin-ext-wght-normal.woff2',
      'fonts/instrument-sans-latin-wght-normal.woff2','fonts/newsreader-latin-ext-standard-normal.woff2',
      'fonts/newsreader-latin-standard-normal.woff2','index.html','preflight.css','public-demo.mjs'].sort());
    const html=await readFile(join(output,'index.html'),'utf8');
    assert.match(html,/Pactway Preflight · İşlem öncesi kontrol/);
    assert.match(html,/src="\/public-demo\.mjs"/);assert.doesNotMatch(html,/src="\/preflight\.mjs"/);
    assert.match(html,/id="live-access-notice"[^>]*hidden/);
    const publicController=await readFile(join(output,'public-demo.mjs'),'utf8');
    assert.doesNotMatch(publicController,/live-access-notice|live-access-state/);
    const examples=await import(pathToFileURL(join(output,'examples.mjs')).href+'?test='+Date.now());
    assert.deepEqual(Object.keys(examples.PUBLIC_REPLAY_EXAMPLES),['within-limits','limit-breach','stale-evidence']);
    assert.deepEqual(Object.values(examples.PUBLIC_REPLAY_EXAMPLES).map(report=>report.verdict),['ALLOW','BLOCK','INSUFFICIENT_DATA']);
    for(const report of Object.values(examples.PUBLIC_REPLAY_EXAMPLES)) {
      assert.equal(report.mode,'REPLAY');assert.equal(report.publication,'LOCAL_ONLY');
      assert.equal(report.agentTrace.plannerKind,'replay');assert.equal(report.agentTrace.modelCallCount,0);
    }
    const regenerated=join(output,'regenerated-examples.mjs');await generatePublicReplayFixtures(regenerated);
    assert.equal(await readFile(join(output,'examples.mjs'),'utf8'),await readFile(regenerated,'utf8'));
  } finally {await rm(output,{recursive:true,force:true});}
});
