/**
 * المراجع المعاكس الثالث على تعارض R12-DEP-2 مع R12-BAK-2 · KEPT_DOCUMENTED_ENTITY (orphans.ts) وdocumentKeptSettlement (service.ts) ·
 * بيانات مصطنعة، والأرقام بالهللة محسوبة باليد.
 *
 * «صار له مستند» سطرٌ في سجل العمليات بمعرّف القيد وحده، لا بالتسوية التي وثّقته · وسجل العمليات يُزامَن ويُضمّ في الاعتماد بعد الاستعادة
 *   (adoptAsCloudTruth: «سطور سجل العمليات تُضمّ · إضافةٌ لا تغيّر رقماً»).
 * السيناريو: (أ) ستة أقساط ١٬٠٠٠ وتأمين ١٬٠٠٠، سُدّد خمسة · التسوية S1: التأمين كله مقابل ديسمبر (P1 وقيدها E1) · مزامنة · نسخة B1 ·
 *   التعديل S2: ردّ التأمين كله (العاكس R1 وقيد الردّ F2) · مزامنة · استعادة B1 واعتمادها (R1 وF2 في المراجعة) · يحفظ المالك الردّ
 *   ثانيةً من شاشة العقد (F2 يُعكس بـ F2′ ويُرحَّل F3، ويُكتب «صار له مستند» لـ R1 وF2) · مزامنة · ثم يستعيد B1 مرةً ثانية ويعتمدها.
 * بعد الاستعادة الثانية وقبل الاعتماد: صفّ التسوية S1، وR1 وF3 في المراجعة، والفحوص خضراء:
 *   2400 (مدين موجب) = −١٠٠٬٠٠٠ قبض + E1 ١٠٠٬٠٠٠ − R1 ١٠٠٬٠٠٠ + F2 ١٠٠٬٠٠٠ − F2′ ١٠٠٬٠٠٠ + F3 ١٠٠٬٠٠٠ = ٠ ·
 *   والمعلَّم R1 + F3 = −١٠٠٬٠٠٠ + ١٠٠٬٠٠٠ = ٠ · فالمطابقة ٠ = المحتجز ٠ (S1 سُوّي).
 * بعد الاعتماد: يُضمّ من السحابة «صار له مستند» لـ R1 (تسوية S2′ التي ليست في هذه البيانات) فيدخل R1 المطابقة وحده: المعلَّم F3 وحده
 *   (+١٠٠٬٠٠٠) · ويحمرّ فحص التأمينات بألفٍ، ويخرج R1 من أداة المراجعة وهو بلا مستندٍ هنا.
 * الصحيح: الاعتماد لا يغيّر الفحوص ولا أداة المراجعة (ما وثّقته تسويةٌ في خطٍّ زمني آخر لا يوثّقه هنا).
 *   (الضابط: السيناريو نفسه بحذف سطور «صار له مستند» من السحابة قبل الاستعادة الثانية يبقى أخضر وR1 في المراجعة بعد الاعتماد · جرّبته
 *   باختبارٍ مؤقت حُذف · فالعلّة في سطر التوثيق لا في ضمّ علامات المراجعة القديمة.)
 *   TZ=Asia/Riyadh npx jest tests/review12.r3.documentedAcrossRestore.test.ts
 */
import * as path from 'node:path';
import { tempDir, rmrf } from './helpers/testDb';
import { MemoryRemote } from './helpers/memoryRemote';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { makeBackupEnv, type TestBackupEnv } from './helpers/backupEnv';
import { confirmContract, saveDepositSettlement, recordRentPayment } from '@/domain/contracts/service';
import { createBackup } from '@/domain/backup/create';
import { prepareRestore, commitRestore } from '@/domain/backup/restore';
import { integrityChecks } from '@/domain/accounting/integrity';
import { accountBalance } from '@/domain/accounting/ledger';
import { keptForReview } from '@/domain/accounting/orphans';
import { enableSync, syncOnce, readCloud, planFromSnapshot, adoptAsCloudTruth } from '@/sync/engine';
import { getMeta } from '@/repos/settings';
import type { DB } from '@/db/adapter';

