// Source fixture only: local stdin/stdout JSON-RPC, no SDK, credentials or network.
import {createInterface} from 'node:readline';
import {catalog} from './stdio-catalog.mjs';
// Fail without printing values if the parent ever leaks application credentials.
if(Object.keys(process.env).some(key=>/^(OKX_API_KEY|OKX_SECRET_KEY|OKX_PASSPHRASE|OPENAI_API_KEY|NODE_OPTIONS|MG_.*)$/i.test(key)))
  throw new Error('FIXTURE_UNEXPECTED_ENVIRONMENT');
const mode=process.argv[process.argv.indexOf('--profile')+1];
const send=value=>process.stdout.write(JSON.stringify(value)+'\n');
for await(const line of createInterface({input:process.stdin})) {
  const message=JSON.parse(line);
  if(!Object.hasOwn(message,'id'))continue;
  let result;
  if(message.method==='initialize')result={protocolVersion:'2025-06-18',capabilities:{tools:{}}};
  else if(message.method==='tools/list')result={tools:catalog};
  else if(message.method==='tools/call') {
    const tool=message.params.name,at=new Date().toISOString();
    const permission=mode==='readonly-perm'?{perm:'read_only'}:mode==='readonly-write-perm'?{perm:'read_only,trade'}:{};
    const envelope={tool,ok:true,data:{endpoint:'GET /api/v5/account/config',requestTime:at,data:[{uid:'123',echo:message.params.arguments,...permission}]},
      capabilities:{readOnly:true,hasAuth:true,demo:true,moduleAvailability:{account:{status:'enabled'},market:{status:'enabled'},spot:{status:'enabled'}}},timestamp:at};
    result={content:[{type:'text',text:JSON.stringify(envelope)}],structuredContent:envelope,isError:false};
  } else {send({jsonrpc:'2.0',id:message.id,error:{code:-32601,message:'unknown method'}});continue;}
  send({jsonrpc:'2.0',id:message.id,result});
  if(mode==='drift' && message.method==='tools/call')send({jsonrpc:'2.0',method:'notifications/tools/list_changed'});
}
