export const PUBLIC_REPLAY_EXAMPLES=Object.freeze({
  "within-limits": {
    "schemaVersion": 1,
    "mode": "REPLAY",
    "publication": "LOCAL_ONLY",
    "policy": {
      "schemaVersion": 1,
      "id": "replay-within-limits",
      "instrument": "AVAX-USDT",
      "side": "buy",
      "tdMode": "cash",
      "ordType": "limit",
      "maxNotional": "25",
      "maxPrice": "25",
      "durationSeconds": "600",
      "createdAtMs": 1792231199000,
      "validFromMs": 1792231199000,
      "expiresAtMs": 1792231799000
    },
    "policyHash": "9d82d5c82e63544e843fabc720c61489d5daf5fdb6089eb93f00a4194321982e",
    "candidate": {
      "instrument": "AVAX-USDT",
      "side": "buy",
      "tdMode": "cash",
      "ordType": "limit",
      "price": "25",
      "size": "0.4"
    },
    "candidateHash": "e816fab918428b03c1cbc5324059ed7343ee326c0fbaeccf0f89a9bb0bf466ef",
    "verdict": "ALLOW",
    "reasonCodes": [],
    "checks": [
      {
        "id": "policy",
        "label": "Politika bağı ve geçerlilik zamanı",
        "result": "PASS",
        "reasonCode": "PASS"
      },
      {
        "id": "agent-plan",
        "label": "Salt okunur araç planı",
        "result": "PASS",
        "reasonCode": "PASS"
      },
      {
        "id": "scope",
        "label": "Sabit ürün kapsamı",
        "result": "PASS",
        "reasonCode": "PASS"
      },
      {
        "id": "price-cap",
        "label": "Fiyat üst sınırı",
        "result": "PASS",
        "reasonCode": "PASS"
      },
      {
        "id": "notional-cap",
        "label": "Ücret hariç emir bedeli üst sınırı",
        "result": "PASS",
        "reasonCode": "PASS"
      },
      {
        "id": "evidence",
        "label": "Kanıt bütünlüğü, tazeliği ve aynı bağlantı bağı",
        "result": "PASS",
        "reasonCode": "PASS"
      },
      {
        "id": "instrument",
        "label": "Spot durumu ve listelenen enstrüman kuralları",
        "result": "PASS",
        "reasonCode": "PASS"
      },
      {
        "id": "price-grid",
        "label": "Fiyat adımı",
        "result": "PASS",
        "reasonCode": "PASS"
      },
      {
        "id": "size-grid",
        "label": "Miktar adımı ve enstrüman sınırları",
        "result": "PASS",
        "reasonCode": "PASS"
      }
    ],
    "sanitizedEvidence": {
      "ticker": {
        "sourceObservationId": "replay-ticker",
        "sourcePayloadHash": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
        "bindingHash": "854fce23a31dae4f647a210b1fc5be29d90b38918c26b3cdc58d70532d0fb0ab",
        "observedAtMs": 1792231199000,
        "exchangeTimestampMs": 1792231199000,
        "referencePrice": "24.95",
        "reference": "BEST_ASK"
      },
      "instrument": {
        "sourceObservationId": "replay-instrument",
        "sourcePayloadHash": "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
        "bindingHash": "854fce23a31dae4f647a210b1fc5be29d90b38918c26b3cdc58d70532d0fb0ab",
        "observedAtMs": 1792231199000,
        "instrument": {
          "instId": "AVAX-USDT",
          "instType": "SPOT",
          "baseCcy": "AVAX",
          "quoteCcy": "USDT",
          "state": "live",
          "tickSz": "0.01",
          "lotSz": "0.01",
          "minSz": "0.1",
          "maxLmtSz": "1000"
        }
      }
    },
    "evidenceHash": "b3fdd6ada38de16143c23f95d362bef37c48858ea34656cbae7048173ba88525",
    "agentTrace": {
      "plannerKind": "replay",
      "plan": {
        "tools": []
      },
      "modelCallCount": 0,
      "failureCode": null
    },
    "checkedAtMs": 1792231200000,
    "notChecked": [
      {
        "code": "ACCOUNT_BALANCE",
        "label": "Hesap bakiyesi ve kullanılabilir tutar"
      },
      {
        "code": "FEES",
        "label": "İşlem ve ağ ücretleri"
      },
      {
        "code": "PORTFOLIO",
        "label": "Portföy uygunluğu ve toplam kampanya harcaması"
      },
      {
        "code": "ORDER_LIFECYCLE",
        "label": "Emir gönderme, borsanın kabulü ve fiyat bandı, iptal, dolum ve gerçekleşme"
      },
      {
        "code": "INVESTMENT_SUITABILITY",
        "label": "Yatırım uygunluğu veya kârlılık"
      },
      {
        "code": "USD_NATIVE_LIMIT",
        "label": "Borsanın USD bazlı tutar sınırı için bağımsız kur dönüşümü"
      }
    ],
    "disclosure": "Bu rapor yalnız belirtilen kontrollerin yerel sonucudur. Piyasa verisi güncel bir referanstır; likidite, kayma, adil fiyat veya borsanın emri kabul edeceği anlamına gelmez. Rapor alım tavsiyesi, emir yürütme engeli, bakiye yeterliliği, gerçekleşme, kâr veya güvenlik garantisi değildir. Hash yerel bütünlük kontrolüdür; imza, bağımsız zaman damgası veya zincir yayını değildir.",
    "reportHash": "7286f5560f457b4a9081ce5decd15042b323a1023e376e0c7a2e465560339e84"
  },
  "limit-breach": {
    "schemaVersion": 1,
    "mode": "REPLAY",
    "publication": "LOCAL_ONLY",
    "policy": {
      "schemaVersion": 1,
      "id": "replay-limit-breach",
      "instrument": "AVAX-USDT",
      "side": "buy",
      "tdMode": "cash",
      "ordType": "limit",
      "maxNotional": "25",
      "maxPrice": "25",
      "durationSeconds": "600",
      "createdAtMs": 1792231199000,
      "validFromMs": 1792231199000,
      "expiresAtMs": 1792231799000
    },
    "policyHash": "c08f83c4f6a1e9645b161e3a2d2b4905f8836bafeebfa2a4f7f41610c87959af",
    "candidate": {
      "instrument": "AVAX-USDT",
      "side": "buy",
      "tdMode": "cash",
      "ordType": "limit",
      "price": "25.01",
      "size": "0.4"
    },
    "candidateHash": "dda7f8f725ba702e87f4d0fe582598aae14d586da9289e07b8659863903e0c84",
    "verdict": "BLOCK",
    "reasonCodes": [
      "PRICE_CAP_EXCEEDED"
    ],
    "checks": [
      {
        "id": "policy",
        "label": "Politika bağı ve geçerlilik zamanı",
        "result": "PASS",
        "reasonCode": "PASS"
      },
      {
        "id": "agent-plan",
        "label": "Salt okunur araç planı",
        "result": "PASS",
        "reasonCode": "PASS"
      },
      {
        "id": "scope",
        "label": "Sabit ürün kapsamı",
        "result": "PASS",
        "reasonCode": "PASS"
      },
      {
        "id": "price-cap",
        "label": "Fiyat üst sınırı",
        "result": "BLOCK",
        "reasonCode": "PRICE_CAP_EXCEEDED"
      },
      {
        "id": "notional-cap",
        "label": "Ücret hariç emir bedeli üst sınırı",
        "result": "PASS",
        "reasonCode": "PASS"
      },
      {
        "id": "evidence",
        "label": "Kanıt bütünlüğü, tazeliği ve aynı bağlantı bağı",
        "result": "PASS",
        "reasonCode": "PASS"
      },
      {
        "id": "instrument",
        "label": "Spot durumu ve listelenen enstrüman kuralları",
        "result": "PASS",
        "reasonCode": "PASS"
      },
      {
        "id": "price-grid",
        "label": "Fiyat adımı",
        "result": "PASS",
        "reasonCode": "PASS"
      },
      {
        "id": "size-grid",
        "label": "Miktar adımı ve enstrüman sınırları",
        "result": "PASS",
        "reasonCode": "PASS"
      }
    ],
    "sanitizedEvidence": {
      "ticker": {
        "sourceObservationId": "replay-ticker",
        "sourcePayloadHash": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
        "bindingHash": "854fce23a31dae4f647a210b1fc5be29d90b38918c26b3cdc58d70532d0fb0ab",
        "observedAtMs": 1792231199000,
        "exchangeTimestampMs": 1792231199000,
        "referencePrice": "24.95",
        "reference": "BEST_ASK"
      },
      "instrument": {
        "sourceObservationId": "replay-instrument",
        "sourcePayloadHash": "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
        "bindingHash": "854fce23a31dae4f647a210b1fc5be29d90b38918c26b3cdc58d70532d0fb0ab",
        "observedAtMs": 1792231199000,
        "instrument": {
          "instId": "AVAX-USDT",
          "instType": "SPOT",
          "baseCcy": "AVAX",
          "quoteCcy": "USDT",
          "state": "live",
          "tickSz": "0.01",
          "lotSz": "0.01",
          "minSz": "0.1",
          "maxLmtSz": "1000"
        }
      }
    },
    "evidenceHash": "b3fdd6ada38de16143c23f95d362bef37c48858ea34656cbae7048173ba88525",
    "agentTrace": {
      "plannerKind": "replay",
      "plan": {
        "tools": []
      },
      "modelCallCount": 0,
      "failureCode": null
    },
    "checkedAtMs": 1792231200000,
    "notChecked": [
      {
        "code": "ACCOUNT_BALANCE",
        "label": "Hesap bakiyesi ve kullanılabilir tutar"
      },
      {
        "code": "FEES",
        "label": "İşlem ve ağ ücretleri"
      },
      {
        "code": "PORTFOLIO",
        "label": "Portföy uygunluğu ve toplam kampanya harcaması"
      },
      {
        "code": "ORDER_LIFECYCLE",
        "label": "Emir gönderme, borsanın kabulü ve fiyat bandı, iptal, dolum ve gerçekleşme"
      },
      {
        "code": "INVESTMENT_SUITABILITY",
        "label": "Yatırım uygunluğu veya kârlılık"
      },
      {
        "code": "USD_NATIVE_LIMIT",
        "label": "Borsanın USD bazlı tutar sınırı için bağımsız kur dönüşümü"
      }
    ],
    "disclosure": "Bu rapor yalnız belirtilen kontrollerin yerel sonucudur. Piyasa verisi güncel bir referanstır; likidite, kayma, adil fiyat veya borsanın emri kabul edeceği anlamına gelmez. Rapor alım tavsiyesi, emir yürütme engeli, bakiye yeterliliği, gerçekleşme, kâr veya güvenlik garantisi değildir. Hash yerel bütünlük kontrolüdür; imza, bağımsız zaman damgası veya zincir yayını değildir.",
    "reportHash": "ed6de337fb3f0524115af4d67461df4fc18c01adcfc375909287970db0f4e6be"
  },
  "stale-evidence": {
    "schemaVersion": 1,
    "mode": "REPLAY",
    "publication": "LOCAL_ONLY",
    "policy": {
      "schemaVersion": 1,
      "id": "replay-stale-evidence",
      "instrument": "AVAX-USDT",
      "side": "buy",
      "tdMode": "cash",
      "ordType": "limit",
      "maxNotional": "25",
      "maxPrice": "25",
      "durationSeconds": "600",
      "createdAtMs": 1792231199000,
      "validFromMs": 1792231199000,
      "expiresAtMs": 1792231799000
    },
    "policyHash": "622a47cfcdcd57d83cf830eda00caef53b4b00f240bb0cb72f85919674485ea0",
    "candidate": {
      "instrument": "AVAX-USDT",
      "side": "buy",
      "tdMode": "cash",
      "ordType": "limit",
      "price": "25",
      "size": "0.4"
    },
    "candidateHash": "e816fab918428b03c1cbc5324059ed7343ee326c0fbaeccf0f89a9bb0bf466ef",
    "verdict": "INSUFFICIENT_DATA",
    "reasonCodes": [
      "EVIDENCE_STALE_OR_FUTURE",
      "EVIDENCE_UNAVAILABLE"
    ],
    "checks": [
      {
        "id": "policy",
        "label": "Politika bağı ve geçerlilik zamanı",
        "result": "PASS",
        "reasonCode": "PASS"
      },
      {
        "id": "agent-plan",
        "label": "Salt okunur araç planı",
        "result": "PASS",
        "reasonCode": "PASS"
      },
      {
        "id": "scope",
        "label": "Sabit ürün kapsamı",
        "result": "PASS",
        "reasonCode": "PASS"
      },
      {
        "id": "price-cap",
        "label": "Fiyat üst sınırı",
        "result": "PASS",
        "reasonCode": "PASS"
      },
      {
        "id": "notional-cap",
        "label": "Ücret hariç emir bedeli üst sınırı",
        "result": "PASS",
        "reasonCode": "PASS"
      },
      {
        "id": "evidence",
        "label": "Kanıt bütünlüğü, tazeliği ve aynı bağlantı bağı",
        "result": "INSUFFICIENT_DATA",
        "reasonCode": "EVIDENCE_STALE_OR_FUTURE"
      },
      {
        "id": "instrument",
        "label": "Spot durumu ve listelenen enstrüman kuralları",
        "result": "INSUFFICIENT_DATA",
        "reasonCode": "EVIDENCE_UNAVAILABLE"
      },
      {
        "id": "price-grid",
        "label": "Fiyat adımı",
        "result": "INSUFFICIENT_DATA",
        "reasonCode": "EVIDENCE_UNAVAILABLE"
      },
      {
        "id": "size-grid",
        "label": "Miktar adımı ve enstrüman sınırları",
        "result": "INSUFFICIENT_DATA",
        "reasonCode": "EVIDENCE_UNAVAILABLE"
      }
    ],
    "sanitizedEvidence": {
      "ticker": {
        "sourceObservationId": "replay-ticker",
        "sourcePayloadHash": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
        "bindingHash": "854fce23a31dae4f647a210b1fc5be29d90b38918c26b3cdc58d70532d0fb0ab",
        "observedAtMs": 1792231189999,
        "exchangeTimestampMs": 1792231189999,
        "referencePrice": "24.95",
        "reference": "BEST_ASK"
      },
      "instrument": {
        "sourceObservationId": "replay-instrument",
        "sourcePayloadHash": "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
        "bindingHash": "854fce23a31dae4f647a210b1fc5be29d90b38918c26b3cdc58d70532d0fb0ab",
        "observedAtMs": 1792231189999,
        "instrument": {
          "instId": "AVAX-USDT",
          "instType": "SPOT",
          "baseCcy": "AVAX",
          "quoteCcy": "USDT",
          "state": "live",
          "tickSz": "0.01",
          "lotSz": "0.01",
          "minSz": "0.1",
          "maxLmtSz": "1000"
        }
      }
    },
    "evidenceHash": "d28c6472accd6b2fdd133ed639d7d03fe98b8285e84c1d98e890d58380e0da8a",
    "agentTrace": {
      "plannerKind": "replay",
      "plan": {
        "tools": []
      },
      "modelCallCount": 0,
      "failureCode": null
    },
    "checkedAtMs": 1792231200000,
    "notChecked": [
      {
        "code": "ACCOUNT_BALANCE",
        "label": "Hesap bakiyesi ve kullanılabilir tutar"
      },
      {
        "code": "FEES",
        "label": "İşlem ve ağ ücretleri"
      },
      {
        "code": "PORTFOLIO",
        "label": "Portföy uygunluğu ve toplam kampanya harcaması"
      },
      {
        "code": "ORDER_LIFECYCLE",
        "label": "Emir gönderme, borsanın kabulü ve fiyat bandı, iptal, dolum ve gerçekleşme"
      },
      {
        "code": "INVESTMENT_SUITABILITY",
        "label": "Yatırım uygunluğu veya kârlılık"
      },
      {
        "code": "USD_NATIVE_LIMIT",
        "label": "Borsanın USD bazlı tutar sınırı için bağımsız kur dönüşümü"
      }
    ],
    "disclosure": "Bu rapor yalnız belirtilen kontrollerin yerel sonucudur. Piyasa verisi güncel bir referanstır; likidite, kayma, adil fiyat veya borsanın emri kabul edeceği anlamına gelmez. Rapor alım tavsiyesi, emir yürütme engeli, bakiye yeterliliği, gerçekleşme, kâr veya güvenlik garantisi değildir. Hash yerel bütünlük kontrolüdür; imza, bağımsız zaman damgası veya zincir yayını değildir.",
    "reportHash": "a109da2d8749dce106798cba3f46521c68b161a5eecfd24ad70d8448f8f6775f"
  }
});
