# Pactway Preflight

## Ne problemi cozer?

AI ajaninin onerisi ile borsaya gonderilecek emir arasinda, tek onerinin acik sinirlara ve secili piyasa kurallarina uygunlugunu inceleyen yardimci aractir. Hedef kullanici ajan gelistiricisi veya operatorudur. Yeni bir trading botu, kar tahmini veya portfoy yoneticisi degildir.

Mevcut dar kapsam: AVAX-USDT, spot cash, limit alim. Ajan salt okunur ATK kaniti ve bagimsiz kontrol geri bildirimiyle oneriyi inceler; fiyat ve miktari yalniz azaltarak tek duzeltme yapabilir. Modelden bagimsiz kesin ondalik hesap son sonucu uretir. Modelin final sonuc veya emir yetkisi yoktur.

## Ilk ziyaret

1. Kullanici tek emir bedeli ust sinirini (ucret haric), birim fiyat ust sinirini ve gecerlilik suresini girer.
2. Serverin degistirilemeyen politika ozetini inceler ve hash ile onaylar. Sure taslak olusturulurken baslar; sonradan uzatilmaz.
3. Onerilen limit fiyatini (USDT/AVAX) ve miktari (AVAX) girer. Politika duzenlemek yeni politika olusturur.
4. Canli baglanti hazirsa Ajan incelemesi veya Dogrudan kontrol secer. Ajan incelemesi en fazla iki yerel model cagrisi ve tek asagi yonlu duzeltmeyle sinirlidir; emir gondermez. Dogrudan kontrol oneriyi degistirmez. Istek yolu/kimligi ayni istegin tekrarlanmasinda korunur; yanit kaybi yeni model cagrisi anlamina gelmez.
5. Sonuc, varsa ilk/son oneri farki, model eylemi, bagimsiz kontrol sonucu ve kapsam disi maddeleri inceler; JSON raporunu indirir.

Canli kontrolde ayni anda tek adim gorunur: politika, onaydan sonra fiyat/miktar onerisi, kontrol baslayinca sonuc. Adim dugmeleri mevcut veriyi incelemek icindir; otomatik onay veya yeni kontrol baslatmaz. Bekleyen/belirsiz bir istekte kurtarma eylemi gorunur kalir ve baska akis acilmaz. Onceki adima donmek politikayi kendiliginden degistirmez.

Canli kontrol, kayitli ornekler ve gecmis ayri gorunumlerdir. Gecmis yalniz bu oturumun kayitlarini acar; ana formun altinda surekli listelenmez. Ornek gorunumunde canli politika ve fiyat/miktar formu gizlenir; rapor kendi sabit ornek girdilerini gosterir. Ornekler gercek piyasa/model cagrisi yapmaz, formdaki girdileri kullanmaz ve canli politika yerine gecmez. Gorunum degistirmek bir kontrol veya model cagrisi baslatmaz.

Onay oncesinde bedel/fiyat/sure ve ucret-haric kapsam ozeti gorunur. Onayli politika sonraki adimlarda kompakt sinir ozeti ve kalan sureyle gorunur. Suresi bitince yeni politika gerekir. Alan hatalari ilgili girisin altinda gosterilir. Emir bedeli ve sinira kalan tutar onizlemesi kesin ondalik hesaptir; bu onizleme tek basina ALLOW veya BLOCK karari degildir.

Baglanti durumunun ayrintilari kapali panelden acilir. Sonucta karar, gerekce, raporun kendi girdileri ve JSON indirme gorunur; dokuz kontrol, kanit/hash ve kapsam disi maddeler teknik rapor panelindedir. Gecmis rapor bugunku politikanin veya fiyat/miktar girisinin yerine gecmez.

Kullanici site icinde API secret, sifre, ozel anahtar girmez; cuzdana, Remix'e veya eklentiye yonlendirilmez.

## Sonuclari yorumlama

| Sonuc | Anlami |
| --- | --- |
| ALLOW | Yalniz bu raporda listelenen, kapsam icindeki kontroller gecti. |
| BLOCK | Bilinen bir sinir veya enstruman kurali ihlali var. |
| INSUFFICIENT_DATA | Kontrol guvenilir ve taze kanitla tamamlanamadi. |

ALLOW bir alim tavsiyesi, para korumasi, emir kabul veya gerceklesme garantisi degildir. Bu servis baska bir yurutucuyu teknik olarak engellemez. Bakiye, ucret, USD cinsinden borsa notional ust limiti, borsa fiyat bandi/emir kabul kurallari, likidite/slippage, portfoy dagilimi ve toplam harcama kapsam disidir. Ticker yalniz guncel bir referanstir; adil fiyat veya yeterli likidite kaniti degildir. USDT sessizce USD kabul edilmez. Bu maddeleri ayri dogrulamadan emir gonderilmemelidir.

