import {FUJI_CHAIN_ID,FUJI_RPC_URL} from '../../src/audit/fuji.mjs';
import {readBoundedJson} from '../../src/io/bounded-json.mjs';
import {requireFujiRpcHttp} from '../../src/audit/fuji-rpc-http.mjs';
import {addressWord,expectedRuntime} from './fuji-build.mjs';
const hex32=value=>typeof value==='string' && /^0x[0-9a-f]{64}$/i.test(value);
const quantity=value=>typeof value==='string' && /^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value);
const equal=(a,b)=>typeof a==='string' && typeof b==='string' && a.toLowerCase()===b.toLowerCase();
const requireMatch=(condition,code)=>{if(!condition)throw new Error(code);};

// Read-only checks against the fixed public Fuji endpoint. RPC is trusted, not a light client.
// artifact must come from the local compileRegistry(), not from the claimed deployment.
export async function verifyFujiDeployment({artifact,transactionHash,owner,recorder,fetchImpl=fetch}) {
  addressWord(owner);addressWord(recorder);
  requireMatch(hex32(transactionHash),'FUJI_TX_INVALID');
  requireMatch(artifact?.chainId===FUJI_CHAIN_ID,'FUJI_ARTIFACT_CHAIN_INVALID');
  let id=0;const signal=AbortSignal.timeout(30000);
  async function rpc(method,params=[]) {
    const requestId=++id;
    const response=await fetchImpl(FUJI_RPC_URL,{method:'POST',redirect:'error',signal,headers:{'Content-Type':'application/json'},
      body:JSON.stringify({jsonrpc:'2.0',id:requestId,method,params})});
    await requireFujiRpcHttp(response);
    const data=await readBoundedJson(response,{maxBytes:1048576});
    requireMatch(data.jsonrpc==='2.0' && data.id===requestId && !data.error && Object.hasOwn(data,'result'),'FUJI_RPC_ENVELOPE');
    return data.result;
  }
  const chain=await rpc('eth_chainId');
  requireMatch(quantity(chain) && BigInt(chain)===43113n,'FUJI_WRONG_CHAIN');
  const receipt=await rpc('eth_getTransactionReceipt',[transactionHash]);
  if(receipt===null)return {verified:false,state:'pending',chainId:FUJI_CHAIN_ID};
  requireMatch(equal(receipt.transactionHash,transactionHash) && receipt.to===null && equal(receipt.from,owner)
    && hex32(receipt.blockHash) && quantity(receipt.blockNumber),'FUJI_RECEIPT_MISMATCH');
  requireMatch(quantity(receipt.status) && BigInt(receipt.status)===1n,'FUJI_DEPLOYMENT_FAILED');
  addressWord(receipt.contractAddress);
  const transaction=await rpc('eth_getTransactionByHash',[transactionHash]);
  requireMatch(transaction && equal(transaction.hash,transactionHash) && transaction.to===null && equal(transaction.from,owner)
    && transaction.value==='0x0' && equal(transaction.blockHash,receipt.blockHash) && transaction.blockNumber===receipt.blockNumber
    && equal(transaction.input,artifact.bytecode+addressWord(recorder)),'FUJI_CREATION_MISMATCH');
  const block=await rpc('eth_getBlockByNumber',[receipt.blockNumber,false]);
  requireMatch(block && equal(block.hash,receipt.blockHash) && block.number===receipt.blockNumber
    && Array.isArray(block.transactions) && block.transactions.some(hash=>equal(hash,transactionHash)),'FUJI_BLOCK_MISMATCH');
  const address=receipt.contractAddress.toLowerCase();
  const code=await rpc('eth_getCode',[address,receipt.blockNumber]);
  requireMatch(equal(code,expectedRuntime(artifact,{owner,recorder})),'FUJI_RUNTIME_MISMATCH');
  for(const [name,expected] of Object.entries({owner,recorder})) {
    const value=await rpc('eth_call',[{to:address,data:'0x'+artifact.methodIdentifiers[name+'()']},receipt.blockNumber]);
    requireMatch(equal(value,'0x'+addressWord(expected)),'FUJI_ROLE_MISMATCH');
  }
  return {verified:true,state:'deployment-verified',chainId:FUJI_CHAIN_ID,contractAddress:address,
    transactionHash:transactionHash.toLowerCase(),blockNumber:receipt.blockNumber,blockHash:receipt.blockHash.toLowerCase(),
    owner:owner.toLowerCase(),recorder:recorder.toLowerCase(),sourceSha256:artifact.sourceSha256,
    scope:'Exact local creation/runtime and roles at canonical RPC block; no policy/decision publication or CEX proof.'};
}
