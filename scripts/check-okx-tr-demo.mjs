// Operator runs this in their own terminal. No command-line/env/file credentials.
import {probe,hiddenInput} from './lib/okx-tr-demo-probe.mjs';

function hidden(label) {
  return new Promise((resolve,reject)=>{
    let value='';
    const cleanup=()=>{process.stdin.off('data',data);process.stdin.off('end',ended);process.stdin.pause();process.stdin.setRawMode(false);process.stdout.write('\n');};
    const ended=()=>{cleanup();reject(new Error('INPUT_ENDED'));};
    const data=chunk=>{
      try {
        const state=hiddenInput(value,chunk);value=state.value;
        if(state.done){cleanup();resolve(value);value='';}
      }catch{value='';cleanup();reject(new Error('INPUT_CANCELLED_OR_INVALID'));}
    };
    process.stdout.write(label+': ');process.stdin.setEncoding('utf8');process.stdin.setRawMode(true);
    process.stdin.on('data',data);process.stdin.once('end',ended);process.stdin.resume();
  });
}
async function main() {
  if(process.argv.length!==2 || !process.stdin.isTTY || !process.stdout.isTTY){
    console.log('RESULT: INTERACTIVE_TERMINAL_REQUIRED (anahtarlari komuta eklemeyin)');process.exitCode=1;return;
  }
  // Refuse common tracing modes which could expose HTTPS authentication headers.
  if(process.execArgv.length || process.env.NODE_OPTIONS || process.env.NODE_DEBUG || process.env.NODE_DEBUG_NATIVE
      || process.env.SSLKEYLOGFILE || process.env.NODE_TLS_REJECT_UNAUTHORIZED){
    console.log('RESULT: UNSAFE_RUNTIME_OPTIONS (temiz terminal kullanin)');process.exitCode=1;return;
  }
  console.log('OKX TR DEMO / YALNIZ OKUMA ON KONTROLU');
  console.log('Hedef: https://tr.okx.com | demo bayragi: 1 | yalniz GET time + account/config.');
  console.log('API key ve passphrase yalniz OKX TR kimlik dogrulamasina gonderilir; secret yerelde imza uretir.');
  console.log('Dosya/env/uygulama kaydi yok. Degerler ekranda gorunmez. Her alani tek tek girip Enter basin.');
  console.log('Anahtar normal hesaba aitse Ctrl+C ile cikin. Bu islem uygulama/ATK baglantisini acmaz.');
  let credentials;
  try {
    credentials={apiKey:await hidden('Demo API key'),secret:await hidden('Demo Secret key'),passphrase:await hidden('Demo API passphrase')};
    const result=await probe(credentials);
    console.log('RESULT: '+result.code);
    console.log('Okuma yaniti alindi; read_only dogrulandi. Hesap UID eslestirmesi ve ATK entegrasyonu henuz yapilmadi.');
  }catch(error){
    const code=String(error?.code || '');
    console.log('RESULT: '+(/^(OKX_501\d{2}|HTTP_\d{1,3}|TIMEOUT|NETWORK_ERROR|RESPONSE_TOO_LARGE|RESPONSE_INVALID|CLOCK_INVALID|ACCOUNT_INVALID|READ_ONLY_NOT_CONFIRMED|INPUT_INVALID|PREFLIGHT_FAILED)$/.test(code)?code:'INPUT_CANCELLED_OR_INVALID'));
    process.exitCode=1;
  }finally{
    if(credentials)for(const key of Object.keys(credentials))credentials[key]='';
    // JS strings cannot guarantee memory zeroization; exit releases the process.
    credentials=null;process.stdin.pause();
  }
}
await main();