Eksik/eski/farkli oturuma ait veri ALLOW uretmez. Model gecersiz yanit verirse veya salt okuma baglantisi kapanirsa gizli fixture/cloud fallback yoktur. Dogrudan kontrolde sayilar degistirilmez; ajan yolundaki duzeltme acikca kaydedilir ve yeniden kontrol edilir. Islem, iptal veya transfer API'si bu urunun akisinda bulunmaz.

## OKX ve Avalanche nerede?

Canli piyasa kaniti UID eslesmesi onceden yapilmis OKX TR demo salt-okunur ATK oturumundan gelir. Bu yerel MVP operator baglantisidir; herhangi bir ziyaretcinin kisisel borsa hesabini bagladigi cok-kullanicili SaaS degildir. Yerel Ollama gercek plan cagrisi icin gereklidir. Anahtarlar yalniz ozel terminal baslaticisina girilir, tarayiciya/repo/rapora yazilmaz.

Yeni surumu mevcut 18774 oturumunu kapatmadan acmak icin ozel terminalde `node scripts/connect-preflight.mjs` kullanilir. Sabit 18779 portu bos olmalidir. UID, demo salt-okuma anahtari ve katalog onayi yeniden kullanicidan alinir; eski surecin credential'i okunmaz veya devralinmaz. Basarida adres `http://127.0.0.1:18779/` olur. Anahtarlar sohbet mesajina yazilmamalidir.

Sinirli ajan dongusunu mevcut 18779 oturumunu kapatmadan yuklemek icin `node scripts/connect-preflight-agent.mjs` kullanilir. Ayri portu 18783'tur; ozel terminal ayni demo/salt-okuma bilgilerini yeniden ister. Eski backend yeni ozelligi desteklemiyorsa arayuz Dogrudan kontrol yolunu korur. Yalniz sayfayi yenilemek calisan backend'i guncellemez.

Yeni Preflight raporlari varsayilan olarak `LOCAL_ONLY` kalir. Canli kabuldeki tek bir raporun politika ve rapor hash'leri daha sonra operatorun iki ayri Core imzasiyla Fuji MandateRegistry'ye kaydedilip receipt'leri salt okunur dogrulanmistir; bu istisna otomatik yayin, tum raporlarin zincire yazilmasi veya borsa emri anlamina gelmez. UI, web sitesi ve backend Avalanche uzerinde host edilmis degildir. Normal urun kullanicisindan cuzdana baglanmasi ya da Remix kullanmasi istenmez; imza akisi yalniz operator bonus kanitidir.

## Raporu uygulama disinda kontrol etme

```powershell
node scripts/verify-preflight-report.mjs "C:\path\preflight-report.json"
```

Basarida exit code 0, tutarsiz raporda 1, hatali komut kullaniminda 2 doner. Dogrulama ayni sabit kurallarla sonucu tekrar hesaplar ve hash baglarini kontrol eder. Hash, imza veya bagimsiz kaynak kaniti degildir: dosyayi degistirebilen kisi yeni hash de uretebilir. Rapor tek basina gercek ATK cagrisi yapildigini bagimsiz olarak ispatlamaz; gercek kaynak kaydi yerel kayitli stdio journal'indadir.

Fuji icin yalniz imzasiz bir taahhut manifesti hazirlamak gerekirse bir veya daha cok rapor verilebilir; arac dogrulanmis en yeni `LIVE_READ_ONLY` raporu secer:

```powershell
node scripts/prepare-preflight-fuji-publication.mjs "C:\path\report.json" --output "C:\path\manifest.json"
```

`READY_FOR_USER_SIGNATURE`, islemlerin gonderildigi anlamina gelmez. Arac cuzdan acmaz, imza istemez, RPC cagrisi veya transaction submission yapmaz. Cikti mevcut Fuji kontratina sifir value ile iki calldata verir: once gercek Preflight `policyHash` degeriyle `commitPolicy`, sonra rapor hash'ini makbuz taahhudu olarak tasiyan `appendDecision`. Ikinci islem yalniz ayni yeni task icin ilk islemin basarili receipt'i dogrulandiktan sonra imzalanip gonderilebilir. Zincir yayini ancak kullanicinin ayri imzalari, gonderimleri ve iki receipt dogrulamasi sonrasinda iddia edilebilir.

## Sunum cumlesi

"Pactway, AI trading ajani gelistiren ekipler icin tek emir onerisine odaklanan dar kapsamli bir preflight aracidir. Ajan, salt okunur OKX kanitini ve bagimsiz kontrol sonucunu inceler; onaylanmis sinirlar icinde tek duzeltme yapar veya bekler. Sonucu model degil kesin kurallar belirler. Emir gondermeyiz, kar vaat etmeyiz; ilk oneriden sonuca neyin degistigini tasinabilir bir raporla gosteririz."
