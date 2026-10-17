// Separate local-model + simulated execution preview. Never inherits OKX credentials.
import {fork} from 'node:child_process';
import {join,isAbsolute} from 'node:path';
import {mkdir,mkdtemp} from 'node:fs/promises';
import {dataDirectory} from '../src/persistence/data-directory.mjs';
import {root,osEnvironment} from './lib/readonly-atk-setup.mjs';
import {checkLocalModel,LOCAL_MODEL,localPlannerEnvironment} from './lib/local-model-setup.mjs';
import {FUJI_PROFILE,fujiEnvironment} from '../src/audit/fuji-deployment-profile.mjs';

let child;
try {
  if(process.argv.length!==2 || process.execArgv.length)throw new Error('LOCAL_MODEL_START_FAILED');
  await checkLocalModel();
  const local=process.env.LOCALAPPDATA;
  if(!local || !isAbsolute(local))throw new Error('LOCAL_MODEL_START_FAILED');
  const parent=dataDirectory({workspaceRoot:root,environment:{MG_DATA_DIR:join(local,'Pactway','local-model-sessions')}});
  await mkdir(parent,{recursive:true,mode:0o700});
  const directory=await mkdtemp(join(parent,'session-'));
  child=fork(join(root,'src/server.mjs'),[],{cwd:root,execArgv:[],windowsHide:true,
    env:{...osEnvironment(),MG_DATA_DIR:directory,MG_PORT:'18775',MG_EXECUTION_MODE:'fixture',MG_ATK_EXECUTION:'0',
      ...localPlannerEnvironment({PACTWAY_LOCAL_MODEL:LOCAL_MODEL}),
      ...fujiEnvironment({PACTWAY_FUJI_PROFILE:FUJI_PROFILE.id})},stdio:['ignore','inherit','inherit','ipc']});
  const stop=()=>{if(child.connected)child.send({type:'PACTWAY_SHUTDOWN'},()=>{});};
  process.once('SIGINT',stop);process.once('SIGTERM',stop);
  child.once('error',()=>{console.error('LOCAL_MODEL_START_FAILED');process.exitCode=1;});
  child.once('exit',code=>{process.exitCode=code??1;});
}catch {console.error('LOCAL_MODEL_NOT_READY_OR_START_FAILED');process.exitCode=1;}
