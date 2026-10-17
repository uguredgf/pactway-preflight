/** Explicit child environment. App/model/operator secrets never enter the ATK process. */
export function atkEnvironment(source=process.env) {
  const allowed=new Set(['PATH','SYSTEMROOT','WINDIR','TEMP','TMP','HOME','USERPROFILE',
    'APPDATA','LOCALAPPDATA','XDG_CONFIG_HOME','OKX_API_KEY','OKX_SECRET_KEY','OKX_PASSPHRASE',
    'OKX_SITE','OKX_TIMEOUT_MS','OKX_LOG_RETENTION_DAYS']);
  const output={};
  for(const [key,value] of Object.entries(source))if(allowed.has(key.toUpperCase()) && typeof value==='string')output[key]=value;
  // Verified against installed ATK 1.4.8 config. No host/auth-binary override is inherited.
  output.OKX_DEMO='true';output.OKX_UPDATE_CHECK='false';
  return output;
}
