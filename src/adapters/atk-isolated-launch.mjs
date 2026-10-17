import {open,lstat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {isAbsolute,resolve} from 'node:path';
import {draftIsolatedDemoEntry} from './atk-isolated-session-draft.mjs';
import {draftExecutionDemoEntry} from './atk-execution-entry.mjs';
import {verifyDemoConnectionManifest,createDemoConnectionManifest} from './demo-connection-manifest.mjs';
import {ISOLATED_BOOTSTRAP_SOURCE} from './atk-isolated-bootstrap-source.mjs';

const secretKeys=['OKX_API_KEY','OKX_SECRET_KEY','OKX_PASSPHRASE'];
const osKeys=['SystemRoot','WINDIR','TEMP','TMP'];
const fail=()=>{throw new Error('ATK_ISOLATED_LAUNCH_DENIED');};
function strings(input,allowed,required=[]) {
  if(!input || typeof input!=='object' || Array.isArray(input)
      || ![Object.prototype,null].includes(Object.getPrototypeOf(input)) || Object.getOwnPropertySymbols(input).length)fail();
  const descriptors=Object.getOwnPropertyDescriptors(input),output=Object.create(null);
  if(Object.keys(descriptors).some(key=>!allowed.includes(key)) || required.some(key=>!Object.hasOwn(descriptors,key)))fail();
  for(const [key,descriptor] of Object.entries(descriptors)) {
    if(!Object.hasOwn(descriptor,'value'))fail();
    const value=descriptor.value;
    if(typeof value!=='string' || !value || value.length>4096 || value.trim()!==value || /[\x00-\x1f\x7f]/.test(value))fail();
    output[key]=value;
  }
  return output;
}
async function sourceFile(path) {
  if(typeof path!=='string' || !isAbsolute(path) || /[\0\r\n]/.test(path))fail();
  const link=await lstat(path);if(!link.isFile() || link.isSymbolicLink())fail();
  const file=await open(path,'r');
  try {
    const before=await file.stat();
    if(!before.isFile() || before.size<1 || before.size>8*1024*1024 || before.dev!==link.dev || before.ino!==link.ino)fail();
    const bytes=Buffer.alloc(before.size+1);let total=0;
    while(total<bytes.length) {
      const read=await file.read(bytes,total,bytes.length-total,null);
      if(!read.bytesRead)break;total+=read.bytesRead;
    }
    const after=await file.stat();
    if(total!==before.size || after.size!==before.size || after.mtimeMs!==before.mtimeMs || after.ctimeMs!==before.ctimeMs)fail();
    return new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,total));
  } finally {await file.close();}
}

/** Private launch state. Descriptions are nonsecret. Environment is handed to
 * spawn once, never serialized, hashed, journalled or included in an error.
 * No source artifact is emitted; an existing derived entry must match the pinned
 * source transformation exactly. This class does not itself spawn or use network.
 */
export class IsolatedATKLaunch {
  #manifest;#upstream;#derived;#environment;#description=null;#execution;#bootstrap;
  constructor({manifest,upstreamEntryPath,derivedEntryPath,credentials,osEnvironment={},execution=false,bootstrapEntryPath=null}) {
    if(typeof execution!=='boolean')fail();this.#execution=execution;
    if(!verifyDemoConnectionManifest(manifest))fail();
    this.#manifest=createDemoConnectionManifest(manifest.config);
    for(const path of [upstreamEntryPath,derivedEntryPath])if(typeof path!=='string' || !isAbsolute(path) || /[\0\r\n]/.test(path))fail();
    if(resolve(upstreamEntryPath).toLowerCase()===resolve(derivedEntryPath).toLowerCase())fail();
    this.#upstream=upstreamEntryPath;this.#derived=derivedEntryPath;
    if(bootstrapEntryPath!==null && (typeof bootstrapEntryPath!=='string' || !isAbsolute(bootstrapEntryPath) || /[\0\r\n]/.test(bootstrapEntryPath)
        || [upstreamEntryPath,derivedEntryPath].some(path=>resolve(path).toLowerCase()===resolve(bootstrapEntryPath).toLowerCase())))fail();
    this.#bootstrap=bootstrapEntryPath;
    this.#environment={...strings(osEnvironment,osKeys),...strings(credentials,secretKeys,secretKeys)};
  }
  async inspect() {
    if(!this.#environment)fail();
    try {
      const source=await sourceFile(this.#upstream),derived=await sourceFile(this.#derived);
      if(this.#bootstrap && await sourceFile(this.#bootstrap)!==ISOLATED_BOOTSTRAP_SOURCE)fail();
      const expected=(this.#execution?draftExecutionDemoEntry:draftIsolatedDemoEntry)(this.#manifest,source);
      if(!expected.ok || derived!==expected.source)fail();
      const c=this.#manifest.config;
      const args=Object.freeze(['--profile',c.profile,'--demo','--site',c.site,'--modules','market,spot,account',
        ...(this.#execution?[]:['--read-only']),'--no-log']);
      this.#description=Object.freeze({entrySha256:createHash('sha256').update(derived,'utf8').digest('hex'),
        bootstrapEntryPath:this.#bootstrap,bootstrapSha256:this.#bootstrap?createHash('sha256').update(ISOLATED_BOOTSTRAP_SOURCE).digest('hex'):null,
        connectionHash:this.#manifest.configHash,profile:c.profile,args,
        execution:this.#execution,verification:'PINNED_DERIVED_SOURCE_AND_EXPLICIT_ENVIRONMENT',actualAccountVerified:false,routeVerified:false,writeEnabled:false});
      return this.#description;
    } catch {this.discard();fail();}
  }
  takeEnvironment() {
    if(!this.#description || !this.#environment)fail();
    const environment=this.#environment;this.#environment=null;return environment;
  }
  discard() {this.#environment=null;}
}
