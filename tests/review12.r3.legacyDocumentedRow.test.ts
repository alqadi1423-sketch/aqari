/**
 * إصلاح المراجع المعاكس الثالث على تعارض R12-DEP-2 مع R12-BAK-2 · «صار له مستند» مشتقٌّ لا مخزَّن (orphans.ts: documentedSql) · ضابط
 * لبياناتٍ كتبها الإصدار السابق (cd9653c) سطراً في سجل العمليات بنوع «قيد بعد الاستعادة صار له مستند» · بيانات مصطنعة، والأرقام بالهللة
 * محسوبة باليد.
 * السيناريو: (أ) ستة أقساط ١٬٠٠٠ وتأمين ١٬٠٠٠، سُدّد خمسة · التسوية S1: التأمين كله مقابل ديسمبر (P1 وقيدها E1) · نسخة · التعديل S2: ردّ
 *   التأمين كله (العاكس R1 وقيد الردّ F2) · استعادة النسخة من الجهاز: R1 وF2 في المراجعة والفحوص خضراء ·
 *   2400 (مدين موجب) = −١٠٠٬٠٠٠ قبض + E1 ١٠٠٬٠٠٠ − R1 ١٠٠٬٠٠٠ + F2 ١٠٠٬٠٠٠ = ٠ · والمعلَّم R1 + F2 = ٠ · فالمطابقة ٠ = المحتجز ٠ ·
 *   ثم يصل سطرٌ قديم «صار له مستند» لـ R1 (من خطٍّ زمنيٍّ آخر، يضمّه الاعتماد من السحابة).
 * الصحيح: السطر القديم لا أثر له · الفحوص خضراء وR1 وF2 في المراجعة حتى تُحفظ التسوية هنا، ثم تفرغ المراجعة.
 *   TZ=Asia/Riyadh npx jest tests/review12.r3.legacyDocumentedRow.test.ts
 */
import * as path from 'node:path';
import { tempDir, rmrf } from './helpers/testDb';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { makeBackupEnv, type TestBackupEnv } from './helpers/backupEnv';
import { confirmContract, saveDepositSettlement, recordRentPayment } from '@/domain/contracts/service';
import { createBackup } from '@/domain/backup/create';
import { prepareRestore, commitRestore } from '@/domain/backup/restore';
import { integrityChecks } from '@/domain/accounting/integrity';
import { accountBalance } from '@/domain/accounting/ledger';
import { keptForReview } from '@/domain/accounting/orphans';
import { logAudit } from '@/domain/audit';
import type { DB } from '@/db/adapter';

const dirs: string[] = [];
const newEnv = () => { const d = tempDir('aq-r12-r3-legacy-'); dirs.push(d); return makeBackupEnv(d); };
afterAll(() => { for (const d of dirs) rmrf(d); });
async function backup(env: TestBackupEnv): Promise<string> {
  const out = path.join(env.root, 'b-' + Math.random().toString(36).slice(2) + '.aqbk');
  await createBackup(env, out);
  return out;
}
const insts = (db: DB, c: string) => db.all<{ id: string; due_date: string }>(
  `SELECT id, due_date FROM contract_installments WHERE contract_id = ? ORDER BY due_date`, [c]);
const ARREARS = { deductionHalalas: 100000, deductionReason: 'إيجار ديسمبر غير المدفوع', refundHalalas: 0, notes: '', arrearsHalalas: 100000 };
const REFUND = { deductionHalalas: 0, deductionReason: '', refundHalalas: 100000, notes: '', arrearsHalalas: 0 };
const view = (db: DB) => ({
  c2400: accountBalance(db, '2400'),
  red: integrityChecks(db).filter((c) => !c.ok).map((c) => c.name + ' (' + c.value + ')'),
  review: keptForReview(db).map((k) => db.get<{ t: string }>(`SELECT src_type AS t FROM journal_entries WHERE id = ?`, [k.id])!.t).sort(),
});

test('سطر «صار له مستند» من الإصدار السابق لا يُخرج عاكساً معلَّماً من المراجعة ولا يحمّر فحص التأمينات', async () => {
  const env = newEnv();
  const db0 = env.db;
  const u = addUnit(db0, addProperty(db0, { name: 'عقار السطر القديم المصطنع' }), { unit_no: 'R3L-1' });
  const a = confirmContract(db0, contractInput(u, { tenant: 'مستأجر السطر القديم المصطنع', idNumber: '1000013401', phone: '0500013401',
    start: '2025-07-01', end: '2025-12-31', valueHalalas: 600000, depositHalalas: 100000 }));
  for (const i of insts(db0, a).slice(0, 5)) {
    recordRentPayment(db0, a, { installmentId: i.id, period: '', date: i.due_date, lines: [{ method: 'cash', amountHalalas: 100000 }], discountHalalas: 0, notes: '' });
  }
  const date = '2026-01-05';
  saveDepositSettlement(db0, a, { date, ...ARREARS });
  const archive = await backup(env);
  saveDepositSettlement(db0, a, { date, ...REFUND });
  const db = (await commitRestore(env, await prepareRestore(env, archive))).db;
  const restored = { c2400: 0, red: [], review: ['deposit_refund', 'deposit_rent_rev'] };
  expect(view(db)).toEqual(restored);

  const r1 = db.get<{ id: string; no: string }>(`SELECT id, no FROM journal_entries WHERE src_type = 'deposit_rent_rev'`)!;
  logAudit(db, 'النسخ الاحتياطي', 'update', 'قيد بعد الاستعادة صار له مستند', r1.no, undefined, { id: r1.id, no: r1.no, how: 'حُفظت تسويته' });
  expect(view(db)).toEqual(restored);

  // حفظ التسوية هنا يعيد ما ضُمّ داخل المطابقة: 2400 = ٠ + عكس F2 −١٠٠٬٠٠٠ + F3 ١٠٠٬٠٠٠ = ٠
  saveDepositSettlement(db, a, { date, ...REFUND });
  expect(view(db)).toEqual({ c2400: 0, red: [], review: [] });
  env.closeLive();
});
