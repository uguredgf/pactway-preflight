import {readBoundedJson} from '../io/bounded-json.mjs';

const TOOLS=Object.freeze(['market_get_ticker','market_get_instruments']);
const FORMAT=Object.freeze({type:'object',additionalProperties:false,properties:{tools:{type:'array',
  items:{type:'string',enum:TOOLS},minItems:2,maxItems:2,uniqueItems:true}},required:['tools']});
const INSTRUCTIONS='Return only the requested JSON. Choose the order for exactly two distinct read-only data collection tools. '
  +'The only tools are market_get_ticker and market_get_instruments. Do not provide arguments, a verdict, trading advice, or any other field.';

function plan(value) {
  if(!value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).sort().join(',')!=='tools'
      || !Array.isArray(value.tools) || value.tools.length!==2 || new Set(value.tools).size!==2
      || value.tools.some(tool=>!TOOLS.includes(tool)))throw Object.assign(new Error('Model veri planı geçersiz.'),{code:'PREFLIGHT_PLAN_INVALID'});
  return Object.freeze({tools:Object.freeze([...value.tools])});
}

/** One bounded local-model call chooses order only; the server owns all tool args. */
export class PreflightOllamaPlanner {
  kind='ollama';
  constructor({url='http://127.0.0.1:11434/api/chat',model,reserveCall,fetchImpl=fetch}={}) {
    const endpoint=new URL(url);
    if(endpoint.protocol!=='http:' || !['127.0.0.1','localhost','[::1]'].includes(endpoint.hostname)
        || endpoint.pathname!=='/api/chat' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash)
      throw new Error('Preflight yalnız yerel Ollama endpointini destekler.');
    if(typeof model!=='string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,99}$/.test(model)
        || model.includes('://') || /cloud/i.test(model))throw new Error('Yerel model adı geçersiz.');
    if(typeof reserveCall!=='function')throw new Error('Kalıcı preflight model kotası gerekli.');
    this.url=endpoint.href;this.model=model;this.reserveCall=reserveCall;this.fetch=fetchImpl;
  }
  async createPlan({checkId,ownerId,policyHash,candidateHash}) {
    if(this.reserveCall({checkId,ownerId})!==true)throw Object.assign(new Error('Model çağrı kotası doldu.'),{code:'PREFLIGHT_PLAN_LIMIT'});
    const input=JSON.stringify({scope:'AVAX-USDT spot cash buy limit',policyHash,candidateHash,task:'choose_read_order'});
    let response;
    try {response=await this.fetch(this.url,{method:'POST',redirect:'error',signal:AbortSignal.timeout(30000),
      headers:{'Content-Type':'application/json'},body:JSON.stringify({model:this.model,stream:false,think:false,
        format:FORMAT,options:{temperature:0,num_predict:64,num_ctx:2048},
        messages:[{role:'system',content:INSTRUCTIONS},{role:'user',content:input}]})});}
    catch{throw Object.assign(new Error('Yerel planlayıcı yanıt vermedi.'),{code:'PREFLIGHT_PLAN_UNAVAILABLE'});}
    if(!response.ok){await response.body?.cancel();throw Object.assign(new Error('Yerel planlayıcı yanıt vermedi.'),{code:'PREFLIGHT_PLAN_UNAVAILABLE'});}
    try {
      const data=await readBoundedJson(response);
      if(data.done!==true || data.done_reason!=='stop' || data.message?.role!=='assistant'
          || data.message?.tool_calls?.length || typeof data.message?.content!=='string' || data.message.content.length>1024)
        throw new Error();
      return plan(JSON.parse(data.message.content));
    } catch(error) {
      if(error?.code==='PREFLIGHT_PLAN_INVALID')throw error;
      throw Object.assign(new Error('Yerel planlayıcı yanıtı geçersiz.'),{code:'PREFLIGHT_PLAN_INVALID'});
    }
  }
}

export const PREFLIGHT_READ_TOOLS=TOOLS;
