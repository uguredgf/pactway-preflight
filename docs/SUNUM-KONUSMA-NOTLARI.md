# Pactway Preflight jüri konuşma notları

## 3-5 dakikalık akış

**1. Açılış**  
Pactway, AI trading ajanı geliştiren ekipler ve operatörler için tek emir önerisine odaklanan bir işlem öncesi kontrol aracıdır. Bugünkü dar kapsam AVAX-USDT spot cash limit alımdır. Ürün emir göndermez.

**2. Sorun**  
Bir model öneri üretebilir, ancak bu öneri operatör sınırlarını, borsa grid kurallarını veya kanıt tazeliğini otomatik olarak kanıtlamaz. Pactway model ile yürütme arasındaki bu boşluğu hedefler.

**3. Ürün akışı**  
Operatör azami emir bedelini, fiyat üst sınırını ve süreyi onaylar. Aday fiyat ve miktar girilir. Yerel ajan iki sabit salt okunur OKX aracından veri alır. En fazla iki model çağrısı ve tek aşağı yönlü revizyon vardır. Final kararı modelden bağımsız governor verir.

**4. Canlı örnek**  
25 × 0.4 önerisi ACCEPT ve ALLOW oldu. 26.001 × 0.4 önerisi 25 × 0.4 olarak revize edildi, ardından ACCEPT ve ALLOW oldu. 25 × 0.00000001 için uygulanabilir aşağı yönlü çözüm olmadığı için ajan WAIT, governor BLOCK verdi.

**5. Güven sınırı**  
OKX TR demo ATK yalnız ticker ve enstrüman kurallarını sağlar. Emir, iptal veya transfer yetkisi yoktur. ALLOW yatırım tavsiyesi, fill veya kâr garantisi değildir. Bakiye, ücret, portföy ve likidite kapsam dışıdır.

**6. Avalanche bonusu**  
Kullanıcı, tek canlı raporun politika ve rapor hash taahhüdünü mevcut Avalanche Fuji registry kontratına iki işlemle yazdı. Bu zincir kaydı rapor hash taahhüdüdür. CEX gerçekleşmesini veya kaynak verinin doğruluğunu kanıtlamaz. Uygulama otomatik anchor yapmaz.

**7. Kapanış**  
Pactway modelin hareket alanını sınırlar, neyin değiştiğini raporlar ve son kararı kesin kurallara bırakır.

## Demo sırası

1. `http://127.0.0.1:18783/` adresini aç.
2. 25 USDT azami bedel, 25 USDT/AVAX azami fiyat ve 600 saniyelik politikayı onayla.
3. Sırasıyla `25 × 0.4`, `26.001 × 0.4` ve `25 × 0.00000001` adaylarını çalıştır.
4. Model eylemi ile bağımsız sonucu ayrı göster.
5. JSON raporunu indirip ilk ve son aday ayrımını göster.

Public statik replay: <https://pactway-preflight-demo.vercel.app>. Bu sayfa üç sabit örnek gösterir. Canlı kişisel operatör akışı yalnız localhost 18783 üzerinde çalışır.

## Kısa jüri Q&A

**Neden modelin kendisi karar vermiyor?**  
Çünkü fiyat, emir bedeli, tick, lot ve minimum miktar kuralları kesin hesap gerektirir. Model yalnız öneriyi inceler; governor exact decimal hesapla final sonucu üretir.

**Bu bir trading botu mu?**  
Hayır. Emir gönderme, iptal ve transfer API'si yoktur. Ürün tek adayın işlem öncesi kontrolünü ve taşınabilir raporunu üretir.

**OKX bağlantısı ne yapıyor?**  
UID eşleşmiş demo salt okunur oturumdan ticker ve enstrüman kurallarını alıyor. Kullanıcının tarayıcıya anahtar girmesi gerekmez.

**ALLOW ne anlama geliyor?**  
Yalnız raporda listelenen kapsam kontrollerinin geçtiğini söyler. Yatırım tavsiyesi, bakiye yeterliliği, emir kabulü veya gerçekleşme garantisi değildir.

**Avalanche burada ne sağlıyor?**  
Tek bir raporun hash taahhüdü için harici, sıralı bir kayıt sağlıyor. Uygulama Avalanche üzerinde host edilmiyor ve her raporu otomatik yazmıyor.

**Test durumu nedir?**  
Son kayıtta 535/535 tüm repo testi geçti. 116 odaklı test bu toplamın içindedir. Ayrıca iki HTTP kabul testi kaydedildi.

**Bugünkü sınır nedir?**  
Yalnız AVAX-USDT, spot cash, limit alım. Ek enstrümanlar, başka borsalar, imzalı kaynak makbuzları ve operatör onaylı otomatik anchoring roadmap kapsamındadır.

## Zincir doğrulama bilgileri

- Canlı rapor hash: `0x28ec5af9d1553a3d290477131576b326b36dd0e2af0c8917a25d4a4533a71260`
- Fuji kontratı: `0xd2f8b2164c9843c2eb15dfed696d230427eb436b`
- `commitPolicy`: `0xa303dc8b2745144eb998be7064b49a14388bb9848386ad706a116ea8bf2a8eae`, blok `59602823`
- `appendDecision`: `0x6114d998b958fc1f1b83e1b5ffa7b2ba543a381974d4acb951fda77c2e2b8eaf`, blok `59603314`

## Sunum öncesi kontrol

- Özel terminalde 18783 oturumunun açık ve `salt okunur` durumda olduğunu doğrula.
- Yerel Ollama modelinin hazır olduğunu doğrula.
- Public replay bağlantısını statik üç örnek olarak tanıt; canlı OKX/model akışı izlenimi verme.
- Her sonuçta `emir yetkisi kapalı` ifadesini görünür tut.
