/** Streamed byte limit applies even without a Content-Length header. */
export async function readBoundedJson(response,{maxBytes=65536}={}) {
  if(!Number.isSafeInteger(maxBytes) || maxBytes<1 || maxBytes>1048576)throw new Error('Yanıt sınırı geçersiz');
  if(Number(response.headers.get('content-length'))>maxBytes){await response.body?.cancel();throw new Error('Yanıt çok büyük');}
  if(!response.body)throw new Error('Yanıt boş');
  const reader=response.body.getReader(),chunks=[];let size=0;
  try {
    while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;
      if(size>maxBytes){await reader.cancel();throw new Error('Yanıt çok büyük');}chunks.push(value);}
  }finally{reader.releaseLock();}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
