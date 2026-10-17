import {runReadonlyConnector} from './connect-okx-tr-readonly.mjs';
import {ensureSharedPortAvailable,generateSharedSecrets,sharedConnectorEnvironment,sharedLauncherConfiguration,sharedServerEnvironment,
  startQuickTunnel,validateCloudflaredExecutable,writeSharedDemoState} from './lib/shared-demo-setup.mjs';
import {waitForPublicOrigin} from './lib/shared-demo-setup.mjs';

let secrets,tunnel;
try {
  const configuration=sharedLauncherConfiguration(process.argv.slice(2),process.env);
  const executablePath=await validateCloudflaredExecutable(configuration);
  const environment=sharedConnectorEnvironment(configuration,process.env);
  await runReadonlyConnector({environment,sessionNamespace:'shared-demo-sessions',allowLauncherArguments:true,
    beforeServerStart:async()=>{
      await ensureSharedPortAvailable(configuration.port);
      secrets=generateSharedSecrets();
      tunnel=await startQuickTunnel({executablePath,port:configuration.port,environment});
      return {publicOrigin:tunnel.origin,serverEnvironment:sharedServerEnvironment(tunnel.origin,secrets),
        stop:tunnel.stop,closed:tunnel.closed,isRunning:tunnel.isRunning};
    },
    onServerReady:async({directory,files,serverPid})=>{
      if(!tunnel?.isRunning())throw Object.assign(new Error('CLOUDFLARED_STOPPED'),{code:'CLOUDFLARED_STOPPED'});
      console.log('Paylasim adresinin disaridan acilmasi bekleniyor (en fazla 90 saniye). Pencereyi kapatmayin.');
      await waitForPublicOrigin(tunnel.origin);
      const statePath=await writeSharedDemoState(directory,{origin:tunnel.origin,port:configuration.port,serverPid,
        tunnelPid:tunnel.pid,dataDirectory:files.data});
      console.log('Paylasim URL: '+tunnel.origin);
      console.log('Davet kodu: '+secrets.inviteCode);
      console.log('Durum dosyasi: '+statePath);
      console.log('Simdi bu URL ziyaret edilebilir; davet kodunu ziyaretcilere ayri ve ozel olarak iletin.');
      console.log('RESULT: SHARED_DEMO_READY');
    }});
}catch(error) {
  await tunnel?.stop();
  const code=String(error?.code || error?.message || '');
  console.log('RESULT: '+(/^(SHARED|CLOUDFLARED|LOCAL_DATA_PATH_)/.test(code)?code:'SHARED_DEMO_SETUP_FAILED'));
  process.exitCode=1;
}finally{
  secrets=null;tunnel=null;
}
