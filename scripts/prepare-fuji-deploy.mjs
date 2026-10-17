// Compile only. No wallet, key, network or transaction submission.
import {mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {compileRegistry} from './lib/fuji-build.mjs';
const {input,source,artifact}=await compileRegistry();
const parent=fileURLToPath(new URL('../exports/',import.meta.url));
await mkdir(parent,{recursive:true});const directory=await mkdtemp(join(parent,'fuji-build-'));
for(const [name,value] of [['MandateRegistry.sol',source],['compiler-input.json',JSON.stringify(input,null,2)],['artifact.json',JSON.stringify(artifact,null,2)]])
  await writeFile(join(directory,name),value,{flag:'wx'});
console.log(JSON.stringify({result:'FUJI_COMPILED_NOT_DEPLOYED',directory,compiler:artifact.compilerVersion,
  evmVersion:input.settings.evmVersion,optimizerRuns:200,sourceSha256:artifact.sourceSha256,
  creationBytes:(artifact.bytecode.length-2)/2,runtimeBytes:(artifact.deployedBytecode.length-2)/2,warnings:artifact.warnings}));
