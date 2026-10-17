// Isolated QA-only text-mode preview. Fixed local model, fixture execution,
// selected read-only Fuji profile, no ATK and no inherited credentials.
import {fork} from 'node:child_process';
import {join,isAbsolute} from 'node:path';
import {mkdir,mkdtemp} from 'node:fs/promises';
import {dataDirectory} from '../src/persistence/data-directory.mjs';
import {FUJI_PROFILE,fujiEnvironment} from '../src/audit/fuji-deployment-profile.mjs';
import {root,osEnvironment} from './lib/readonly-atk-setup.mjs';
import {checkLocalModel,LOCAL_MODEL,localPlannerEnvironment} from './lib/local-model-setup.mjs';

let child,stopping=false;
try {
  if(process.argv.length!==2 || process.execArgv.length)throw new Error('LOCAL_TEXT_PREVIEW_FAILED');
  await checkLocalModel();
  const local=process.env.LOCALAPPDATA;
  if(!local || !isAbsolute(local))throw new Error('LOCAL_TEXT_PREVIEW_FAILED');
  const parent=dataDirectory({workspaceRoot:root,environment:{MG_DATA_DIR:join(local,'Pactway','text-preview-sessions')}});
  await mkdir(parent,{recursive:true,mode:0o700});
  const directory=await mkdtemp(join(parent,'session-'));
  console.log('Pactway text QA data retained: '+directory);
  child=fork(join(root,'src/server.mjs'),[],{cwd:root,execArgv:[],windowsHide:true,
    env:{...osEnvironment(),MG_DATA_DIR:directory,MG_PORT:'18776',MG_EXECUTION_MODE:'fixture',MG_ATK_EXECUTION:'0',
      ...localPlannerEnvironment({PACTWAY_LOCAL_MODEL:LOCAL_MODEL}),
      ...fujiEnvironment({PACTWAY_FUJI_PROFILE:FUJI_PROFILE.id})},stdio:['ignore','inherit','inherit','ipc']});
  const stop=()=>{if(stopping)return;stopping=true;if(child.connected)child.send({type:'PACTWAY_SHUTDOWN'},()=>{});else child.kill();};
  process.once('SIGINT',stop);process.once('SIGTERM',stop);process.once('disconnect',stop);
  process.once('exit',()=>{if(child && !child.killed)child.kill();});
  child.once('error',()=>{console.error('LOCAL_TEXT_PREVIEW_FAILED');process.exitCode=1;});
  child.once('exit',code=>{process.exitCode=code??1;});
} catch {console.error('LOCAL_TEXT_PREVIEW_NOT_READY_OR_START_FAILED');process.exitCode=1;}
