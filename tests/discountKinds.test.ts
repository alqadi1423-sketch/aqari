/**
 * نوعا الخصم والحارس · المسار من الخدمة إلى القيد إلى القاعدة إلى الفحص المشترك وعرض الاستحقاق:
 *  «بعد الاستحقاق»: القسط بقيمته · قيد الدفعة نفسه: مدين النقد بالمقبوض، مدين 4900 بالخصم، دائن الإيراد بهما.
 *  «تنزيل من القسط»: القسط يُخفَّض بالخصم · الإيراد بالمقبوض · لا سطر 4900 · والعقد كما هو.
 * وطرق السداد وحركة البنك بالمقبوض فعلاً.
 */
import { memDb } from './helpers/testDb';
import { addProperty, addUnit, addBank, contractInput } from './helpers/fixtures';
import { confirmContract, recordRentPayment, RuleViolation } from '@/domain/contracts/service';
import { postEntry } from '@/domain/accounting/post';
import { semanticIssues } from '@/domain/backup/semantic';
import { allInstallments } from '@/domain/stats';
import { monthlyRevenueExpenseAccrual } from '@/domain/accrual';
import { DISCOUNT_AFTER_DUE, DISCOUNT_REDUCES_INSTALLMENT } from '@/domain/contracts/installments';
import type { DB } from '@/db/adapter';

const T = '2026-12-31';

function contract(db: DB, monthly = 248000) {
  const p = addProperty(db);
  const u = addUnit(db, p, { rent: monthly });
  const cid = confirmContract(db, contractInput(u, { tenant: 'مستأجر', valueHalalas: monthly * 12, depositHalalas: 0, idNumber: '1012345678',
    start: '2026-01-01', end: '2026-12-31' }));
  const insts = db.all<{ id: string }>(`SELECT id FROM contract_installments WHERE contract_id = ? ORDER BY due_date`, [cid]).map((r) => r.id);
  return { cid, insts };
}
const lines = (db: DB, paymentId: string) => db.all<{ a: string; d: number; c: number }>(
  `SELECT l.account_code AS a, l.debit_halalas AS d, l.credit_halalas AS c FROM contract_payments p
   JOIN journal_lines l ON l.entry_id = p.journal_entry_id WHERE p.id = ? ORDER BY l.account_code`, [paymentId]);
const inst = (db: DB, id: string) => db.get<{ amount: number; paid: number }>(
  `SELECT amount_halalas AS amount, paid_halalas AS paid FROM contract_installments WHERE id = ?`, [id])!;
const view = (db: DB, id: string) => allInstallments(db, T).find((x) => x.installmentId === id)!;

describe('خصم بعد الاستحقاق', () => {
  test('في قيد الدفعة نفسه: النقد بالمقبوض · 4900 بالخصم · الإيراد بهما · والقسط والعقد بقيمتهما', () => {
    const db = memDb();
    const bank = addBank(db);
    const k = contract(db);
    const pid = recordRentPayment(db, k.cid, {
      installmentId: k.insts[0], period: 'يناير', date: '2026-01-05', notes: '',
      discountHalalas: 22000, discountKind: DISCOUNT_AFTER_DUE,
      lines: [{ method: 'bank', bankId: bank, amountHalalas: 226000 }],
    });
    expect(lines(db, pid)).toEqual([
      { a: '1100', d: 226000, c: 0 }, { a: '4200', d: 0, c: 248000 }, { a: '4900', d: 22000, c: 0 },
    ]);
    expect(db.get(`SELECT gross_halalas g, discount_halalas d, net_halalas n, discount_kind k FROM contract_payments WHERE id = ?`, [pid]))
      .toEqual({ g: 248000, d: 22000, n: 226000, k: DISCOUNT_AFTER_DUE });
    // طرق السداد وحركة البنك بالمقبوض فعلاً
    expect(db.get<{ a: number }>(`SELECT amount_halalas AS a FROM payment_lines WHERE payment_id = ?`, [pid])!.a).toBe(226000);
    expect(db.get<{ a: number }>(`SELECT amount_halalas AS a FROM bank_tx ORDER BY rowid DESC LIMIT 1`)!.a).toBe(226000);
    expect(inst(db, k.insts[0])).toEqual({ amount: 248000, paid: 226000 });
    expect(db.get<{ v: number }>(`SELECT value_halalas AS v FROM contracts WHERE id = ?`, [k.cid])!.v).toBe(248000 * 12);
    expect(view(db, k.insts[0])).toMatchObject({ discount: 22000, remaining: 0, displayStatus: 'مدفوعة' });
    expect(semanticIssues(db)).toEqual([]);
    db.close();
  });
});

