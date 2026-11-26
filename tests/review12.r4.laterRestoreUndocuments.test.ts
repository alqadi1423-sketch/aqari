/**
 * المراجع المعاكس الرابع على R12-BAK-2 (dcab693: «صار له مستند» مشتقٌّ من حال الدفتر الآن: documentedSql في orphans.ts) · بيانات
 * مصطنعة، والأرقام بالهللة محسوبة باليد.
 *
 * الاشتقاق يقرأ «لعقده قيد تسويةٍ حيّ غير معلَّم» من الدفتر الحالي، فليس ثابتاً: ما وثّقه حفظٌ بعد الاستعادة يعود غير موثَّق متى عُكس
 *   قيد ذلك الحفظ أو عُلِّم · واستعادة نسخةٍ أُخذت بعد ذلك الحفظ تفعل الاثنين بتعديلٍ لاحقٍ لها: تعكس قيده بعاكسٍ مضموم معلَّم وتعلّم قيده
 *   الجديد · فتعود علامة R1 القديمة (من الاستعادة الأولى) خارج المطابقة وحدها وأصله E1 داخلها.
 *   (في 31bb43e سطر «صار له مستند» لـ R1 وF2 محفوظٌ في النسخة B2 نفسها فيبقى · واشتقاقه في dcab693 ينقلب.)
 * السيناريو: ستة أقساط ١٬٠٠٠ سُدّد خمسة نقداً، وتأمين ١٬٠٠٠ · التسوية S1: التأمين كله مقابل ديسمبر (P1 وقيدها E1) · مزامنة · نسخة B1 ·
 *   التعديل S2: ردّ التأمين كله (R1 يعكس E1، وF2) · مزامنة · استعادة B1 واعتمادها (R1 وF2 معلَّمان) · يحفظ المالك تسوية النسخة كما تظهر
 *   (التأمين مقابل ديسمبر: F2′ يعكس F2، وP3 وقيدها E3) فيصير R1 وF2 «لهما مستند» وتخضرّ الفحوص · مزامنة · نسخة B2 ·
 *   التعديل S4: ردّ التأمين كله (R3 يعكس E3 ويُلغي P3، وF4) · مزامنة · ثم يستعيد المالك B2 ويعتمدها.
 * بعد الاستعادة الثانية: حال B2 ومعها R3 وF4 مضمومان معلَّمان (تعديلٌ بعد النسخة يُراجَع كله)، وإلغاء P3 محمولٌ مع R3:
 *   2400 (دائن موجب) = ١٠٠٬٠٠٠ − E1 + R1 − F2 + F2′ − E3 + R3 − F4 = ٠ · 4200 = ٥٠٠٬٠٠٠ + E1 − R1 + E3 − R3 = ٥٠٠٬٠٠٠ ·
 *   1100 = ٥٠٠٬٠٠٠ + ١٠٠٬٠٠٠ − F2 + F2′ − F4 = ٥٠٠٬٠٠٠ · صفّ التسوية S1 (من B2).
 *   الصحيح: خارج المطابقة R3 وF4 وحدهما (−١٠٠٬٠٠٠ + ١٠٠٬٠٠٠ = ٠ مديناً)، والمطابقة ٠ = المحتجز ٠ (S1 سُوّي) فالفحوص خضراء، وفي المراجعة
 *   R3 وF4 · وخانة «منها مقابل أقساطٍ متأخرة» ما سدّدته S1 في B2: P3 ١٠٠٬٠٠٠ (لا P1 أيضاً: R1 له مستند في B2).
 * اليوم: R1 وF2 (وعاكسه F2′) يعودان خارج المطابقة: −١ + ١ − ١ − ١ + ١ = −١٠٠٬٠٠٠ · فالمطابقة −١٬٠٠٠ / ٠ ويحمرّ فحص التأمينات، وR1
 *   في المراجعة ثانيةً، والخانة ٢٠٠٬٠٠٠ (P1 وP3) فوق الخصم ١٠٠٬٠٠٠ فتُظهر الورقة «أكبر من الخصم» ولا تُحفظ كما تظهر.
 *   TZ=Asia/Riyadh npx jest tests/review12.r4.laterRestoreUndocuments.test.ts
 */
import * as path from 'node:path';
import { tempDir, rmrf } from './helpers/testDb';
import { MemoryRemote } from './helpers/memoryRemote';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { makeBackupEnv, type TestBackupEnv } from './helpers/backupEnv';
import { confirmContract, saveDepositSettlement, recordRentPayment, depositArrearsPaid } from '@/domain/contracts/service';
import { createBackup } from '@/domain/backup/create';
import { prepareRestore, commitRestore } from '@/domain/backup/restore';
import { integrityChecks } from '@/domain/accounting/integrity';
import { accountBalance } from '@/domain/accounting/ledger';
import { keptForReview } from '@/domain/accounting/orphans';
import { enableSync, syncOnce, readCloud, planFromSnapshot, adoptAsCloudTruth } from '@/sync/engine';
import { getMeta } from '@/repos/settings';
import type { DB } from '@/db/adapter';

const UID = 'user-r12-r4-later';
const dirs: string[] = [];
const newEnv = () => { const d = tempDir('aq-r12-r4-later-'); dirs.push(d); return makeBackupEnv(d); };
afterAll(() => { for (const d of dirs) rmrf(d); });
async function backup(env: TestBackupEnv): Promise<string> {
  const out = path.join(env.root, 'b-' + Math.random().toString(36).slice(2) + '.aqbk');
  await createBackup(env, out);
  return out;
}
const insts = (db: DB, c: string) => db.all<{ id: string; due_date: string }>(
  `SELECT id, due_date FROM contract_installments WHERE contract_id = ? ORDER BY due_date`, [c]);