const UID = 'user-r12-r3-doc';
const dirs: string[] = [];
const newEnv = () => { const d = tempDir('aq-r12-r3-doc-'); dirs.push(d); return makeBackupEnv(d); };
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
const view = (db: DB) => ({
  c2400: accountBalance(db, '2400'),
  red: integrityChecks(db).filter((c) => !c.ok).map((c) => c.name + ' (' + c.value + ')'),
  review: keptForReview(db).map((k) => db.get<{ t: string }>(`SELECT src_type AS t FROM journal_entries WHERE id = ?`, [k.id])!.t).sort(),
});

test('«صار له مستند» من تسويةٍ في خطٍّ زمني آخر لا يُخرج عاكساً معلَّماً من المراجعة ولا يُحمّر فحص التأمينات بعد استعادةٍ ثانية', async () => {
  const r = new MemoryRemote();
  const env = newEnv();
  enableSync(env.db, UID);
  const db0 = env.db;
  const u = addUnit(db0, addProperty(db0, { name: 'عقار استعادتين مصطنع' }), { unit_no: 'R3T-1' });
  const a = confirmContract(db0, contractInput(u, { tenant: 'مستأجر استعادتين مصطنع', idNumber: '1000013101', phone: '0500013101',
    start: '2025-07-01', end: '2025-12-31', valueHalalas: 600000, depositHalalas: 100000 }));
  for (const i of insts(db0, a).slice(0, 5)) {
    recordRentPayment(db0, a, { installmentId: i.id, period: '', date: i.due_date, lines: [{ method: 'cash', amountHalalas: 100000 }], discountHalalas: 0, notes: '' });
  }
  const date = '2026-01-05';
  saveDepositSettlement(db0, a, { date, ...ARREARS });
  await sync(db0, r);
  const archive = await backup(env);
  saveDepositSettlement(db0, a, { date, ...REFUND });
  await sync(db0, r);

  // الاستعادة الأولى واعتمادها: R1 وF2 في المراجعة والفحوص خضراء
  const snap1 = await readCloud(r);
  const db1 = (await commitRestore(env, await prepareRestore(env, archive, undefined, { cloud: async () => snap1.docs }))).db;
  adoptAsCloudTruth(db1, UID, planFromSnapshot(db1, snap1));
  for (let i = 0; i < 2; i++) await sync(db1, r);
  expect(view(db1)).toEqual({ c2400: 0, red: [], review: ['deposit_refund', 'deposit_rent_rev'] });
  // المالك يحفظ الردّ ثانيةً من شاشة العقد: المراجعة فارغة والفحوص خضراء
  saveDepositSettlement(db1, a, { date, ...REFUND });
  for (let i = 0; i < 2; i++) await sync(db1, r);
  expect(view(db1)).toEqual({ c2400: 0, red: [], review: [] });

  // الاستعادة الثانية للنسخة نفسها
  const snap2 = await readCloud(r);
  const db2 = (await commitRestore(env, await prepareRestore(env, archive, undefined, { cloud: async () => snap2.docs }))).db;
  const before = view(db2);
  // قبل الاعتماد: R1 (ومعه إلغاء P1) وF3 في المراجعة، وF2 وعاكسه زوجٌ أثره صفر، والفحوص خضراء
  expect(before).toEqual({ c2400: 0, red: [], review: ['deposit_refund', 'deposit_rent_rev'] });
  adoptAsCloudTruth(db2, UID, planFromSnapshot(db2, snap2));
  // الاعتماد يضمّ سطور سجل العمليات «إضافةً لا تغيّر رقماً» · اليوم: R1 يخرج من المراجعة ويحمرّ فحص التأمينات
  // (1,000.00 / 0.00 · خارجها قيود بلا مستند -1,000.00)
  expect(view(db2)).toEqual(before);
  env.closeLive();
});
