/**
 * المراجع المعاكس الثاني على قرار تعارض R12-DEP-2 مع R12-BAK-2 (keepPosted.ts: تعديل التسوية بعد النسخة يُراجَع كله) · بيانات مصطنعة،
 * والأرقام بالهللة محسوبة باليد.
 *
 * السيناريو (الاتجاه المعاكس لـ review12.r.singleRestoreEdit، وهو سيناريو review12.backup.depositRentEdit): (أ) ستة أقساط ١٬٠٠٠ وتأمين
 *   ١٬٠٠٠ نقداً، سُدّد خمسة وبقي ديسمبر · [السلسلة: جُدّد إلى (ب) بترحيل التأمين وسُدّد (ب) كله] · التسوية: ردّ التأمين كله · نسخة · ثم
 *   عدّلها المالك: التأمين كله مقابل ديسمبر (دفعة «من التأمين» P2 وقيدها E2، وعاكس قيد الردّ F′) · ثم استعاد النسخة.
 * بعد الاستعادة (R12-BAK-2): المستندات كما في النسخة (ردّ التأمين، وديسمبر مستحق، ولا P2) · وF′ وE2 مضمومان في المراجعة · والفحوص خضراء.
 * العيب: أداة المراجعة لا توصل المالك إلى دفترٍ يطابق مستنداته · F′ لا زرّ له (مرآة قيد)، وE2 زرّه يفتح مستنده (شاشة العقد، A1-2) ·
 *   وتعديل التسوية هناك لا يعكس E2 أبداً: reverseDepositRent يعكس قيود الدفعات الحيّة (liveDepositRent) وE2 بلا دفعة لأن R12-BAK-2 لم
 *   يحمل P2 · فأيّ حفظٍ للتسوية بعدها يُبقي إيراد ديسمبر من E2:
 *   - إعادة التعديل نفسه (التأمين مقابل ديسمبر) تقيد إيراد ديسمبر مرتين: 4200 = ٧٠٠٬٠٠٠ والقسط ١٠٠٬٠٠٠ · و2400 مدينٌ ١٠٠٬٠٠٠.
 *   - وتأكيد ما في النسخة (الردّ) يُبقي إيراد ديسمبر في الدفتر وديسمبر مستحق: 4200 = ٦٠٠٬٠٠٠.
 *   وفي الحالين فحص التأمينات أحمر (-1,000.00 / 0.00) · وكان قبل R12-BAK-2 يُحمل P2 مع E2 فيصل إليه تعديل التسوية.
 *   (ومثله تعديل تاريخ التسوية وحده، وتعديل الأضرار إلى أقساطٍ متأخرة: E2 مضموم بلا دفعته في المراجعة وإعادة الحفظ تقيد القسط مرتين.)
 * الصحيح: بعد أن يتّبع المالك أداة المراجعة ويحفظ التسوية التي يريدها يطابق الدفتر المستندات والفحوص خضراء.
 *   TZ=Asia/Riyadh npx jest tests/review12.r2.keptDepositRentUnreachable.test.ts
 */
import * as path from 'node:path';
import { tempDir, rmrf } from './helpers/testDb';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { makeBackupEnv, type TestBackupEnv } from './helpers/backupEnv';
import { confirmContract, saveDepositSettlement, recordRentPayment, renewContract } from '@/domain/contracts/service';
import { createBackup } from '@/domain/backup/create';
import { prepareRestore, commitRestore } from '@/domain/backup/restore';
import { integrityChecks } from '@/domain/accounting/integrity';
import { accountBalance } from '@/domain/accounting/ledger';
import { keptForReview } from '@/domain/accounting/orphans';
import { entrySourceAction } from '@/domain/accounting/sourceCancel';
import type { DB } from '@/db/adapter';

const dirs: string[] = [];
const newEnv = () => { const d = tempDir('aq-r12-r2-unreach-'); dirs.push(d); return makeBackupEnv(d); };
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
const REFUND = { deductionHalalas: 0, deductionReason: '', refundHalalas: 100000, notes: '', arrearsHalalas: 0 };
const ARREARS = { deductionHalalas: 100000, deductionReason: 'إيجار ديسمبر غير المدفوع', refundHalalas: 0, notes: '', arrearsHalalas: 100000 };
const view = (db: DB, dec: string) => ({
  c1100: accountBalance(db, '1100'),
  c4200: accountBalance(db, '4200'),
  dec: db.get(`SELECT paid_halalas AS p, status AS s FROM contract_installments WHERE id = ?`, [dec]),
  red: integrityChecks(db).filter((c) => !c.ok).map((c) => c.name + ' (' + c.value + ')'),
});