describe('تنزيل من قيمة القسط', () => {
  test('القسط يُخفَّض · الإيراد بالمقبوض ولا سطر 4900 · والعقد بقيمته الموثّقة · والتنزيل في سجل العمليات بتنبيه منصة إيجار', () => {
    const db = memDb();
    const k = contract(db);
    const pid = recordRentPayment(db, k.cid, {
      installmentId: k.insts[1], period: 'فبراير', date: '2026-02-05', notes: '',
      discountHalalas: 22000, discountKind: DISCOUNT_REDUCES_INSTALLMENT,
      lines: [{ method: 'cash', amountHalalas: 226000 }],
    });
    expect(lines(db, pid)).toEqual([{ a: '1100', d: 226000, c: 0 }, { a: '4200', d: 0, c: 226000 }]);
    expect(inst(db, k.insts[1])).toEqual({ amount: 226000, paid: 226000 });
    expect(db.get<{ v: number }>(`SELECT value_halalas AS v FROM contracts WHERE id = ?`, [k.cid])!.v).toBe(248000 * 12);
    // لا يُعدّ خصمه ثانية: نزل من المبلغ
    expect(view(db, k.insts[1])).toMatchObject({ discount: 0, remaining: 0, displayStatus: 'مدفوعة' });
    const log = db.get<{ e: string; b: string; a: string }>(
      `SELECT entity_name AS e, before_json AS b, after_json AS a FROM audit_log WHERE entity_type = 'تنزيل من قيمة القسط'`)!;
    expect(log.e).toContain('يخالف قيمة العقد الموثّقة في منصة إيجار');
    expect(JSON.parse(log.b)).toEqual({ amount_halalas: 248000 });
    expect(JSON.parse(log.a)).toEqual({ amount_halalas: 226000 });
    expect(semanticIssues(db)).toEqual([]);
    db.close();
  });
});

describe('لا خصم بلا نوع', () => {
  test('الخدمة ترفض خصماً بلا نوع أو بنوع غير معروف · والتنزيل بلا قسط', () => {
    const db = memDb();
    const k = contract(db);
    const base = { installmentId: k.insts[0], period: 'يناير', date: '2026-01-05', notes: '', discountHalalas: 22000,
      lines: [{ method: 'cash' as const, amountHalalas: 226000 }] };
    expect(() => recordRentPayment(db, k.cid, base)).toThrow('حدّد نوع الخصم');
    expect(() => recordRentPayment(db, k.cid, { ...base, discountKind: 'خصم ما' as never })).toThrow('نوع خصم غير معروف');
    expect(() => recordRentPayment(db, k.cid, { ...base, installmentId: null, discountKind: DISCOUNT_REDUCES_INSTALLMENT }))
      .toThrow(RuleViolation);
    expect(db.get(`SELECT id FROM contract_payments`)).toBeFalsy();
    db.close();
  });

  test('القاعدة ترفض نوعاً غير معروف أو نوعاً بلا خصم', () => {
    const db = memDb();
    const k = contract(db);
    const ins = (kind: string, disc: number) => db.run(
      `INSERT INTO contract_payments (id,contract_id,installment_id,period,date,gross_halalas,discount_halalas,net_halalas,created_at,discount_kind)
       VALUES (?,?,?,'م','2026-01-01',?,?,1000,'x',?)`, ['P' + kind + disc, k.cid, k.insts[0], 1000 + disc, disc, kind]);
    expect(() => ins('خصم ما', 100)).toThrow('نوع خصم غير معروف');
    expect(() => ins(DISCOUNT_REDUCES_INSTALLMENT, 0)).toThrow('نوع خصم بلا خصم');
    db.close();
  });
});

