/**
 * إصلاح ما وجده المراجع المعاكس الثاني على تعارض R12-DEP-2 مع R12-BAK-2 · ضوابط لما لم تغطّه اختباراته · بيانات مصطنعة، والأرقام بالهللة
 * محسوبة باليد.
 *
 * القرار: تعديل تسوية التأمين بعد النسخة يُراجَع كله وصفّ التسوية كما في النسخة، والدفعة التي عُكس قيدها يُحمل إلغاؤها مع عاكسها ويبقى
 *   العاكس في المراجعة (keepPosted.ts) · وحفظ التسوية بعد الاستعادة يعكس كل قيدٍ حيّ منها، ومنه قيد سدادٍ من التأمين بلا دفعةٍ حيّة، ويُعيد
 *   ما ضُمّ منها داخل المطابقة (service.ts: reverseDepositRent وdocumentKeptSettlement · orphans.ts: KEPT_DOCUMENTED_ENTITY).
 * الضابط الأول (ذكره المراجع ولم يختبره): جهازٌ ثانٍ للمالك كان عنده التعديل · بعد الاستعادة والاعتماد والمزامنة يتفق الجهازان على ما قررته
 *   الاستعادة، ثم يحفظ المالك تسوية النسخة من الجهاز الثاني فيتفقان على دفترها والفحوص خضراء.
 * الضابط الثاني (A1-2 قبل هذا البند): نسخةٌ قبل التسوية · قيد سداد ديسمبر من التأمين يُضمّ بلا دفعته ويُراجَع · ثم يحفظ المالك التسوية نفسها
 *   من شاشة العقد · وكان قيد الضمّ يبقى حيّاً فيُقيد إيراد ديسمبر مرتين (4200 = ٧٠٠٬٠٠٠ في العقد الواحد) ويحمرّ فحص التأمينات.
 *   TZ=Asia/Riyadh npx jest tests/review12.r2.settlementAfterRestore.test.ts
 */
import * as path from 'node:path';
import { tempDir, rmrf, memDb } from './helpers/testDb';
import { MemoryRemote } from './helpers/memoryRemote';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { makeBackupEnv, type TestBackupEnv } from './helpers/backupEnv';
import { confirmContract, saveDepositSettlement, recordRentPayment, renewContract } from '@/domain/contracts/service';
import { createBackup } from '@/domain/backup/create';
import { prepareRestore, commitRestore } from '@/domain/backup/restore';
import { integrityChecks } from '@/domain/accounting/integrity';
import { accountBalance } from '@/domain/accounting/ledger';
import { keptForReview } from '@/domain/accounting/orphans';
import { DEPOSIT_RENT_METHOD } from '@/domain/contracts/installments';
import { enableSync, syncOnce, readCloud, planFromSnapshot, adoptAsCloudTruth } from '@/sync/engine';
import { getMeta } from '@/repos/settings';
import type { DB } from '@/db/adapter';

const UID = 'user-r12-r2-after';
const dirs: string[] = [];
const newEnv = () => { const d = tempDir('aq-r12-r2-after-'); dirs.push(d); return makeBackupEnv(d); };
afterAll(() => { for (const d of dirs) rmrf(d); });
async function backup(env: TestBackupEnv): Promise<string> {
  const out = path.join(env.root, 'b-' + Math.random().toString(36).slice(2) + '.aqbk');
  await createBackup(env, out);
  return out;
}
const insts = (db: DB, c: string) => db.all<{ id: string; due_date: string }>(
  `SELECT id, due_date FROM contract_installments WHERE contract_id = ? ORDER BY due_date`, [c]);
