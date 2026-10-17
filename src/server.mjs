import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { Store } from './persistence/store.mjs';
import { dataDirectory } from './persistence/data-directory.mjs';
import { Engine } from './engine.mjs';
import { FixturePlanner, OllamaPlanner, OpenAIPlanner } from './planner.mjs';
import { VisitorAccess, RequestLimits, equalSecret } from './access.mjs';
import { ExecutionQueue } from './execution-queue.mjs';
import { SafetyLane } from './safety-lane.mjs';
import { checkRequestOrigin } from './http-boundary.mjs';
import {DemoExecutor} from './demo-executor.mjs';
import {OllamaDraftExtractor,OpenAIDraftExtractor} from './extractor.mjs';
import {demoPolicyConfiguration} from './demo-policy.mjs';
import {FUJI_PROFILE} from './audit/fuji-deployment-profile.mjs';
import {failedFujiAcceptance} from './audit/fuji-acceptance-profile.mjs';
import {ReadOnlyMarketService} from './read-only-market.mjs';
import {PreflightRepository} from './preflight/repository.mjs';
import {PreflightService} from './preflight/service.mjs';
import {PreflightOllamaPlanner} from './preflight/planner.mjs';
import {PreflightAgentReviewer} from './preflight/agent-reviewer.mjs';
import {PREFLIGHT_SCOPE,PREFLIGHT_LIMITS} from './preflight/domain.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const PREFLIGHT_PUBLIC_ERRORS=new Set(['PREFLIGHT_POLICY_LIMIT','PREFLIGHT_POLICY_NOT_FOUND','PREFLIGHT_POLICY_INVALID',
  'PREFLIGHT_POLICY_NOT_APPROVED','PREFLIGHT_POLICY_NOT_CURRENT','PREFLIGHT_CHECK_LIMIT','PREFLIGHT_CHECK_STATE',
  'PREFLIGHT_CHECK_NOT_FOUND','PREFLIGHT_IDEMPOTENCY_CONFLICT','PREFLIGHT_REPORT_PENDING','PREFLIGHT_REPORT_INVALID',
  'PREFLIGHT_PLAN_LIMIT','PREFLIGHT_LIVE_UNAVAILABLE','PREFLIGHT_BUSY','PREFLIGHT_CLOSING',
  'PREFLIGHT_STORAGE_UNCERTAIN','PREFLIGHT_EXAMPLE_NOT_FOUND','PREFLIGHT_INPUT_INVALID']);
const port=Number(process.env.MG_PORT || 8766);
if(!Number.isInteger(port) || port<1024 || port>65535)throw new Error('MG_PORT geçersiz');
const configuredOrigin=process.env.MG_PUBLIC_ORIGIN || '';
const operatorKey=process.env.MG_OPERATOR_KEY || '';
if(operatorKey && (operatorKey.length<24 || operatorKey.length>256))throw new Error('MG_OPERATOR_KEY 24–256 karakter olmalı.');
let publicOrigin=null;
if(configuredOrigin) {
  const url=new URL(configuredOrigin);
  if(url.protocol!=='https:' || url.username || url.password || url.pathname!=='/' || url.search || url.hash)
    throw new Error('MG_PUBLIC_ORIGIN yalnız HTTPS origin olmalı.');
  publicOrigin=url.origin;
  if(!(process.env.MG_INVITE_CODE?.length>=24 && process.env.MG_INVITE_CODE.length<=256))
    throw new Error('Paylaşım için 24–256 karakterlik MG_INVITE_CODE gerekir.');
  if(!operatorKey || equalSecret(operatorKey,process.env.MG_INVITE_CODE))
    throw new Error('Paylaşım için davet kodundan farklı MG_OPERATOR_KEY gerekir.');
}
const plannerMode=process.env.MG_PLANNER || 'fixture';
const fujiProfile=process.env.MG_FUJI_PROFILE;
if(fujiProfile!==undefined && fujiProfile!==FUJI_PROFILE.id)throw new Error('FUJI_PROFILE_INVALID');
const modelCallLimit=Number(process.env.MG_OPENAI_CALL_LIMIT || 100);
if(!Number.isSafeInteger(modelCallLimit) || modelCallLimit<1 || modelCallLimit>1000)throw new Error('MG_OPENAI_CALL_LIMIT 1–1000 arasında olmalı');
if(!['fixture','ollama','openai'].includes(plannerMode))throw new Error('MG_PLANNER fixture, ollama veya openai olmalı');
const planner=plannerMode==='fixture'?new FixturePlanner():plannerMode==='openai'
  ?new OpenAIPlanner({apiKey:process.env.OPENAI_API_KEY,model:process.env.MG_OPENAI_MODEL,reserveCall:usage=>store.reserveOwnedModelCall(modelCallLimit,usage)})
  :new OllamaPlanner({url:process.env.MG_OLLAMA_URL,model:process.env.MG_OLLAMA_MODEL,reserveCall:usage=>store.reserveOwnedModelCall(modelCallLimit,usage)});
