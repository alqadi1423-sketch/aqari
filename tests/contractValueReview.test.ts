/**
 * محور «قيمة العقد» في المراجعة المستقلة (docs/مراجعة/مراجعة-التثبيت.md، الصفوف ١–١٠) · قرار المالك 2026-10-07:
 * يُصلح ضمن المرحلة ١، ولكل صف اختبار يفشل قبل الإصلاح · بيانات مصطنعة.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { memDb } from './helpers/testDb';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import type { DB } from '@/db/adapter';
import {
  saveDraft, confirmContract, recordRentPayment, renewContract, scheduleInstallments,
} from '@/domain/contracts/service';
import { accountMovement } from '@/domain/accounting/ledger';
import { DISCOUNT_REDUCES_INSTALLMENT } from '@/domain/contracts/installments';
import { scheduleSumGap } from '@/domain/pdf/ejarExtras';
import { buildContractDoc } from '@/domain/printDocs';
import { templateContext } from '@/domain/templates';
import { unitReportData } from '@/domain/reportData';
import { tenantProfile } from '@/domain/tenants';
import { contractCancelledValue, contractRemainingHalalas, propertyStats, allPropertyStats } from '@/domain/stats';

const credit = (db: DB, code: string) => { const m = accountMovement(db, code, null, null); return m.credit - m.debit; };
const insts = (db: DB, c: string) => db.all<{ id: string; due_date: string; amount_halalas: number }>(
  `SELECT id, due_date, amount_halalas FROM contract_installments WHERE contract_id = ? ORDER BY due_date`, [c]);
const sum = (rows: Array<{ amount_halalas: number }>) => rows.reduce((s, r) => s + Number(r.amount_halalas), 0);

/** عقد شهري ستة أشهر: إيجار ٤٨٠ ريالاً وخدمات ٩٠ ومواقف ٣٠ · الإجمالي ٦٠٠ · وجدول إيجار بالإجمالي */
function world() {
  const db = memDb();
  const pid = addProperty(db, { name: 'عقار قيمة العقد' });
  const u = addUnit(db, pid, { unit_no: 'V-1' });
  const base = { ...contractInput(u, { tenant: 'مستأجر قيمة مصطنع', idNumber: '1000008001', phone: '0500008001', depositHalalas: 0, start: '2026-01-01', end: '2026-06-30', valueHalalas: 48000, cycle: 'شهرية' }) };
  const schedule = ['2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01', '2026-05-01', '2026-06-01'].map((d) => ({ dueDate: d, amountHalalas: 10000 }));
  return { db, pid, u, base, schedule };
}
const pay = (db: DB, c: string, inst: { id: string; due_date: string }, amount: number) =>
  recordRentPayment(db, c, { installmentId: inst.id, period: inst.due_date, date: inst.due_date, lines: [{ method: 'cash', amountHalalas: amount }], discountHalalas: 0, notes: '' });

test('#1 المسودة تحفظ الخدمات والمواقف وتعيدها · والتوثيق بعد إعادة الفتح بالإجمالي وفصل الإيراد', () => {
  const { db, base, schedule } = world();
  const id = saveDraft(db, { ...base, schedule, fromEjarFile: true, servicesHalalas: 9000, parkingHalalas: 3000 });
  const row = db.get<{ s: number; p: number }>(`SELECT services_halalas AS s, parking_halalas AS p FROM contracts WHERE id = ?`, [id])!;
  expect([row.s, row.p]).toEqual([9000, 3000]);
  // النموذج المعاد فتحه بلا بيانات الملف المقروءة: المبلغان من المسودة نفسها
  const cid = confirmContract(db, base, id);
  const rows = insts(db, cid);
  expect(sum(rows)).toBe(60000);
  pay(db, cid, rows[0], 10000);
  expect([credit(db, '4200'), credit(db, '4210'), credit(db, '4220')]).toEqual([8000, 1500, 500]);
});

test('#1 لا توثيق إن خالف مجموع جدول إيجار إجمالي العقد', () => {
  const { db, base, schedule } = world();
  expect(() => confirmContract(db, { ...base, schedule, fromEjarFile: true })).toThrow();
});

