import {normalizeReadOnlyMarketTicker} from './adapters/atk-market-account.mjs';

const fail=(message,status=409)=>Object.assign(new Error(message),{status,code:'READ_ONLY_MARKET_UNAVAILABLE'});
const ARGS=Object.freeze({instId:'AVAX-USDT',demo:true});
const MAX_AGE_MS=10000;

/** Bounded informational read. Validated observations are explicitly consumed
 * outside the economic replay path and never enter a task snapshot or ledger. */
export class ReadOnlyMarketService {
  #store;#client;#busy=false;#cached=null;#nextAt=0;#clock;#cooldownMs;
  constructor(store,client,{clock=()=>Date.now(),cooldownMs=5000}={}) {
    if(!store || !client || typeof clock!=='function' || !Number.isSafeInteger(cooldownMs)
        || cooldownMs<1000 || cooldownMs>60000)throw new TypeError('Read-only market configuration invalid');
    this.#store=store;this.#client=client;this.#clock=clock;this.#cooldownMs=cooldownMs;
  }
  async refresh() {
    const now=this.#clock();
    if(this.#cached) {
      const age=now-this.#cached.exchangeTimestampMs;
      if(now>=this.#cached.observedAtMs && age>=0 && age<=MAX_AGE_MS && now<this.#nextAt)
        return Object.freeze({...this.#cached,cached:true,ageMs:age});
      this.#cached=null;
    }
    if(this.#busy)throw fail('Piyasa okuması sürüyor. Birkaç saniye sonra tekrar dene.',429);
    if(now<this.#nextAt)throw fail('Piyasa okuması kısa süre önce denendi. Birkaç saniye sonra tekrar dene.',429);
    this.#busy=true;this.#nextAt=now+this.#cooldownMs;this.#cached=null;
    let receipt=null,saved=null,consumed=false;
    try {
      receipt=await this.#client.callJournalledRead('market_get_ticker',ARGS);
      const binding=this.#client.journalContext();saved=this.#store.atkToolObservation(receipt.observationId);
      const checked=normalizeReadOnlyMarketTicker(saved?.record,{expectedBinding:binding,nowMs:this.#clock(),maxAgeMs:MAX_AGE_MS,maxSkewMs:2000});
      if(!checked.ok)throw fail('OKX TR piyasa verisi doğrulanamadı; görev alanları değiştirilmedi.');
      this.#store.consumeReadOnlyEvidence({observationId:receipt.observationId,expectedBinding:binding,
        expectedTool:'market_get_ticker',expectedArgs:ARGS,expectedPayloadHash:checked.sourcePayloadHash,
        action:'READ_ONLY_MARKET_ACCEPTED'});consumed=true;
      const observedAtMs=this.#clock(),market=checked.market;
      this.#cached=Object.freeze({state:'LIVE_READ_ONLY',source:'OKX_TR_DEMO_ATK',instrument:market.instrument,
        bid:market.bid,ask:market.ask,last:market.last,spread:market.spread,
        exchangeTimestampMs:market.exchangeTimestampMs,observedAtMs,
        ageMs:Math.max(0,observedAtMs-market.exchangeTimestampMs),freshness:checked.timing.freshness,
        cached:false,evidence:'JOURNALLED_AND_VALIDATED',orderSubmissionEnabled:false,executionMode:'fixture'});
      return this.#cached;
    } catch(error) {
      if(receipt && saved && !consumed) {
        try {
          this.#store.consumeReadOnlyEvidence({observationId:receipt.observationId,expectedBinding:this.#client.journalContext(),
            expectedTool:'market_get_ticker',expectedArgs:ARGS,expectedPayloadHash:saved.record.payloadHash,
            action:'READ_ONLY_MARKET_REJECTED'});
        } catch {throw fail('Piyasa kanıtı güvenle kapatılamadı; yeni görevler güvenlik incelemesini bekliyor.');}
      }
      if(error?.status)throw error;
      throw fail('OKX TR piyasa verisi alınamadı; görev alanları değiştirilmedi.');
    } finally {this.#busy=false;}
  }
}
