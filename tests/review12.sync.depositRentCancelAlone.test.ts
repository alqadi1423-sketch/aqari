/**
 * مدقق المرحلة ١ المستقل (المراجعة الشاملة 2026-11-13) · المزامنة · A1-2 · بيانات مصطنعة كلها.
 *
 * العيب: قرار A1-2 «الدفعة "من التأمين" لا تُلغى وحدها بل بتعديل التسوية» محروسٌ في الخدمة وحدها (planCancelPayment: paidFromSettlement) ·
 *   وجهاز المالك لا يحرسه (engine.ts: collectionRowCheck يمنع العضو من إلغاء دفعة العربون وحدها: paidFromDeposit، لا دفعة التسوية) ·
 *   والسابقة نفسها في الكود: «ودفعة العربون لا يلغيها عضو (البند ٢٧ · جهاز العضو بنسخة قديمة يلغيها فيعود مبلغها عالقاً في 2450)» ·
 *   فجهاز عضوٍ بإصدارٍ قبل fb0ee46 (لا مخطط جديد لـA1-2، فلا يرفع حدّ الإصدار شيئاً ما لم يرفعه المالك يدوياً) له «التحصيل» و«التأمينات»
 *   يرى دفعة «من التأمين» دفعةً عادية فيلغيها بعكس قيدها (deposit_rent_rev، تجيزه القاعدة لقسم التأمينات)، فيقبله جهاز المالك.
 * السيناريو: عقد ثلاثة أشهر بأقساط ١٬٠٠٠ وتأمين ١٬٥٠٠ نقداً، لم يُدفع شيء · سوّى المالك التأمين: خصم ١٬٥٠٠، منها ١٬٢٠٠ مقابل الأقساط
 *   (يناير ١٬٠٠٠ وفبراير ٢٠٠) و٣٠٠ أضرار · ثم يلغي العضو دفعة يناير «من التأمين» وحدها كما يفعل إلغاء الدفعة في الإصدار السابق.
 * اليوم على جهاز المالك: يُقبل الإلغاء · يناير مستحقٌ ثانيةً (٠ مسدَّد)، والتزام التأمين 2400 يعود ١٬٠٠٠ والتسوية تقول إنه خُصم كله،
 *   والإيجار 4200 ينزل إلى ٢٠٠ · فيُطالَب المستأجر بيناير وقد سُدّد من تأمينه.
 * الصحيح: يُرفض إلغاء دفعة التسوية وحدها على جهاز المالك كدفعة العربون: يناير مدفوعٌ ١٠٠٬٠٠٠، و2400 صفر، و4200 = ١٢٠٬٠٠٠، و4300 = ٣٠٬٠٠٠.
 *   TZ=Asia/Riyadh npx jest tests/review12.sync.depositRentCancelAlone.test.ts
 */
import { memDb } from './helpers/testDb';
import { MemoryRemote } from './helpers/memoryRemote';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { enableSync, syncOnce, setSyncState } from '@/sync/engine';
import { annotate } from '@/sync/acl';
import { getMeta } from '@/repos/settings';
import { confirmContract, saveDepositSettlement } from '@/domain/contracts/service';
import { reverseEntryById } from '@/domain/accounting/post';
import { recomputeInstallments } from '@/domain/contracts/paid';
import { accountBalance } from '@/domain/accounting/ledger';
import type { Access } from '@/domain/access/access';
import type { DB } from '@/db/adapter';
import type { RemoteStore } from '@/sync/types';

const OWNER = 'OWNER-R12-DRC';
const dev = (db: DB) => getMeta(db, 'device_id')!;

async function joinMember(r: MemoryRemote, a: Access) {
  const db = memDb();
  enableSync(db, a.uid!);
  db.run(`DELETE FROM sync_outbox`);
  db.run(`INSERT OR REPLACE INTO sync_state (k, v) VALUES ('membership', ?)`, [JSON.stringify({ org: OWNER, profile: { name: 'عضو مصطنع' } })]);
  setSyncState(db, 'org', OWNER);
  const remote: RemoteStore = {
    pull: (c, l) => r.pull(c, l), write: (d) => r.write(d), clockSample: () => r.clockSample(),
    reserveBlocks: (q) => r.reserveBlocks(q), takeInvoiceSeq: (f) => r.takeInvoiceSeq(f), memberMode: true,
    annotate: (d, doc) => annotate(d, doc, a).doc,
  };
  await syncOnce(db, remote, dev(db));
  return { db, sync: () => syncOnce(db, remote, dev(db)) };
}

