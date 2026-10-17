// Interactive operator workflow: independent UID -> REST read check -> observed
// catalog + explicit approval -> isolated read-only app startup and captured UID.
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {join,isAbsolute} from 'node:path';
import {randomUUID} from 'node:crypto';
import {fork} from 'node:child_process';
import {ReadOnlyATK} from '../src/adapters/atk.mjs';
import {dataDirectory} from '../src/persistence/data-directory.mjs';
import {copyAccountExpectation} from '../src/adapters/atk-account-expectation.mjs';
import {probe} from './lib/okx-tr-demo-probe.mjs';
import {hidden,requirePrivateTerminal} from './lib/private-terminal.mjs';
import {checkLocalModel,localPlannerEnvironment} from './lib/local-model-setup.mjs';
import {root,fail,osEnvironment,prepareReadonlyInstallation,observedBaseline,explicitApproval,readonlyServerEnvironment,readonlyApplicationPort} from './lib/readonly-atk-setup.mjs';

let client,child,credentials,closing=false;
async function stop() {
  if(closing)return;closing=true;
  await client?.close();
  if(child && child.exitCode===null && child.signalCode===null)await new Promise(resolve=>{
    const timer=setTimeout(()=>{child.kill();resolve();},5000);
    child.once('exit',()=>{clearTimeout(timer);resolve();});
    if(child.connected)child.send({type:'PACTWAY_SHUTDOWN'},()=>{});else child.kill();
  });
}
const interrupted=()=>{void stop().finally(()=>process.exit(130));};
process.once('SIGINT',interrupted);process.once('SIGTERM',interrupted);
try {
  requirePrivateTerminal();
  const applicationPort=readonlyApplicationPort(process.env);
  const localPlanner=localPlannerEnvironment(process.env);
  if(localPlanner.MG_PLANNER==='ollama') {
    await checkLocalModel();
    console.log('Yerel model: '+localPlanner.MG_OLLAMA_MODEL+' (Preflight okuma plani; emir gondermez).');
  }
  console.log('OKX TR DEMO / UID + SALT OKUNUR ATK BAGLANTISI');
  console.log('UID: OKX hesap/profil ekranindan, API anahtarinin ait oldugu demo hesap icin bagimsiz olarak alin.');
  console.log('API yanitindan UID kopyalamayin. Uyusmazlikta durulur; normal/global hesaba gecilmez.');
  console.log('Anahtarlar dosyaya yazilmaz; yalniz bu surec ve izole alt sureclerin belleginde/ortaminda kullanilir.');
  console.log('UID beklentisi ve hesap/config kaniti OneDrive DISINDA yerel uygulama klasorune kaydedilir.');
  console.log('Preflight canli piyasa okur; emir/iptal/transfer yok. Legacy gorevler ayri fixture simulasyonudur.');
  const expectedUid=await hidden('Beklenen hesap UID');
  if(!/^[0-9]{1,64}$/.test(expectedUid))throw fail('EXPECTED_UID_INVALID');
  const setup=await prepareReadonlyInstallation(randomUUID());
  credentials={apiKey:await hidden('Demo API key'),secret:await hidden('Demo Secret key'),passphrase:await hidden('Demo API passphrase')};
  await probe(credentials,{expectedUid});
  console.log('RESULT: DEMO_READ_UID_MATCHED');
  client=new ReadOnlyATK({nodePath:process.execPath,entryPath:setup.entryPath,profile:setup.manifest.config.profile,execution:false,
    isolated:{manifest:setup.manifest,upstreamEntryPath:setup.upstreamEntryPath,bootstrapEntryPath:setup.bootstrapEntryPath,osEnvironment:osEnvironment(),
      credentials:{OKX_API_KEY:credentials.apiKey,OKX_SECRET_KEY:credentials.secret,OKX_PASSPHRASE:credentials.passphrase}}});
  const handshake=await client.connect(),baseline=observedBaseline(client,setup.manifest,handshake);
  const local=process.env.LOCALAPPDATA;
  if(!local || !isAbsolute(local))throw fail('LOCAL_DATA_PATH_REQUIRED');
  const parent=dataDirectory({workspaceRoot:root,environment:{MG_DATA_DIR:join(local,'Pactway','readonly-sessions')}});
  await mkdir(parent,{recursive:true,mode:0o700});
  const directory=await mkdtemp(join(parent,'session-'));
  const files={data:join(directory,'data'),manifest:join(directory,'manifest.json'),approval:join(directory,'approval.json'),account:join(directory,'account.json')};
  const catalogPath=join(directory,'catalog-review.json');
  await writeFile(catalogPath,JSON.stringify(baseline.baseline,null,2),{flag:'wx',mode:0o600});
  console.log('Salt okuma araclari: '+baseline.baseline.tools.map(tool=>tool.name).join(', '));
  console.log('Incelenecek katalog: '+catalogPath);
  console.log('Katalog SHA-256: '+baseline.baselineHash);
  console.log('Bu katalogla salt okunur baglantiyi onayliyorsaniz yukaridaki hash degerini girin; aksi halde Ctrl+C.');
  const approval=explicitApproval(baseline,await hidden('Onaylanan katalog SHA-256'));
  await client.close();client=null;
  const expectation=copyAccountExpectation({schemaVersion:1,connectionHash:setup.manifest.configHash,accountId:setup.manifest.config.accountId,expectedUid},setup.manifest.configHash,setup.manifest.config.accountId);
  for(const [path,value] of [[files.manifest,setup.manifest],[files.approval,approval],[files.account,expectation]])
    await writeFile(path,JSON.stringify(value,null,2),{flag:'wx',mode:0o600});
  const env=readonlyServerEnvironment(setup,files,credentials);
  const ready=new Promise((resolve,reject)=>{
    child=fork(join(root,'src/server.mjs'),[],{cwd:root,execArgv:[],env,windowsHide:true,stdio:['ignore','ignore','ignore','ipc']});
    const timer=setTimeout(()=>reject(fail('APP_START_TIMEOUT')),45000);
    child.once('error',()=>{clearTimeout(timer);reject(fail('APP_START_FAILED'));});
    child.once('exit',()=>{clearTimeout(timer);reject(fail('APP_STOPPED'));});
    child.on('message',message=>{if(message?.type==='PACTWAY_READONLY_READY'){
      clearTimeout(timer);message.ready===true?resolve():reject(fail('ATK_READONLY_IDENTITY_OR_CONNECTION_FAILED'));
    }});
  });
  for(const key of ['OKX_API_KEY','OKX_SECRET_KEY','OKX_PASSPHRASE'])delete env[key];
  for(const key of Object.keys(credentials))credentials[key]='';credentials=null;
  await ready;
  console.log('RESULT: ATK_READONLY_UID_MATCHED_APP_READY');
  console.log('Uygulama: http://127.0.0.1:'+applicationPort+'/');
  console.log('Hesap/config UID eslesti, read_only dogrulandi. Emir gonderme kapali. Bu pencere acik kalsin; cikis Ctrl+C.');
  await new Promise(resolve=>{if(child.exitCode!==null || child.signalCode!==null)resolve();else child.once('exit',resolve);});
}catch(error){
  const code=String(error?.code || error?.message || '');
  const safe=/^(OKX_501\d{2}|HTTP_\d{1,3}|EXPECTED_UID_INVALID|UID_MISMATCH|READ_ONLY_NOT_CONFIRMED|INTERACTIVE_TERMINAL_REQUIRED|UNSAFE_RUNTIME_OPTIONS|INPUT_CANCELLED|INPUT_INVALID|CLOCK_INVALID|NETWORK_ERROR|TIMEOUT|CATALOG_NOT_APPROVED|APP_PORT_INVALID|APP_START_TIMEOUT|APP_START_FAILED|APP_STOPPED|ATK_READONLY_IDENTITY_OR_CONNECTION_FAILED|ATK_PACKAGE_VERSION_MISMATCH|ATK_ENTRY_HASH_MISMATCH|ATK_FILES_UNAVAILABLE|ATK_CATALOG_READONLY_REQUIRED|ATK_CATALOG_REQUIRED_MISSING|LOCAL_MODEL_NOT_READY)$/.test(code)?code:'READONLY_SETUP_FAILED';
  console.log('RESULT: '+safe);process.exitCode=1;
}finally{
  if(credentials)for(const key of Object.keys(credentials))credentials[key]='';credentials=null;
  await stop();process.stdin.pause();
}
