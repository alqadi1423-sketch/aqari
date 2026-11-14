/**
 * المتحقق المستقل على إصلاح A1-2 (المراجعة الشاملة 2026-11-13) · الاستعادة و«القيد المرحّل لا يُحذف» (keepPosted.ts) · بيانات مصطنعة.
 *
 * العيب ١ · استعادة نسخةٍ أُخذت قبل التسوية: قيد سداد القسط من التأمين (deposit_rent) يُضمّ وتُحمل معه دفعته «من التأمين» (keepPosted
 *   يحمل كل دفعةٍ عقدها وقسطها في النسخة)، وصفّ التسوية لا يُحمل · فلا يُدرج القيد في المراجعة، والعقد غير مُسوّى في النسخة فتأمينه
 *   ١٬٠٠٠ محتجز، والتزام 2400 صفرٌ بعد سداد مارس منه: فحص «تأمينات المستأجرين = التأمينات المحتجزة» أحمر 0.00 / 1,000.00.
 *   والضابط: التسوية نفسها أضراراً كلها (deposit_deduct) تُضمّ وتُدرج في المراجعة «مستنده في النسخة بحاله قبل هذا القيد» فيخرج أثرها
 *   من المطابقة والفحوص خضراء · فالعيب في المصدر الجديد وحده.
 *   السلوك الصحيح: بعد الاستعادة لا فحص أحمر من قيدٍ مضموم: قيد deposit_rent الذي لم يُحمل صفّ تسويته يُعامل كقيد الخصم (يُدرج في
 *   المراجعة فيخرج من المطابقة) أو يُحمل معه ما يجعل الدفتر والمستندات متطابقين.
 *
 * العيب ٢ · استعادة نسخةٍ أُخذت قبل العقد نفسه: قيد deposit_rent المضموم يتيمٌ (عقده ليس في البيانات) فيُدرج في المراجعة، لكن
 *   entrySourceAction يعيد له { kind: 'document' } قبل فحص اليتيم (sourceCancel.ts: فرع DEPOSIT_RENT_SRC قبل isOrphanEntry)، ولا
 *   مستند يُفتح (entrySourceRoute يعيد null لعقدٍ غائب) · فلا «عكس القيد» له، وقيود التحصيل اليتيمة في الاستعادة نفسها لها «عكس
 *   القيد» · خلافاً للقاعدة الموثّقة في رأس sourceCancel.ts: «قيدٌ غاب مستنده ← «عكس القيد»: لا مستند يُلغى منه».
 *   السلوك الصحيح: قيد deposit_rent اليتيم يُعكس من الدفتر كأخواته (op «عكس القيد»).
 *   TZ=Asia/Riyadh npx jest tests/review11.A1_2.restoreKept.test.ts
 */
import * as path from 'node:path';
import { tempDir, rmrf } from './helpers/testDb';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { makeBackupEnv, type TestBackupEnv } from './helpers/backupEnv';
import { confirmContract, saveDepositSettlement, recordRentPayment } from '@/domain/contracts/service';
import { createBackup } from '@/domain/backup/create';
import { prepareRestore, commitRestore } from '@/domain/backup/restore';
import { integrityChecks } from '@/domain/accounting/integrity';
import { entrySourceAction } from '@/domain/accounting/sourceCancel';
import type { DB } from '@/db/adapter';

const dirs: string[] = [];
const newEnv = () => { const d = tempDir('aq-a12-keep-'); dirs.push(d); return makeBackupEnv(d); };
afterAll(() => { for (const d of dirs) rmrf(d); });

async function backup(env: TestBackupEnv): Promise<string> {
  const out = path.join(env.root, 'b-' + Math.random().toString(36).slice(2) + '.aqbk');
  await createBackup(env, out);
  return out;
}

