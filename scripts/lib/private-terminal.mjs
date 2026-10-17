import {hiddenInput} from './okx-tr-demo-probe.mjs';
export function requirePrivateTerminal({allowArguments=false}={}) {
  if((!allowArguments && process.argv.length!==2) || !process.stdin.isTTY || !process.stdout.isTTY)throw new Error('INTERACTIVE_TERMINAL_REQUIRED');
  if(process.execArgv.length || ['NODE_OPTIONS','NODE_DEBUG','NODE_DEBUG_NATIVE','SSLKEYLOGFILE','NODE_TLS_REJECT_UNAUTHORIZED'].some(key=>process.env[key]))throw new Error('UNSAFE_RUNTIME_OPTIONS');
}
export function hidden(label) {
  return new Promise((resolve,reject)=>{
    let value='';
    const cleanup=()=>{process.stdin.off('data',data);process.stdin.off('end',ended);process.stdin.pause();process.stdin.setRawMode(false);process.stdout.write('\n');};
    const ended=()=>{cleanup();reject(new Error('INPUT_CANCELLED'));};
    const data=chunk=>{
      try {
        const state=hiddenInput(value,chunk);value=state.value;
        if(state.done){cleanup();resolve(value);value='';}
      }catch{value='';cleanup();reject(new Error('INPUT_CANCELLED'));}
    };
    process.stdout.write(label+': ');process.stdin.setEncoding('utf8');process.stdin.setRawMode(true);
    process.stdin.on('data',data);process.stdin.once('end',ended);process.stdin.resume();
  });
}
