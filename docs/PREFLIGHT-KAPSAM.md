# Pactway Preflight: sabit MVP kapsamı

17 Ekim 2026. Bu belge yeni ürün akışının uygulama sözleşmesidir. Geniş trading ekranı ana ürün olmaktan çıkar; eski yürütme kodu silinmez veya yetkileri açılmaz.

## Ürün

AI işlem ajanı geliştiricisi/operatörü için tek önerinin işlem öncesi kontrolü. Yalnız AVAX-USDT, spot, cash, buy, limit. Sınırlı ajan salt okunur kanıt ve bağımsız kontrol geri bildirimiyle öneriyi inceler; fiyat ve miktarı yalnız azaltarak tek düzeltme yapabilir. Nihai sonucu bağımsız kesin ondalık kontrol üretir. Sonuç tavsiye niteliğindedir; başka bir yürütücüyü teknik olarak engellemez.

Sonuçlar: `ALLOW` = yalnız kapsam dahilindeki kontroller geçti; `BLOCK` = bilinen kural ihlali; `INSUFFICIENT_DATA` = güvenilir/taze kanıt yok veya kontrol tamamlanamadı. Hiçbiri alım tavsiyesi, kâr, gerçekleşme, bakiye yeterliliği veya güvenlik garantisi değildir.

## Politika ve öneri

Politika girdisi tam olarak `{instrument,side,tdMode,ordType,maxNotional,maxPrice,durationSeconds}`. Sabit değerler AVAX-USDT/buy/cash/limit; diğerleri pozitif decimal string, süre 60..3600 tam saniye string. maxNotional emir bedeli sınırıdır, **ücret hariçtir**. Server id/validFromMs/expiresAtMs üretir; hash bütün değişmez politikayı kapsar. Süre taslak oluşturulunca başlar; gerçek insan onay anı ayrı metadata olabilir. Kullanıcı server özetini ve hash'i açıkça onaylar. Onaylanan politika değişmez; değişiklik yeni politika gerektirir.

Öneri tam olarak `{instrument,side,tdMode,ordType,price,size}`; size AVAX, price USDT/AVAX. Miktarlar en çok 12 tam + 8 ondalık basamak, sayı değil string. Bilinmeyen alanlar reddedilir. Doğrudan kontrolde off-grid değerler değiştirilmez. Ajan incelemesinde yalnız açık düzeltme kapsamıyla aşağı yönlü yeni öneri üretilebilir; başlangıç ve son öneri birlikte gösterilir. Notional çarpımı tam hassasiyetle sınıra karşılaştırılır.

Kontroller: sabit kapsam, politika hash/zamanı, fiyat üst sınırı, emir bedeli üst sınırı, güncel ve aynı bağa ait ticker+instrument kanıtı, enstrüman live/cash spot kuralları, tickSize, lotSize ve minSize. Hesap bakiyesi, ücret, portföy, toplam kampanya harcaması, emir gönderme/iptal/dolum ve yatırım uygunluğu kapsam dışıdır.

## Agent ve kanıt

Canlı yol yalnız UID eşleşmiş read-only ATK ve yerel Ollama ile açılır. Ajan incelemesinde server iki sabit aracı okur: `market_get_ticker`, `market_get_instruments`. Araç argümanları sabittir: `{instId:'AVAX-USDT',demo:true}` ve `{instType:'SPOT',instId:'AVAX-USDT',demo:true}`. Bağımsız evaluator geri bildirimi yerel modele gösterilir. Model `ACCEPT`, `REVISE` veya `WAIT` döner. En fazla iki model çağrısı, tek düzeltme, değişmeyen kapsam/politika ve başlangıç değerlerini aşmayan fiyat/miktar sınırı vardır. İkinci turda yeni düzeltme yoktur. Kabulden sonra son kural kontrolü için kanıt tekrar okunur; eski bir model yanıtı güncel kuralları geçersiz kılamaz. Model final verdict, araç argümanı veya emir yetkisi veremez.

Doğrudan kontrol eski tek plan çağrılı yolu korur; model yalnız aynı iki aracın sırasını seçer ve öneri değişmez. Bu sınırlı sıralama tek başına güçlü bir otonomi iddiası değildir. Bozuk çıktı, eksik kanıt veya bağlantı hatasında gizli fixture/cloud fallback yoktur.

Her ATK sonucu önce mevcut kalıcı registered stdio journal'a yazılır. Tam binding/hash/aktif capture/null task+intent doğrulanır; yalnız bilgi amaçlı preflight tüketimi APPLIED yapar. Ekonomik replay ve eski ledger gevşetilmez. Ticker ve instrument normalizer'ları yeniden kullanılır; 10 sn maksimum yaş, 5 sn maksimum gözlem farkı. Ajanın her inceleme turu ve kabul sonrası final kontrolü yeni kanıt alır; eski kanıtla ALLOW yoktur. Model kotası çağrıdan önce kalıcı kaydedilir; kesintiden sonra otomatik model/ATK tekrarı yapılmaz.

