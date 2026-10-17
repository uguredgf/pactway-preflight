import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {readonlyApplicationPort,readonlyServerEnvironment} from '../scripts/lib/readonly-atk-setup.mjs';

test('read-only launcher preserves the old port unless explicitly configured',()=>{
  assert.equal(readonlyApplicationPort({}),'18774');
  assert.equal(readonlyApplicationPort({PACTWAY_APP_PORT:'18779'}),'18779');
  for(const value of ['80','0','65536','18779x','018779',18779,'18779\n'])
    assert.throws(()=>readonlyApplicationPort({PACTWAY_APP_PORT:value}),/APP_PORT_INVALID/);
});

test('separate preflight launcher cannot inherit execution or cloud configuration',()=>{
  const setup={entryPath:'entry',upstreamEntryPath:'upstream',bootstrapEntryPath:'bootstrap',manifest:{config:{profile:'readonly'}}};
  const files={data:'data',manifest:'manifest',approval:'approval',account:'account'};
  const env=readonlyServerEnvironment(setup,files,{apiKey:'fake',secret:'fake',passphrase:'fake'},
    {PACTWAY_APP_PORT:'18779',MG_ATK_EXECUTION:'1',MG_EXECUTION_MODE:'demo-prepared',OPENAI_API_KEY:'must-not-inherit'});
  assert.equal(env.MG_PORT,'18779');
  assert.equal(env.MG_ATK_EXECUTION,'0');
  assert.equal(env.MG_EXECUTION_MODE,'fixture');
  assert.equal(env.OPENAI_API_KEY,undefined);
  const source=readFileSync(new URL('../scripts/connect-preflight.mjs',import.meta.url),'utf8');
  assert.match(source,/PACTWAY_LOCAL_MODEL=LOCAL_MODEL/);
  assert.match(source,/PACTWAY_APP_PORT='18779'/);
});
