import { existsSync,realpathSync,lstatSync } from 'node:fs';
import { resolve,relative,isAbsolute,dirname,basename,join,sep } from 'node:path';
import { homedir } from 'node:os';

function canonicalPath(value){
  let ancestor=resolve(value);const suffix=[];
  while(!existsSync(ancestor)){
    const parent=dirname(ancestor);if(parent===ancestor)break;
    suffix.unshift(basename(ancestor));ancestor=parent;
  }
  return resolve(realpathSync(ancestor),...suffix);
}
function inside(target,parent){const path=relative(parent,target);return path==='' || path!=='..' && !path.startsWith('..'+sep) && !isAbsolute(path);}

/** Resolve only. No directories/files are created here; never migrate a ledger implicitly. */
export function dataDirectory({workspaceRoot,environment=process.env}={}){
  const configured=environment.MG_DATA_DIR;
  if(configured && !isAbsolute(configured))throw new Error('MG_DATA_DIR mutlak dizin olmalı');
  const fallback=process.platform==='win32'
    ?join(environment.LOCALAPPDATA || join(homedir(),'AppData','Local'),'MandateGuard','data')
    :join(homedir(),'.local','share','mandateguard');
  const directory=canonicalPath(configured || fallback);
  const excluded=[workspaceRoot,environment.OneDrive,environment.OneDriveConsumer,environment.OneDriveCommercial].filter(Boolean).map(canonicalPath);
  if(excluded.some(parent=>inside(directory,parent)) || /(?:^|[\\/])OneDrive(?: - [^\\/]+)?(?:[\\/]|$)/i.test(directory))
    throw new Error('Kalıcı veri dizini workspace ve OneDrive dışında olmalı');
  for(const name of ['mandateguard.db','mandateguard.db-wal','mandateguard.db-shm','owner.lock']){
    const file=join(directory,name);let info;
    try{info=lstatSync(file);}catch(error){if(error.code==='ENOENT')continue;throw error;}
    if(info.isSymbolicLink() || !info.isFile() || info.nlink>1)
      throw new Error('Kalıcı DB ve yan dosyalar symlink/hardlink veya özel dosya olamaz');
  }
  if(workspaceRoot && existsSync(join(workspaceRoot,'.local','mandateguard.db')))
    throw new Error('Eski workspace veritabanı bulundu. Sunucu kapalıyken tutarlı DB/defter/kota geçişi tamamlanmalı; yeni boş defter otomatik açılmadı.');
  return directory;
}
