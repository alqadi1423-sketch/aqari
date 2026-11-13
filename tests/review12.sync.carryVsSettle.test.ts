/**
 * مدقق المرحلة ١ المستقل (المراجعة الشاملة 2026-11-13) · المزامنة · A1-1 (بلا مشكك خاص به) · بيانات مصطنعة كلها.
 *
 * العيب: حارس A1-1 على جهاز المالك (deriveSources.ts: carryAfterSettle) يرفض قيد ترحيل التأمين إن وجد صفّ تسويةٍ للعقد القديم هنا أو في
 *   الوارد · فهو يحرس ترتيباً واحداً، ويرفض القيد وحده:
 *   (أ) إن وصل التجديد بترحيله أولاً ثم التسوية (عضو التأمينات سوّى العقد قبل أن يصله التجديد): لا حارس للتسوية بعد الترحيل على جهاز
 *       المالك (depositCarried في الخدمة وحدها)، فيُقبل الاثنان: تأمين ١٬٠٠٠ قُبض مرة واحدة رُدّ للمستأجر ورُحِّل إلى العقد الجديد معاً،
 *       فالتزام العقد القديم في 2400 سالب ١٬٠٠٠ والجديد يحمل ١٬٠٠٠ يُردّ ثانيةً عند نهايته · وهي نتيجة A1-1 نفسها.
 *   (ب) وإن وصلا معاً: يُرفض قيد الترحيل، ويبقى العقد الجديد بتأمين ١٬٠٠٠ في صفّه (deposit_halalas) بلا شيءٍ في 2400، ففحص المطابقة
 *       الثالث أحمر وشاشة تسويته تعرض ردّ ١٬٠٠٠ لم يُقبض.
 * السيناريو: عقد ١٠٬٠٠٠ ريال (2026-01-01 إلى 2026-10-31) بتأمين ١٬٠٠٠ نقداً، انتهى · عضو «كامل العقود» يجدّده مع ترحيل التأمين، وعضو
 *   «كامل التأمينات» يسوّيه بردّ ١٬٠٠٠، كلٌّ على جهازه قبل أن يرى عمل الآخر.
 * الصحيح (أياً كان ترتيب الوصول): التأمين المقبوض مرةً يُحسب مرةً · التزام العقد القديم صفر، والمردود منه مع المحتجز للجديد ١٠٠٬٠٠٠
 *   هللة لا ٢٠٠٬٠٠٠، وتأمين العقد الجديد في صفّه بقدر ما يحتجزه له الدفتر، والفحص الثالث أخضر.
 *   TZ=Asia/Riyadh npx jest tests/review12.sync.carryVsSettle.test.ts
 */
import { memDb } from './helpers/testDb';
import { MemoryRemote } from './helpers/memoryRemote';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { enableSync, syncOnce, setSyncState } from '@/sync/engine';
import { annotate } from '@/sync/acl';
import { getMeta } from '@/repos/settings';
import { confirmContract, saveDepositSettlement, renewContract } from '@/domain/contracts/service';
import { ownerCashIn } from '@/domain/cashOps';
import { integrityChecks } from '@/domain/accounting/integrity';
import type { Access } from '@/domain/access/access';
import type { DB } from '@/db/adapter';
import type { RemoteStore } from '@/sync/types';

const OWNER = 'OWNER-R12-CS';
const DEPOSIT_CHECK = 'تأمينات المستأجرين = التأمينات المحتجزة (غير المُسوَّاة)';
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

/** التزام التأمين في 2400 لعقدٍ بعينه (دائن موجب) */
const liability = (db: DB, cid: string) => Number(db.get<{ n: number }>(
  `SELECT COALESCE(SUM(l.credit_halalas - l.debit_halalas), 0) AS n FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
   WHERE e.status = 'مرحّل' AND l.account_code = '2400' AND l.contract_id = ?`, [cid])!.n);
