/**
 * مراجعة إصلاح R12-SYN-3 (01bc668) · بيانات مصطنعة كلها.
 *
 * العيب: memberBankOutCheck يحسب رصيد البنك من حركاته المطبَّقة هنا ويضيف ما ينتظر في الوارد من حركاتٍ داخلة (pendingBankIn) ولا
 *   يطرح ما ينتظر من حركاتٍ خارجة · وحركات البنك تُطبَّق بعد القيود · فجهاز المالك الثاني (لوحٌ يزامن أقل) الذي يسحب في دورةٍ واحدة
 *   سحبَ المالك من جهازه الأول وإلغاءَ العضو معاً يرى البنك قبل السحب فيقبل الإلغاء، والجهاز الأول (طبّق السحب قبله) يرفضه ·
 *   فيختلف دفترا المالك على جهازيه، وينزل البنك تحت الصفر على الثاني خلاف قرار المالك ٥٥.
 * السيناريو: عقدٌ بتأمين ٢٬٠٠٠ نقداً · بنك أ افتتاحيه صفر · عضو «التحصيل» وحده يحصّل قسطاً ١٬٢٠٠ بشيكٍ في بنك أ · يصل الجهازين ·
 *   المالك يسحب من جهازه الأول ١٬٠٠٠ من بنك أ إلى المحفظة ويزامن · اللوح لا يزامن بعد · الشيك يرتجع فيلغي العضو الدفعة (جهازه
 *   يرى بنك أ ١٬٢٠٠) · ثم يزامن اللوح (يصله السحب والإلغاء معاً) والجهاز الأول، ويمضي شهر.
 * الأرقام: بنك أ = ٠ + ١٢٠٬٠٠٠ − ١٠٠٬٠٠٠ = ٢٠٬٠٠٠ هللة على الجهازين (الإلغاء مرفوض) · واليوم على اللوح:
 *   ٠ + ١٢٠٬٠٠٠ − ١٠٠٬٠٠٠ − ١٢٠٬٠٠٠ = −١٠٠٬٠٠٠ هللة.
 *   TZ=Asia/Riyadh npx jest tests/review12.r.bankShortSecondOwner.test.ts
 */
import { memDb } from './helpers/testDb';
import { MemoryRemote } from './helpers/memoryRemote';
import { addBank, addProperty, addUnit, contractInput } from './helpers/fixtures';
import { enableSync, syncOnce, setSyncState } from '@/sync/engine';
import { annotate, memberTokens } from '@/sync/acl';
import { getMeta } from '@/repos/settings';
import { confirmContract, recordRentPayment } from '@/domain/contracts/service';
import { cancelPayment } from '@/domain/contracts/cancelPayment';
import { withdrawCashFromBank } from '@/domain/cashOps';
import { bankBalance } from '@/domain/accounting/ledger';
import type { Access } from '@/domain/access/access';
import type { DB } from '@/db/adapter';
import type { RemoteDoc, RemoteStore } from '@/sync/types';

const ORG = 'OWNER-R12-R2O';
const OWNER: Access = { owner: true, uid: ORG, perms: {}, allProps: true, props: [] } as Access;
const COLLECT: Access = { owner: false, uid: 'M-R12-R2O', perms: { collect: 3 }, allProps: true, props: [] } as Access;
const dev = (db: DB) => getMeta(db, 'device_id')!;