const executionMode=process.env.MG_EXECUTION_MODE || 'fixture';
if(!['fixture','demo-prepared'].includes(executionMode))throw new Error('MG_EXECUTION_MODE geçersiz');
let demoPolicy=null;
if(executionMode==='demo-prepared') {
  if(process.env.MG_ATK_EXECUTION!=='1' || process.env.MG_ATK_ISOLATED!=='1' || !operatorKey
      || !['openai','ollama'].includes(plannerMode) || !process.env.MG_DEMO_POLICY_FILE)
    throw new Error('Açık demo yürütme, model ve operatör politika yapılandırması gerekli.');
  const configuration=await readFile(process.env.MG_DEMO_POLICY_FILE,'utf8');
  if(Buffer.byteLength(configuration,'utf8')>8192)throw new Error('Demo politika yapılandırması çok büyük.');
  demoPolicy=demoPolicyConfiguration(JSON.parse(configuration));
}
const store=new Store(dataDirectory({workspaceRoot:root}));
const preflightRepository=new PreflightRepository(store,{modelCallLimit});
const preflightPlanner=plannerMode==='ollama'?new PreflightOllamaPlanner({url:process.env.MG_OLLAMA_URL,
  model:process.env.MG_OLLAMA_MODEL,reserveCall:({checkId,ownerId})=>preflightRepository.reservePlanCall(ownerId,checkId)}):null;
const preflightAgentReviewer=plannerMode==='ollama'?new PreflightAgentReviewer({url:process.env.MG_OLLAMA_URL,
  model:process.env.MG_OLLAMA_MODEL,reserveCall:({checkId,ownerId})=>preflightRepository.reserveAgentCall(ownerId,checkId)}):null;
const extractor=plannerMode==='openai'?new OpenAIDraftExtractor({apiKey:process.env.OPENAI_API_KEY,model:process.env.MG_OPENAI_MODEL,
  reserveCall:usage=>store.reserveOwnedModelCall(modelCallLimit,usage)}):plannerMode==='ollama'
  ?new OllamaDraftExtractor({url:process.env.MG_OLLAMA_URL,model:process.env.MG_OLLAMA_MODEL,
    reserveCall:usage=>store.reserveOwnedModelCall(modelCallLimit,usage)}):null;
// Cookies are scoped by host, not port. Namespace local processes by their listen
// port; shared deployments use the configured external origin port so changing an
// internal listen port does not invalidate browser sessions.
const sessionCookiePort=publicOrigin?(new URL(publicOrigin).port || '443'):String(port);
const sessionCookieName=`${publicOrigin?'__Host-':''}mg-session-${sessionCookiePort}`;
const access=new VisitorAccess(store,{shared:Boolean(publicOrigin),inviteCode:process.env.MG_INVITE_CODE,cookieName:sessionCookieName});
const limits=new RequestLimits();
const engine=new Engine(store,planner,{extractor,executionMode,demoPolicy,isExecutionAuthorized:state=>Boolean(state.ownerId) && store.ownerSessionActive(state.ownerId,Date.now())});engine.recover();
const queue=new ExecutionQueue(store,engine,{demoExecutor:()=>status.atk.state==='DEMO_EXECUTION_CONNECTED'?demoExecutor:null});queue.recover();
const safety=new SafetyLane(store,{isOwnerActive:(state,now)=>Boolean(state.ownerId) && store.ownerSessionActive(state.ownerId,now)});
const staticFiles=new Map([
  ['/', ['preflight.html','text/html; charset=utf-8']], ['/preflight.html',['preflight.html','text/html; charset=utf-8']],
  ['/preflight.css',['public/preflight.css','text/css; charset=utf-8']],
  ['/preflight.mjs',['public/preflight.mjs','text/javascript; charset=utf-8']],
  ['/legacy',['app.html','text/html; charset=utf-8']], ['/legacy/',['app.html','text/html; charset=utf-8']],
  ['/app.html',['app.html','text/html; charset=utf-8']],
  ['/app.css',['public/app.css','text/css; charset=utf-8']], ['/app.mjs',['public/app.mjs','text/javascript; charset=utf-8']],
  ['/messages.mjs',['public/messages.mjs','text/javascript; charset=utf-8']],
  ['/ui-state.mjs',['public/ui-state.mjs','text/javascript; charset=utf-8']],
  ['/motion.css',['public/motion.css','text/css; charset=utf-8']], ['/motion.js',['public/motion.js','text/javascript; charset=utf-8']]
]);
for(const name of ['instrument-sans-latin-wght-normal.woff2','instrument-sans-latin-ext-wght-normal.woff2','newsreader-latin-standard-normal.woff2','newsreader-latin-ext-standard-normal.woff2'])
  staticFiles.set('/fonts/'+name,['previews/concepts/fonts/'+name,'font/woff2']);