/** التسوية ردّاً · نسخة · تعديلها مقابل ديسمبر · استعادة · ويُعاد ما تعرضه أداة المراجعة */
async function restoredAfterEdit(chain: boolean, n: number) {
  const env = newEnv();
  const db0 = env.db;
  const u = addUnit(db0, addProperty(db0, { name: 'عقار مراجعةٍ مصطنع ' + n }), { unit_no: 'R2U-' + n });
  const a = confirmContract(db0, contractInput(u, { tenant: 'مستأجر مراجعةٍ مصطنع ' + n, idNumber: '100001208' + n, phone: '050001208' + n,
    start: '2025-07-01', end: '2025-12-31', valueHalalas: 600000, depositHalalas: 100000 }));
  payCash(db0, a, 5);
  let holder = a;
  let date = '2026-01-05';
  if (chain) {
    holder = renewContract(db0, a, { start: '2026-01-01', end: '2026-06-30', valueHalalas: 600000, cycle: 'شهرية', carryDeposit: true,
      extraDepositHalalas: 0, services: '', furnished: 'غير مؤثثة', ejarNo: '', note: '' });
    payCash(db0, holder, 6);
    date = '2026-07-05';
  }
  const dec = insts(db0, a)[5].id;
  saveDepositSettlement(db0, holder, { date, ...REFUND });
  const archive = await backup(env);
  saveDepositSettlement(db0, holder, { date, ...ARREARS });
  const db = (await commitRestore(env, await prepareRestore(env, archive))).db;
  // بعد الاستعادة: الفحوص خضراء، وفي المراجعة F′ بلا زرّ وE2 زرّه «مستنده» (شاشة العقد) لا عكسٌ من الدفتر
  expect(view(db, dec).red).toEqual([]);
  const review = keptForReview(db).map((k) => ({
    t: db.get<{ t: string }>(`SELECT src_type AS t FROM journal_entries WHERE id = ?`, [k.id])!.t,
    action: entrySourceAction(db, k.id)?.kind ?? null,
  })).sort((x, y) => x.t.localeCompare(y.t));
  expect(review).toEqual([{ t: 'deposit_refund_rev', action: null }, { t: 'deposit_rent', action: 'document' }]);
  return { env, db, holder, date, dec };
}

test.each([
  // العقد الواحد: 1100 = ٥ أقساط ٥٠٠٬٠٠٠ + تأمين ١٠٠٬٠٠٠ − ردّه ١٠٠٬٠٠٠ + عكس الردّ ١٠٠٬٠٠٠ = ٦٠٠٬٠٠٠ · 4200 = ٥٠٠٬٠٠٠ + ديسمبر مرةً من التأمين ١٠٠٬٠٠٠
  { chain: false, n: 1, cash: 600000, rent: 600000 },
  // السلسلة: 1100 = ١١ قسطاً ١٬١٠٠٬٠٠٠ + ١٠٠٬٠٠٠ − ١٠٠٬٠٠٠ + ١٠٠٬٠٠٠ = ١٬٢٠٠٬٠٠٠ · 4200 = ١٬١٠٠٬٠٠٠ + ديسمبر مرةً ١٠٠٬٠٠٠ = ١٬٢٠٠٬٠٠٠
  { chain: true, n: 2, cash: 1200000, rent: 1200000 },
])('المالك يعيد تعديل التسوية بعد الاستعادة من شاشة العقد (السلسلة: $chain): ديسمبر يُقيد إيراده مرةً واحدة والفحوص خضراء', async ({ chain, n, cash, rent }) => {
  const { env, db, holder, date, dec } = await restoredAfterEdit(chain, n);
  saveDepositSettlement(db, holder, { date, ...ARREARS });
  // اليوم: 4200 = ٧٠٠٬٠٠٠ (السلسلة ١٬٣٠٠٬٠٠٠): E2 المضموم وقيد الدفعة الجديدة معاً · وفحص التأمينات أحمر
  expect(view(db, dec)).toEqual({ c1100: cash, c4200: rent, dec: { p: 100000, s: 'مدفوعة' }, red: [] });
  env.closeLive();
});

test('المالك يؤكد تسوية النسخة (الردّ) بعد الاستعادة من شاشة العقد: لا إيراد لديسمبر المستحق والفحوص خضراء', async () => {
  const { env, db, holder, date, dec } = await restoredAfterEdit(false, 3);
  saveDepositSettlement(db, holder, { date, ...REFUND });
  // 1100 = ٥٠٠٬٠٠٠ + تأمين ١٠٠٬٠٠٠ − ردّه ١٠٠٬٠٠٠ + عكسه ١٠٠٬٠٠٠ − الردّ المؤكَّد ١٠٠٬٠٠٠ = ٥٠٠٬٠٠٠ · 4200 = ٥ أقساط ٥٠٠٬٠٠٠ وديسمبر مستحق
  // اليوم: 4200 = ٦٠٠٬٠٠٠ (E2 باقٍ) · وفحص التأمينات أحمر
  expect(view(db, dec)).toEqual({ c1100: 500000, c4200: 500000, dec: { p: 0, s: 'مستحقة' }, red: [] });
  env.closeLive();
});