/** عقد ثلاثة أشهر ٣٬٠٠٠ بأقساط ١٬٠٠٠ وتأمين ١٬٠٠٠ لدى المكتب · سُدّد يناير وفبراير نقداً */
function lease(db: DB, n: number) {
  const u = addUnit(db, addProperty(db, { name: 'عقار استعادة مصطنع ' + n }), { unit_no: 'RK-' + n });
  const cid = confirmContract(db, contractInput(u, { tenant: 'مستأجر استعادة مصطنع ' + n, idNumber: '10000066' + String(n).padStart(2, '0'),
    phone: '05000066' + String(n).padStart(2, '0'), valueHalalas: 300000, cycle: 'شهرية', start: '2026-01-01', end: '2026-03-31', depositHalalas: 100000 }));
  const insts = db.all<{ id: string; due_date: string }>(`SELECT id, due_date FROM contract_installments WHERE contract_id = ? ORDER BY due_date`, [cid]);
  for (const i of insts.slice(0, 2)) {
    recordRentPayment(db, cid, { installmentId: i.id, period: '', date: i.due_date,
      lines: [{ method: 'cash', amountHalalas: 100000 }], discountHalalas: 0, notes: '' });
  }
  return cid;
}
/** التسوية: التأمين كله مقابل مارس غير المدفوع */
const settleArrears = (db: DB, cid: string) => saveDepositSettlement(db, cid, { date: '2026-04-05', deductionHalalas: 100000,
  deductionReason: 'إيجار مارس غير المدفوع', refundHalalas: 0, notes: '', arrearsHalalas: 100000 });

test('A1-2 · استعادة نسخةٍ قبل التسوية: قيد السداد من التأمين المضموم لا يُحمّر فحص التأمينات (كقيد الخصم)', async () => {
  const env = newEnv();
  const cid = lease(env.db, 1);
  const archive = await backup(env);
  settleArrears(env.db, cid);
  expect(integrityChecks(env.db).filter((c) => !c.ok).map((c) => c.name)).toEqual([]);

  const plan = await prepareRestore(env, archive);
  const kept = plan.kept.find((k) => env.db.get(`SELECT 1 FROM journal_entries WHERE id = ? AND src_type = 'deposit_rent'`, [k.id]));
  expect(kept).toBeDefined();
  const db = (await commitRestore(env, plan)).db;
  // اليوم: «تأمينات المستأجرين = التأمينات المحتجزة (غير المُسوَّاة)» 0.00 / 1,000.00 · والقيد ليس في المراجعة (review = null)
  expect(integrityChecks(db).filter((c) => !c.ok).map((c) => c.name + ' (' + c.value + ')')).toEqual([]);
  env.closeLive();
});

test('A1-2 · قيد السداد من التأمين اليتيم بعد الاستعادة يُعكس من الدفتر «عكس القيد» كقيود التحصيل اليتيمة', async () => {
  const env = newEnv();
  addProperty(env.db, { name: 'عقار قبل العقد مصطنع' });
  const archive = await backup(env);
  const cid = lease(env.db, 2);
  settleArrears(env.db, cid);

  const db = (await commitRestore(env, await prepareRestore(env, archive))).db;
  expect(db.get(`SELECT 1 FROM contracts WHERE id = ?`, [cid])).toBeUndefined();
  const rent = db.get<{ id: string }>(`SELECT id FROM journal_entries WHERE src_type = 'rent' AND reversed_by IS NULL LIMIT 1`)!;
  const dep = db.get<{ id: string }>(`SELECT id FROM journal_entries WHERE src_type = 'deposit_rent' AND src_id = ?`, [cid])!;
  // أخته من الاستعادة نفسها: قيد تحصيلٍ يتيم له «عكس القيد»
  const rentAction = entrySourceAction(db, rent.id);
  expect(rentAction?.kind === 'op' ? rentAction.label : rentAction).toBe('عكس القيد');
  // وقيد السداد من التأمين اليتيم كذلك (اليوم: { kind: 'document' } ولا مستند يُفتح)
  const depAction = entrySourceAction(db, dep.id);
  expect(depAction?.kind === 'op' ? depAction.label : depAction).toBe('عكس القيد');
  env.closeLive();
});
