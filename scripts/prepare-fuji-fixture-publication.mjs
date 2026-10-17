// Generates an independent fixture acceptance run. No network, model or wallet access.
import {mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Store} from '../src/persistence/store.mjs';
import {Engine} from '../src/engine.mjs';
import {FixturePlanner} from '../src/planner.mjs';
import {prepareFujiPublication} from './lib/fuji-publication.mjs';

const data=await mkdtemp(join(tmpdir(),'pactway-fuji-fixture-'));
const store=new Store(data);
try {
  const engine=new Engine(store,new FixturePlanner());
  const draft=engine.draft({budget:'100',singleOrderNotionalMax:'25',maxPrice:'25',maxSharePercent:'10'});
  const task=engine.approve({draftId:draft.id,policyHash:draft.policyHash,acknowledgement:true});
  await engine.run(task.id);
  engine.stop(task.id);
  const view=engine.scenario(task.id,'confirm-cancel');
  if(!view.auditVerified || view.summary.reserved!=='0' || view.ledger.phase!=='STOPPED')throw new Error('FUJI_FIXTURE_NOT_SETTLED');
  const bundle=await prepareFujiPublication({policyCommitment:view.auditPolicy,receipts:view.receipts,expectedHead:view.auditHead});
  bundle.provenance={mode:'fixture',planner:'fixture',realExchangeOrders:false,realAccountData:false,
    purpose:'Independent acceptance test; not a user-approved investment policy or an Ollama decision.',taskId:task.id};
  const parent=fileURLToPath(new URL('../exports/',import.meta.url));
  await mkdir(parent,{recursive:true});
  const directory=await mkdtemp(join(parent,'fuji-publication-'));
  await writeFile(join(directory,'publication.json'),JSON.stringify(bundle,null,2)+'\n',{flag:'wx'});
  const args=bundle.commitPolicy.args;
  await writeFile(join(directory,'ILK-ISLEM.md'),`# Fuji: ilk politika kaydı\n\nBu paket bağımsız bir FIXTURE (simülasyon) testidir; gerçek hesap verisi, gerçek emir veya Ollama kararı içermez. Henüz zincire yazılmadı. Dosyayı saklayın; işlemden sonra yeni paket üretmeyin.\n\n- Ağ: Avalanche Fuji, 43113.\n- Cüzdan: ${bundle.commitPolicy.from}\n- Mevcut kontrat: ${bundle.commitPolicy.to}\n- Value: 0 wei. Yalnız test AVAX ağ ücreti.\n\nRemix'te mevcut kontratı açın; yeniden Deploy yapmayın. Gerekirse derlenmiş MandateRegistry ile At Address alanına yukarıdaki kontratı girin. commitPolicy fonksiyonunu genişletin.\n\n## taskId\n\n\`${args.taskId}\`\n\n## policyHash\n\n\`${args.policyHash}\`\n\nAğ, kontrat, iki parametre ve sıfır value değerini kontrol ederek yalnız commitPolicy işlemini bir defa onaylayın. Başarılıysa tam transaction hash'i paylaşın. Belirsiz sonuçta tekrar göndermeyin; önce zincirden kontrol edilsin.\n\nappendDecision için henüz işlem yapmayın. Politika makbuzu doğrulandıktan sonra paket içindeki ilk onay kaydı (sequence=1) ayrı işlemle yazılabilir; bu tüm denetim zincirinin yayımlandığı anlamına gelmez.\n`,{flag:'wx'});
  console.log(JSON.stringify({result:bundle.state,directory,retainedFixtureData:data,receipts:view.receipts.length,
    firstDecisionKind:bundle.firstReceipt.source.decision.kind,commitPolicy:bundle.commitPolicy.args},null,2));
} finally {store.close();}
