// Windows may add these OS defaults to CreateProcess environments. Scrub only
// those known additions BEFORE importing SDK/dependencies; reject every other
// unexpected key. This is environment hygiene, not an operating-system sandbox.
export const ISOLATED_BOOTSTRAP_SOURCE=String.raw`import {isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
try {
  if(process.execArgv.length || !isAbsolute(process.argv[2] || ''))throw new Error();
  const allowed=new Set(['SystemRoot','WINDIR','TEMP','TMP','OKX_API_KEY','OKX_SECRET_KEY','OKX_PASSPHRASE']);
  const injected=new Set(['HOMEDRIVE','HOMEPATH','LOGONSERVER','PATH','SYSTEMDRIVE','USERDOMAIN','USERNAME','USERPROFILE']);
  for(const key of Object.keys(process.env)) {
    if(allowed.has(key))continue;
    if(process.platform==='win32' && injected.has(key.toUpperCase()))delete process.env[key];
    else throw new Error();
  }
  const target=process.argv[2];
  process.argv=[process.argv[0],...process.argv.slice(2)];
  await import(pathToFileURL(target).href);
}catch{
  process.stderr.write('PACTWAY_BOOTSTRAP_DENIED\n');process.exitCode=1;
}
`;
