import { constants } from 'node:fs';
import { lstat, realpath, open } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { PINNED_ATK, verifyDemoConnectionManifest } from './demo-connection-manifest.mjs';

const PACKAGE_BYTES = 64 * 1024;
const ENTRY_BYTES = 8 * 1024 * 1024;
const FAILURE_CODES = new Set(['ATK_PATHS_INVALID','ATK_PATH_OUTSIDE_PACKAGE','ATK_ENTRY_PATH_MISMATCH',
  'ATK_PATH_LINK','ATK_PATH_TYPE','ATK_FILE_TOO_LARGE','ATK_FILE_CHANGED','ATK_PACKAGE_JSON_INVALID',
  'ATK_PACKAGE_NAME_MISMATCH','ATK_PACKAGE_VERSION_MISMATCH','ATK_ENTRY_HASH_MISMATCH']);
const fail = code => { throw Object.assign(new Error(code), { code }); };
const samePath = (a,b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const contained = (root,file) => {
  const relative = path.relative(root,file);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

function operatorPaths(input) {
  if (!input || ![Object.prototype,null].includes(Object.getPrototypeOf(input))
      || Object.getOwnPropertySymbols(input).length) fail('ATK_PATHS_INVALID');
  const fields = Object.getOwnPropertyDescriptors(input);
  if (Object.keys(fields).length !== 2 || !['packageRoot','entryPath'].every(key =>
    fields[key] && Object.hasOwn(fields[key],'value'))) fail('ATK_PATHS_INVALID');
  const result = {};
  for (const key of ['packageRoot','entryPath']) {
    const value = fields[key].value;
    if (typeof value !== 'string' || value.length > 4096 || !path.isAbsolute(value)
        || value.includes('\0')) fail('ATK_PATHS_INVALID');
    const parsed = path.parse(value);
    // Local paths only; reject device namespaces/UNC, ADS and ambiguous Windows names.
    if (process.platform === 'win32' && !/^[a-z]:[\\/]$/i.test(parsed.root)) fail('ATK_PATHS_INVALID');
    const parts = value.slice(parsed.root.length).split(/[\\/]/);
    if (parts.length > 128 || parts.some(part => part === '.' || part === '..'
      || (process.platform === 'win32' && /[:<>"|?*]|[. ]$/.test(part)))) fail('ATK_PATHS_INVALID');
    result[key] = path.resolve(value);
  }
  if (!contained(result.packageRoot,result.entryPath)
      || samePath(result.entryPath,path.join(result.packageRoot,'package.json'))) fail('ATK_PATH_OUTSIDE_PACKAGE');
  if (!samePath(result.entryPath,path.join(result.packageRoot,'dist','index.js'))) fail('ATK_ENTRY_PATH_MISMATCH');
  return result;
}

async function checkedPath(file, directory = false) {
  const root = path.parse(file).root;
  const parts = file.slice(root.length).split(path.sep).filter(Boolean);
  let current = root;
  for (let index = -1; index < parts.length; index++) {
    if (index >= 0) current = path.join(current,parts[index]);
    const stat = await lstat(current,{bigint:true});
    if (stat.isSymbolicLink()) fail('ATK_PATH_LINK');
    if (index < parts.length - 1 || directory) {
      if (!stat.isDirectory()) fail('ATK_PATH_TYPE');
    } else if (!stat.isFile() || stat.nlink !== 1n) fail('ATK_PATH_TYPE');
  }
  const canonical = await realpath(file);
  if (!samePath(canonical,file)) fail('ATK_PATH_LINK');
  return canonical;
}

const sameFile = (a,b) => ['dev','ino','size','mtimeNs','ctimeNs','mode','nlink'].every(key => a[key] === b[key]);

async function boundedRead(file, maximum) {
  await checkedPath(file);
  const before = await lstat(file,{bigint:true});
  if (before.size > BigInt(maximum)) fail('ATK_FILE_TOO_LARGE');
  const handle = await open(file,constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat({bigint:true});
    if (!opened.isFile() || !sameFile(before,opened)) fail('ATK_FILE_CHANGED');
    const buffer = Buffer.alloc(Number(opened.size) + 1);
    let count = 0;
    while (count < buffer.length) {
      const {bytesRead} = await handle.read(buffer,count,buffer.length-count,count);
      if (!bytesRead) break;
      count += bytesRead;
    }
    if (count !== Number(opened.size) || !sameFile(opened,await handle.stat({bigint:true}))) fail('ATK_FILE_CHANGED');
    await checkedPath(file);
    if (!sameFile(opened,await lstat(file,{bigint:true}))) fail('ATK_FILE_CHANGED');
    return {bytes:buffer.subarray(0,count),stat:opened};
  } finally { await handle.close(); }
}

/** Snapshot gate for explicit operator-owned installed files. Never resolves main/bin,
 * imports package code, follows sourcemaps, starts a child, reads configuration or grants transport access.
 * Ancestor lstat/realpath and descriptor checks reject observed links/replacements.
 * Node cannot attest every Windows reparse tag or eliminate concurrent TOCTOU; the
 * installation and ancestors must be operator-owned and stable during inspection.
 * This is NOT an attestation of dependencies, runtime, auth, routing or demo account.
 */
export async function inspectInstalledATKPackage(manifest, paths) {
  if (!verifyDemoConnectionManifest(manifest)) return rejected('DEMO_MANIFEST_HASH');
  try {
    const connectionHash = Object.getOwnPropertyDescriptor(manifest,'configHash').value;
    const {packageRoot,entryPath} = operatorPaths(paths);
    const canonicalRoot = await checkedPath(packageRoot,true);
    const packagePath = path.join(packageRoot,'package.json');
    if (!contained(canonicalRoot,await checkedPath(entryPath))) fail('ATK_PATH_OUTSIDE_PACKAGE');
    const packageFile = await boundedRead(packagePath,PACKAGE_BYTES);
    let metadata;
    try { metadata = JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(packageFile.bytes)); }
    catch { fail('ATK_PACKAGE_JSON_INVALID'); }
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) fail('ATK_PACKAGE_JSON_INVALID');
    if (metadata.name !== PINNED_ATK.name) fail('ATK_PACKAGE_NAME_MISMATCH');
    if (metadata.version !== PINNED_ATK.version) fail('ATK_PACKAGE_VERSION_MISMATCH');
    const entry = await boundedRead(entryPath,ENTRY_BYTES);
    const entrySha256 = createHash('sha256').update(entry.bytes).digest('hex');
    if (entrySha256 !== PINNED_ATK.entrySha256) fail('ATK_ENTRY_HASH_MISMATCH');
    // Recheck both files together before returning the observed snapshot.
    await checkedPath(packageRoot,true);
    for (const [file,stat] of [[packagePath,packageFile.stat],[entryPath,entry.stat]]) {
      await checkedPath(file);
      if (!sameFile(stat,await lstat(file,{bigint:true}))) fail('ATK_FILE_CHANGED');
    }
    return Object.freeze({ok:true,code:'ATK_PACKAGE_FINGERPRINT_MATCH',
      verification:'INSTALLED_FILES_ONLY',package:PINNED_ATK,connectionHash,
      entryBytes:entry.bytes.length,writeEnabled:false});
  } catch (error) {
    let code;
    try { code = Object.getOwnPropertyDescriptor(error,'code')?.value; } catch { /* Untrusted thrown object. */ }
    return rejected(FAILURE_CODES.has(code) ? code : 'ATK_FILES_UNAVAILABLE');
  }
}

function rejected(code) {
  return Object.freeze({ok:false,code,verification:'UNVERIFIED',writeEnabled:false});
}
