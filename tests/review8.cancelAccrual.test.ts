/**
 * المراجعة الشاملة (الالتزام ac76adc) · البند ٣: الإلغاء يكتب تاريخه في end، والاستحقاق كان يقسم قيمة العقد على المدة حتى end
 * فيضيع مقام المدة الكاملة ويتضخم إيراد ما قبل الإلغاء · الآن original_end مقام النصيب (الهجرة ٤٨)، والإلغاء لا يمسّه ·
 * بيانات مصطنعة.
 */
import { memDb } from './helpers/testDb';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { confirmContract, cancelContract, recordRentPayment } from '@/domain/contracts/service';
import { periodRevenueAccrual } from '@/domain/accrual';
import { DISCOUNT_REDUCES_INSTALLMENT } from '@/domain/contracts/installments';
import { openNodeDb } from '@/db/nodeAdapter';
import { migrate } from '@/db/migrations';
import { MIGRATIONS } from '@/db/schema';
import { seed } from '@/db/seed';
import { MemoryRemote } from './helpers/memoryRemote';
import { enableSync, syncOnce, docId } from '@/sync/engine';
import { getMeta } from '@/repos/settings';
import type { DB } from '@/db/adapter';

const cancel = (date: string) => ({ date, reason: 'سبب مصطنع', installmentsFate: 'cancel' as const, settle: false,
  deductionHalalas: 0, refundHalalas: 0, deductionReason: '' });

test('٣ عقد ١٢٬٠٠٠ لسنة أُلغي في ٣١ مارس: إيراد الربع الأول ٢٬٩٥٨٫٩٠ لا ١٢٬٠٠٠', () => {
  const db = memDb();
  const u = addUnit(db, addProperty(db, { name: 'عقار مصطنع' }), { unit_no: 'C-1' });
  const cid = confirmContract(db, contractInput(u, { valueHalalas: 1200000, start: '2026-01-01', end: '2026-12-31', depositHalalas: 0 }));
  cancelContract(db, cid, cancel('2026-03-31'));
  expect(db.get<{ e: string }>(`SELECT end AS e FROM contracts WHERE id = ?`, [cid])!.e).toBe('2026-03-31');
  // ١٢٠٠٠٠٠ × ٩٠ ÷ ٣٦٥ = ٢٩٥٨٩٠
  expect(periodRevenueAccrual(db, '2026-01-01', '2026-03-31')).toBe(295890);
  expect(periodRevenueAccrual(db, '2026-04-01', '2026-12-31')).toBe(0);
  db.close();
});

test('٣ والتنزيل من القسط يُطرح بمقام مدة قسطه لا بمدة مقصوصة بالإلغاء', () => {
  const db = memDb();
  const u = addUnit(db, addProperty(db, { name: 'عقار مصطنع' }), { unit_no: 'C-2' });
  const cid = confirmContract(db, contractInput(u, { valueHalalas: 1200000, cycle: 'ربع سنوية', start: '2026-01-01', end: '2026-12-31', depositHalalas: 0 }));
  const q2 = db.get<{ id: string }>(`SELECT id FROM contract_installments WHERE contract_id = ? AND due_date = '2026-04-01'`, [cid])!.id;
  // تنزيل ٩١٠٠ على قسط الربع الثاني (٩١ يوماً: ١٠٠ لكل يوم)
  recordRentPayment(db, cid, { installmentId: q2, period: '2026-04-01', date: '2026-04-01', lines: [{ method: 'cash', amountHalalas: 100000 }],
    discountHalalas: 9100, discountKind: DISCOUNT_REDUCES_INSTALLMENT, notes: '' });
  cancelContract(db, cid, cancel('2026-05-15'));
  const full = periodRevenueAccrual(db, '2026-04-01', '2026-06-30');
  // نصيب العقد من ١ أبريل إلى ١٥ مايو (٤٥ يوماً) بمقام السنة، ناقص نصيب التنزيل من الأيام نفسها بمقام ٩١ يوماً (٤٥٠٠)
  const contractShare = Math.round((1200000 * 135) / 365) - Math.round((1200000 * 90) / 365);
  expect(full).toBe(contractShare - 4500);
  db.close();
});

