// Explicit integration: installed pinned SDK starts with fake credentials only.
// No tools/call, no account access, no provider/RPC/model calls or downloads.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {unlink,realpath,lstat} from 'node:fs/promises';
import {dirname,join,basename} from 'node:path';
import {ReadOnlyATK} from '../../src/adapters/atk.mjs';
import {prepareReadonlyInstallation,observedBaseline,osEnvironment,root} from '../../scripts/lib/readonly-atk-setup.mjs';

test('installed isolated read-only SDK exposes valid complete catalog without account calls',{timeout:30000},async()=>{
  const setup=await prepareReadonlyInstallation(randomUUID());let client;
  try {
    client=new ReadOnlyATK({nodePath:process.execPath,entryPath:setup.entryPath,profile:setup.manifest.config.profile,
      isolated:{manifest:setup.manifest,upstreamEntryPath:setup.upstreamEntryPath,bootstrapEntryPath:setup.bootstrapEntryPath,osEnvironment:osEnvironment(),
        credentials:{OKX_API_KEY:'fixture-not-real',OKX_SECRET_KEY:'fixture-not-real',OKX_PASSPHRASE:'fixture-not-real'}}});
    const handshake=await client.connect(),baseline=observedBaseline(client,setup.manifest,handshake);
    assert.equal(baseline.ok,true);assert.ok(baseline.baseline.tools.length>=9);
    assert.ok(baseline.baseline.tools.every(tool=>tool.annotations.readOnlyHint===true && tool.annotations.destructiveHint===false));
    assert.equal(client.launchContext().execution,false);
    await assert.rejects(client.submitDemo({}));
  }finally{
    await client?.close();
    const target=await realpath(setup.entryPath),info=await lstat(target);
    assert.equal(dirname(target),await realpath(join(root,'.local')));
    assert.ok(/^readonly-atk-[a-f0-9-]{36}\.mjs$/.test(basename(target)));assert.equal(info.nlink,1);
    await unlink(target);
    const boot=await realpath(setup.bootstrapEntryPath);
    assert.equal(dirname(boot),await realpath(join(root,'.local')));assert.ok(/^readonly-bootstrap-[a-f0-9-]{36}\.mjs$/.test(basename(boot)));
    await unlink(boot);
  }
});
