import {open,lstat} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import {verifyDemoConnectionManifest} from './demo-connection-manifest.mjs';
import {copyAccountExpectation} from './atk-account-expectation.mjs';

async function readJson(path,limit) {
  if(typeof path!=='string' || !isAbsolute(path) || /[\0\r\n]/.test(path))throw new Error('ATK_JOURNAL_CONFIG_PATH');
  const link=await lstat(path);
  if(!link.isFile() || link.isSymbolicLink())throw new Error('ATK_JOURNAL_CONFIG_FILE');
  const file=await open(path,'r');
  try {
    const before=await file.stat();
    if(!before.isFile() || before.size<1 || before.size>limit || before.ino!==link.ino || before.dev!==link.dev)
      throw new Error('ATK_JOURNAL_CONFIG_SIZE');
    const bytes=Buffer.alloc(before.size+1);let total=0;
    while(total<bytes.length) {
      const read=await file.read(bytes,total,bytes.length-total,null);
      if(!read.bytesRead)break;total+=read.bytesRead;
    }
    const after=await file.stat();
    if(total!==before.size || before.size!==after.size || before.mtimeMs!==after.mtimeMs || before.ctimeMs!==after.ctimeMs)
      throw new Error('ATK_JOURNAL_CONFIG_CHANGED');
    return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,total)));
  } finally {await file.close();}
}

/** Operator-selected nonsecret config only. Never accepts paths from HTTP or
 * reads ambient profile/secrets. Approval is checked against live catalog later.
 */
export async function loadATKJournalConfiguration({manifestPath,approvalPath,accountExpectationPath}) {
  if(!manifestPath && !approvalPath && !accountExpectationPath)return null;
  if(!manifestPath || !approvalPath)throw new Error('ATK_JOURNAL_CONFIG_PAIR_REQUIRED');
  const manifest=await readJson(manifestPath,16384);
  if(!verifyDemoConnectionManifest(manifest))throw new Error('ATK_JOURNAL_MANIFEST');
  const approval=await readJson(approvalPath,4*1024*1024);
  if(!approval || Object.keys(approval).sort().join(',')!=='approvedBaselineHash,baseline')
    throw new Error('ATK_JOURNAL_APPROVAL');
  const accountExpectation=accountExpectationPath
    ? copyAccountExpectation(await readJson(accountExpectationPath,4096),manifest.configHash,manifest.config.accountId) : null;
  return {manifest,approval,accountExpectation};
}