test('جهاز المالك الثاني يسحب سحبَ المالك وإلغاءَ العضو معاً: لا يقبل ما رفضه الجهاز الأول ولا ينزل البنك تحت الصفر', async () => {
  const r = new MemoryRemote();
  const owner = memDb();
  enableSync(owner, ORG);
  const A = addBank(owner, 'بنك أ مصطنع', 0);
  const u = addUnit(owner, addProperty(owner, { name: 'عقار مصطنع' }), { unit_no: 'R2O-1' });
  const cid = confirmContract(owner, contractInput(u, { tenant: 'مستأجر مصطنع', idNumber: '1000001391', phone: '0555551391' }));
  await syncOnce(owner, r, dev(owner));
  // جهاز المالك الثاني (لوح) على الحساب نفسه
  const tab = memDb();
  enableSync(tab, ORG);
  const tsync = async () => { await syncOnce(tab, r, dev(tab)); await syncOnce(tab, r, dev(tab)); };
  const osync = async () => { await syncOnce(owner, r, dev(owner)); await syncOnce(owner, r, dev(owner)); };
  await tsync();

  // جهاز العضو يسحب ما تجيزه رموز رؤيته (كـ review12.sync.bankNegativeViaMember)
  const tokens = new Set(memberTokens(COLLECT));
  const seen = (x: RemoteDoc | null) => !!x && (x.g ?? []).some((g) => tokens.has(g));
  const m = memDb();
  enableSync(m, COLLECT.uid!);
  m.run(`DELETE FROM sync_outbox`);
  m.run(`INSERT OR REPLACE INTO sync_state (k, v) VALUES ('membership', ?)`, [JSON.stringify({ org: ORG, profile: { name: 'محصِّل مصطنع' } })]);
  setSyncState(m, 'org', ORG);
  const remote: RemoteStore = {
    pull: async (c, l) => {
      const page = await r.pull(c, l);
      const docs: RemoteDoc[] = [];
      for (const d of page.docs) {
        const a = d.op ? { doc: d, pub: null } : annotate(owner, { ...d } as RemoteDoc, OWNER);
        if (seen(a.doc)) docs.push(a.doc);
        else if (seen(a.pub)) docs.push(a.pub!);
      }
      return { ...page, docs };
    },
    write: (d) => r.write(d), clockSample: () => r.clockSample(),
    reserveBlocks: (q) => r.reserveBlocks(q), takeInvoiceSeq: (f) => r.takeInvoiceSeq(f), memberMode: true,
    annotate: (d, doc) => annotate(d, doc, COLLECT).doc,
  };
  const msync = () => syncOnce(m, remote, dev(m));
  await msync();

  // ١) العضو يحصّل ١٬٢٠٠ بشيكٍ في بنك أ · يصل الجهازين
  const inst = m.get<{ id: string }>(`SELECT id FROM contract_installments WHERE contract_id = ? ORDER BY due_date LIMIT 1`, [cid])!.id;
  const pay = recordRentPayment(m, cid, { installmentId: inst, period: 'الأول', date: '2026-02-01',
    lines: [{ method: 'cheque', bankId: A, amountHalalas: 120_000 }], discountHalalas: 0, notes: '' });
  await msync();
  await osync();
  await tsync();
  expect([bankBalance(owner, A), bankBalance(tab, A)]).toEqual([120_000, 120_000]);
  // ٢) المالك يسحب ١٬٠٠٠ من جهازه الأول (في حدّ رصيده) ويزامن · واللوح لم يزامن بعد
  withdrawCashFromBank(owner, { bankId: A, amountHalalas: 100_000, date: '2026-02-05' });
  await osync();
  await msync();
  // ٣) الشيك يرتجع: العضو يلغي (جهازه يرى بنك أ ١٬٢٠٠)
  try { cancelPayment(m, pay, { date: '2026-02-10', reason: 'شيك مرتجع مصطنع' }); } catch { /* المنع على جهاز العضو أحد طرفي الصحيح */ }
  await msync();
  // ٤) اللوح يسحب السحب والإلغاء معاً، ثم الجهاز الأول، ثم يمضي شهر
  await tsync();
  await osync();
  for (const db of [owner, tab]) db.run(`UPDATE sync_inbox SET waiting_since = '2020-01-01T00:00:00.000Z', attempts = 50`);
  await tsync();
  await osync();
  await tsync();

  const out = { owner: bankBalance(owner, A), tablet: bankBalance(tab, A) };
  // eslint-disable-next-line no-console
  console.log('جهازا المالك ·', JSON.stringify(out));
  // ٠ + ١٢٠٬٠٠٠ − ١٠٠٬٠٠٠ = ٢٠٬٠٠٠ على الجهازين (اليوم على اللوح: −١٠٠٬٠٠٠)
  expect(out).toEqual({ owner: 20_000, tablet: 20_000 });
  owner.close(); tab.close(); m.close();
});
