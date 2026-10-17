import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {checkLocalModel,localPlannerEnvironment,LOCAL_MODEL,LOCAL_MODEL_DIGEST} from '../scripts/lib/local-model-setup.mjs';
import {readonlyServerEnvironment} from '../scripts/lib/readonly-atk-setup.mjs';

const tag={name:LOCAL_MODEL,digest:LOCAL_MODEL_DIGEST,size:2497293803};
const info={capabilities:['completion'],details:{format:'gguf'}};
function mock(tags={models:[tag]},show=info) {
  const calls=[];
  return {calls,fetch:async(url,options)=>{
    calls.push({url,...options});
    assert.equal(options.redirect,'error');assert.ok(options.signal instanceof AbortSignal);
    return new Response(JSON.stringify(url.endsWith('/tags')?tags:show));
  }};
}
test('local preflight pins downloaded model and only reads local tags/show',async()=>{
  const f=mock();assert.deepEqual(await checkLocalModel(f.fetch),{model:LOCAL_MODEL,digest:LOCAL_MODEL_DIGEST});
  assert.deepEqual(f.calls.map(c=>[c.url,c.method]),[['http://127.0.0.1:11434/api/tags','GET'],['http://127.0.0.1:11434/api/show','POST']]);
  assert.deepEqual(JSON.parse(f.calls[1].body),{model:LOCAL_MODEL});
});
test('missing, changed, duplicate or remote models fail without fallback or generation',async()=>{
  for(const tags of [{},{models:[]},{models:[{...tag,digest:'a'.repeat(64)}]},{models:[tag,tag]},
    {models:[{...tag,size:100}]},{models:[{...tag,remote_host:'https://cloud'}]}]) {
    const f=mock(tags);await assert.rejects(checkLocalModel(f.fetch),{code:'LOCAL_MODEL_NOT_READY'});assert.equal(f.calls.length,1);
  }
  for(const show of [{...info,remote_model:'cloud'}, {...info,remote_host:'https://cloud'}, {}, {...info,details:{format:'remote'}}]) {
    await assert.rejects(checkLocalModel(mock(undefined,show).fetch),{code:'LOCAL_MODEL_NOT_READY'});
  }
});
test('preflight sanitizes network errors and provider responses',async()=>{
  for(const fetch of [async()=>{throw new Error('private body');},async()=>new Response('private body',{status:500}),async()=>new Response('not-json')])
    await assert.rejects(checkLocalModel(fetch),error=>error.message==='LOCAL_MODEL_NOT_READY');
});
test('explicit local option cannot open exchange execution or inherit provider credentials',()=>{
  assert.deepEqual(localPlannerEnvironment({MG_PLANNER:'openai'}),{MG_PLANNER:'fixture'});
  assert.throws(()=>localPlannerEnvironment({PACTWAY_LOCAL_MODEL:'other:cloud'}));
  const env=readonlyServerEnvironment({manifest:{config:{profile:'demo'}}},{data:'test'},
    {apiKey:'fake',secret:'fake',passphrase:'fake'},
    {PACTWAY_LOCAL_MODEL:LOCAL_MODEL,OPENAI_API_KEY:'never',MG_ATK_EXECUTION:'1',MG_OLLAMA_URL:'https://remote'});
  assert.equal(env.MG_PLANNER,'ollama');assert.equal(env.MG_OLLAMA_MODEL,LOCAL_MODEL);
  assert.equal(env.MG_OLLAMA_URL,'http://127.0.0.1:11434/api/chat');
  assert.equal(env.MG_EXECUTION_MODE,'fixture');assert.equal(env.MG_ATK_EXECUTION,'0');assert.equal(env.OPENAI_API_KEY,undefined);
});
test('separate model preview uses allowlisted environment, no exchange credentials',()=>{
  const source=readFileSync(new URL('../scripts/start-local-model.mjs',import.meta.url),'utf8');
  assert.match(source,/await checkLocalModel\(\)/);assert.match(source,/env:\{\.\.\.osEnvironment\(\)/);
  assert.doesNotMatch(source,/\.\.\.process\.env|OKX_API_KEY|OPENAI_API_KEY/);
  assert.match(source,/MG_EXECUTION_MODE:'fixture',MG_ATK_EXECUTION:'0'/);
  assert.match(source,/fujiEnvironment\(\{PACTWAY_FUJI_PROFILE:FUJI_PROFILE\.id\}\)/);
});

test('text-mode QA preview is fixed, isolated, retained and shuts down through IPC',()=>{
  const source=readFileSync(new URL('../scripts/start-local-text-preview.mjs',import.meta.url),'utf8');
  assert.match(source,/await checkLocalModel\(\)/);assert.match(source,/MG_PORT:'18776'/);
  assert.match(source,/text-preview-sessions/);assert.match(source,/mkdtemp/);assert.doesNotMatch(source,/rm|remove/);
  assert.match(source,/MG_EXECUTION_MODE:'fixture',MG_ATK_EXECUTION:'0'/);
  assert.match(source,/fujiEnvironment\(\{PACTWAY_FUJI_PROFILE:FUJI_PROFILE\.id\}\)/);
  assert.match(source,/PACTWAY_SHUTDOWN/);assert.match(source,/process\.once\('disconnect',stop\)/);
  assert.doesNotMatch(source,/\.\.\.process\.env|OKX_API_KEY|OPENAI_API_KEY/);
});

test('local-model app check accepts an explicit loopback origin or port',()=>{
  const source=readFileSync(new URL('../scripts/check-local-model-app.mjs',import.meta.url),'utf8');
  assert.match(source,/MG_LOCAL_MODEL_APP_ORIGIN/);
  assert.match(source,/--origin/);assert.match(source,/--port/);
  assert.match(source,/LOOPBACK_HOSTS/);assert.match(source,/url\.protocol!==\x27http:\x27/);
  assert.match(source,/DEFAULT_ORIGIN=\x27http:\/\/127\.0\.0\.1:18775\x27/);
});