const paid = (db: DB, cid: string) => db.all<{ p: number }>(
  `SELECT paid_halalas AS p FROM contract_installments WHERE contract_id = ? ORDER BY due_date`, [cid]).map((x) => Number(x.p));

test('A1-2 · إلغاء دفعة «من التأمين» وحدها من جهاز عضو (إصدارٌ سابق) يُرفض على جهاز المالك كدفعة العربون', async () => {
  const r = new MemoryRemote();
  const owner = memDb();
  enableSync(owner, OWNER);
  const u = addUnit(owner, addProperty(owner, { name: 'عقار مصطنع' }), { unit_no: 'DRC-1' });
  const cid = confirmContract(owner, contractInput(u, { tenant: 'مستأجر مصطنع', idNumber: '1000001331', phone: '0500001331',
    valueHalalas: 300_000, cycle: 'شهرية', start: '2026-01-01', end: '2026-03-31', depositHalalas: 150_000 }));
  // الخصم ١٬٥٠٠: منه ١٬٢٠٠ للأقساط (يناير ١٬٠٠٠ وفبراير ٢٠٠) و٣٠٠ أضرار
  saveDepositSettlement(owner, cid, { date: '2026-04-05', deductionHalalas: 150_000, deductionReason: 'إيجار وأضرار مصطنعة',
    refundHalalas: 0, notes: '', arrearsHalalas: 120_000 });
  await syncOnce(owner, r, dev(owner));
  expect(paid(owner, cid)).toEqual([100_000, 20_000, 0]);

  const m = await joinMember(r, { owner: false, uid: 'M-R12-DRC', perms: { collect: 3, deposits: 3 }, allProps: true, props: [] } as Access);
  // ما يكتبه «إلغاء الدفعة» في الإصدار السابق لـA1-2 (cancelPayment قبل paidFromSettlement): مرآة قيدها بتاريخ الإلغاء، ووسم الدفعة
  // ملغاةً بعاكسها، ثم المسدَّد من الدفعات
  const jan = m.db.get<{ id: string; je: string; inst: string }>(
    `SELECT p.id, p.journal_entry_id AS je, p.installment_id AS inst FROM contract_payments p JOIN contract_installments i ON i.id = p.installment_id
     WHERE p.contract_id = ? AND p.method_label = 'من التأمين' ORDER BY i.due_date LIMIT 1`, [cid])!;
  m.db.transaction(() => {
    const rev = reverseEntryById(m.db, jan.je, 'إلغاء دفعة · مستأجر مصطنع · إلغاء مصطنع', '2026-04-10')!;
    m.db.run(`UPDATE contract_payments SET cancelled_at = ?, cancel_reason = ?, cancel_entry_id = ? WHERE id = ?`,
      ['2026-04-10', 'إلغاء مصطنع', rev.id, jan.id]);
    recomputeInstallments(m.db, [jan.inst]);
  });
  await m.sync();
  await syncOnce(owner, r, dev(owner));
  await syncOnce(owner, r, dev(owner));

  const out = {
    paid: paid(owner, cid),
    cancelled: owner.get<{ c: string | null }>(`SELECT cancelled_at AS c FROM contract_payments WHERE id = ?`, [jan.id])!.c,
    a2400: accountBalance(owner, '2400'), a4200: accountBalance(owner, '4200'), a4300: accountBalance(owner, '4300'),
  };
  // eslint-disable-next-line no-console
  console.log('A1-2 إلغاء دفعة التسوية وحدها ·', JSON.stringify(out));
  // اليوم: { paid: [0, 20000, 0], cancelled: '2026-04-10', a2400: 100000, a4200: 20000, a4300: 30000 }
  expect(out).toEqual({ paid: [100_000, 20_000, 0], cancelled: null, a2400: 0, a4200: 120_000, a4300: 30_000 });
  owner.close();
  m.db.close();
});