const payCash = (db: DB, c: string, n: number) => {
  for (const i of insts(db, c).slice(0, n)) {
    recordRentPayment(db, c, { installmentId: i.id, period: '', date: i.due_date, lines: [{ method: 'cash', amountHalalas: 100000 }], discountHalalas: 0, notes: '' });
  }
};
const sync = (db: DB, r: MemoryRemote) => syncOnce(db, r, getMeta(db, 'device_id')!);
const ARREARS = { deductionHalalas: 100000, deductionReason: 'إيجار ديسمبر غير المدفوع', refundHalalas: 0, notes: '', arrearsHalalas: 100000 };
const REFUND = { deductionHalalas: 0, deductionReason: '', refundHalalas: 100000, notes: '', arrearsHalalas: 0 };
/** ما يراه المالك على جهاز: الدفتر وقسط ديسمبر ودفعاته «من التأمين» الحيّة والفحوص الحمراء وأداة المراجعة */
const view = (db: DB, dec: string) => ({
  c1100: accountBalance(db, '1100'),
  c4200: accountBalance(db, '4200'),
  dec: db.get(`SELECT paid_halalas AS p, status AS s FROM contract_installments WHERE id = ?`, [dec]),
  depositRentLive: Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM contract_payments WHERE installment_id = ? AND method_label = ?
    AND cancelled_at IS NULL`, [dec, DEPOSIT_RENT_METHOD])!.n),
  red: integrityChecks(db).filter((c) => !c.ok).map((c) => c.name + ' (' + c.value + ')'),
  review: keptForReview(db).length,
});

/** (أ) ستة أقساط ١٬٠٠٠ وتأمين ١٬٠٠٠، سُدّد خمسة · [السلسلة: جُدّد إلى (ب) بترحيل التأمين وسُدّد (ب) كله] */
function lease(db: DB, chain: boolean, n: number) {
  const u = addUnit(db, addProperty(db, { name: 'عقار حفظٍ بعد الاستعادة مصطنع ' + n }), { unit_no: 'R2A-' + n });
  const a = confirmContract(db, contractInput(u, { tenant: 'مستأجر حفظٍ بعد الاستعادة مصطنع ' + n, idNumber: '100001210' + n,
    phone: '050001210' + n, start: '2025-07-01', end: '2025-12-31', valueHalalas: 600000, depositHalalas: 100000 }));
  payCash(db, a, 5);
  if (!chain) return { holder: a, date: '2026-01-05', dec: insts(db, a)[5].id };
  const b = renewContract(db, a, { start: '2026-01-01', end: '2026-06-30', valueHalalas: 600000, cycle: 'شهرية', carryDeposit: true,
    extraDepositHalalas: 0, services: '', furnished: 'غير مؤثثة', ejarNo: '', note: '' });
  payCash(db, b, 6);
  return { holder: b, date: '2026-07-05', dec: insts(db, a)[5].id };
}

test.each([
  // بعد الاستعادة: 1100 = ٥ أقساط ٥٠٠٬٠٠٠ + تأمين ١٠٠٬٠٠٠ − ردّه ١٠٠٬٠٠٠ · 4200 = ٥٠٠٬٠٠٠ + سداد ديسمبر ١٠٠٬٠٠٠ − عكسه ١٠٠٬٠٠٠ ·
  // وبعد حفظ تسوية النسخة: 1100 + عكس الردّ ١٠٠٬٠٠٠ = ٦٠٠٬٠٠٠ · 4200 + سداد ديسمبر الجديد ١٠٠٬٠٠٠ = ٦٠٠٬٠٠٠
  { chain: false, n: 1, cash: 500000, rent: 500000, cash2: 600000, rent2: 600000 },
  // السلسلة: ١١ قسطاً نقداً ١٬١٠٠٬٠٠٠ بدل الخمسة، والباقي مثله
  { chain: true, n: 2, cash: 1100000, rent: 1100000, cash2: 1200000, rent2: 1200000 },
])('جهازٌ ثانٍ للمالك كان عنده التعديل (السلسلة: $chain): يتفق مع الجهاز المستعاد، ثم على حفظ تسوية النسخة منه', async ({ chain, n, cash, rent, cash2, rent2 }) => {
  const r = new MemoryRemote();
  const env = newEnv();
  enableSync(env.db, UID);
  const db0 = env.db;
  const { holder, date, dec } = lease(db0, chain, n);
  saveDepositSettlement(db0, holder, { date, ...ARREARS });
  await sync(db0, r);
  const two = memDb();
  enableSync(two, UID);
  for (let i = 0; i < 2; i++) await sync(two, r);
  const archive = await backup(env);
  saveDepositSettlement(db0, holder, { date, ...REFUND });
  await sync(db0, r);
  for (let i = 0; i < 2; i++) await sync(two, r);

  const snap = await readCloud(r);
  const db = (await commitRestore(env, await prepareRestore(env, archive, undefined, { cloud: async () => snap.docs }))).db;
  // ديسمبر p = ٠: دفعته «من التأمين» ملغاةٌ بعاكس قيدها المحمول معها · وفي المراجعة العاكس وقيد الردّ
  const restored = { c1100: cash, c4200: rent, dec: { p: 0, s: 'مستحقة' }, depositRentLive: 0, red: [], review: 2 };
  expect(view(db, dec)).toEqual(restored);
  adoptAsCloudTruth(db, UID, planFromSnapshot(db, snap));
  await sync(db, r);
  for (let i = 0; i < 3; i++) { await sync(two, r); await sync(db, r); }
  expect({ restored: view(db, dec), two: view(two, dec) }).toEqual({ restored, two: restored });

  // المالك يحفظ تسوية النسخة (التأمين مقابل ديسمبر) من الجهاز الثاني · فديسمبر p = دفعته الجديدة ١٠٠٬٠٠٠ والمراجعة فارغة
  saveDepositSettlement(two, holder, { date, ...ARREARS });
  for (let i = 0; i < 3; i++) { await sync(two, r); await sync(db, r); }
  const saved = { c1100: cash2, c4200: rent2, dec: { p: 100000, s: 'مدفوعة' }, depositRentLive: 1, red: [], review: 0 };
  expect({ restored: view(db, dec), two: view(two, dec) }).toEqual({ restored: saved, two: saved });
  env.closeLive();
  two.close();
});

test.each([
  // 1100 = ٥ أقساط ٥٠٠٬٠٠٠ + تأمين ١٠٠٬٠٠٠ = ٦٠٠٬٠٠٠ · 4200 = ٥٠٠٬٠٠٠ + قيد الضمّ ١٠٠٬٠٠٠ − عكسه بالحفظ ١٠٠٬٠٠٠ + سداد ديسمبر ١٠٠٬٠٠٠ = ٦٠٠٬٠٠٠
  { chain: false, n: 3, cash: 600000, rent: 600000 },
  // السلسلة: ١١ قسطاً نقداً ١٬١٠٠٬٠٠٠ + تأمين ١٠٠٬٠٠٠ · 4200 = ١٬١٠٠٬٠٠٠ + ١٠٠٬٠٠٠ − ١٠٠٬٠٠٠ + ١٠٠٬٠٠٠
  { chain: true, n: 4, cash: 1200000, rent: 1200000 },
])('نسخةٌ قبل التسوية (السلسلة: $chain): حفظ التسوية بعد الاستعادة يعكس قيد السداد المضموم بلا دفعته فيُقيد ديسمبر مرةً', async ({ chain, n, cash, rent }) => {
  const env = newEnv();
  const db0 = env.db;
  const { holder, date, dec } = lease(db0, chain, n);
  const archive = await backup(env);
  saveDepositSettlement(db0, holder, { date, ...ARREARS });
  const db = (await commitRestore(env, await prepareRestore(env, archive))).db;
  // بعد الاستعادة: قيد السداد في المراجعة بلا دفعته، وديسمبر مستحق، والفحوص خضراء
  expect(view(db, dec)).toEqual({ c1100: cash, c4200: rent, dec: { p: 0, s: 'مستحقة' }, depositRentLive: 0, red: [], review: 1 });
  saveDepositSettlement(db, holder, { date, ...ARREARS });
  expect(view(db, dec)).toEqual({ c1100: cash, c4200: rent, dec: { p: 100000, s: 'مدفوعة' }, depositRentLive: 1, red: [], review: 0 });
  env.closeLive();
});