const sync = (db: DB, r: MemoryRemote) => syncOnce(db, r, getMeta(db, 'device_id')!);
const ARREARS = { deductionHalalas: 100000, deductionReason: 'إيجار ديسمبر غير المدفوع', refundHalalas: 0, notes: '', arrearsHalalas: 100000 };
const REFUND = { deductionHalalas: 0, deductionReason: '', refundHalalas: 100000, notes: '', arrearsHalalas: 0 };
const view = (db: DB, a: string, dec: string) => ({
  c1100: accountBalance(db, '1100'), c2400: accountBalance(db, '2400'), c4200: accountBalance(db, '4200'),
  dec: db.get(`SELECT paid_halalas AS p, status AS s FROM contract_installments WHERE id = ?`, [dec]),
  red: integrityChecks(db).filter((c) => !c.ok).map((c) => c.name + ' (' + c.value + ')'),
  review: keptForReview(db).map((k) => db.get<{ t: string }>(`SELECT src_type AS t FROM journal_entries WHERE id = ?`, [k.id])!.t).sort(),
  prefill: depositArrearsPaid(db, a),
});
async function restore(env: TestBackupEnv, r: MemoryRemote, archive: string): Promise<DB> {
  const snap = await readCloud(r);
  const db = (await commitRestore(env, await prepareRestore(env, archive, undefined, { cloud: async () => snap.docs }))).db;
  adoptAsCloudTruth(db, UID, planFromSnapshot(db, snap));
  for (let i = 0; i < 2; i++) await sync(db, r);
  return db;
}

test('ما وثّقه حفظ التسوية بعد استعادةٍ يبقى موثَّقاً حين تُستعاد نسخةٌ أُخذت بعد ذلك الحفظ ويُراجَع تعديلٌ لاحقٌ لها', async () => {
  const r = new MemoryRemote();
  const env = newEnv();
  enableSync(env.db, UID);
  const db0 = env.db;
  const u = addUnit(db0, addProperty(db0, { name: 'عقار الاستعادة اللاحقة المصطنع' }), { unit_no: 'R4L-1' });
  const a = confirmContract(db0, contractInput(u, { tenant: 'مستأجر الاستعادة اللاحقة المصطنع', idNumber: '1000014301', phone: '0500014301',
    start: '2025-07-01', end: '2025-12-31', valueHalalas: 600000, depositHalalas: 100000 }));
  for (const i of insts(db0, a).slice(0, 5)) {
    recordRentPayment(db0, a, { installmentId: i.id, period: '', date: i.due_date, lines: [{ method: 'cash', amountHalalas: 100000 }], discountHalalas: 0, notes: '' });
  }
  const dec = insts(db0, a)[5].id;
  const date = '2026-01-05';
  saveDepositSettlement(db0, a, { date, ...ARREARS });
  await sync(db0, r);
  const b1 = await backup(env);
  saveDepositSettlement(db0, a, { date, ...REFUND });
  await sync(db0, r);

  // الاستعادة الأولى (B1): R1 وF2 معلَّمان · ثم يحفظ المالك تسوية النسخة: F2′ وE3 (P3) · R1 وF2 لهما مستند
  const db1 = await restore(env, r, b1);
  expect(view(db1, a, dec)).toMatchObject({ red: [], review: ['deposit_refund', 'deposit_rent_rev'], prefill: 100000 });
  saveDepositSettlement(db1, a, { date, ...ARREARS });
  for (let i = 0; i < 2; i++) await sync(db1, r);
  // 1100 = ٥٠٠٬٠٠٠ + ١٠٠٬٠٠٠ − F2 + F2′ = ٦٠٠٬٠٠٠ · 4200 = ٥٠٠٬٠٠٠ + E1 − R1 + E3 = ٦٠٠٬٠٠٠ · ديسمبر مدفوع بـ P3
  expect(view(db1, a, dec)).toEqual({ c1100: 600000, c2400: 0, c4200: 600000, dec: { p: 100000, s: 'مدفوعة' }, red: [], review: [], prefill: 100000 });
  const b2 = await backup(env);
  saveDepositSettlement(db1, a, { date, ...REFUND });
  await sync(db1, r);

  // الاستعادة الثانية (B2): حال B2 ومعها R3 وF4 معلَّمان وإلغاء P3 محمول · ديسمبر مستحق
  // 1100 = ٦٠٠٬٠٠٠ − F4 = ٥٠٠٬٠٠٠ · 4200 = ٦٠٠٬٠٠٠ − R3 = ٥٠٠٬٠٠٠ · 2400 = ٠ · خارج المطابقة R3 + F4 = ٠ · المطابقة ٠ = ٠
  // والخانة P3 ١٠٠٬٠٠٠ (ما سدّدته S1 في B2)
  // اليوم: «تأمينات المستأجرين … (-1,000.00 / 0.00 · خارجها قيود بلا مستند 1,000.00)» وR1 في المراجعة والخانة ٢٠٠٬٠٠٠
  const db2 = await restore(env, r, b2);
  expect(view(db2, a, dec)).toEqual({ c1100: 500000, c2400: 0, c4200: 500000, dec: { p: 0, s: 'مستحقة' }, red: [],
    review: ['deposit_refund', 'deposit_rent_rev'], prefill: 100000 });
  env.closeLive();
});