test('٣ الهجرة ٤٨ تعبّئ original_end: من end للقائم، ومن جدول الأقساط للملغى قبلها', () => {
  const db = openNodeDb(':memory:');
  // القاعدة بإصدار ٤٧ كما كانت قبل البند
  db.exec('PRAGMA foreign_keys = OFF');
  for (let v = 0; v < 47; v++) db.exec(MIGRATIONS[v]);
  db.exec('PRAGMA user_version = 47');
  db.exec('PRAGMA foreign_keys = ON');
  seed(db);
  const p = addProperty(db, { name: 'عقار مصطنع' });
  const live = confirmContract(db, contractInput(addUnit(db, p, { unit_no: 'M-1' }), { start: '2026-01-01', end: '2026-12-31', depositHalalas: 0, idNumber: '1000000081' }));
  const old = confirmContract(db, contractInput(addUnit(db, p, { unit_no: 'M-2' }), { start: '2026-01-31', end: '2027-01-30', depositHalalas: 0, idNumber: '1000000082' }));
  const late = confirmContract(db, contractInput(addUnit(db, p, { unit_no: 'M-3' }), { cycle: 'ربع سنوية', start: '2026-03-01', end: '2027-02-28', depositHalalas: 0, idNumber: '1000000083' }));
  // الإلغاء كما كان قبل البند: تاريخه في end
  const oldCancel = (id: string, d: string) => db.run(`UPDATE contracts SET status = 'ملغى', cancel_date = ?, end = ? WHERE id = ?`, [d, d, id]);
  oldCancel(old, '2026-04-10');
  oldCancel(late, '2026-09-01');
  migrate(db);
  const oe = (id: string) => db.get<{ e: string | null }>(`SELECT original_end AS e FROM contracts WHERE id = ?`, [id])!.e;
  expect(oe(live)).toBe('2026-12-31');
  expect(oe(old)).toBe('2027-01-30');
  expect(oe(late)).toBe('2027-02-28');
  db.close();
});

test('٣ وما يغيّر نهاية عقدٍ غير ملغى يغيّر original_end معه · والإلغاء لا يمسّه', () => {
  const db = memDb();
  const u = addUnit(db, addProperty(db, { name: 'عقار مصطنع' }), { unit_no: 'C-3' });
  const cid = confirmContract(db, contractInput(u, { start: '2026-01-01', end: '2026-12-31', depositHalalas: 0 }));
  const oe = () => db.get<{ e: string | null }>(`SELECT original_end AS e FROM contracts WHERE id = ?`, [cid])!.e;
  expect(oe()).toBe('2026-12-31');
  db.run(`UPDATE contracts SET end = '2027-06-30' WHERE id = ?`, [cid]);
  expect(oe()).toBe('2027-06-30');
  cancelContract(db, cid, cancel('2026-05-01'));
  expect(oe()).toBe('2027-06-30');
  db.close();
});

test('٣ (التحقق المستقل) ملغى قبل الترقية في السحابة بلا original_end: الجهاز الجديد لا يضخّم، وتعديله لا يعيد التضخم إلى غيره', async () => {
  const OWN = 'owner-1';
  const sync = (db: DB, r: MemoryRemote) => syncOnce(db, r, getMeta(db, 'device_id')!);
  const oe = (db: DB, id: string) => db.get<{ e: string | null }>(`SELECT original_end AS e FROM contracts WHERE id = ?`, [id])!.e;
  const r = new MemoryRemote();
  const a = memDb();
  enableSync(a, OWN);
  const u = addUnit(a, addProperty(a, { name: 'عقار مصطنع' }), { unit_no: 'C-9' });
  const cid = confirmContract(a, contractInput(u, { valueHalalas: 1200000, start: '2026-01-01', end: '2026-12-31', depositHalalas: 0 }));
  // إلغاءٌ بالإصدار ٤٧ (قبل البند): تاريخه في end · ومستند السحابة كما رفعه ذلك الإصدار بلا original_end
  a.run(`UPDATE contracts SET status = 'ملغى', cancel_date = '2026-03-31', end = '2026-03-31' WHERE id = ?`, [cid]);
  await sync(a, r);
  delete (r.docs.get(docId('contracts', cid))!.d as Record<string, unknown>).original_end;
  expect(oe(a, cid)).toBe('2026-12-31');
  const b = memDb();
  enableSync(b, OWN);
  await sync(b, r);
  expect(periodRevenueAccrual(b, '2026-01-01', '2026-03-31')).toBe(295890);
  b.run(`UPDATE contracts SET ejar_no = '99999' WHERE id = ?`, [cid]);
  await sync(b, r);
  await sync(a, r);
  expect(periodRevenueAccrual(a, '2026-01-01', '2026-03-31')).toBe(295890);
  a.close(); b.close();
});

/* ═══════════ تتمة · المراجعة الأخيرة: الملغى في يوم نهايته بالضبط لم تُقصّ نهايته فلا تُشتق ═══════════ */

