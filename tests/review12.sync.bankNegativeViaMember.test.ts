/**
 * مدقق المرحلة ١ المستقل (المراجعة الشاملة 2026-11-13) · المزامنة · A2.2 (بلا مشكك خاص به) · بيانات مصطنعة كلها.
 *
 * العيب: إصلاح A2.2 («لا عكس يُنزل بنكاً تحت الصفر في كل المسارات» · قرار المالك ٥٥) فحصٌ على الجهاز الذي يُلغي (bankShortages في
 *   planCancelPayment)، وأثبته على جهاز العضو باختبارَي المدقق Q3 وQ3c بجهازٍ ثانٍ للمالك يرى كل شيء (helpers/rederive: pair) ·
 *   أما العضو الحقيقي فلا يرى حركات البنك: bank_tx يقرؤها «البنوك» و«التقارير» و«الدفتر» وحدها (readSections.ts)، فعضو «التحصيل»
 *   يرى رصيد البنك افتتاحيّه وما أودعه هو، لا سحب المالك منه · فيُجاز له إلغاء التحصيل، وجهاز المالك يطبّق الإلغاء كله بحركته السالبة
 *   (engine.ts: memberBankTxCheck لا يفحص ما كُتب مع قيده · Q٣) فيصير البنك سالباً، وهو ما منعه A2.2 على جهاز المالك نفسه.
 * السيناريو: عقدٌ بتأمين ٢٬٠٠٠ نقداً · عضو التحصيل يحصّل قسطاً ١٬٢٠٠ بشيكٍ في «بنك أ» · المالك يسحب من بنك أ ١٬٠٠٠ إلى المحفظة ·
 *   الشيك يرتجع فيلغي العضو الدفعة (جهازه يرى بنك أ ١٬٢٠٠ فيجيزه) · ويمضي شهر.
 * اليوم على جهاز المالك: بنك أ −١٬٠٠٠ (−١٠٠٬٠٠٠ هللة)، و1100 = ٢٬٠٠٠، بلا أي رفض.
 * الصحيح: لا ينزل بنكٌ تحت الصفر من أي جهاز (يُمنع الإلغاء على جهاز العضو، أو يُرفض كله على جهاز المالك): بنك أ ٢٠٠ (٢٠٬٠٠٠ هللة)،
 *   و1100 = ٢٬٠٠٠ + ١٬٢٠٠ = ٣٬٢٠٠ (٣٢٠٬٠٠٠ هللة).
 *   TZ=Asia/Riyadh npx jest tests/review12.sync.bankNegativeViaMember.test.ts
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
import { bankBalance, accountBalance } from '@/domain/accounting/ledger';
import type { Access } from '@/domain/access/access';
import type { DB } from '@/db/adapter';
import type { RemoteDoc, RemoteStore } from '@/sync/types';

const ORG = 'OWNER-R12-BN';
const OWNER: Access = { owner: true, uid: ORG, perms: {}, allProps: true, props: [] } as Access;
/** عضو التحصيل كاملاً وحده (لا البنوك ولا الدفتر) */
const COLLECT: Access = { owner: false, uid: 'M-R12-BN', perms: { collect: 3 }, allProps: true, props: [] } as Access;
const dev = (db: DB) => getMeta(db, 'device_id')!;

test('A2.2 · عضو التحصيل لا يرى سحب المالك من البنك فيلغي تحصيلاً بشيك: البنك لا يصير سالباً على جهاز المالك', async () => {
  const r = new MemoryRemote();
  const owner = memDb();
  enableSync(owner, ORG);
  const A = addBank(owner, 'بنك أ مصطنع', 0);
  const u = addUnit(owner, addProperty(owner, { name: 'عقار مصطنع' }), { unit_no: 'BN-1' });
  const cid = confirmContract(owner, contractInput(u, { tenant: 'مستأجر مصطنع', idNumber: '1000001293', phone: '0555551293' }));
  await syncOnce(owner, r, dev(owner));

  // جهاز العضو يسحب ما تجيزه له رموز رؤيته كما يكتبها annotate (كـ tests/review11.A1_2.collectMemberView.test.ts)
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

  // ١) العضو يحصّل القسط الأول ١٬٢٠٠ بشيكٍ في بنك أ
  const inst = m.get<{ id: string }>(`SELECT id FROM contract_installments WHERE contract_id = ? ORDER BY due_date LIMIT 1`, [cid])!.id;
  const pay = recordRentPayment(m, cid, { installmentId: inst, period: 'الأول', date: '2026-02-01',
    lines: [{ method: 'cheque', bankId: A, amountHalalas: 120_000 }], discountHalalas: 0, notes: '' });
  await msync();
  await syncOnce(owner, r, dev(owner));
  await syncOnce(owner, r, dev(owner));
  expect(bankBalance(owner, A)).toBe(120_000);
  // ٢) المالك يسحب ١٬٠٠٠ من بنك أ إلى المحفظة (في حدّ رصيده) · ولا يصل العضوَ: حركات البنك ليست من قسمه
  withdrawCashFromBank(owner, { bankId: A, amountHalalas: 100_000, date: '2026-02-05' });
  await syncOnce(owner, r, dev(owner));
  await msync();
  expect(bankBalance(owner, A)).toBe(20_000);
  // ٣) الشيك يرتجع: العضو يحاول الإلغاء (جهازه يرى بنك أ ١٬٢٠٠، فيجيزه اليوم)
  try { cancelPayment(m, pay, { date: '2026-02-10', reason: 'شيك مرتجع مصطنع' }); } catch { /* المنع على جهاز العضو أحد طرفي الصحيح */ }
  await msync();
  await syncOnce(owner, r, dev(owner));
  await syncOnce(owner, r, dev(owner));
  // ٤) يمضي شهر (ما ينتظر يُحسم)
  owner.run(`UPDATE sync_inbox SET waiting_since = '2020-01-01T00:00:00.000Z', attempts = 50`);
  await syncOnce(owner, r, dev(owner));
  await syncOnce(owner, r, dev(owner));

  const out = { bankA: bankBalance(owner, A), cash1100: accountBalance(owner, '1100') };
  // eslint-disable-next-line no-console
  console.log('A2.2 عبر العضو ·', JSON.stringify(out));
  // بنك أ لا ينزل تحت الصفر (اليوم: −١٠٠٬٠٠٠)، ولا نصف إلغاء: النقدية ٢٠٠٬٠٠٠ تأميناً + ١٢٠٬٠٠٠ تحصيلاً
  expect(out).toEqual({ bankA: 20_000, cash1100: 320_000 });
  owner.close();
  m.close();
});