Kayıtlı örnek yolu ayrı `REPLAY` modudur: üç sabit senaryo (sınırlar içinde, limit ihlali, eski veri), aynı saf evaluator ile çalışır. Gerçek ATK/model çağrısı veya canlı kontrol diye sunulmaz. Kullanıcının canlı politikasını değiştirmez.

## HTTP sözleşmesi

Tüm yollar mevcut session/Origin/CSRF/ownership sınırlarını kullanır; cookie'ler port bazında izoledir. Secret input alanı veya genel tool proxy yoktur.

- `GET /api/preflight/status`: `{version:1,liveAvailable,plannerKind,atkState,scope,limits,orderSubmissionEnabled:false,publication:'LOCAL_ONLY'}`. No raw UID/config/credential.
- `POST /api/preflight/policies`: politika girdisi; server `{id,policy,policyHash,status:'DRAFT'|'APPROVED',createdAtMs}` döner.
- `POST /api/preflight/policies/:id/approve`: `{policyHash,acknowledgement:true}`; aynı onay idempotent.
- `GET /api/preflight/policies/:id`: owner-scoped politika kaydı.
- `POST /api/preflight/checks`: `{policyId,policyHash,candidate,clientRequestId}`; UUID idempotency key; 202 `{id,state:'QUEUED'|'RUNNING'|'COMPLETED',mode:'LIVE_READ_ONLY',createdAtMs,report:null|object}`. Aynı key+aynı input aynı id; farklı input 409.
- `POST /api/preflight/agent-checks`: aynı istek gövdesi, `source:'AGENT'` işareti ve sınırlı inceleme döngüsü. Aynı UUID doğrudan/ajan yolları arasında yeniden kullanılamaz. Sonuçlar mevcut check/report/history yollarından okunur. Capability status alanları `agentAvailable` ve `agentVersion` ile bildirilir; eski backend'de ajan yolu seçilmez.
- `GET /api/preflight/checks/:id`: aynı kayıt; yalnız sahibi okur. İn-flight süreç async, bounded, yeniden başlatmada otomatik devam etmez.
- `GET /api/preflight/history`: `{policies:[],checks:[]}` sınırlı owner listesi.
- `POST /api/preflight/examples/:name`: `{clientRequestId}`; name `within-limits`, `limit-breach`, `stale-evidence`; completed `REPLAY` check döner, aynı rapor formatı. Kullanıcı politikasına bağlanmaz.
- `GET /api/preflight/checks/:id/report`: tamamlanmış rapor; owner-scoped. Aynı JSON ayrıca CLI ile offline doğrulanabilir.

Report: domain modülü schemaVersion, mode, policy+policyHash, candidate+candidateHash, verdict, reasonCodes, checks[], sanitized evidence, agent trace, checkedAtMs, notChecked[], disclosure, reportHash alanlarının sabit formatını belirler. Policy/candidate/evidence hash bağı korunur. Hash yerel bütünlüğü denetler; imza/bağımsız timestamp veya zincir yayını değildir. Bütün raporlar LOCAL_ONLY; mevcut Fuji kontratı yalnız ayrı arşiv referansıdır.

## Ekran

Ana `/`: ürün adı ve kısa işlem kapsamı; politika/sınırlar, öneri, kontrol sonucu tek çalışma alanı. Öncelik kullanılabilir araç; büyük marketing hero yok. Salt-okuma/örnek modu net. Politika özeti onayı, çağrı planı/kanıt zamanları, üç sonucu ayıran görünüm, geçmiş ve JSON indirme. Cüzdan/Remix/eklenti/API secret formu yok. Eski ekran `/legacy` altında tarihsel simülasyon olarak kalabilir; ana navigasyonda öne çıkarılmaz.

## Çalışma sırası

1. Alan sözleşmesi, backend ve frontend paralel kodlanır. Bu aşamada testler çalıştırılmaz; test kaynakları yazılabilir.
2. Bileşen sözleşmeleri birleştirilir; kod ve güvenlik bağımsız gözden geçirilir.
3. En sonda tam regresyon, yeni saf/domain/HTTP testleri, gerçek Ollama, public Fuji read, tarayıcı desktop/mobil/hata akışları çalıştırılır.
4. Canlı özel ATK kabulü yeni private launcher girişini gerektirirse kullanıcıya bırakılır. Mevcut 18774 süreci sessizce durdurulmaz; anahtarlar devralınmaz veya diske yazılmaz.
