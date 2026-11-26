/**
 * المراجع المعاكس الثالث على تعارض R12-DEP-2 مع R12-BAK-2 · البند ٤ (خطر في الواجهة) · ورقة «تفاصيل التصرف بالتأمين» بعد استعادةٍ ضمّت تعديل
 * التسوية · بيانات مصطنعة، والأرقام بالهللة محسوبة باليد.
 *
 * الورقة (app/(tabs)/contracts.tsx: SettlementSheet) تملأ «منها مقابل أقساطٍ متأخرة» للتسوية القائمة من depositArrearsPaid، وتعرض الخصم
 *   من صفّ التسوية · وما في الخانة يُحفظ كما هو (arrearsH = toHalalas(الخانة) ما دام في الخانة نص).
 * السيناريو: (أ) ستة أقساط ١٬٠٠٠ وتأمين ١٬٠٠٠، سُدّد خمسة · التسوية S1: التأمين كله مقابل ديسمبر (P1 وقيدها E1) · مزامنة · نسخة ·
 *   التعديل S2: ردّ التأمين كله (العاكس R1 يلغي P1، وقيد الردّ F2) · مزامنة · استعادة النسخة واعتمادها: صفّ التسوية S1، وإلغاء P1 محمولٌ
 *   مع عاكسه R1، وR1 وF2 في المراجعة («تسويته في النسخة بحالها قبل تعديلها») · فيفتح المالك الورقة ليحفظ تسوية النسخة.
 * قبل الإصلاح: الخانة ٠ (لا دفعة «من التأمين» حيّة) والخصم ١٬٠٠٠ بسببه «إيجار ديسمبر» · فحفظ الورقة كما تظهر يقيد ١٬٠٠٠ في 4300 أضراراً
 *   ويبقى ديسمبر مستحقاً، عكس ما تقوله S1 وقرار المالك س١ (خصم الإيجار المتأخر من التأمين يسدّد القسط).
 * الصحيح: الخانة ما سدّدته S1 من الأقساط: P1 ١٠٠٬٠٠٠ (إلغاؤها من تعديلٍ يُراجَع، ليس في البيانات) · وحفظها كما تظهر يسدّد ديسمبر:
 *   4200 = ٥٠٠٬٠٠٠ + E1 − R1 + E3 = ٦٠٠٬٠٠٠ · 4300 = ٠ · 1100 = ٥٠٠٬٠٠٠ + ١٠٠٬٠٠٠ − F2 + عكسه = ٦٠٠٬٠٠٠ · 2400 = ٠ · والفحوص خضراء
 *   والمراجعة فارغة.
 * والضابط: تسويةٌ قائمة خصمها أضرارٌ وديسمبر مستحق (لا استعادة) تبقى خانتها ٠، فلا يُقلب خصم الأضرار إيجاراً.
 *   TZ=Asia/Riyadh npx jest tests/review12.r3.sheetArrearsAfterRestore.test.ts
 */
import * as path from 'node:path';
import { tempDir, rmrf } from './helpers/testDb';
import { MemoryRemote } from './helpers/memoryRemote';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { makeBackupEnv, type TestBackupEnv } from './helpers/backupEnv';
import { confirmContract, saveDepositSettlement, recordRentPayment, depositArrearsPaid, depositArrearsDue } from '@/domain/contracts/service';
import { createBackup } from '@/domain/backup/create';
import { prepareRestore, commitRestore } from '@/domain/backup/restore';
import { integrityChecks } from '@/domain/accounting/integrity';
import { accountBalance } from '@/domain/accounting/ledger';
import { keptForReview } from '@/domain/accounting/orphans';
import { enableSync, syncOnce, readCloud, planFromSnapshot, adoptAsCloudTruth } from '@/sync/engine';
import { getMeta } from '@/repos/settings';
import type { DB } from '@/db/adapter';

const UID = 'user-r12-r3-sheet';
const dirs: string[] = [];
const newEnv = () => { const d = tempDir('aq-r12-r3-sheet-'); dirs.push(d); return makeBackupEnv(d); };
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
const DAMAGES = { deductionHalalas: 100000, deductionReason: 'أضرار في الوحدة', refundHalalas: 0, notes: '', arrearsHalalas: 0 };
const view = (db: DB, dec: string) => ({
  c1100: accountBalance(db, '1100'), c2400: accountBalance(db, '2400'), c4200: accountBalance(db, '4200'), c4300: accountBalance(db, '4300'),
  dec: db.get(`SELECT paid_halalas AS p, status AS s FROM contract_installments WHERE id = ?`, [dec]),
  red: integrityChecks(db).filter((c) => !c.ok).map((c) => c.name + ' (' + c.value + ')'),
  review: keptForReview(db).length,
});

