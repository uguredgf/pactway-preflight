// Operator helper source only. Does not start the app or connect to an exchange.
// Run without task ID to inspect; explicit flag is required to reconcile a fixture.
const key=process.env.MG_OPERATOR_KEY;
if(!key || key.length<24 || key.length>256)throw new Error('Operatör anahtarı ortam değişkeninde gerekli.');
const origin=process.env.MG_PUBLIC_ORIGIN || 'http://localhost:'+(process.env.MG_PORT || 8766);
const url=new URL(origin);
if(url.username || url.password || url.pathname!=='/' || url.search || url.hash
  || !(url.protocol==='https:' || url.protocol==='http:' && ['localhost','127.0.0.1'].includes(url.hostname)))
  throw new Error('Yalnız HTTPS origin veya yerel uygulama adresi kullanılabilir.');
const [taskId,flag,...extra]=process.argv.slice(2);
if(extra.length || taskId && (!/^[a-f0-9-]{36}$/.test(taskId) || flag!=='--confirm-local-fixture'))
  throw new Error('Kullanım: node scripts/recover-fixture.mjs [task-id --confirm-local-fixture]');
async function request(path,input) {
  const response=await fetch(url.origin+path,{method:input?'POST':'GET',redirect:'error',signal:AbortSignal.timeout(10000),
    headers:{'X-MG-Operator':key,'Origin':url.origin,...(input?{'Content-Type':'application/json'}:{})},
    ...(input?{body:JSON.stringify(input)}:{})});
  const result=await response.json();if(!response.ok)throw new Error(result.error || 'Operatör isteği tamamlanamadı.');return result;
}
if(!taskId)console.log(JSON.stringify(await request('/api/operator/recovery'),null,2));
else {
  const task=await request('/api/operator/reconcile-fixture',{taskId});
  console.log(JSON.stringify({id:task.id,mode:task.mode,phase:task.ledger.phase,summary:task.summary,auditVerified:task.auditVerified},null,2));
}