const OWNER = 'owner-1';
const syncDev = (db: DB, r: MemoryRemote) => syncOnce(db, r, getMeta(db, 'device_id')!);
const year = (db: DB) => periodRevenueAccrual(db, '2026-01-01', '2026-12-31');

test('٣ تتمة: عقد ستة أشهر بدورة سنوية أُلغي في يوم نهايته يستحق قيمته كاملة لا ١٨١ من ٣٦٥ · وعلى الجهاز الجديد كذلك', async () => {
  const r = new MemoryRemote();
  const a = memDb();
  enableSync(a, OWNER);
  const u = addUnit(a, addProperty(a, { name: 'عقار مصطنع' }), { unit_no: 'C-10' });
  const cid = confirmContract(a, contractInput(u, { valueHalalas: 600000, cycle: 'سنوية', start: '2026-01-01', end: '2026-06-30', depositHalalas: 0 }));
  expect(year(a)).toBe(600000);
  cancelContract(a, cid, cancel('2026-06-30'));
  expect(a.get(`SELECT end, original_end AS oe, cancel_date AS cd FROM contracts WHERE id = ?`, [cid]))
    .toEqual({ end: '2026-06-30', oe: '2026-06-30', cd: '2026-06-30' });
  expect(year(a)).toBe(600000);
  await syncDev(a, r);
  const b = memDb();
  enableSync(b, OWNER);
  await syncDev(b, r);
  expect(year(b)).toBe(600000);
  a.close(); b.close();
});

test('٣ تتمة: وأحد عشر شهراً بدورة ربع سنوية أُلغي في يوم نهايته يستحق ١١٬٠٠٠ كاملة', () => {
  const db = memDb();
  const u = addUnit(db, addProperty(db, { name: 'عقار مصطنع' }), { unit_no: 'C-11' });
  const cid = confirmContract(db, contractInput(u, { valueHalalas: 1100000, cycle: 'ربع سنوية', start: '2026-01-01', end: '2026-11-30', depositHalalas: 0 }));
  cancelContract(db, cid, cancel('2026-11-30'));
  expect(year(db)).toBe(1100000);
  db.close();
});

test('٣ تتمة: والملغى قبل الترقية بدورة سنوية في نصفه الثاني يتفق عليه الجهاز الجديد والمرقّى ولو عُدّل على الجديد', async () => {
  const r = new MemoryRemote();
  const a = memDb();
  enableSync(a, OWNER);
  const u = addUnit(a, addProperty(a, { name: 'عقار مصطنع' }), { unit_no: 'C-12' });
  const cid = confirmContract(a, contractInput(u, { valueHalalas: 1200000, cycle: 'سنوية', start: '2026-01-01', end: '2026-12-31', depositHalalas: 0 }));
  // إلغاءٌ بالإصدار ٤٧ في ٣٠ سبتمبر: تاريخه في end ولا قسط بعده (قسطٌ واحد في يناير) · ومستند السحابة بلا original_end
  a.run(`UPDATE contracts SET status = 'ملغى', cancel_date = '2026-09-30', end = '2026-09-30' WHERE id = ?`, [cid]);
  await syncDev(a, r);
  delete (r.docs.get(docId('contracts', cid))!.d as Record<string, unknown>).original_end;
  // ١٢٠٠٠٠٠ × ٢٧٣ ÷ ٣٦٥
  const share = Math.round((1200000 * 273) / 365);
  expect(year(a)).toBe(share);
  const b = memDb();
  enableSync(b, OWNER);
  await syncDev(b, r);
  expect(year(b)).toBe(share);
  b.run(`UPDATE contracts SET ejar_no = '99998' WHERE id = ?`, [cid]);
  await syncDev(b, r);
  await syncDev(a, r);
  expect(year(a)).toBe(share);
  const c = memDb();
  enableSync(c, OWNER);
  await syncDev(c, r);
  expect(year(c)).toBe(share);
  a.close(); b.close(); c.close();
});

test('٣ تتمة: ونهايةٌ متفق عليها كُتبت بالمقصوصة وبعد الإلغاء أقساطٌ مستحقة: القصّ ثابت فتُشتق من الجدول', () => {
  const db = memDb();
  const u = addUnit(db, addProperty(db, { name: 'عقار مصطنع' }), { unit_no: 'C-13' });
  const cid = confirmContract(db, contractInput(u, { valueHalalas: 1200000, start: '2026-01-01', end: '2026-12-31', depositHalalas: 0 }));
  db.run(`UPDATE contracts SET status = 'ملغى', cancel_date = '2026-03-31', end = '2026-03-31', original_end = '2026-03-31' WHERE id = ?`, [cid]);
  expect(year(db)).toBe(295890);
  db.close();
});
