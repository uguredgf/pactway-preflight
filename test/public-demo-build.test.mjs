import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {buildPublicDemo,generatePublicReplayFixtures} from '../scripts/build-public-demo.mjs';

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