/** (أ) ستة أقساط ١٬٠٠٠ وتأمين ١٬٠٠٠ نقداً، سُدّد خمسة نقداً · ديسمبر مستحق */
function lease(db: DB, n: number) {
  const u = addUnit(db, addProperty(db, { name: 'عقار ورقة التسوية المصطنع ' + n }), { unit_no: 'R3S-' + n });
  const a = confirmContract(db, contractInput(u, { tenant: 'مستأجر ورقة التسوية المصطنع ' + n, idNumber: '100001330' + n, phone: '050001330' + n,
    start: '2025-07-01', end: '2025-12-31', valueHalalas: 600000, depositHalalas: 100000 }));
  for (const i of insts(db, a).slice(0, 5)) {
    recordRentPayment(db, a, { installmentId: i.id, period: '', date: i.due_date, lines: [{ method: 'cash', amountHalalas: 100000 }], discountHalalas: 0, notes: '' });
  }
  return { a, dec: insts(db, a)[5].id, date: '2026-01-05' };
}

/** ما تحفظه الورقة إن حُفظت كما تظهر: الخصم والسبب والردّ من صفّ التسوية، والخانة من depositArrearsPaid ما دام في الخانة نص */
function sheetAsShown(db: DB, a: string) {
  const row = db.get<{ date: string; deduction_halalas: number; deduction_reason: string; refund_halalas: number }>(
    `SELECT date, deduction_halalas, deduction_reason, refund_halalas FROM deposit_settlements WHERE contract_id = ?`, [a])!;
  const deduction = Number(row.deduction_halalas);
  const prefill = depositArrearsPaid(db, a);
  const due = depositArrearsDue(db, a, row.date);
  return { date: row.date, deductionHalalas: deduction, deductionReason: row.deduction_reason, refundHalalas: Number(row.refund_halalas),
    notes: '', arrearsHalalas: due > 0 && deduction > 0 ? prefill : 0 };
}

test('بعد استعادةٍ ضمّت تعديل التسوية: خانة «مقابل أقساطٍ متأخرة» ما سدّدته تسوية النسخة، وحفظ الورقة كما تظهر يسدّد ديسمبر لا أضراراً', async () => {
  const r = new MemoryRemote();
  const env = newEnv();
  enableSync(env.db, UID);
  const db0 = env.db;
  const { a, dec, date } = lease(db0, 1);
  saveDepositSettlement(db0, a, { date, ...ARREARS });
  await sync(db0, r);
  const archive = await backup(env);
  saveDepositSettlement(db0, a, { date, ...REFUND });
  await sync(db0, r);

  const snap = await readCloud(r);
  const db = (await commitRestore(env, await prepareRestore(env, archive, undefined, { cloud: async () => snap.docs }))).db;
  adoptAsCloudTruth(db, UID, planFromSnapshot(db, snap));
  for (let i = 0; i < 2; i++) await sync(db, r);
  // بعد الاستعادة: 1100 = ٥٠٠٬٠٠٠ + ١٠٠٬٠٠٠ − F2 = ٥٠٠٬٠٠٠ · 4200 = ٥٠٠٬٠٠٠ + E1 − R1 = ٥٠٠٬٠٠٠ · R1 وF2 في المراجعة
  expect(view(db, dec)).toEqual({ c1100: 500000, c2400: 0, c4200: 500000, c4300: 0, dec: { p: 0, s: 'مستحقة' }, red: [], review: 2 });

  // الورقة: الخصم ١٬٠٠٠ «إيجار ديسمبر» ومنه مقابل ديسمبر ١٬٠٠٠ (P1 من S1، وإلغاؤها من التعديل المراجَع) · اليوم: ٠
  const shown = sheetAsShown(db, a);
  expect(shown).toEqual({ date, ...ARREARS });
  saveDepositSettlement(db, a, shown);
  // 1100 = ٥٠٠٬٠٠٠ + عكس F2 ١٠٠٬٠٠٠ = ٦٠٠٬٠٠٠ · 4200 = ٥٠٠٬٠٠٠ + E3 ١٠٠٬٠٠٠ = ٦٠٠٬٠٠٠ · 4300 = ٠ · ديسمبر مدفوع
  expect(view(db, dec)).toEqual({ c1100: 600000, c2400: 0, c4200: 600000, c4300: 0, dec: { p: 100000, s: 'مدفوعة' }, red: [], review: 0 });
  env.closeLive();
});

test('الضابط: تسويةٌ قائمة خصمها أضرارٌ وديسمبر مستحق تبقى خانتها ٠ ويُحفظ خصمها أضراراً كما كان', () => {
  const env = newEnv();
  const db = env.db;
  const { a, dec, date } = lease(db, 2);
  saveDepositSettlement(db, a, { date, ...DAMAGES });
  // depositArrearsDue = ديسمبر ١٠٠٬٠٠٠ والخصم ١٠٠٬٠٠٠ فالخانة ظاهرة، وفيها ما سدّدته التسوية القائمة: ٠
  expect(sheetAsShown(db, a)).toEqual({ date, ...DAMAGES });
  saveDepositSettlement(db, a, sheetAsShown(db, a));
  // 4300 = ١٠٠٬٠٠٠ − عكسه + ١٠٠٬٠٠٠ = ١٠٠٬٠٠٠ · 4200 = ٥٠٠٬٠٠٠ · 1100 = ٥٠٠٬٠٠٠ + ١٠٠٬٠٠٠ · ديسمبر مستحق
  expect(view(db, dec)).toEqual({ c1100: 600000, c2400: 0, c4200: 500000, c4300: 100000, dec: { p: 0, s: 'مستحقة' }, red: [], review: 0 });
  env.closeLive();
});
