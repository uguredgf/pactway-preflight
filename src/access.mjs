import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

const fail=(message,status)=>Object.assign(new Error(message),{status});
const digest=value=>createHash('sha256').update(value).digest('hex');
export function validateCookieName(value,{shared=false}={}) {
  if(typeof value!=='string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value))throw new Error('Oturum cookie adı geçersiz.');
  if(shared!==value.startsWith('__Host-'))throw new Error('Paylaşımlı oturum cookie adı __Host- önekiyle eşleşmeli.');
  return value;
}
export const equalSecret=(a,b)=>typeof a==='string' && typeof b==='string'
  && timingSafeEqual(Buffer.from(digest(a)),Buffer.from(digest(b)));

/** Invitation grants a browser session, never exchange/account authority. */
export class VisitorAccess {
  constructor(store,{shared=false,inviteCode='',maxSessions=30,lifetimeMs=8*3600000,cookieName}={}) {
    if(shared && (inviteCode.length<24 || inviteCode.length>256)) throw new Error('Paylaşım için 24–256 karakterlik MG_INVITE_CODE gerekir.');
    this.store=store;this.shared=shared;this.inviteCode=inviteCode;this.maxSessions=maxSessions;this.lifetimeMs=lifetimeMs;
    this.cookieName=validateCookieName(cookieName??(shared?'__Host-mg-session':'mg-session'),{shared});
  }
  read(request) {
    const matches=(request.headers.cookie || '').split(';').map(part=>part.trim())
      .filter(part=>part.startsWith(this.cookieName+'='));
    if(matches.length!==1)return null;
    const token=matches[0].slice(this.cookieName.length+1);
    if(!/^[a-f0-9]{64}$/.test(token))return null;
    const tokenHash=digest(token),session=this.store.session(tokenHash);
    return session && session.expiresAtMs>Date.now()?{...session,tokenHash}:null;
  }
  cookie(response,token,maxAge) {
    response.setHeader('Set-Cookie',`${this.cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${this.shared?'; Secure':''}`);
  }
  create(response,inviteCode) {
    if(this.shared && !equalSecret(inviteCode,this.inviteCode))throw fail('Davet kodu geçersiz.',403);
    if(this.store.activeSessionCount(Date.now())>=this.maxSessions)throw fail('Deneme kontenjanı dolu. Daha sonra tekrar dene.',429);
    const token=randomBytes(32).toString('hex');
    const session={tokenHash:digest(token),ownerId:randomUUID(),csrf:randomBytes(32).toString('hex'),expiresAtMs:Date.now()+this.lifetimeMs};
    this.store.saveSession(session);this.cookie(response,token,Math.floor(this.lifetimeMs/1000));return session;
  }
  revoke(response,session) {
    if(session)this.store.revokeSession(session.tokenHash);
    this.cookie(response,'',0);
  }
  owns(session,id) {
    const state=this.store.get(id);
    if(!state || !session || state.ownerId!==session.ownerId)throw fail('Görev bulunamadı.',404);
    return state;
  }
}

/** One bounded per-session bucket plus a global unauthenticated join bucket. */
export class RequestLimits {
  constructor(){this.entries=new Map();}
  allow(key,limit,windowMs=60000) {
    const now=Date.now();
    for(const [id,value] of this.entries)if(value.until<=now)this.entries.delete(id);
    let item=this.entries.get(key);
    if(!item){item={count:0,until:now+windowMs};this.entries.set(key,item);}
    item.count+=1;if(item.count>limit)throw fail('Çok fazla istek. Biraz bekleyip tekrar dene.',429);
  }
}
