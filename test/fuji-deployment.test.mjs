import test from 'node:test';
import assert from 'node:assert/strict';
import {compileRegistry,addressWord,expectedRuntime,COMPILER_VERSION} from '../scripts/lib/fuji-build.mjs';
import {verifyFujiDeployment} from '../scripts/lib/fuji-deployment-check.mjs';
const {artifact,input}=await compileRegistry();
const owner='0x'+'11'.repeat(20),recorder='0x'+'22'.repeat(20),address='0x'+'33'.repeat(20);
const transactionHash='0x'+'aa'.repeat(32),blockHash='0x'+'bb'.repeat(32),blockNumber='0x12';
const options={artifact,owner,recorder,transactionHash};
function mock(overrides={}) {
  const values={eth_chainId:'0xa869',
    eth_getTransactionReceipt:{transactionHash,from:owner,to:null,contractAddress:address,blockHash,blockNumber,status:'0x1'},
    eth_getTransactionByHash:{hash:transactionHash,from:owner,to:null,value:'0x0',blockHash,blockNumber,input:artifact.bytecode+addressWord(recorder)},
    eth_getBlockByNumber:{hash:blockHash,number:blockNumber,transactions:[transactionHash]},
    eth_getCode:expectedRuntime(artifact,{owner,recorder}),...overrides};
  const calls=[];
  const fetchImpl=async(url,config)=>{
    assert.equal(url,'https://api.avax-test.network/ext/bc/C/rpc');assert.equal(config.redirect,'error');
    const {method,params,id}=JSON.parse(config.body);calls.push(method);
    assert.ok(['eth_chainId','eth_getTransactionReceipt','eth_getTransactionByHash','eth_getBlockByNumber','eth_getCode','eth_call'].includes(method));
    const result=method==='eth_call'?(overrides.eth_call??('0x'+addressWord(params[0].data==='0x'+artifact.methodIdentifiers['owner()']?owner:recorder))):values[method];
    return new Response(JSON.stringify({jsonrpc:'2.0',id,result}));
  };
  return {values,calls,fetchImpl};
}
test('registry compiles with pinned compiler/settings and expected non-payable ABI',async()=>{
  assert.equal(artifact.compilerVersion,COMPILER_VERSION);assert.equal(input.settings.evmVersion,'paris');
  assert.deepEqual(input.settings.optimizer,{enabled:true,runs:200});assert.equal(artifact.warnings.length,0);
  const functions=artifact.abi.filter(item=>item.type==='function');
  assert.deepEqual(functions.map(item=>item.name).sort(),['appendDecision','commitPolicy','owner','recordedReceipts','recorder','tasks']);
  assert.ok(!artifact.abi.some(item=>['receive','fallback'].includes(item.type) || item.stateMutability==='payable'));
  assert.deepEqual(artifact.abi.find(item=>item.type==='constructor').inputs.map(item=>item.type),['address']);
  assert.equal((await compileRegistry()).artifact.bytecode,artifact.bytecode);
});
test('runtime patches exact owner/recorder slots and rejects zero/invalid addresses',()=>{
  assert.notEqual(expectedRuntime(artifact,{owner,recorder}),artifact.deployedBytecode);
  for(const bad of ['0x'+'00'.repeat(20),'secret','0x123',null])assert.throws(()=>addressWord(bad));
});
test('exact Fuji creation, canonical receipt block, full runtime and both roles verify read-only',async()=>{
  const f=mock(),result=await verifyFujiDeployment({...options,fetchImpl:f.fetchImpl});
  assert.equal(result.verified,true);assert.equal(result.contractAddress,address);assert.equal(result.chainId,43113);
  assert.equal(f.calls.length,7);assert.equal(result.sourceSha256,artifact.sourceSha256);
});
test('wrong network fails before any transaction lookup',async()=>{
  const f=mock({eth_chainId:'0xa86a'});
  await assert.rejects(verifyFujiDeployment({...options,fetchImpl:f.fetchImpl}),/FUJI_WRONG_CHAIN/);
  assert.deepEqual(f.calls,['eth_chainId']);
});
test('pending transaction is not a successful deployment',async()=>{
  const f=mock({eth_getTransactionReceipt:null});
  assert.deepEqual(await verifyFujiDeployment({...options,fetchImpl:f.fetchImpl}),{verified:false,state:'pending',chainId:43113});
  assert.equal(f.calls.length,2);
});
for(const [name,method,patch,code] of [
  ['wrong owner','eth_getTransactionReceipt',{from:recorder},'FUJI_RECEIPT_MISMATCH'],
  ['ordinary call','eth_getTransactionReceipt',{to:address},'FUJI_RECEIPT_MISMATCH'],
  ['reverted creation','eth_getTransactionReceipt',{status:'0x0'},'FUJI_DEPLOYMENT_FAILED'],
  ['wrong constructor','eth_getTransactionByHash',{input:artifact.bytecode+addressWord(owner)},'FUJI_CREATION_MISMATCH'],
  ['nonzero transfer value','eth_getTransactionByHash',{value:'0x1'},'FUJI_CREATION_MISMATCH'],
  ['reorg block','eth_getBlockByNumber',{hash:'0x'+'cc'.repeat(32)},'FUJI_BLOCK_MISMATCH'],
  ['missing transaction in block','eth_getBlockByNumber',{transactions:[]},'FUJI_BLOCK_MISMATCH']
])test(name+' cannot verify deployment',async()=>{
  const base=mock();const f=mock({[method]:{...base.values[method],...patch}});
  await assert.rejects(verifyFujiDeployment({...options,fetchImpl:f.fetchImpl}),new RegExp(code));
});
test('runtime mismatch or wrong role cannot verify deployment',async()=>{
  for(const overrides of [{eth_getCode:'0x6000'},{eth_getCode:expectedRuntime(artifact,{owner:recorder,recorder})},{eth_call:'0x'+addressWord(address)}]) {
    const f=mock(overrides);await assert.rejects(verifyFujiDeployment({...options,fetchImpl:f.fetchImpl}),/FUJI_(RUNTIME|ROLE)_MISMATCH/);
  }
});
test('invalid public inputs cause no RPC, and malformed RPC envelope is rejected',async()=>{
  let calls=0;
  await assert.rejects(verifyFujiDeployment({...options,transactionHash:'not-a-hash',fetchImpl:async()=>{calls++;}}));
  assert.equal(calls,0);
  await assert.rejects(verifyFujiDeployment({...options,fetchImpl:async()=>new Response(JSON.stringify({jsonrpc:'2.0',id:999,result:'0xa869'}))}),/FUJI_RPC_ENVELOPE/);
});
test('public RPC rate limiting has one bounded allowlisted reason without response content',async()=>{
  await assert.rejects(verifyFujiDeployment({...options,fetchImpl:async()=>new Response('private upstream text',{
    status:429,headers:{'retry-after':'999999'}})}),error=>error?.code==='FUJI_RPC_RATE_LIMITED'
      && error.message==='FUJI_RPC_RATE_LIMITED' && !error.message.includes('private upstream text'));
});