const status={executionMode,plannerKind:planner.kind,extractorAvailable:!!extractor,
  accessMode:publicOrigin?'INVITED_VISITORS':'LOCAL_VISITORS',queueMode:executionMode==='fixture'?'SINGLE_FIXTURE_EXECUTOR':'SINGLE_DEMO_EXECUTOR',
  atk:{state:'NOT_CONNECTED',writeEnabled:false,orderSubmissionEnabled:false,transferEnabled:false},
  avalanche:{state:'NOT_DEPLOYED',chainId:43113},tests:'NOT_RUN'};
let atk=null,demoExecutor=null,readOnlyMarket=null,atkConnection=Promise.resolve(),fujiConnection=Promise.resolve();
let fujiRefreshing=false,fujiRefreshNextAt=0;
const preflightService=new PreflightService({repository:preflightRepository,getRuntime:()=>
  status.atk.state==='READ_ONLY_CONNECTED' && status.atk.readPermissionConfirmed===true && preflightPlanner
    ?{client:atk,planner:preflightPlanner,agentReviewer:preflightAgentReviewer,store}:null});
const preflightStatus=()=>{
  const integrations=integrationStatus();
  return preflightService.status({plannerKind:preflightPlanner?.kind??'unavailable',atkState:integrations.atk.state,
    agentAvailable:Boolean(preflightAgentReviewer && integrations.atk.state==='READ_ONLY_CONNECTED'
      && integrations.atk.readPermissionConfirmed===true),agentVersion:1,
    scope:PREFLIGHT_SCOPE,limits:{...PREFLIGHT_LIMITS,...preflightRepository.limits()}});
};
async function connectFujiRegistry({interactive=false}={}) {
  if(!fujiProfile) {
    if(interactive)throw Object.assign(new Error('Bu süreçte Fuji profili yapılandırılmadı.'),{status:409});
    return status.avalanche;
  }
  const now=Date.now();
  if(fujiRefreshing)throw Object.assign(new Error('Fuji doğrulaması sürüyor.'),{status:429});
  if(interactive && now<fujiRefreshNextAt)throw Object.assign(new Error('Fuji doğrulaması kısa süre önce çalıştı. Biraz bekleyip tekrar dene.'),{status:429});
  fujiRefreshing=true;fujiRefreshNextAt=now+30000;
  status.avalanche={state:'VERIFYING_DEPLOYMENT',chainId:43113};
  try {
    const {verifySelectedFuji}=await import('../scripts/lib/verify-selected-fuji.mjs');
    const verified=await verifySelectedFuji();
    if(shuttingDown)return;
    const deployment={state:'DEPLOYMENT_VERIFIED',chainId:43113,contractAddress:verified.contractAddress,
      transactionHash:verified.transactionHash,buildProfile:verified.buildProfile,checkedAtMs:Date.now(),
      publication:'TASK_RECEIPTS_NOT_VERIFIED',writeEnabled:false,
      acceptanceTest:{state:'VERIFYING',mode:'fixture',onlyFirstReceipt:true,writeEnabled:false}};
    status.avalanche=deployment;
    try {
      const {verifyFujiAcceptanceTest}=await import('../scripts/lib/verify-fuji-acceptance.mjs');
      const acceptanceTest=await verifyFujiAcceptanceTest();
      if(!shuttingDown)status.avalanche={...deployment,acceptanceTest};
    } catch(error) {if(!shuttingDown)status.avalanche={...deployment,
      acceptanceTest:failedFujiAcceptance(error?.code)};}
  }catch(error) {if(!shuttingDown)status.avalanche={state:'DEPLOYMENT_VERIFICATION_FAILED',chainId:43113,
    writeEnabled:false,...(error?.code==='FUJI_RPC_RATE_LIMITED'?{reasonCode:'FUJI_RPC_RATE_LIMITED'}:{})};}
  finally {fujiRefreshing=false;}
  return status.avalanche;
}
function integrationStatus() {
  if(atk && ['READ_ONLY_CONNECTED','DEMO_EXECUTION_CONNECTED'].includes(status.atk.state))try {atk.tools();}catch {
    status.atk={state:'DISCONNECTED',writeEnabled:false,orderSubmissionEnabled:false,transferEnabled:false};readOnlyMarket=null;
  }
  return {...status,safety:store.globalSafetyStatus()};
}
function reply(response,statusCode,data) {
  response.writeHead(statusCode,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-MG-Server-Time':String(Date.now())});
  response.end(JSON.stringify(data));
}
function checkOrigin(request) {
  return checkRequestOrigin(request,{publicOrigin,port});
}
function validToken(request,session) {return equalSecret(request.headers['x-mg-csrf'],session.csrf);}
async function body(request) {
  if(!/^application\/json(?:;|$)/i.test(request.headers['content-type'] || ''))throw Object.assign(new Error('JSON bekleniyor'),{status:415});
  let bytes=0;const chunks=[];
  for await(const chunk of request) {
    bytes+=chunk.length;if(bytes>16384)throw Object.assign(new Error('İstek çok büyük'),{status:413});chunks.push(chunk);
  }
  try {const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if(!value || typeof value!=='object' || Array.isArray(value))throw new Error();return value;
  }catch {throw Object.assign(new Error('Geçersiz JSON'),{status:400});}
}
function taskView(id){return queue.view(id);}
function hasUnresolved(state){return state.busy || state.ledger.intents.some(intent=>!intent.settled);}
function tick() {
  const result=safety.sweep(Date.now());
  if(demoExecutor)void demoExecutor.tick();
  if(!result.ok)return;
  void queue.pump().catch(()=>{store.pauseGlobal('SAFETY_PROCESSING_FAILED');});
}

const server=createServer(async(request,response)=>{
  response.setHeader('X-Content-Type-Options','nosniff');response.setHeader('Referrer-Policy','no-referrer');
  response.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  try {
    if(shuttingDown)return reply(response,503,{error:'Sunucu kapanıyor. Sonuç kaydını yeni bağlantıda kontrol et.'});
    if(!checkOrigin(request))return reply(response,403,{error:'İstek yapılandırılan site origin’iyle eşleşmiyor.'});
    const path=new URL(request.url,publicOrigin || 'http://'+request.headers.host).pathname;
    if(request.method==='GET' && staticFiles.has(path)) {
      const [file,type]=staticFiles.get(path),content=await readFile(join(root,file));
      response.writeHead(200,{'Content-Type':type,'Cache-Control':'no-store'});return response.end(content);
    }
    if(path.startsWith('/api/operator/')) {
      if(!operatorKey || !equalSecret(request.headers['x-mg-operator'],operatorKey))return reply(response,404,{error:'Yol bulunamadı.'});
      limits.allow('operator',30);
      if(request.method==='POST' && ['/api/operator/demo-baseline','/api/operator/demo-submit','/api/operator/demo-reconcile','/api/operator/demo-propose'].includes(path)) {
        if(!demoExecutor)return reply(response,409,{error:'Doğrulanmış demo yürütme bağlantısı hazır değil.'});
        const input=await body(request);
        const expected=path.endsWith('demo-baseline')?['campaignId']:path.endsWith('demo-submit')?['taskId','candidate']:['taskId'];
        if(Object.keys(input).sort().join(',')!==expected.sort().join(','))return reply(response,400,{error:'Geçersiz demo isteği.'});
        try {
          const result=path.endsWith('demo-baseline')?await demoExecutor.baseline(input.campaignId)
            :path.endsWith('demo-submit')?await demoExecutor.submit(input.taskId,input.candidate)
            :path.endsWith('demo-propose')?await demoExecutor.propose(input.taskId):await demoExecutor.poll(input.taskId);
          // Raw records, account UID, manifest and request paths are never exposed.
          return reply(response,200,{code:result.code??'DEMO_BASELINE_RECORDED',settled:result.settled===true,
            retryAllowed:false,observationId:result.observationId??null,
            ...(path.endsWith('demo-propose')?{proposal:result.proposal??null,candidate:result.candidate??null,
              governorCode:result.governorCode??null,dispatchAllowed:false}:{})});
        } catch {return reply(response,409,{error:'Demo işlemi tamamlanmadı. Kayıtlar ve ayrılan bütçe korunuyor; işlem durumunu kontrol et.'});}
      }
      if(request.method==='GET' && path==='/api/operator/safety-work')return reply(response,200,safety.recoveryView());
      if(request.method==='POST' && ['/api/operator/observation-review','/api/operator/observation-replay',
          '/api/operator/observation-quarantine'].includes(path)) {
        const input=await body(request);
        try {
          if(path.endsWith('observation-review'))return reply(response,200,store.reviewObservation({kind:input.kind,id:input.id}));
          if(path.endsWith('observation-quarantine')) {
            if(input.kind!=='atk')return reply(response,400,{error:'Bu işlem ATK gözlem kayıtları içindir.'});
            return reply(response,200,store.quarantineATKObservation({id:input.id,expectedReviewHash:input.reviewHash}));
          }
          if(input.kind!=='fixture')return reply(response,409,{error:'Bu kaynağın ekonomik replay bağlantısı henüz hazır değil. Kayıt korunuyor.'});
          return reply(response,200,store.replayFixtureObservation({id:input.id,expectedReviewHash:input.reviewHash}));
        } catch(error) {
          const message=error?.code==='OBSERVATION_REPLAY_REQUIRES_PAUSE'
            ?'Yeniden işlemeden önce sistemin kalıcı olarak duraklatılması gerekiyor.'
            :error?.code==='OBSERVATION_REVIEW_STALE'
              ?'Gözlem veya görev değişti. Güncel kaydı yeniden incele.'
              :'Gözlem yeniden işlenemedi. Kayıt korundu; içerik, görev ve karar kayıtları incelenmeli.';
          return reply(response,409,{error:message});
        }
      }
      if(request.method==='POST' && path==='/api/operator/pause') {
        await body(request);
        const paused=store.pauseGlobal('OPERATOR_PAUSE');
        const followup=safety.sweep(Date.now());
        return reply(response,paused.durablePaused?200:503,{safety:store.globalSafetyStatus(),
          message:paused.durablePaused?'Sistem duraklatıldı. Açık emirlerin sonucu ayrıca takip ediliyor.':
            'Yeni işler bu süreçte durduruldu; kalıcı duraklatma kaydı doğrulanamadı.',
          trackingPrepared:followup.ok,exchangeCancellationConfirmed:false});
      }
      if(request.method==='GET' && path==='/api/operator/recovery')return reply(response,200,{executionMode,
        tasks:store.list().filter(hasUnresolved).map(state=>({id:state.id,phase:state.ledger.phase,busy:state.busy,
          ownerSessionActive:store.ownerSessionActive(state.ownerId,Date.now()),
          intentStates:state.ledger.intents.filter(intent=>!intent.settled).map(intent=>intent.state)}))});
      if(request.method==='POST' && path==='/api/operator/reconcile-fixture') {
        const input=await body(request),state=store.get(input.taskId);
        if(!state || state.mode!=='fixture' || state.policy.executionMode!=='fixture' || state.busy
          || !state.ledger.intents.some(intent=>!intent.settled))return reply(response,409,{error:'Uzlaştırılabilir fixture intent yok.'});
        // Explicit operator observation of the local fixture; never an exchange ACK.
        engine.stop(state.id);queue.cancelWaiting(state.id);engine.scenario(state.id,'confirm-cancel');
        store.update(state.id,()=>({decision:{kind:'OPERATOR_FIXTURE_RECONCILED',message:'Operatör yerel fixture iptal/dolum kayıtlarını uzlaştırdı. Borsa sonucu değildir.'}}));
        return reply(response,200,taskView(state.id));
      }
      return reply(response,404,{error:'Yol bulunamadı.'});
    }
    let session=access.read(request);
    if(request.method==='POST' && path==='/api/session/join') {
      limits.allow('joins',15);const input=await body(request);
      // An active session cannot be silently replaced, orphaning its held intent.
      session=access.read(request);if(!session)session=access.create(response,input.inviteCode);
      return reply(response,200,{csrf:session.csrf,expiresAtMs:session.expiresAtMs,status:integrationStatus(),
        tasks:store.list(session.ownerId).map(state=>({id:state.id,phase:state.ledger.phase})),drafts:store.listPolicyWorkflows(session.ownerId)});
    }
    if(request.method==='GET' && path==='/api/bootstrap' && !session && !publicOrigin)session=access.create(response);
    if(!session)return reply(response,401,{error:'Davetli oturumu gerekiyor.',code:'SESSION_REQUIRED',inviteRequired:Boolean(publicOrigin)});
    const stopping=request.method==='POST' && /^\/api\/tasks\/[a-f0-9-]{36}\/stop$/.test(path);
    if(stopping)limits.allow('stop:'+session.ownerId,120);
    else limits.allow('read:'+session.ownerId,180);
    if(request.method==='GET' && path==='/api/bootstrap')return reply(response,200,{csrf:session.csrf,expiresAtMs:session.expiresAtMs,status:integrationStatus(),
      tasks:store.list(session.ownerId).map(state=>({id:state.id,phase:state.ledger.phase})),drafts:store.listPolicyWorkflows(session.ownerId)});
    if(request.method==='GET' && path==='/api/status')return reply(response,200,integrationStatus());
    if(request.method==='GET' && path==='/api/preflight/status')return reply(response,200,preflightStatus());
    if(request.method==='GET' && path==='/api/preflight/history')return reply(response,200,preflightService.history(session.ownerId));
    const preflightPolicy=path.match(/^\/api\/preflight\/policies\/([a-f0-9-]{36})(?:\/(approve))?$/i);
    const preflightCheck=path.match(/^\/api\/preflight\/checks\/([a-f0-9-]{36})(?:\/(report))?$/i);
    if(request.method==='GET' && preflightPolicy && !preflightPolicy[2])
      return reply(response,200,preflightService.policy(session.ownerId,preflightPolicy[1]));
    if(request.method==='GET' && preflightCheck)
      return reply(response,200,preflightCheck[2]?preflightService.report(session.ownerId,preflightCheck[1]):
        preflightService.check(session.ownerId,preflightCheck[1]));
    if(request.method==='GET' && path==='/api/work')return reply(response,200,{
      tasks:store.list(session.ownerId).map(state=>({id:state.id,phase:state.ledger.phase})),drafts:store.listPolicyWorkflows(session.ownerId)});
    const match=path.match(/^\/api\/tasks\/([a-f0-9-]{36})(?:\/(run|stop|scenario|audit))?$/);
    const draftMatch=path.match(/^\/api\/policy\/drafts\/([a-f0-9-]{36})(?:\/(edit|extract))?$/);
    if(draftMatch)engine.drafts.get(session.ownerId,draftMatch[1]);
    if(request.method==='GET' && draftMatch && !draftMatch[2])return reply(response,200,engine.drafts.get(session.ownerId,draftMatch[1]));
    if(match)access.owns(session,match[1]);
    if(request.method==='GET' && match) {
      const task=taskView(match[1]);
      if(match[2]==='audit')return reply(response,200,{policyCommitment:task.auditPolicy,receipts:task.receipts,expectedHead:task.auditHead,verified:task.auditVerified,publication:'LOCAL_ONLY'});
      if(!match[2])return reply(response,200,task);
    }
    if(request.method!=='POST')return reply(response,404,{error:'Yol bulunamadı.'});
    if(!validToken(request,session))return reply(response,403,{error:'Oturum belirteci geçersiz. Sayfayı yenile.'});
    // Stop remains available even if a visitor has exhausted ordinary action requests.
    const marketRefresh=path==='/api/market/refresh',fujiRefresh=path==='/api/avalanche/refresh';
    if(match?.[2]==='stop')limits.allow('stop-action:'+session.ownerId,120);
    else if(marketRefresh)limits.allow('market:'+session.ownerId,12);
    else if(fujiRefresh)limits.allow('fuji:'+session.ownerId,4);
    else limits.allow('write:'+session.ownerId,20);
    const input=await body(request);
    if(shuttingDown)return reply(response,503,{error:'Sunucu kapanıyor; yeni işlem başlamadı.'});
    // Revalidate after request-body I/O: logout or expiry may have occurred meanwhile.
    const refreshed=access.read(request);
    if(!refreshed || refreshed.ownerId!==session.ownerId || !validToken(request,refreshed))
      return reply(response,401,{error:'Oturum sona erdi.',code:'SESSION_REQUIRED',inviteRequired:Boolean(publicOrigin)});
    session=refreshed;if(match)access.owns(session,match[1]);
    if(path==='/api/preflight/policies')return reply(response,201,preflightService.createPolicy(session.ownerId,input));
    if(preflightPolicy?.[2]==='approve')return reply(response,200,
      preflightService.approvePolicy(session.ownerId,preflightPolicy[1],input));
    if(path==='/api/preflight/checks')return reply(response,202,preflightService.createCheck(session.ownerId,input));
    if(path==='/api/preflight/agent-checks')return reply(response,202,preflightService.createAgentCheck(session.ownerId,input));
    const preflightExample=path.match(/^\/api\/preflight\/examples\/(within-limits|limit-breach|stale-evidence)$/);
    if(preflightExample)return reply(response,200,preflightService.runExample(session.ownerId,preflightExample[1],input));
    if(marketRefresh) {
      if(Object.keys(input).length)return reply(response,400,{error:'Piyasa yenileme isteği boş olmalı.'});
      if(!readOnlyMarket || status.atk.state!=='READ_ONLY_CONNECTED')
        return reply(response,409,{error:'OKX TR salt okunur piyasa bağlantısı hazır değil.'});
      return reply(response,200,await readOnlyMarket.refresh());
    }
    if(fujiRefresh) {
      if(Object.keys(input).length)return reply(response,400,{error:'Fuji yenileme isteği boş olmalı.'});
      const avalanche=await connectFujiRegistry({interactive:true});
      return reply(response,avalanche.state==='DEPLOYMENT_VERIFIED'?200:409,{avalanche});
    }
    if(draftMatch) {
      if(draftMatch[2]==='edit')return reply(response,200,engine.drafts.edit(session.ownerId,draftMatch[1],input));
      if(draftMatch[2]==='extract') {
        if(Object.keys(input).join(',')!=='expectedRevision')return reply(response,400,{error:'Taslak revision gerekli.'});
        return reply(response,200,await engine.drafts.extract(session.ownerId,draftMatch[1],input));
      }
    }
    if(path==='/api/session/leave') {
      const tasks=store.list(session.ownerId);
      if(tasks.some(hasUnresolved))return reply(response,409,{error:'Önce açık örnek emri durdur ve iptal sonucunu uzlaştır.'});
      for(const state of tasks) {if(!state.ledger.stopRequested)engine.stop(state.id);queue.cancelWaiting(state.id);}
      access.revoke(response,session);return reply(response,200,{closed:true});
    }
    if(path==='/api/policy/draft')return reply(response,200,engine.draft(input,session.ownerId));
    if(path==='/api/tasks/approve-and-enqueue') {
      const result=engine.approveAndEnqueue(input,session.ownerId);
      return reply(response,result.replayed?200:201,{...taskView(result.task.id),approvalReplayed:result.replayed});
    }
    if(path==='/api/tasks') {
      const task=engine.approve(input,session.ownerId);return reply(response,201,taskView(task.id));
    }
    if(match?.[2]==='run')return reply(response,202,queue.enqueue(match[1]));
    if(match?.[2]==='stop') {engine.stop(match[1]);queue.cancelWaiting(match[1]);return reply(response,200,taskView(match[1]));}
    if(match?.[2]==='scenario') {engine.scenario(match[1],input.kind);return reply(response,200,taskView(match[1]));}
    return reply(response,404,{error:'Yol bulunamadı.'});
  }catch(error) {
    if(response.headersSent)return;
    const preflightRequest=/^\/api\/preflight(?:\/|$)/.test(String(request.url??'').split('?')[0]);
    if(preflightRequest) {
      if(PREFLIGHT_PUBLIC_ERRORS.has(error?.code))return reply(response,error.status || 409,{code:error.code,error:error.message});
      if(error instanceof TypeError || error instanceof RangeError)
        return reply(response,400,{code:'PREFLIGHT_INPUT_INVALID',error:'Alanları ve sabit kapsam değerlerini kontrol et.'});
      return reply(response,503,{code:'PREFLIGHT_INTERNAL_FAILURE',error:'Kontrol tamamlanamadı; emir gönderilmedi.'});
    }
    // Only the explicit capacity code is public; never forward arbitrary storage errors.
    if(error.code==='QUEUE_CAPACITY_EXCEEDED')return reply(response,409,{code:'QUEUE_CAPACITY_EXCEEDED',
      error:'Üç bekleyen görev kapasitesi dolu. Yeni iş sıraya alınmadı. Yer açıldığında güncel koşulları kontrol edip yeniden onayla. Otomatik tekrar yapılmaz.'});
    reply(response,error.status || 400,{error:error.status?error.message:'İstek tamamlanamadı. Son doğrulanmış görev durumunu kontrol et. Bu mesaj emrin durduğunu belirtmez.'});
  }
});

// Nothing connects or starts until the user deliberately runs the server.
async function connectReadOnlyATK() {
  if(!process.env.MG_ATK_NODE || !process.env.MG_ATK_ENTRY)return;
  try {
    const {ReadOnlyATK}=await import('./adapters/atk.mjs');
    const {loadATKJournalConfiguration}=await import('./adapters/atk-journal-config.mjs');
    const {verifyReadOnlyIdentity}=await import('./adapters/atk-readonly-identity.mjs');
    const journal=await loadATKJournalConfiguration({manifestPath:process.env.MG_ATK_MANIFEST_FILE,
      approvalPath:process.env.MG_ATK_CATALOG_APPROVAL_FILE,accountExpectationPath:process.env.MG_ATK_ACCOUNT_EXPECTATION_FILE});
    const isolatedMode=process.env.MG_ATK_ISOLATED;
    if(isolatedMode!==undefined && !['0','1'].includes(isolatedMode))throw new Error('ATK_ISOLATED_CONFIGURATION');
    let isolated=null;
    const executionMode=process.env.MG_ATK_EXECUTION;
    if(executionMode!==undefined && !['0','1'].includes(executionMode))throw new Error('ATK_EXECUTION_CONFIGURATION');
    const execution=executionMode==='1';
    if(execution && (isolatedMode!=='1' || !journal?.accountExpectation || !operatorKey))throw new Error('ATK_EXECUTION_CONFIGURATION');
    if(isolatedMode==='1') {
      if(!journal || !process.env.MG_ATK_UPSTREAM_ENTRY)throw new Error('ATK_ISOLATED_CONFIGURATION');
      const osEnvironment={};
      for(const name of ['SystemRoot','WINDIR','TEMP','TMP']) {
        const value=process.env[name] ?? process.env[name.toUpperCase()];
        if(value!==undefined)osEnvironment[name]=value;
      }
      isolated={manifest:journal.manifest,upstreamEntryPath:process.env.MG_ATK_UPSTREAM_ENTRY,bootstrapEntryPath:process.env.MG_ATK_BOOTSTRAP_ENTRY,osEnvironment,
        credentials:{OKX_API_KEY:process.env.OKX_API_KEY,OKX_SECRET_KEY:process.env.OKX_SECRET_KEY,OKX_PASSPHRASE:process.env.OKX_PASSPHRASE}};
      for(const name of ['OKX_API_KEY','OKX_SECRET_KEY','OKX_PASSPHRASE'])delete process.env[name];
    }
    if(shuttingDown)return;
    atk=new ReadOnlyATK({nodePath:process.env.MG_ATK_NODE,entryPath:process.env.MG_ATK_ENTRY,profile:process.env.MG_ATK_PROFILE || 'demo',isolated,execution});
    isolated=null;
    await atk.connect();
    if(shuttingDown){await atk.close();return;}
    if(journal)atk.attachObservationJournal({store,...journal});
    let readIdentity=null;
    if(!execution && journal?.accountExpectation) {
      if(isolatedMode!=='1')throw new Error('ATK_READONLY_ISOLATION_REQUIRED');
      readIdentity=await verifyReadOnlyIdentity(atk,store,journal.accountExpectation);
      if(shuttingDown){await atk.close();return;}
      readOnlyMarket=new ReadOnlyMarketService(store,atk);
    }
    if(execution) {
      demoExecutor=new DemoExecutor(store,atk,{planner});await demoExecutor.initialize();
      if(shuttingDown){await demoExecutor.close();await atk.close();return;}
    }
    status.atk={state:execution?'DEMO_EXECUTION_CONNECTED':'READ_ONLY_CONNECTED',writeEnabled:execution,
      orderSubmissionEnabled:execution,transferEnabled:false,marketReadAvailable:!execution && !!readOnlyMarket,
      submissionMode:execution?'PER_ATTEMPT_DURABLE_ADMISSION':'DISABLED',tools:atk.tools().map(tool=>tool.name),
      journalState:journal?'CAPTURE_CONNECTED':'NOT_CONFIGURED',launchVerification:atk.launchContext().verification,
      accountExpectationState:execution?'CAPTURED_UID_MATCHED':readIdentity?.accountExpectationState || 'NOT_CONFIGURED',
      readPermissionConfirmed:readIdentity?.readPermissionConfirmed===true,
      actualAccountVerified:false,routeVerified:false};
    if(process.connected)process.send({type:'PACTWAY_READONLY_READY',ready:!execution && readIdentity?.readPermissionConfirmed===true});
  }catch {status.atk={state:'CONNECTION_FAILED',writeEnabled:false,orderSubmissionEnabled:false,transferEnabled:false};
    readOnlyMarket=null;await demoExecutor?.close();demoExecutor=null;await atk?.close();atk=null;
    if(process.connected)process.send({type:'PACTWAY_READONLY_READY',ready:false});}
}
server.requestTimeout=15000;server.headersTimeout=10000;server.keepAliveTimeout=5000;
server.maxHeadersCount=40;
server.on('error',()=>{process.exitCode=1;console.error('Sunucu başlatılamadı veya bağlantı hatası oluştu.');void shutdown();});
// HTTPS terminates at an explicitly configured proxy; the app always stays loopback-only.
server.listen(port,'127.0.0.1',()=>{if(shuttingDown)return;console.log('Pactway '+executionMode+': '+(publicOrigin || 'http://localhost:'+port));atkConnection=connectReadOnlyATK();fujiConnection=connectFujiRegistry();});
const deadlines=setInterval(()=>{try {tick();}catch {store.pauseGlobal('SAFETY_PROCESSING_FAILED');}},1000);
let shuttingDown=false;
async function shutdown() {
  if(shuttingDown)return;shuttingDown=true;clearInterval(deadlines);
  const drained=queue.close();
  const closed=new Promise(resolve=>server.close(resolve));
  for(const state of store.listRuntime())if(state.busy || state.queue?.state==='QUEUED'){engine.stop(state.id);queue.cancelWaiting(state.id);}
  await Promise.all([drained,closed,preflightService.close(),demoExecutor?.close(),atk?.close(),atkConnection,fujiConnection]);
  store.close();process.exit(process.exitCode || 0);
}
process.once('SIGINT',shutdown);process.once('SIGTERM',shutdown);
// Only a parent-created private IPC channel can request this; no HTTP control.
if(process.send){process.once('disconnect',()=>void shutdown());process.on('message',message=>{if(message?.type==='PACTWAY_SHUTDOWN')void shutdown();});}
