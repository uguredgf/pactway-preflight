// Explicit operator preparation only: reads nonsecret files and writes a NEW
// derived entry with exclusive creation. Never launches SDK/server or reads keys.
import {readFile,writeFile,lstat} from 'node:fs/promises';
import {resolve,isAbsolute} from 'node:path';
import {draftExecutionDemoEntry} from '../src/adapters/atk-execution-entry.mjs';

async function bounded(path,limit) {
  if(!isAbsolute(path))throw new Error('Absolute paths required');
  const stat=await lstat(path);
  if(!stat.isFile() || stat.isSymbolicLink() || stat.size<1 || stat.size>limit)throw new Error('Invalid input file');
  const bytes=await readFile(path);
  if(bytes.length>limit)throw new Error('Input file too large');
  return new TextDecoder('utf-8',{fatal:true}).decode(bytes);
}
const [manifestPath,upstreamPath,outputPath,...extra]=process.argv.slice(2);
if(extra.length || ![manifestPath,upstreamPath,outputPath].every(value=>typeof value==='string' && isAbsolute(value)))
  throw new Error('Usage: node scripts/prepare-demo-execution.mjs <absolute-manifest.json> <absolute-upstream-entry> <absolute-new-entry.mjs>');
if([manifestPath,upstreamPath].some(path=>resolve(path).toLowerCase()===resolve(outputPath).toLowerCase()))
  throw new Error('Output must be a separate new file');
const manifest=JSON.parse(await bounded(manifestPath,16384));
const prepared=draftExecutionDemoEntry(manifest,await bounded(upstreamPath,8*1024*1024));
if(!prepared.ok)throw new Error(prepared.code);
await writeFile(outputPath,prepared.source,{encoding:'utf8',flag:'wx'});
console.log(JSON.stringify({code:prepared.code,entrySha256:prepared.isolatedDerivedSha256,launched:false}));
