import {readBoundedJson} from '../../src/io/bounded-json.mjs';

export const LOCAL_MODEL='qwen3:4b-instruct';
export const LOCAL_MODEL_DIGEST='0edcdef34593eac1aa2be9c7d06c432dcf81945adca5eca2f27662c18f168ba0';
export const LOCAL_MODEL_URL='http://127.0.0.1:11434/api/chat';
const fail=()=>Object.assign(new Error('LOCAL_MODEL_NOT_READY'),{code:'LOCAL_MODEL_NOT_READY'});

// No install, pull, fallback, credentials, generation or arbitrary endpoint.
export async function checkLocalModel(fetchImpl=fetch) {
  try {
    const request=async(path,body)=>{
      const response=await fetchImpl('http://127.0.0.1:11434/api/'+path,{
        method:body?'POST':'GET',redirect:'error',signal:AbortSignal.timeout(5000),
        ...(body?{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})});
      if(!response.ok){await response.body?.cancel();throw fail();}
      return readBoundedJson(response);
    };
    const tags=await request('tags');
    const matches=tags.models?.filter(model=>model.name===LOCAL_MODEL);
    if(matches?.length!==1 || matches[0].digest!==LOCAL_MODEL_DIGEST || matches[0].size<1_000_000_000
      || matches[0].remote_model || matches[0].remote_host)throw fail();
    const info=await request('show',{model:LOCAL_MODEL});
    if(info.remote_model || info.remote_host || !info.capabilities?.includes('completion') || info.details?.format!=='gguf')throw fail();
    return {model:LOCAL_MODEL,digest:LOCAL_MODEL_DIGEST};
  }catch {throw fail();}
}

// Explicit opt-in only. Unrelated ambient model/provider configuration is ignored.
export function localPlannerEnvironment(environment={}) {
  if(environment.PACTWAY_LOCAL_MODEL===undefined)return {MG_PLANNER:'fixture'};
  if(environment.PACTWAY_LOCAL_MODEL!==LOCAL_MODEL)throw fail();
  return {MG_PLANNER:'ollama',MG_OLLAMA_MODEL:LOCAL_MODEL,MG_OLLAMA_URL:LOCAL_MODEL_URL};
}
