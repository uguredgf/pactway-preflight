// Source only; not run. No server or browser is launched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkRequestOrigin } from '../src/http-boundary.mjs';
import { atkEnvironment } from '../src/adapters/atk-environment.mjs';

test('external invitation can navigate to the entry document without opening cross-site API access',()=>{
  const config={publicOrigin:'https://demo.example',port:8766};
  const navigation={method:'GET',url:'/',headers:{host:'demo.example','sec-fetch-site':'cross-site','sec-fetch-mode':'navigate','sec-fetch-dest':'document'}};
  assert.equal(checkRequestOrigin(navigation,config),true);
  assert.equal(checkRequestOrigin({...navigation,url:'/api/bootstrap'},config),false);
  assert.equal(checkRequestOrigin({...navigation,url:'/api/status'},config),false);
  assert.equal(checkRequestOrigin({...navigation,method:'POST',url:'/api/tasks'},config),false);
  assert.equal(checkRequestOrigin({...navigation,headers:{...navigation.headers,host:'evil.example'}},config),false);
  assert.equal(checkRequestOrigin({...navigation,headers:{...navigation.headers,'sec-fetch-mode':'cors'}},config),false);
  assert.equal(checkRequestOrigin({method:'POST',url:'/api/tasks',headers:{host:'demo.example',origin:'https://demo.example'}},config),true);
});

test('ATK child receives its credentials and system paths but no application secrets or executable overrides',()=>{
  const result=atkEnvironment({Path:'system-path',USERPROFILE:'user-path',OKX_API_KEY:'test-okx',
    OPENAI_API_KEY:'test-model',MG_INVITE_CODE:'test-invite',MG_OPERATOR_KEY:'test-operator',
    OKX_DEMO:'false',OKX_UPDATE_CHECK:'true',OKX_API_BASE_URL:'https://other.example',OKX_AUTH_BIN:'unexpected.exe'});
  assert.equal(result.Path,'system-path');assert.equal(result.OKX_API_KEY,'test-okx');
  assert.equal(result.OKX_DEMO,'true');assert.equal(result.OKX_UPDATE_CHECK,'false');
  for(const key of ['OPENAI_API_KEY','MG_INVITE_CODE','MG_OPERATOR_KEY','OKX_API_BASE_URL','OKX_AUTH_BIN'])assert.equal(Object.hasOwn(result,key),false);
});
