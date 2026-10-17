import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync,realpathSync} from 'node:fs';
import {join,dirname,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {ISOLATED_BOOTSTRAP_SOURCE} from '../src/adapters/atk-isolated-bootstrap-source.mjs';
import {osEnvironment} from '../scripts/lib/readonly-atk-setup.mjs';

test('bootstrap scrubs known Windows additions before import and denies unrelated overrides',{timeout:15000},async()=>{
  const directory=mkdtempSync(join(tmpdir(),'pactway-bootstrap-')),boot=join(directory,'boot.mjs'),target=join(directory,'target.mjs');
  try {
    writeFileSync(boot,ISOLATED_BOOTSTRAP_SOURCE);
    writeFileSync(target,"console.log(JSON.stringify({keys:Object.keys(process.env).sort(),args:process.argv.slice(2)}));");
    async function run(extra={}) {
      const child=spawn(process.execPath,[boot,target,'--read-only'],{windowsHide:true,env:{...osEnvironment(),OKX_API_KEY:'fake',OKX_SECRET_KEY:'fake',OKX_PASSPHRASE:'fake',...extra}});
      let out='',err='';child.stdout.on('data',d=>{out+=d;});child.stderr.on('data',d=>{err+=d;});
      return await new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>{child.kill();reject(new Error('test timeout'));},5000);
        child.once('error',e=>{clearTimeout(timer);reject(e);});child.once('close',code=>{clearTimeout(timer);resolve({out,err,code});});
      });
    }
    const good=await run();assert.equal(good.code,0);const result=JSON.parse(good.out);
    assert.deepEqual(result.args,['--read-only']);
    assert.ok(result.keys.every(key=>['SystemRoot','WINDIR','TEMP','TMP','OKX_API_KEY','OKX_SECRET_KEY','OKX_PASSPHRASE'].includes(key)));
    for(const extra of [{HTTP_PROXY:'https://invalid.test'},{OPENAI_API_KEY:'fake-unrelated'},{OKX_SITE:'global'}]){
      const bad=await run(extra);assert.equal(bad.code,1);assert.equal(bad.out,'');assert.equal(bad.err,'PACTWAY_BOOTSTRAP_DENIED\n');
    }
  }finally{
    const path=realpathSync(directory);assert.equal(dirname(path),realpathSync(tmpdir()));assert.ok(basename(path).startsWith('pactway-bootstrap-'));rmSync(path,{recursive:true,force:true});
  }
});
