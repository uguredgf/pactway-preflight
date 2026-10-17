// One bounded local-only proposal using invented fixture values; no account access.
import {OllamaPlanner} from '../src/planner.mjs';
import {checkLocalModel,LOCAL_MODEL} from './lib/local-model-setup.mjs';
import {readBoundedJson} from '../src/io/bounded-json.mjs';
try {
  await checkLocalModel();let calls=0;
  const planner=new OllamaPlanner({model:LOCAL_MODEL,reserveCall:()=>++calls===1,
    fetchImpl:async(url,options)=>{
      const response=await fetch(url,options),copy=await readBoundedJson(response);
      console.log(JSON.stringify({http:response.status,done:copy.done,doneReason:copy.done_reason,role:copy.message?.role,
        toolCalls:copy.message?.tool_calls?.length??0,contentLength:copy.message?.content?.length,loadMs:copy.load_duration/1e6,evalCount:copy.eval_count}));
      return new Response(JSON.stringify(copy),{status:response.status,headers:{'Content-Type':'application/json'}});
    }});
  const result=await planner.propose({policy:{budget:'100',singleOrderNotionalMax:'25',maxPrice:'25',maxShare:'0.1',
    quoteFeeRateMax:'0',quoteFeeFixedMax:'0.01',baseFeeRateMax:'0'},
    snapshot:{baseBalance:'1.61290322',quoteBalance:'460',availableQuote:'460',referencePrice:'24.80',tickSize:'0.01',lotSize:'0.00000001',minSize:'0.01',source:'controlled-fixture'},
    ledgerSummary:{spent:'0',reserved:'0',remaining:'100'},attempt:0});
  console.log(JSON.stringify({result:'LOCAL_MODEL_PROPOSAL_OK',action:result.action,calls}));
}catch(error){console.error(['TimeoutError','AbortError'].includes(error?.name)?'LOCAL_MODEL_TIMEOUT':'LOCAL_MODEL_PROPOSAL_FAILED');process.exitCode=1;}