test('#2 لا استبدال صامت: مبالغ الجدول كما هي · والفرق يُحسب للتنبيه', () => {
  const { schedule } = world();
  const odd = schedule.map((r, i) => (i === 5 ? { ...r, amountHalalas: 12000 } : r));
  const rows = scheduleInstallments(odd, '2026-01-01', '2026-06-30', 60000);
  expect(rows?.map((r) => r.amountHalalas)).toEqual(odd.map((r) => r.amountHalalas));
  expect(scheduleSumGap(odd, 60000)).toBe(2000);
  expect(scheduleSumGap(schedule, 60000)).toBe(0);
});

test('#3 التجديد ينقل الخدمات والمواقف · ويدخلان الأقساط وفصل الإيراد', () => {
  const { db, base } = world();
  const cid = confirmContract(db, { ...base, servicesHalalas: 9000, parkingHalalas: 3000 });
  const nid = renewContract(db, cid, {
    start: '2026-07-01', end: '2026-12-31', valueHalalas: 48000, cycle: 'شهرية', carryDeposit: false,
    extraDepositHalalas: 0, services: '', furnished: 'غير مؤثثة', ejarNo: '', note: '',
  });
  const row = db.get<{ s: number; p: number }>(`SELECT services_halalas AS s, parking_halalas AS p FROM contracts WHERE id = ?`, [nid])!;
  expect([row.s, row.p]).toEqual([9000, 3000]);
  expect(sum(insts(db, nid))).toBe(60000);
});

test('#4 مطبوعة العقد: الإيجار والخدمات والمواقف والإجمالي', () => {
  const html = buildContractDoc({ name: 'منشأة مصطنعة' } as never, {
    contractNo: 'T-1', tenantName: 'مستأجر', idNumber: '', phone: '', unitLabel: 'و', propertyName: 'ع', start: '2026-01-01', end: '2026-06-30',
    valueHalalas: 48000, servicesHalalas: 9000, parkingHalalas: 3000, depositHalalas: 0, cycle: 'شهرية', status: 'سارٍ', installments: [],
  }, '2026-01-01T00:00:00Z');
  expect(html).toContain('480.00');
  expect(html).toContain('90.00');
  expect(html).toContain('30.00');
  expect(html).toContain('600.00');
});

test('#5 تقرير الوحدة وملف المستأجر يعرضان إجمالي العقد', () => {
  const { db, u, base } = world();
  const cid = confirmContract(db, { ...base, servicesHalalas: 9000, parkingHalalas: 3000 });
  const rep = unitReportData(db, u, null, '2026-12-31')!;
  expect(rep.contracts[0].total_halalas).toBe(60000);
  const tid = db.get<{ t: string }>(`SELECT tenant_id AS t FROM contracts WHERE id = ?`, [cid])!.t;
  expect(tenantProfile(db, tid, '2026-03-01')!.contracts[0].total_halalas).toBe(60000);
});

test('#6 القوالب: {المبلغ} صفر حين لا يبقى شيء · ومتغيرات الإجمالي والخدمات والمواقف', () => {
  const { db, base } = world();
  const cid = confirmContract(db, { ...base, servicesHalalas: 9000, parkingHalalas: 3000 });
  for (const i of insts(db, cid)) pay(db, cid, i, 10000);
  const ctx = templateContext(db, cid);
  expect(ctx['{المبلغ}']).toBe('0.00');
  expect(ctx['{إجمالي_العقد}']).toBe('600.00');
  expect(ctx['{الخدمات}']).toBe('90.00');
  expect(ctx['{المواقف}']).toBe('30.00');
});

test('#7 قيمة الملغى = المتبقي من الأقساط الملغاة · بدالة واحدة في البطاقة والإحصاء', () => {
  const { db, pid, base } = world();
  const cid = confirmContract(db, { ...base, servicesHalalas: 9000, parkingHalalas: 3000 });
  const rows = insts(db, cid);
  pay(db, cid, rows[0], 4000);
  db.run(`UPDATE contract_installments SET status = 'ملغية' WHERE contract_id = ?`, [cid]);
  db.run(`UPDATE contracts SET status = 'ملغى' WHERE id = ?`, [cid]);
  const v = contractCancelledValue(db, { id: cid, status: 'ملغى', value_halalas: 48000 });
  expect(v).toBe(60000 - 4000);
  expect(propertyStats(db, pid, '2026-03-01').cancelledValue).toBe(v);
  expect(allPropertyStats(db, '2026-03-01').get(pid)?.cancelledValue).toBe(v);
});