describe('الحارس · خصم بعد الاستحقاق بلا سطر 4900 بقيمته في الدفتر لا يُحفظ', () => {
  const entry = (db: DB, lines: { account: string; debit: number; credit: number }[], srcType = 'rent', srcId = 'x') =>
    postEntry(db, { date: '2026-01-05', memo: 'م', lines, srcType, srcId })!;

  test('إدراج: قيد الدفعة بلا سطر خصم · أو بسطر لا يساوي الخصم · مرفوض · والمساوي يمرّ', () => {
    const db = memDb();
    const k = contract(db);
    const ins = (id: string, entryId: string) => db.run(
      `INSERT INTO contract_payments (id,contract_id,installment_id,period,date,gross_halalas,discount_halalas,net_halalas,journal_entry_id,created_at,discount_kind)
       VALUES (?,?,?,'م','2026-01-05',248000,22000,226000,?,'x',?)`, [id, k.cid, k.insts[0], entryId, DISCOUNT_AFTER_DUE]);
    const noLine = entry(db, [{ account: '1100', debit: 226000, credit: 0 }, { account: '4200', debit: 0, credit: 226000 }]);
    expect(() => ins('G1', noLine.id)).toThrow('خصم بعد الاستحقاق بلا سطر خصم مساوٍ له في الدفتر');
    const wrong = entry(db, [{ account: '1100', debit: 226000, credit: 0 }, { account: '4900', debit: 10000, credit: 0 }, { account: '4200', debit: 0, credit: 236000 }]);
    expect(() => ins('G2', wrong.id)).toThrow('خصم بعد الاستحقاق بلا سطر خصم مساوٍ له في الدفتر');
    const right = entry(db, [{ account: '1100', debit: 226000, credit: 0 }, { account: '4900', debit: 22000, credit: 0 }, { account: '4200', debit: 0, credit: 248000 }]);
    expect(() => ins('G3', right.id)).not.toThrow();
    db.close();
  });

  test('تعديل: تحديد النوع على دفعة بلا سطر مرفوض · ومع قيد خصم مربوط بها بقيمته يمرّ', () => {
    const db = memDb();
    const k = contract(db);
    const e = entry(db, [{ account: '1100', debit: 226000, credit: 0 }, { account: '4200', debit: 0, credit: 226000 }]);
    db.run(`INSERT INTO contract_payments (id,contract_id,installment_id,period,date,gross_halalas,discount_halalas,net_halalas,journal_entry_id,created_at)
            VALUES ('GU',?,?,'م','2026-01-05',248000,22000,226000,?,'x')`, [k.cid, k.insts[0], e.id]);
    expect(() => db.run(`UPDATE contract_payments SET discount_kind = ? WHERE id = 'GU'`, [DISCOUNT_AFTER_DUE]))
      .toThrow('خصم بعد الاستحقاق بلا سطر خصم مساوٍ له في الدفتر');
    entry(db, [{ account: '4900', debit: 22000, credit: 0 }, { account: '4200', debit: 0, credit: 22000 }], 'discount', 'GU');
    expect(() => db.run(`UPDATE contract_payments SET discount_kind = ? WHERE id = 'GU'`, [DISCOUNT_AFTER_DUE])).not.toThrow();
    db.close();
  });

  test('الفحص المشترك للاستعادة والمزامنة يسمّي ما تجاوز الحارس (كاتب لا يمرّ بالمحفّزات)', () => {
    const db = memDb();
    const k = contract(db);
    for (const t of ['trg_pay_discount_booked_ins', 'trg_pay_discount_booked_upd', 'trg_pay_discount_kind_ins']) db.exec(`DROP TRIGGER IF EXISTS ${t}`);
    const e = entry(db, [{ account: '1100', debit: 226000, credit: 0 }, { account: '4200', debit: 0, credit: 226000 }]);
    db.run(`INSERT INTO contract_payments (id,contract_id,installment_id,period,date,gross_halalas,discount_halalas,net_halalas,journal_entry_id,created_at,discount_kind)
            VALUES ('GX',?,?,'م','2026-01-05',248000,22000,226000,?,'x',?)`, [k.cid, k.insts[0], e.id, DISCOUNT_AFTER_DUE]);
    db.run(`INSERT INTO contract_payments (id,contract_id,installment_id,period,date,gross_halalas,discount_halalas,net_halalas,created_at,discount_kind)
            VALUES ('GY',?,?,'م','2026-01-06',1000,100,900,'x','خصم ما')`, [k.cid, k.insts[2]]);
    const issues = semanticIssues(db).join(' | ');
    expect(issues).toContain('خصم بعد الاستحقاق بلا سطر خصم مساوٍ له في الدفتر: مستأجر · 2026-01-05 (0.00 من 220.00)');
    expect(issues).toContain('دفعة بنوع خصم غير معروف أو بلا خصم: مستأجر · 2026-01-06');
    db.close();
  });
});

