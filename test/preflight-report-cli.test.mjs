import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runReplayExample, REPLAY_EXAMPLES } from '../src/preflight/examples.mjs';
import { verifyReportFile } from '../scripts/verify-preflight-report.mjs';

async function withDirectory(run) {
  const directory = await mkdtemp(join(tmpdir(), 'pactway-report-cli-'));
  try { await run(directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test('offline verifier accepts each deterministic replay report', async () => {
  await withDirectory(async directory => {
    for (const name of REPLAY_EXAMPLES) {
      const report = runReplayExample(name);
      const path = join(directory, `${name}.json`);
      await writeFile(path, JSON.stringify(report));
      const result = await verifyReportFile(path);
      assert.equal(result.ok, true);
      assert.equal(result.verdict, report.verdict);
      assert.equal(result.mode, 'REPLAY');
      assert.equal(result.reportHash, report.reportHash);
      assert.equal(result.publication, 'LOCAL_ONLY');
    }
  });
});

test('offline verifier rejects changed content, malformed files and oversized input', async () => {
  await withDirectory(async directory => {
    const path = join(directory, 'invalid.json');
    const changed = structuredClone(runReplayExample('within-limits'));
    changed.candidate.price = '26';
    await writeFile(path, JSON.stringify(changed));
    assert.equal((await verifyReportFile(path)).ok, false);
    await writeFile(path, '{');
    assert.equal((await verifyReportFile(path)).ok, false);
    await writeFile(path, Buffer.from([0xc0, 0x80]));
    assert.equal((await verifyReportFile(path)).ok, false);
    await writeFile(path, ' '.repeat(2 * 1024 * 1024 + 1));
    assert.equal((await verifyReportFile(path)).ok, false);
    assert.equal((await verifyReportFile(directory)).ok, false);
    assert.equal((await verifyReportFile(join(directory, 'missing.json'))).ok, false);
  });
});

test('CLI exposes machine-readable status and nonzero invalid/usage exit codes', async () => {
  await withDirectory(async directory => {
    const script = fileURLToPath(new URL('../scripts/verify-preflight-report.mjs', import.meta.url));
    const path = join(directory, 'report.json');
    const environment = {};
    for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP']) {
      if (process.env[key]) environment[key] = process.env[key];
    }
    const options = { encoding: 'utf8', env: environment, windowsHide: true };
    await writeFile(path, JSON.stringify(runReplayExample('within-limits')));
    const valid = spawnSync(process.execPath, [script, path], options);
    assert.equal(valid.status, 0);
    assert.equal(JSON.parse(valid.stdout).ok, true);
    const invalid = spawnSync(process.execPath, [script, join(directory, 'missing.json')], options);
    assert.equal(invalid.status, 1);
    assert.equal(JSON.parse(invalid.stdout).ok, false);
    const usage = spawnSync(process.execPath, [script], options);
    assert.equal(usage.status, 2);
    assert.match(usage.stderr, /Usage:/);
  });
});
