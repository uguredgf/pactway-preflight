import solc from 'solc';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';

export const COMPILER_VERSION='0.8.24+commit.e11b9ed9.Emscripten.clang';
export const SOURCE_NAME='MandateRegistry.sol';
export const sha256=value=>createHash('sha256').update(value).digest('hex');
export async function compileRegistry({profile='prepared'}={}) {
  if(!['prepared','remix-unoptimized-crlf'].includes(profile))throw new Error('FUJI_BUILD_PROFILE_INVALID');
  if(solc.version()!==COMPILER_VERSION)throw new Error('FUJI_COMPILER_VERSION_MISMATCH');
  const original=await readFile(new URL('../../contracts/MandateRegistry.sol',import.meta.url),'utf8');
  const source=profile==='remix-unoptimized-crlf'?original.replaceAll('\r\n','\n').replaceAll('\n','\r\n'):original;
  const input={language:'Solidity',sources:{[SOURCE_NAME]:{content:source}},settings:{
    optimizer:{enabled:profile==='prepared',runs:200},evmVersion:'paris',viaIR:false,
    outputSelection:{'*':{'':['ast'],'*':['abi','metadata','evm.bytecode','evm.deployedBytecode','evm.methodIdentifiers']}}}};
  const output=JSON.parse(solc.compile(JSON.stringify(input)));
  if(output.errors?.some(error=>error.severity==='error'))throw new Error('FUJI_COMPILATION_FAILED');
  const compiled=output.contracts?.[SOURCE_NAME]?.MandateRegistry;
  if(!compiled || !/^[a-f0-9]+$/i.test(compiled.evm.bytecode.object))throw new Error('FUJI_BYTECODE_MISSING');
  const contract=output.sources[SOURCE_NAME].ast.nodes.find(node=>node.nodeType==='ContractDefinition' && node.name==='MandateRegistry');
  const names=Object.fromEntries(contract.nodes.filter(node=>node.nodeType==='VariableDeclaration' && node.mutability==='immutable').map(node=>[node.id,node.name]));
  const immutableReferences={};
  for(const [id,ranges] of Object.entries(compiled.evm.deployedBytecode.immutableReferences)) {
    if(!['owner','recorder'].includes(names[id]))throw new Error('FUJI_UNKNOWN_IMMUTABLE');
    immutableReferences[names[id]]=ranges;
  }
  if(!immutableReferences.owner?.length || !immutableReferences.recorder?.length)throw new Error('FUJI_IMMUTABLES_MISSING');
  return {input,source,artifact:{schemaVersion:1,chainId:43113,buildProfile:profile,compilerVersion:COMPILER_VERSION,
    sourceName:SOURCE_NAME,contractName:'MandateRegistry',sourceSha256:sha256(source),inputSha256:sha256(JSON.stringify(input)),
    settings:input.settings,abi:compiled.abi,bytecode:'0x'+compiled.evm.bytecode.object,
    deployedBytecode:'0x'+compiled.evm.deployedBytecode.object,immutableReferences,
    methodIdentifiers:compiled.evm.methodIdentifiers,metadata:JSON.parse(compiled.metadata),
    warnings:(output.errors??[]).filter(error=>error.severity==='warning').map(error=>error.message)}};
}

export function addressWord(address) {
  if(typeof address!=='string' || !/^0x[0-9a-fA-F]{40}$/.test(address) || /^0x0{40}$/i.test(address))throw new Error('FUJI_ADDRESS_INVALID');
  return address.slice(2).toLowerCase().padStart(64,'0');
}
export function expectedRuntime(artifact,{owner,recorder}) {
  let code=artifact.deployedBytecode.slice(2).toLowerCase();
  for(const [name,address] of Object.entries({owner,recorder})) {
    const word=addressWord(address);
    for(const range of artifact.immutableReferences[name]) {
      if(range.length!==32 || !Number.isSafeInteger(range.start) || range.start<0 || (range.start+32)*2>code.length)throw new Error('FUJI_IMMUTABLE_RANGE');
      code=code.slice(0,range.start*2)+word+code.slice((range.start+32)*2);
    }
  }
  return '0x'+code;
}
