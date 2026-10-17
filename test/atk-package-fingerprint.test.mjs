// Acceptance sources only: not executed during implementation.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,realpath,symlink,link,open,copyFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {inspectInstalledATKPackage} from '../src/adapters/atk-package-fingerprint.mjs';
import {createDemoConnectionManifest,PINNED_ATK} from '../src/adapters/demo-connection-manifest.mjs';

const manifest = () => createDemoConnectionManifest({schemaVersion:1,id:'demo',connectionVersion:'v1',
  accountId:'alias',environment:'demo',instrument:'AVAX-USDT',profile:'demo',site:'tr',
  apiOrigin:'https://tr.okx.com',authMode:'isolated-demo-api-key',sourceTag:'MCP'});

async function fixture(t,metadata = {name:PINNED_ATK.name,version:PINNED_ATK.version}) {
  const temporary = await mkdtemp(path.join(tmpdir(),'mandateguard-fingerprint-'));
  t.after(async () => {
    const target=await realpath(temporary),parent=await realpath(tmpdir());
    assert.equal(path.dirname(target),parent);
    assert.equal(path.basename(target).startsWith('mandateguard-fingerprint-'),true);
    await rm(target,{recursive:true,force:true});
  });
  const packageRoot = await realpath(temporary);
  await mkdir(path.join(packageRoot,'dist'));
  const entryPath = path.join(packageRoot,'dist','index.js');
  await writeFile(path.join(packageRoot,'package.json'),JSON.stringify(metadata));
  await writeFile(entryPath,'throw new Error("fixture must never execute");\n');
  return {packageRoot,entryPath};
}

function reject(result,code) {
  assert.deepEqual(result,{ok:false,code,verification:'UNVERIFIED',writeEnabled:false});
  assert.equal(Object.isFrozen(result),true);
}

test('authentic pinned installed bytes satisfy the file-only gate without execution',async t => {
  const paths = await fixture(t);
  const authenticEntry=fileURLToPath(new URL('../node_modules/@okx_ai/okx-trade-mcp/dist/index.js',import.meta.url));
  // This acceptance source stages bytes only. It never imports or runs the entry.
  await copyFile(authenticEntry,paths.entryPath);
  const declared=manifest();
  const result=await inspectInstalledATKPackage(declared,paths);
  assert.equal(result.ok,true);assert.equal(result.code,'ATK_PACKAGE_FINGERPRINT_MATCH');
  assert.equal(result.connectionHash,declared.configHash);assert.equal(result.verification,'INSTALLED_FILES_ONLY');
  assert.equal(result.writeEnabled,false);assert.deepEqual(result.package,PINNED_ATK);
  assert.equal(Object.isFrozen(result),true);
  assert.equal(Object.hasOwn(result,'entryPath'),false);assert.equal(Object.hasOwn(result,'packageRoot'),false);
});

test('manifest commitment fails before operator path access or filesystem lookup',async () => {
  const declaration = manifest();
  let reads = 0;
  const paths = {get packageRoot(){reads++;throw new Error('secret-path');},entryPath:'relative'};
  reject(await inspectInstalledATKPackage({...declaration,configHash:'0'.repeat(64)},paths),'DEMO_MANIFEST_HASH');
  reject(await inspectInstalledATKPackage({...declaration,package:{...PINNED_ATK,version:'9.9.9'}},paths),'DEMO_MANIFEST_HASH');
  assert.equal(reads,0);
});

test('explicit absolute data paths required; getters are not called',async t => {
  const paths = await fixture(t);
  reject(await inspectInstalledATKPackage(manifest(),{...paths,entryPath:'dist/index.js'}),'ATK_PATHS_INVALID');
  reject(await inspectInstalledATKPackage(manifest(),{...paths,extra:'secret'}),'ATK_PATHS_INVALID');
  let reads = 0;
  reject(await inspectInstalledATKPackage(manifest(),{get packageRoot(){reads++;return paths.packageRoot;},entryPath:paths.entryPath}),'ATK_PATHS_INVALID');
  assert.equal(reads,0);
  const hostile = new Proxy({}, {getPrototypeOf(){throw Object.assign(new Error('private'),{code:'ATK_private-path'});}});
  reject(await inspectInstalledATKPackage(manifest(),hostile),'ATK_FILES_UNAVAILABLE');
});

test('entry must remain inside root and exactly the pinned dist/index.js selection',async t => {
  const paths = await fixture(t);
  reject(await inspectInstalledATKPackage(manifest(),{...paths,entryPath:path.join(path.dirname(paths.packageRoot),'outside.js')}),'ATK_PATH_OUTSIDE_PACKAGE');
  reject(await inspectInstalledATKPackage(manifest(),{...paths,entryPath:path.join(paths.packageRoot,'other.js')}),'ATK_ENTRY_PATH_MISMATCH');
  reject(await inspectInstalledATKPackage(manifest(),{...paths,entryPath:paths.packageRoot + path.sep + 'dist' + path.sep + '..' + path.sep + 'dist' + path.sep + 'index.js'}),'ATK_PATHS_INVALID');
});