describe('عرض الاستحقاق يطرح الخصومات من النوعين', () => {
  test('بعد الاستحقاق: الإيراد كما هو والخصم مصروف · تنزيل من القسط: يُطرح من إيراد شهره · والقيود المنقولة لا تُعدّ مرتين', () => {
    const db = memDb();
    const k = contract(db);
    const before = monthlyRevenueExpenseAccrual(db, '2026-01', '2026-03');
    recordRentPayment(db, k.cid, { installmentId: k.insts[0], period: 'يناير', date: '2026-01-05', notes: '',
      discountHalalas: 22000, discountKind: DISCOUNT_AFTER_DUE, lines: [{ method: 'cash', amountHalalas: 226000 }] });
    recordRentPayment(db, k.cid, { installmentId: k.insts[1], period: 'فبراير', date: '2026-02-05', notes: '',
      discountHalalas: 30000, discountKind: DISCOUNT_REDUCES_INSTALLMENT, lines: [{ method: 'cash', amountHalalas: 218000 }] });
    // قيد خصم منفصل مربوط بقسط مارس وقيد دفعة بمصدر البيانات المنقولة: جانب إيرادهما يحلّ محله التوزيع
    postEntry(db, { date: '2026-03-01', memo: 'خصم', srcType: 'discount', srcId: k.insts[2],
      lines: [{ account: '4900', debit: 5000, credit: 0 }, { account: '4200', debit: 0, credit: 5000 }] });
    postEntry(db, { date: '2026-03-03', memo: 'تحصيل منقول', srcType: 'rent_payment', srcId: 'x',
      lines: [{ account: '1100', debit: 190000, credit: 0 }, { account: '4200', debit: 0, credit: 190000 }] });
    const after = monthlyRevenueExpenseAccrual(db, '2026-01', '2026-03');
    expect(after.get('2026-01')!.revenue).toBe(before.get('2026-01')!.revenue);
    expect(after.get('2026-01')!.expense - before.get('2026-01')!.expense).toBe(22000);
    expect(before.get('2026-02')!.revenue - after.get('2026-02')!.revenue).toBe(30000);
    expect(after.get('2026-02')!.expense).toBe(before.get('2026-02')!.expense);
    expect(after.get('2026-03')!.revenue).toBe(before.get('2026-03')!.revenue);
    expect(after.get('2026-03')!.expense - before.get('2026-03')!.expense).toBe(5000);
    db.close();
  });
});