/** ما خرج من النقد ردّاً لتأمين العقد (قيود الرد وعواكسها) */
const refunded = (db: DB, cid: string) => Number(db.get<{ n: number }>(
  `SELECT COALESCE(SUM(l.credit_halalas - l.debit_halalas), 0) AS n FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
   WHERE e.status = 'مرحّل' AND l.account_code = '1100' AND e.src_type IN ('deposit_refund', 'deposit_refund_rev') AND e.src_id = ?`, [cid])!.n);

test.each([
  ['(أ) يصل التجديد ويطبّقه المالك، ثم تصل التسوية', 'owner-between'],
  ['(ب) يصلان معاً في سحبٍ واحد', 'together'],
])('A1-1 · تجديدٌ بترحيل التأمين وتسويةٌ بردّه من عضوين: التأمين يُحسب مرةً على جهاز المالك · %s', async (_label, order) => {
  const r = new MemoryRemote();
  const owner = memDb();
  enableSync(owner, OWNER);
  ownerCashIn(owner, { amountHalalas: 500_000, date: '2026-01-01' });
  const u = addUnit(owner, addProperty(owner, { name: 'عقار مصطنع' }), { unit_no: 'CS-1' });
  const x = confirmContract(owner, contractInput(u, { tenant: 'مستأجر مصطنع', idNumber: '1000001281', phone: '0500001281',
    valueHalalas: 1_000_000, start: '2026-01-01', end: '2026-10-31', depositHalalas: 100_000 }));
  await syncOnce(owner, r, dev(owner));
  const R = await joinMember(r, { owner: false, uid: 'M-R12-REN', perms: { contracts: 3 }, allProps: true, props: [] } as Access);
  const S = await joinMember(r, { owner: false, uid: 'M-R12-SET', perms: { deposits: 3 }, allProps: true, props: [] } as Access);

  // كلٌّ على جهازه قبل أن يرى عمل الآخر (كلاهما يجيزه التطبيق عنده)
  const y = renewContract(R.db, x, { start: '2026-11-01', end: '2027-10-31', valueHalalas: 1_000_000, cycle: 'شهرية', carryDeposit: true,
    extraDepositHalalas: 0, services: '', furnished: 'غير مؤثثة', ejarNo: '', note: '' });
  saveDepositSettlement(S.db, x, { date: '2026-11-01', deductionHalalas: 0, deductionReason: '', refundHalalas: 100_000, notes: '' });

  await R.sync();
  if (order === 'owner-between') { await syncOnce(owner, r, dev(owner)); await syncOnce(owner, r, dev(owner)); }
  await S.sync();
  await syncOnce(owner, r, dev(owner));
  await syncOnce(owner, r, dev(owner));

  const yDeposit = Number(owner.get<{ d: number }>(`SELECT deposit_halalas AS d FROM contracts WHERE id = ?`, [y])!.d);
  const out = { xLiability: liability(owner, x), counted: refunded(owner, x) + liability(owner, y), yRowMatchesLedger: yDeposit === liability(owner, y) };
  // eslint-disable-next-line no-console
  console.log('A1-1 ترحيل وتسوية ·', order, JSON.stringify({ ...out, yDeposit, yLiability: liability(owner, y), refunded: refunded(owner, x) }));
  // التزام العقد القديم صفر (اليوم في (أ): −١٠٠٬٠٠٠)
  expect(out.xLiability).toBe(0);
  // المردود من القديم مع المحتجز للجديد = المقبوض مرة واحدة ١٠٠٬٠٠٠ (اليوم في (أ): ٢٠٠٬٠٠٠)
  expect(out.counted).toBe(100_000);
  // وتأمين الجديد في صفّه بقدر ما يحتجزه له الدفتر، فلا تعرض تسويته ردّ ما لم يُقبض (اليوم في (ب): ١٠٠٬٠٠٠ في الصف وصفر في الدفتر)
  expect(out.yRowMatchesLedger).toBe(true);
  expect(integrityChecks(owner).find((c) => c.name === DEPOSIT_CHECK)?.ok).toBe(true);
  owner.close(); R.db.close(); S.db.close();
});
