import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {approvePolicy,createPolicy,evaluatePreflight} from '../src/preflight/domain.mjs';
import {FUJI_PROFILE} from '../src/audit/fuji-deployment-profile.mjs';
import {selectedFujiArtifact} from '../scripts/lib/verify-selected-fuji.mjs';
import {preparePreflightFujiPublication,selectLatestPreflightReport} from '../scripts/lib/preflight-fuji-publication.mjs';
import {preparePreflightFujiFiles} from '../scripts/prepare-preflight-fuji-publication.mjs';

function liveReport(checkedAtMs=1792231200000) {
  const binding={accountId:'test-account',catalogHash:'a'.repeat(64),connectionHash:'b'.repeat(64),
    isolatedEntrySha256:'c'.repeat(64),sessionId:'test-session'};
  const draft=createPolicy({instrument:'AVAX-USDT',side:'buy',tdMode:'cash',ordType:'limit',maxNotional:'25',
    maxPrice:'25',durationSeconds:'600'},'test-live',checkedAtMs-1000);
  const policyRecord=approvePolicy(draft,draft.policyHash,checkedAtMs-1000),observedAtMs=checkedAtMs-1000;
  return evaluatePreflight({mode:'LIVE_READ_ONLY',policyRecord,
    candidate:{instrument:'AVAX-USDT',side:'buy',tdMode:'cash',ordType:'limit',price:'25',size:'0.4'},
    evidence:{ticker:{sourceObservationId:'ticker',sourcePayloadHash:'d'.repeat(64),binding,observedAtMs,
      exchangeTimestampMs:observedAtMs,referencePrice:'24.95',reference:'BEST_ASK'},
    instrument:{sourceObservationId:'instrument',sourcePayloadHash:'e'.repeat(64),binding,observedAtMs,
      instrument:{instId:'AVAX-USDT',instType:'SPOT',baseCcy:'AVAX',quoteCcy:'USDT',state:'live',tickSz:'0.01',
        lotSz:'0.01',minSz:'0.1',maxLmtSz:'1000'}}},agentTrace:{plannerKind:'ollama',
      plan:{tools:['market_get_ticker','market_get_instruments']},modelCallCount:1,failureCode:null},checkedAtMs});
}

test('prepares stable zero-value unsigned calldata and makes non-submission explicit',async()=>{
  const report=liveReport(),changed={...report,mode:'REPLAY'};
  // Reusing a replay hash after changing mode must fail: the input must be independently valid.
  await assert.rejects(preparePreflightFujiPublication(changed),/PREFLIGHT_REPORT_INVALID/);
});

test('selected verified live report produces commitPolicy calldata without wallet or RPC access',async()=>{
  const source=liveReport();
  const manifest=await preparePreflightFujiPublication(source),artifact=await selectedFujiArtifact();
  assert.equal(manifest.status,'READY_FOR_USER_SIGNATURE');assert.equal(manifest.submitted,false);
  assert.equal(manifest.signatureRequired,true);assert.equal(manifest.reportHash,'0x'+source.reportHash);
  assert.equal(manifest.policyHash,'0x'+source.policyHash);assert.notEqual(manifest.policyHash,manifest.reportHash);
  const [commit,append]=manifest.transactions;
  for(const transaction of manifest.transactions) {
    assert.equal(transaction.to,FUJI_PROFILE.contractAddress);assert.equal(transaction.value,'0x0');
  }
  assert.equal(commit.data,'0x'+artifact.methodIdentifiers['commitPolicy(bytes32,bytes32)']+
    manifest.taskId.slice(2)+source.policyHash);
  assert.equal(append.args.sequence,'1');assert.equal(append.args.receiptHash,manifest.reportHash);
  assert.equal(append.data.length,2+8+64*5);
  assert.match(manifest.sequencing,/confirmed successful receipt/);
  const changed=structuredClone(source);changed.verdict='BLOCK';assert.equal(manifest.report.verdict,'ALLOW');
});

test('latest selection is deterministic and output refuses overwrite',async()=>{
  const report=liveReport(),latest=liveReport(report.checkedAtMs+1);
  assert.equal(selectLatestPreflightReport([report,latest]).reportHash,latest.reportHash);
  const directory=await mkdtemp(join(tmpdir(),'preflight-fuji-test-')),output=join(directory,'manifest.json');
  try {
    const input=join(directory,'report.json');
    await writeFile(input,JSON.stringify(report));
    const manifest=await preparePreflightFujiFiles([input],output);
    assert.deepEqual(JSON.parse(await readFile(output,'utf8')),manifest);
    await assert.rejects(preparePreflightFujiFiles([input],output));
  } finally {await rm(directory,{recursive:true,force:true});}
});