test('#8 المتبقي على العقد من الأقساط الحيّة: يطرح الخصم ولا يحسب الملغاة', () => {
  const { db, base } = world();
  const cid = confirmContract(db, { ...base, servicesHalalas: 9000, parkingHalalas: 3000 });
  const rows = insts(db, cid);
  recordRentPayment(db, cid, { installmentId: rows[0].id, period: rows[0].due_date, date: rows[0].due_date, lines: [{ method: 'cash', amountHalalas: 9000 }], discountHalalas: 1000, discountKind: DISCOUNT_REDUCES_INSTALLMENT, notes: '' });
  db.run(`UPDATE contract_installments SET status = 'ملغية' WHERE id = ?`, [rows[5].id]);
  expect(contractRemainingHalalas(db, cid)).toBe(60000 - 10000 - 10000);
});

test('#9 التوثيق: الخدمات والمواقف فوق قيمة العقد لا جزءٌ منها', () => {
  const design = fs.readFileSync(path.join(__dirname, '..', 'docs', 'DESIGN.md'), 'utf8');
  expect(design).not.toContain('جزءٌ من قيمته');
});

test('#10 فصل الإيراد تراكمي على مستوى العقد: لا تتآكل هللات الخدمات مع كثرة الدفعات', () => {
  const { db, base } = world();
  // خدمات ٣٣٫٣٣ من إجمالي ١٣٣٫٣٣ · دفعات صغيرة تُفقد بالتقريب لكل دفعة
  const cid = confirmContract(db, { ...base, valueHalalas: 10000, servicesHalalas: 3333, parkingHalalas: 0 });
  const rows = insts(db, cid);
  let paid = 0;
  for (const i of rows) for (let k = 0; k < 3; k++) { pay(db, cid, i, 7); paid += 7; }
  expect(credit(db, '4210')).toBe(Math.floor((paid * 3333) / 13333));
  expect(credit(db, '4200') + credit(db, '4210')).toBe(paid);
});

test('#10 جهة العكس: إلغاء الدفعات يعيد الحسابات الثلاثة إلى الصفر بلا بقايا هللات', async () => {
  const { cancelPayment } = await import('@/domain/contracts/cancelPayment');
  const { db, base } = world();
  const cid = confirmContract(db, { ...base, valueHalalas: 10000, servicesHalalas: 3333, parkingHalalas: 1111 });
  const rows = insts(db, cid);
  const ids = [pay(db, cid, rows[0], 7), pay(db, cid, rows[0], 11), pay(db, cid, rows[1], 13)];
  for (const id of ids.reverse()) cancelPayment(db, id, { date: '2026-03-01', reason: 'اختبار' });
  expect([credit(db, '4200'), credit(db, '4210'), credit(db, '4220')]).toEqual([0, 0, 0]);
});

test('#10 جهة العكس في فرعها (side = debit): تسوية الفائض تعيد الحسابات إلى نسبتها من الصافي', async () => {
  const { settleSurplus, contractSurpluses } = await import('@/domain/ledgerReview');
  const { db, base } = world();
  const cid = confirmContract(db, { ...base, valueHalalas: 10000, servicesHalalas: 3333, parkingHalalas: 1111 });
  for (const i of insts(db, cid)) pay(db, cid, i, Number(i.amount_halalas));
  // دفعات صغيرة بلا قسط فوق الأقساط: فائض يُحوَّل رصيداً دائناً على دفعات
  for (let k = 0; k < 3; k++) recordRentPayment(db, cid, { installmentId: null, period: '2026-06', date: '2026-06-15', lines: [{ method: 'cash', amountHalalas: 7 }], discountHalalas: 0, notes: '' });
  const surplus = contractSurpluses(db).find((x) => x.contractId === cid)!.amount;
  expect(surplus).toBe(21);
  for (const a of [5, 9, 7]) settleSurplus(db, cid, { action: 'credit', amountHalalas: a, date: '2026-06-20' });
  const net = credit(db, '4200') + credit(db, '4210') + credit(db, '4220');
  expect(net).toBe(14444);
  expect(credit(db, '4210')).toBe(Math.floor((net * 3333) / 14444));
  expect(credit(db, '4220')).toBe(Math.floor((net * 1111) / 14444));
});
