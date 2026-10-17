/** Admit public document navigation, keep API and all writes behind the origin boundary. */
export function checkRequestOrigin(request,{publicOrigin=null,port}) {
  const expected=publicOrigin || 'http://'+request.headers.host;
  const hosts=publicOrigin?[new URL(publicOrigin).host]:['localhost:'+port,'127.0.0.1:'+port];
  if(!hosts.includes(request.headers.host))return false;
  if(request.headers['sec-fetch-site']==='cross-site') {
    const path=new URL(request.url,expected).pathname;
    return request.method==='GET' && request.headers['sec-fetch-mode']==='navigate'
      && request.headers['sec-fetch-dest']==='document' && ['/', '/app.html'].includes(path);
  }
  if(request.headers.origin && request.headers.origin!==expected)return false;
  return request.method!=='POST' || request.headers.origin===expected;
}