test('Windows absolute forward-slash paths normalize before installed-file checks',
  {skip:process.platform !== 'win32'},async t => {
    const paths = await fixture(t);
    const forward = Object.fromEntries(Object.entries(paths).map(([key,value]) => [key,value.replaceAll('\\','/')]));
    reject(await inspectInstalledATKPackage(manifest(),forward),'ATK_ENTRY_HASH_MISMATCH');
  });

test('installed package name/version and changed entry cannot satisfy manifest pins',async t => {
  for (const [metadata,code] of [
    [{name:'another-package',version:PINNED_ATK.version},'ATK_PACKAGE_NAME_MISMATCH'],
    [{name:PINNED_ATK.name,version:'1.4.9'},'ATK_PACKAGE_VERSION_MISMATCH'],
    [{name:PINNED_ATK.name,version:PINNED_ATK.version,main:'../../outside.js',bin:'../../outside.js'},'ATK_ENTRY_HASH_MISMATCH'],
  ]) {
    const paths = await fixture(t,metadata);
    reject(await inspectInstalledATKPackage(manifest(),paths),code);
  }
  const paths = await fixture(t);
  await writeFile(paths.entryPath,'changed bytes');
  reject(await inspectInstalledATKPackage(manifest(),paths),'ATK_ENTRY_HASH_MISMATCH');
});

test('malformed metadata and oversized files fail closed before hashing',async t => {
  const paths = await fixture(t);
  const packagePath = path.join(paths.packageRoot,'package.json');
  await writeFile(packagePath,'{');
  reject(await inspectInstalledATKPackage(manifest(),paths),'ATK_PACKAGE_JSON_INVALID');
  await writeFile(packagePath,Buffer.from([0xff]));
  reject(await inspectInstalledATKPackage(manifest(),paths),'ATK_PACKAGE_JSON_INVALID');
  await writeFile(packagePath,' '.repeat(64 * 1024 + 1));
  reject(await inspectInstalledATKPackage(manifest(),paths),'ATK_FILE_TOO_LARGE');
  await writeFile(packagePath,JSON.stringify({name:PINNED_ATK.name,version:PINNED_ATK.version}));
  const file = await open(paths.entryPath,'r+');
  try { await file.truncate(8 * 1024 * 1024 + 1); } finally { await file.close(); }
  reject(await inspectInstalledATKPackage(manifest(),paths),'ATK_FILE_TOO_LARGE');
});

test('hardlinked files are rejected when the platform permits creating a hardlink',async t => {
  const paths = await fixture(t);
  try { await link(paths.entryPath,path.join(paths.packageRoot,'alias.js')); }
  catch (error) {
    if (['EPERM','EACCES','ENOTSUP'].includes(error.code)) { t.skip('Platform lacks hardlink permission'); return; }
    throw error;
  }
  reject(await inspectInstalledATKPackage(manifest(),paths),'ATK_PATH_TYPE');
});

test('missing files and directories in place of entry return sanitized results',async t => {
  const paths = await fixture(t);
  await rm(paths.entryPath);
  reject(await inspectInstalledATKPackage(manifest(),paths),'ATK_FILES_UNAVAILABLE');
  await mkdir(paths.entryPath);
  reject(await inspectInstalledATKPackage(manifest(),paths),'ATK_PATH_TYPE');
});

test('symlink file is rejected',async t => {
  const paths = await fixture(t);
  const original = path.join(paths.packageRoot,'original.js');
  await writeFile(original,'fixture');
  await rm(paths.entryPath);
  try { await symlink(original,paths.entryPath,'file'); }
  catch (error) {
    if (['EPERM','EACCES','ENOTSUP'].includes(error.code)) { t.skip('Platform lacks file symlink permission'); return; }
    throw error;
  }
  reject(await inspectInstalledATKPackage(manifest(),paths),'ATK_PATH_LINK');
});

test('junction/symlink ancestor is rejected independently of file symlink privileges',async t => {
  const paths = await fixture(t);
  const alias = path.join(paths.packageRoot,'linked-package');
  try { await symlink(paths.packageRoot,alias,process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) {
    if (['EPERM','EACCES','ENOTSUP'].includes(error.code)) { t.skip('Platform lacks directory link permission'); return; }
    throw error;
  }
  reject(await inspectInstalledATKPackage(manifest(),{packageRoot:alias,entryPath:path.join(alias,'dist','index.js')}),'ATK_PATH_LINK');
});

// The positive source requires the repo-installed exact 1.4.8 devDependency.
// Missing or altered authentic bytes fail instead of skipping or overriding pins.
// Concurrent replacement/growth and Windows reparse attestation still need separate
// platform-specific verification under a later execution permit.
