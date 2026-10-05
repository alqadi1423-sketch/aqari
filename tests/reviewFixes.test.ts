/**
 * إصلاح أخطاء المراجعة الشاملة (aqari-review.md · توجيه المالك ٢٠٢٦-١٠-٠٥) · لكل بند اختبار كُتب فشل على
 * الكود السابق ثم صار دائماً. بيانات مصطنعة كلها.
 */
import { generateInstallments } from '@/domain/contracts/installments';
import { contractEndFromDuration } from '@/domain/dates';

describe('٤.١ الأقساط من تاريخ البداية بتثبيت آخر الشهر', () => {
  const dues = (start: string, end: string, cycle: string) => generateInstallments(start, end, 1200000, cycle).map((x) => x.dueDate);

  test('عقد يبدأ ٣١ يناير: قسط في كل شهر وآخر الشهر مثبّت', () => {
    expect(dues('2026-01-31', '2027-01-30', 'شهرية')).toEqual([
      '2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31', '2026-06-30',
      '2026-07-31', '2026-08-31', '2026-09-30', '2026-10-31', '2026-11-30', '2026-12-31',
    ]);
  });

  test('عقد يبدأ ٣١ أغسطس: لا يسقط سبتمبر', () => {
    const d = dues('2026-08-31', '2027-08-30', 'شهرية');
    expect(d.slice(0, 4)).toEqual(['2026-08-31', '2026-09-30', '2026-10-31', '2026-11-30']);
    expect(d[d.length - 1]).toBe('2027-07-31');
  });

  test('ربع سنوية من ٣٠ أغسطس: لا انزلاق إلى مارس', () => {
    expect(dues('2026-08-30', '2027-08-29', 'ربع سنوية')).toEqual(['2026-08-30', '2026-11-30', '2027-02-28', '2027-05-30']);
  });

  test('المجموع كما هو', () => {
    const xs = generateInstallments('2026-01-31', '2027-01-30', 1000001, 'شهرية');
    expect(xs.reduce((s, x) => s + x.amountHalalas, 0)).toBe(1000001);
  });
});

describe('٤.٨ نهاية العقد بالمدة بتثبيت آخر الشهر', () => {
  test.each([
    ['2026-01-31', 1, '2026-02-28'],
    ['2026-01-30', 1, '2026-02-28'],
    ['2026-01-29', 1, '2026-02-28'],
    ['2026-01-28', 1, '2026-02-27'],
    ['2026-01-31', 12, '2027-01-30'],
    ['2026-03-31', 1, '2026-04-30'],
    ['2028-01-31', 1, '2028-02-29'],
    ['2026-02-01', 12, '2027-01-31'],
  ])('%s + %i شهراً ← %s', (start, months, end) => {
    expect(contractEndFromDuration(start, months)).toBe(end);
  });
});

describe('٤.٢ تحصيل فاتورة المبيعات بقيد', () => {
  const setup = async () => {
    const { memDb } = await import('./helpers/testDb');
    const { addBank } = await import('./helpers/fixtures');
    const { saveInvoice } = await import('@/domain/invoices');
    const db = memDb();
    const bank = addBank(db, 'بنك فواتير تجريبي');
    const id = saveInvoice(db, { customer: 'عميل تجريبي', customerVat: '', issue: '2026-03-01', due: '2026-03-31', notes: '',
      lines: [{ descr: 'خدمة', qty: 1, priceHalalas: 100000, taxPct: 15 }] }, 'مستحقة');
    return { db, bank, id };
  };

  test('التحصيل يرحّل مدين البنك ودائن الذمم ويُسجّل حركة البنك', async () => {
    const { db, bank, id } = await setup();
    const { payInvoice } = await import('@/domain/invoices');
    const { accountBalance, bankBalance } = await import('@/domain/accounting/ledger');
    expect(accountBalance(db, '1200')).toBe(115000);
    payInvoice(db, id, { method: 'bank', bankId: bank, date: '2026-03-10' });
    expect(accountBalance(db, '1200')).toBe(0);
    expect(accountBalance(db, '1100')).toBe(115000);
    expect(bankBalance(db, bank)).toBe(115000);
    const v = db.get<{ status: string; paid_date: string; payment_journal_entry_id: string | null }>(`SELECT status, paid_date, payment_journal_entry_id FROM invoices WHERE id = ?`, [id])!;
    expect(v.status).toBe('مدفوعة');
    expect(v.paid_date).toBe('2026-03-10');
    expect(v.payment_journal_entry_id).toBeTruthy();
  });

  test('لا «مدفوعة» بلا قيد · والرجوع عنها يعكس التحصيل', async () => {
    const { db, id } = await setup();
    const { setInvoiceStatus, payInvoice } = await import('@/domain/invoices');
    const { accountBalance } = await import('@/domain/accounting/ledger');
    expect(() => setInvoiceStatus(db, id, 'مدفوعة')).toThrow();
    payInvoice(db, id, { method: 'cash', bankId: null, date: '2026-03-10' });
    setInvoiceStatus(db, id, 'مستحقة');
    expect(accountBalance(db, '1200')).toBe(115000);
    expect(accountBalance(db, '1100')).toBe(0);
  });

  test('فحص المطابقة يكشف فاتورة «مدفوعة» بلا تحصيل (بيانات سابقة)', async () => {
    const { db, id } = await setup();
    const { integrityChecks } = await import('@/domain/accounting/integrity');
    db.run(`UPDATE invoices SET status = 'مدفوعة' WHERE id = ?`, [id]); // كما كانت تفعل النسخ السابقة
    const c = integrityChecks(db).find((x) => x.name.startsWith('ذمم الفواتير'))!;
    expect(c.ok).toBe(false);
  });
});

describe('٤.٢ و٤.٦ حذف الفاتورة المحصّلة واسترجاعها', () => {
  test('الاسترجاع يعيد قيد الإصدار والتحصيل وحركة البنك كما كانت', async () => {
    const { memDb } = await import('./helpers/testDb');
    const { addBank } = await import('./helpers/fixtures');
    const { saveInvoice, payInvoice, deleteInvoice, restoreInvoice } = await import('@/domain/invoices');
    const { accountBalance, bankBalance } = await import('@/domain/accounting/ledger');
    const { integrityChecks } = await import('@/domain/accounting/integrity');
    const db = memDb();
    const bank = addBank(db, 'بنك استرجاع تجريبي');
    const id = saveInvoice(db, { customer: 'عميل استرجاع', customerVat: '', issue: '2026-04-01', due: '2026-04-30', notes: '',
      lines: [{ descr: 'خدمة', qty: 2, priceHalalas: 50000, taxPct: 15 }] }, 'مستحقة');
    payInvoice(db, id, { method: 'bank', bankId: bank, date: '2026-04-12' });
    deleteInvoice(db, id);
    expect(accountBalance(db, '1100')).toBe(0);
    expect(bankBalance(db, bank)).toBe(0);
    restoreInvoice(db, id);
    expect(accountBalance(db, '1200')).toBe(0);
    expect(accountBalance(db, '1100')).toBe(115000);
    expect(bankBalance(db, bank)).toBe(115000);
    const v = db.get<{ status: string; paid_date: string }>(`SELECT status, paid_date FROM invoices WHERE id = ?`, [id])!;
    expect(v).toEqual({ status: 'مدفوعة', paid_date: '2026-04-12' });
    expect(integrityChecks(db).every((c) => c.ok)).toBe(true);
  });

  test('بنك التحصيل محذوف: يرفض الاسترجاع بسبب واضح ولا يغيّر شيئاً', async () => {
    const { memDb } = await import('./helpers/testDb');
    const { addBank } = await import('./helpers/fixtures');
    const { saveInvoice, payInvoice, deleteInvoice, restoreInvoice } = await import('@/domain/invoices');
    const db = memDb();
    const bank = addBank(db, 'بنك محذوف تجريبي');
    const id = saveInvoice(db, { customer: 'عميل', customerVat: '', issue: '2026-04-01', due: '2026-04-30', notes: '',
      lines: [{ descr: 'خدمة', qty: 1, priceHalalas: 10000, taxPct: 0 }] }, 'مستحقة');
    payInvoice(db, id, { method: 'bank', bankId: bank, date: '2026-04-12' });
    deleteInvoice(db, id);
    db.run(`UPDATE banks SET deleted_at = ? WHERE id = ?`, ['2026-04-13T00:00:00Z', bank]);
    expect(() => restoreInvoice(db, id)).toThrow(/البنك/);
    expect(db.get<{ d: string | null }>(`SELECT deleted_at AS d FROM invoices WHERE id = ?`, [id])!.d).toBeTruthy();
  });
});

test('٤.٢ تعديل فاتورة محصّلة يُرفض فلا يبقى قيد تحصيل بلا فاتورة مدفوعة', async () => {
  const { memDb } = await import('./helpers/testDb');
  const { saveInvoice, payInvoice } = await import('@/domain/invoices');
  const db = memDb();
  const input = { customer: 'عميل تعديل', customerVat: '', issue: '2026-05-01', due: '2026-05-31', notes: '',
    lines: [{ descr: 'خدمة', qty: 1, priceHalalas: 20000, taxPct: 0 }] };
  const id = saveInvoice(db, input, 'مستحقة');
  payInvoice(db, id, { method: 'cash', bankId: null, date: '2026-05-02' });
  expect(() => saveInvoice(db, { ...input, lines: [{ descr: 'خدمة', qty: 2, priceHalalas: 20000, taxPct: 0 }] }, 'مستحقة', id)).toThrow(/التحصيل/);
});

test('٤.٢ أداة البيانات السابقة: تحصيل فاتورة «مدفوعة» بلا قيد يُصلح الفحص', async () => {
  const { memDb } = await import('./helpers/testDb');
  const { saveInvoice, payInvoice } = await import('@/domain/invoices');
  const { integrityChecks } = await import('@/domain/accounting/integrity');
  const db = memDb();
  const id = saveInvoice(db, { customer: 'عميل سابق', customerVat: '', issue: '2026-02-01', due: '2026-02-28', notes: '',
    lines: [{ descr: 'خدمة', qty: 1, priceHalalas: 30000, taxPct: 15 }] }, 'مستحقة');
  db.run(`UPDATE invoices SET status = 'مدفوعة' WHERE id = ?`, [id]);
  const chk = () => integrityChecks(db).find((x) => x.name.startsWith('ذمم الفواتير'))!.ok;
  expect(chk()).toBe(false);
  payInvoice(db, id, { method: 'cash', bankId: null, date: '2026-02-20' });
  expect(chk()).toBe(true);
});

describe('٤.٤ و٤.٥ العربون: التحويل والرد والمطابقة', () => {
  const setup = async (deposit = 100000) => {
    const { memDb } = await import('./helpers/testDb');
    const { addProperty, addUnit, contractInput } = await import('./helpers/fixtures');
    const { createReservation } = await import('@/domain/reservations');
    const { today, addDays } = await import('@/domain/dates');
    const db = memDb();
    const unit = addUnit(db, addProperty(db));
    const rsvId = createReservation(db, { unitId: unit, name: 'صاحب حجز تجريبي', phone: '0500000101', depositHalalas: deposit, expiryDate: addDays(today(), 30) });
    const start = addDays(today(), 10);
    const input = { ...contractInput(unit, { tenant: 'صاحب  حجز تجريبي', start, end: addDays(start, 364), valueHalalas: 1200000, cycle: 'شهرية', depositHalalas: 0 }) };
    return { db, unit, rsvId, start, input };
  };
  const check = async (db: unknown, prefix: string) => {
    const { integrityChecks } = await import('@/domain/accounting/integrity');
    return integrityChecks(db as never).find((x) => x.name.startsWith(prefix))!;
  };

  test('التحويل بمعرّف الحجز: العربون دفعةٌ على القسط الأول بتاريخ العقد · مدين 2450 دائن الإيراد', async () => {
    const { db, rsvId, start, input } = await setup();
    const { confirmContract } = await import('@/domain/contracts/service');
    const { accountBalance } = await import('@/domain/accounting/ledger');
    // الاسم بمسافة زائدة: الربط بالمعرّف لا بالنص
    const cid = confirmContract(db, { ...input, reservationId: rsvId });
    expect(accountBalance(db, '2450')).toBe(0);
    expect(accountBalance(db, '1200')).toBe(0);
    expect(accountBalance(db, '4200')).toBe(100000);
    const first = db.get<{ paid_halalas: number }>(`SELECT paid_halalas FROM contract_installments WHERE contract_id = ? ORDER BY due_date LIMIT 1`, [cid])!;
    expect(first.paid_halalas).toBe(100000);
    const p = db.get<{ date: string; net_halalas: number }>(`SELECT date, net_halalas FROM contract_payments WHERE contract_id = ?`, [cid])!;
    expect(p).toEqual({ date: start, net_halalas: 100000 });
    const e = db.get<{ date: string }>(`SELECT date FROM journal_entries WHERE src_type = 'reservation_convert' AND src_id = ?`, [rsvId])!;
    expect(e.date).toBe(start);
    expect(db.get<{ status: string; converted_contract_id: string }>(`SELECT status, converted_contract_id FROM reservations WHERE id = ?`, [rsvId]))
      .toEqual({ status: 'محوَّل لعقد', converted_contract_id: cid });
    expect((await check(db, 'عربون الحجوزات')).ok).toBe(true);
    expect((await check(db, 'ذمم الفواتير')).ok).toBe(true);
  });

  test('عربون أكبر من القسط الأول يغطي ما بعده بالترتيب', async () => {
    const { db, rsvId, input } = await setup(250000);
    const { confirmContract } = await import('@/domain/contracts/service');
    const cid = confirmContract(db, { ...input, reservationId: rsvId });
    const paid = db.all<{ paid_halalas: number }>(`SELECT paid_halalas FROM contract_installments WHERE contract_id = ? ORDER BY due_date LIMIT 3`, [cid]).map((r) => r.paid_halalas);
    expect(paid).toEqual([100000, 100000, 50000]);
  });

  test('وحدة محجوزة: عقد بلا معرّف الحجز يُرفض ولو تطابق الاسم', async () => {
    const { db, input } = await setup();
    const { confirmContract } = await import('@/domain/contracts/service');
    expect(() => confirmContract(db, { ...input, tenant: 'صاحب حجز تجريبي' })).toThrow(/محجوزة/);
  });

  test('إلغاء الحجز برد العربون يرحّل قيد الرد (مدين 2450 / دائن النقد)', async () => {
    const { db, rsvId } = await setup();
    const { cancelReservation } = await import('@/domain/reservations');
    const { accountBalance } = await import('@/domain/accounting/ledger');
    expect(accountBalance(db, '1100')).toBe(100000);
    cancelReservation(db, rsvId, false);
    expect(accountBalance(db, '2450')).toBe(0);
    expect(accountBalance(db, '1100')).toBe(0);
    expect((await check(db, 'عربون الحجوزات')).ok).toBe(true);
    // لا تسوية ثانية لعربون سُوّي
    expect(() => cancelReservation(db, rsvId, true)).toThrow();
  });

  test('فحص 2450 يكشف عربوناً باقياً في الدفتر لحجز محذوف', async () => {
    const { db, rsvId } = await setup();
    db.run(`UPDATE reservations SET deleted_at = ? WHERE id = ?`, ['2026-01-01T00:00:00Z', rsvId]);
    expect((await check(db, 'عربون الحجوزات')).ok).toBe(false);
  });
});

describe('أدوات البيانات السابقة · معاينة ثم تطبيق بقرار المالك', () => {
  test('٤.٤ تحويل عربون قديم (2450/1200): المعاينة تسرده والتطبيق يعكسه ويسدّد به المتبقي', async () => {
    const { memDb } = await import('./helpers/testDb');
    const { addProperty, addUnit, contractInput } = await import('./helpers/fixtures');
    const { confirmContract, recordRentPayment } = await import('@/domain/contracts/service');
    const { postReservationDeposit } = await import('@/domain/accounting/post');
    const { postEntry } = await import('@/domain/accounting/post');
    const { accountBalance } = await import('@/domain/accounting/ledger');
    const { integrityChecks } = await import('@/domain/accounting/integrity');
    const { previewRepairs, applyRepair } = await import('@/domain/reviewRepairs');
    const db = memDb();
    const unit = addUnit(db, addProperty(db));
    const cid = confirmContract(db, contractInput(unit, { tenant: 'مستأجر قديم', start: '2026-02-01', end: '2027-01-31', valueHalalas: 1200000, cycle: 'شهرية', depositHalalas: 0 }));
    const first = db.get<{ id: string }>(`SELECT id FROM contract_installments WHERE contract_id = ? ORDER BY due_date LIMIT 1`, [cid])!;
    // المستأجر سدّد القسط الأول كاملاً كما كان يحدث (العربون لم ينقصه)
    recordRentPayment(db, cid, { installmentId: first.id, period: 'الأول', date: '2026-02-01', lines: [{ method: 'cash', amountHalalas: 100000 }], discountHalalas: 0, notes: '' });
    const rid = 'R_legacy';
    db.run(`INSERT INTO reservations (id, unit_id, name, deposit_halalas, expiry_date, created_date, status, converted_contract_id)
            VALUES (?,?,?,?,?,?,'محوَّل لعقد',?)`, [rid, unit, 'مستأجر قديم', 60000, '2026-02-10', '2026-01-20', cid]);
    postReservationDeposit(db, { id: rid, name: 'مستأجر قديم', deposit: 60000, date: '2026-01-20' });
    postEntry(db, { date: '2026-01-25', memo: 'تحويل عربون إلى عقد (قديم)', srcType: 'reservation_convert', srcId: rid,
      lines: [{ account: '2450', debit: 60000, credit: 0 }, { account: '1200', debit: 0, credit: 60000 }] });
    expect(accountBalance(db, '1200')).toBe(-60000);

    const p = previewRepairs(db).find((r) => r.key === 'reservation_convert')!;
    expect(p.items).toHaveLength(1);
    expect(accountBalance(db, '1200')).toBe(-60000); // المعاينة لا تغيّر شيئاً

    applyRepair(db, 'reservation_convert');
    expect(accountBalance(db, '1200')).toBe(0);
    expect(accountBalance(db, '2450')).toBe(0);
    const paid = db.all<{ paid_halalas: number }>(`SELECT paid_halalas FROM contract_installments WHERE contract_id = ? ORDER BY due_date LIMIT 2`, [cid]).map((r) => r.paid_halalas);
    expect(paid).toEqual([100000, 60000]); // الأول مسدَّد فذهب العربون للثاني
    expect(integrityChecks(db).filter((c) => !c.ok)).toEqual([]);
    expect(previewRepairs(db).find((r) => r.key === 'reservation_convert')!.items).toHaveLength(0);
  });

  test('٤.١ أقساط انزلقت بالخوارزمية السابقة: المعاينة تسرد الفرق والتطبيق يثبّتها على آخر الشهر', async () => {
    const { memDb } = await import('./helpers/testDb');
    const { addProperty, addUnit, contractInput } = await import('./helpers/fixtures');
    const { confirmContract } = await import('@/domain/contracts/service');
    const { previewRepairs, applyRepair } = await import('@/domain/reviewRepairs');
    const db = memDb();
    const unit = addUnit(db, addProperty(db));
    const cid = confirmContract(db, contractInput(unit, { tenant: 'مستأجر انزلاق', start: '2026-01-31', end: '2027-01-30', valueHalalas: 1200000, cycle: 'شهرية', depositHalalas: 0 }));
    // التواريخ كما كانت الخوارزمية السابقة تولّدها: ٣١ يناير ثم ٣ مارس ثم ٣ أبريل...
    const old = ['2026-01-31', '2026-03-03', '2026-04-03', '2026-05-03', '2026-06-03', '2026-07-03', '2026-08-03', '2026-09-03', '2026-10-03', '2026-11-03', '2026-12-03', '2027-01-03'];
    const ids = db.all<{ id: string }>(`SELECT id FROM contract_installments WHERE contract_id = ? ORDER BY sort`, [cid]).map((r) => r.id);
    ids.forEach((id, i) => db.run(`UPDATE contract_installments SET due_date = ? WHERE id = ?`, [old[i], id]));

    const p = previewRepairs(db).find((r) => r.key === 'installment_drift')!;
    expect(p.items).toHaveLength(1);
    applyRepair(db, 'installment_drift');
    const now = db.all<{ due_date: string }>(`SELECT due_date FROM contract_installments WHERE contract_id = ? ORDER BY sort`, [cid]).map((r) => r.due_date);
    expect(now.slice(0, 3)).toEqual(['2026-01-31', '2026-02-28', '2026-03-31']);
    expect(previewRepairs(db).find((r) => r.key === 'installment_drift')!.items).toHaveLength(0);
  });

  test('٤.١ جدولٌ عُدّل يدوياً لا يمسّه التطبيق', async () => {
    const { memDb } = await import('./helpers/testDb');
    const { addProperty, addUnit, contractInput } = await import('./helpers/fixtures');
    const { confirmContract } = await import('@/domain/contracts/service');
    const { previewRepairs } = await import('@/domain/reviewRepairs');
    const db = memDb();
    const unit = addUnit(db, addProperty(db));
    const cid = confirmContract(db, contractInput(unit, { tenant: 'مستأجر يدوي', start: '2026-01-31', end: '2027-01-30', valueHalalas: 1200000, cycle: 'شهرية', depositHalalas: 0 }));
    db.run(`UPDATE contract_installments SET due_date = '2026-02-15' WHERE contract_id = ? AND sort = 1`, [cid]);
    expect(previewRepairs(db).find((r) => r.key === 'installment_drift')!.items).toHaveLength(0);
  });
});

describe('٤.٣ الدفعات الملغاة خارج كل قراءة', () => {
  const setup = async () => {
    const { memDb } = await import('./helpers/testDb');
    const { addProperty, addUnit, contractInput } = await import('./helpers/fixtures');
    const { confirmContract, recordRentPayment } = await import('@/domain/contracts/service');
    const { cancelPayment } = await import('@/domain/contracts/cancelPayment');
    const db = memDb();
    const prop = addProperty(db);
    const unit = addUnit(db, prop);
    const cid = confirmContract(db, contractInput(unit, { tenant: 'مستأجر إلغاء', start: '2026-01-01', end: '2026-12-31', valueHalalas: 1200000, cycle: 'شهرية', depositHalalas: 0 }));
    const insts = db.all<{ id: string }>(`SELECT id FROM contract_installments WHERE contract_id = ? ORDER BY due_date`, [cid]);
    const pay = (iid: string, d: string) => recordRentPayment(db, cid, { installmentId: iid, period: d, date: d, lines: [{ method: 'cash', amountHalalas: 100000 }], discountHalalas: 0, notes: '' });
    pay(insts[0].id, '2026-01-05');
    const bad = pay(insts[1].id, '2026-02-05');
    cancelPayment(db, bad, { reason: 'سُجّلت خطأً', date: '2026-02-06' });
    expect(db.get<{ c: string | null }>(`SELECT cancelled_at AS c FROM contract_payments WHERE id = ?`, [bad])!.c).toBeTruthy();
    return { db, cid, unit, prop };
  };

  test('الإقرار الضريبي: الإيجار المعفى وكشفه بلا الملغاة', async () => {
    const { db } = await setup();
    const { vatReturnData } = await import('@/domain/vatReturn');
    const r = vatReturnData(db, 2026, 1);
    expect(r.schedules.exemptSales.map((x) => x.net)).toEqual([100000]);
    expect(r.items.some((i) => i.amountHalalas === 200000)).toBe(false);
    expect(r.items.some((i) => i.amountHalalas === 100000)).toBe(true);
  });

  test('كشف حساب المستأجر: الملغاة لا تظهر سداداً', async () => {
    const { db, cid } = await setup();
    const { tenantStatementRows } = await import('@/domain/statement');
    const credits = tenantStatementRows(db, cid).filter((r) => r.creditHalalas > 0).map((r) => r.creditHalalas);
    expect(credits).toEqual([100000]);
  });

  test('تقرير الوحدة والعقار: التحصيل بلا الملغاة', async () => {
    const { db, unit, prop } = await setup();
    const { unitReportData, propertyReportData } = await import('@/domain/reportData');
    const u = unitReportData(db, unit, null, '2026-12-31')!;
    expect(u.payments.map((p) => p.net_halalas)).toEqual([100000]);
    expect(u.totals.income).toBe(100000);
    const p = propertyReportData(db, prop, null, '2026-12-31')!;
    expect(p.payments.map((x) => x.net_halalas)).toEqual([100000]);
  });

  test('دخل العقد بلا أقساط: بلا الملغاة', async () => {
    const { memDb } = await import('./helpers/testDb');
    const { addProperty, addUnit, contractInput } = await import('./helpers/fixtures');
    const { confirmContract, recordRentPayment } = await import('@/domain/contracts/service');
    const { cancelPayment } = await import('@/domain/contracts/cancelPayment');
    const { contractCollectedValue } = await import('@/domain/stats');
    const db = memDb();
    const cid = confirmContract(db, contractInput(addUnit(db, addProperty(db)), { tenant: 'عقد بلا جدول', start: '2026-01-01', end: '2026-12-31', valueHalalas: 1200000, cycle: 'شهرية', depositHalalas: 0 }));
    db.run(`DELETE FROM contract_installments WHERE contract_id = ?`, [cid]); // عقد قديم بلا جدول أقساط
    const pay = (d: string) => recordRentPayment(db, cid, { period: d, date: d, lines: [{ method: 'cash', amountHalalas: 100000 }], discountHalalas: 0, notes: '' });
    pay('2026-01-05');
    cancelPayment(db, pay('2026-02-05'), { reason: 'خطأ', date: '2026-02-06' });
    expect(contractCollectedValue(db, cid)).toBe(100000);
  });

  test('كل استعلام يقرأ الدفعات يستبعد الملغاة أو يعلّل شمولها', () => {
    // جرد ثابت: نص SQL يقرأ من contract_payments (FROM أو JOIN) إما فيه cancelled_at، أو يجلب صفاً بمعرّفه،
    // أو فيه تعليل «/* تشمل الملغاة: ... */» · فلا يُضاف استعلام جديد ينسى الملغاة
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs') as typeof import('fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('path') as typeof import('path');
    const root = path.join(__dirname, '..');
    const walk = (d: string, out: string[] = []): string[] => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p, out);
        else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
      }
      return out;
    };
    const bad: string[] = [];
    for (const f of [...walk(path.join(root, 'src')), ...walk(path.join(root, 'app'))]) {
      const s = fs.readFileSync(f, 'utf8');
      const re = /`[^`]*`/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(s))) {
        const q = m[0];
        if (!/\b(FROM|JOIN)\s+contract_payments/i.test(q)) continue;
        if (/^`\s*(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)/i.test(q)) continue;
        if (/cancelled_at/.test(q) || /\/\* تشمل الملغاة:/.test(q)) continue;
        if (/WHERE\s+(\w+\.)?id\s*=\s*\?/i.test(q)) continue;
        bad.push(path.relative(root, f) + ':' + s.slice(0, m.index).split('\n').length);
      }
    }
    expect(bad).toEqual([]);
  });
});

describe('٤.٦ الاستعادة من السلة تعيد القيود كما كانت أو ترفض بسبب', () => {
  const base = async () => {
    const { memDb } = await import('./helpers/testDb');
    const { addProperty, addUnit, addBank, contractInput } = await import('./helpers/fixtures');
    const { confirmContract } = await import('@/domain/contracts/service');
    const db = memDb();
    const unit = addUnit(db, addProperty(db));
    const cid = confirmContract(db, contractInput(unit, { tenant: 'مستأجر سلة', start: '2026-01-01', end: '2026-12-31', valueHalalas: 1200000, cycle: 'شهرية', depositHalalas: 0 }));
    const bank = addBank(db, 'بنك سلة تجريبي', 5000000);
    return { db, unit, cid, bank };
  };
  /** أرصدة كل الحسابات · لمقارنة الدفتر قبل الحذف وبعد الاستعادة */
  const balances = async (db: unknown) => {
    const { allAccountBalances } = await import('@/domain/accounting/ledger');
    return Object.fromEntries([...allAccountBalances(db as never)].filter(([, v]) => v !== 0));
  };
  const allOk = async (db: unknown) => {
    const { integrityChecks } = await import('@/domain/accounting/integrity');
    return integrityChecks(db as never).filter((c) => !c.ok).map((c) => c.name + ' ' + c.value);
  };

  test('مطالبة مفتوحة: تُستعاد بقيدها فتحصيلها بعدها لا يجعل 1250 سالباً', async () => {
    const { db, cid } = await base();
    const { saveClaim, deleteClaim, collectClaim } = await import('@/domain/claims');
    const { restoreFromTrash } = await import('@/domain/trash');
    const { accountBalance } = await import('@/domain/accounting/ledger');
    const id = saveClaim(db, { contractId: cid, amountHalalas: 30000, reason: 'كسر', date: '2026-03-01' });
    const before = await balances(db);
    deleteClaim(db, id);
    restoreFromTrash(db, 'claims', id);
    expect(await balances(db)).toEqual(before);
    collectClaim(db, id, '2026-03-10');
    expect(accountBalance(db, '1250')).toBe(0);
    expect(await allOk(db)).toEqual([]);
  });

  test('صفقة تقبيل ملغاة: تُستعاد بقيد عمولتها وحركة بنكها', async () => {
    const { db, unit, bank } = await base();
    const { recordKeyMoneyDeal } = await import('@/domain/keymoney');
    const { entrySourceAction } = await import('@/domain/accounting/sourceCancel');
    const { restoreFromTrash } = await import('@/domain/trash');
    const { bankBalance } = await import('@/domain/accounting/ledger');
    const id = recordKeyMoneyDeal(db, { unitId: unit, outgoing: 'مغادر', incoming: 'قادم', amountHalalas: 500000, date: '2026-04-01', commissionHalalas: 25000, method: 'bank', bankId: bank, notes: '' });
    const before = await balances(db);
    const bankBefore = bankBalance(db, bank);
    const e = db.get<{ id: string }>(`SELECT id FROM journal_entries WHERE src_type = 'key_money' AND src_id = ?`, [id])!;
    const op = entrySourceAction(db, e.id);
    if (!op || op.kind !== 'op') throw new Error('لا إجراء');
    op.run('2026-04-05', 'خطأ');
    restoreFromTrash(db, 'key_money_deals', id);
    expect(await balances(db)).toEqual(before);
    expect(bankBalance(db, bank)).toBe(bankBefore);
    expect(await allOk(db)).toEqual([]);
  });

  test('فاتورة شراء قابلة للخصم بفرق تقريب ومسدَّدة: تُستعاد بقيدها نفسه وسدادها', async () => {
    const { db, bank } = await base();
    const { savePurchase, payPurchaseSplit, deletePurchase, TS_DEDUCTIBLE } = await import('@/domain/purchases');
    const { restoreFromTrash } = await import('@/domain/trash');
    const { bankBalance } = await import('@/domain/accounting/ledger');
    db.run(`INSERT INTO suppliers (id, name, vat, created_at) VALUES (?,?,?,?)`, ['S_vat', 'مورد ضريبي تجريبي', '300000000000003', '2026-01-01T00:00:00Z']);
    const id = savePurchase(db, {
      supplier: 'مورد ضريبي تجريبي', date: '2026-05-01', due: '2026-05-31', category: 'صيانة', incorpItem: '',
      amortize: false, amortizeMonths: null, exempt: false, excludeFromVat: false, taxStatus: TS_DEDUCTIBLE,
      subtotalHalalas: 10001, taxHalalas: 1500, totalHalalas: 11502, roundingDiffHalalas: 1,
    });
    payPurchaseSplit(db, id, [{ method: 'bank', bankId: bank, amountHalalas: 11502 }], '2026-05-03');
    const before = await balances(db);
    const bankBefore = bankBalance(db, bank);
    expect(before['1270']).toBe(1500);
    deletePurchase(db, id);
    restoreFromTrash(db, 'purchases', id);
    expect(await balances(db)).toEqual(before);
    expect(bankBalance(db, bank)).toBe(bankBefore);
    expect(db.get<{ paid: number }>(`SELECT paid FROM purchases WHERE id = ?`, [id])!.paid).toBe(1);
    expect(await allOk(db)).toEqual([]);
  });

  test('بنك السداد محذوف: الاستعادة تُرفض بسببها ولا يتغير شيء', async () => {
    const { db, bank } = await base();
    const { savePurchase, payPurchaseSplit, deletePurchase } = await import('@/domain/purchases');
    const { restoreFromTrash } = await import('@/domain/trash');
    const id = savePurchase(db, {
      supplier: 'مورد عادي', date: '2026-05-01', due: '2026-05-31', category: 'صيانة', incorpItem: '',
      amortize: false, amortizeMonths: null, exempt: false, excludeFromVat: false,
      subtotalHalalas: 20000, taxHalalas: 0, totalHalalas: 20000,
    });
    payPurchaseSplit(db, id, [{ method: 'bank', bankId: bank, amountHalalas: 20000 }], '2026-05-03');
    deletePurchase(db, id);
    const mid = await balances(db);
    db.run(`UPDATE banks SET deleted_at = ? WHERE id = ?`, ['2026-05-04T00:00:00Z', bank]);
    expect(() => restoreFromTrash(db, 'purchases', id)).toThrow(/البنك/);
    expect(await balances(db)).toEqual(mid);
    expect(db.get<{ d: string | null }>(`SELECT deleted_at AS d FROM purchases WHERE id = ?`, [id])!.d).toBeTruthy();
  });

  test('حركة بنكية مرتبطة بقيد لا تُحذف · واليدوية تُحذف وتُستعاد', async () => {
    const { db, bank } = await base();
    const { deleteBankTx } = await import('@/domain/bankTx');
    const { savePurchase, payPurchaseSplit } = await import('@/domain/purchases');
    const { restoreFromTrash } = await import('@/domain/trash');
    const { bankBalance } = await import('@/domain/accounting/ledger');
    const pid = savePurchase(db, {
      supplier: 'مورد', date: '2026-05-01', due: '2026-05-31', category: 'صيانة', incorpItem: '',
      amortize: false, amortizeMonths: null, exempt: false, excludeFromVat: false,
      subtotalHalalas: 1000, taxHalalas: 0, totalHalalas: 1000,
    });
    payPurchaseSplit(db, pid, [{ method: 'bank', bankId: bank, amountHalalas: 1000 }], '2026-05-03');
    const linked = db.get<{ id: string }>(`SELECT id FROM bank_tx WHERE journal_no != '' AND bank_id = ?`, [bank])!;
    expect(() => deleteBankTx(db, linked.id)).toThrow(/قيد/);
    db.run(`INSERT INTO bank_tx (id, bank_id, date, descr, amount_halalas, matched, source, created_at) VALUES ('T_manual',?,?,?,?,0,'',?)`,
      [bank, '2026-05-05', 'حركة يدوية', 700, '2026-05-05T00:00:00Z']);
    const b0 = bankBalance(db, bank);
    deleteBankTx(db, 'T_manual');
    expect(bankBalance(db, bank)).toBe(b0 - 700);
    restoreFromTrash(db, 'bank_tx', 'T_manual');
    expect(bankBalance(db, bank)).toBe(b0);
  });
});

describe('٤.٩ و٤.١٠ و٤.١١ المتبقي والتأخير بدالة واحدة مع شاشة التحصيل', () => {
  const T = '2026-06-15';
  const setup = async () => {
    const { memDb } = await import('./helpers/testDb');
    const { addProperty, addUnit, contractInput } = await import('./helpers/fixtures');
    const { confirmContract } = await import('@/domain/contracts/service');
    const db = memDb();
    const cid = confirmContract(db, contractInput(addUnit(db, addProperty(db)), { tenant: 'مستأجر متأخرات', start: '2026-01-01', end: '2026-12-31', valueHalalas: 1200000, cycle: 'شهرية', depositHalalas: 0 }));
    const insts = db.all<{ id: string; due_date: string }>(`SELECT id, due_date FROM contract_installments WHERE contract_id = ? ORDER BY due_date`, [cid]);
    return { db, cid, insts };
  };
  const late = async (db: unknown) => {
    const { computeReminders } = await import('@/domain/reminders');
    return computeReminders(db as never, T).filter((r) => r.kind === 'دفعة متأخرة').map((r) => r.entityId);
  };

  test('٤.٩ عقد ملغى: متأخراته تظهر في التنبيهات وتُحصَّل', async () => {
    const { db, cid, insts } = await setup();
    const { cancelContract, recordRentPayment } = await import('@/domain/contracts/service');
    cancelContract(db, cid, { date: '2026-03-10', reason: 'مغادرة', installmentsFate: 'cancel', settle: false, deductionHalalas: 0, refundHalalas: 0, deductionReason: '' });
    // يناير وفبراير ومارس قبل الإلغاء باقية دَيناً
    expect(await late(db)).toEqual([insts[0].id, insts[1].id, insts[2].id]);
    recordRentPayment(db, cid, { installmentId: insts[0].id, period: 'يناير', date: T, lines: [{ method: 'cash', amountHalalas: 100000 }], discountHalalas: 0, notes: '' });
    expect(await late(db)).toEqual([insts[1].id, insts[2].id]);
    // بلا قسط محدد لا دفعة على عقد ملغى
    expect(() => recordRentPayment(db, cid, { period: 'عام', date: T, lines: [{ method: 'cash', amountHalalas: 1000 }], discountHalalas: 0, notes: '' })).toThrow(/ملغى/);
  });

  test('٤.١٠ قسط سُدّد مع خصم ليس متأخراً · و{المبلغ} يطرح الخصم', async () => {
    const { db, cid, insts } = await setup();
    const { recordRentPayment } = await import('@/domain/contracts/service');
    const { templateContext } = await import('@/domain/templates');
    const { DISCOUNT_AFTER_DUE } = await import('@/domain/contracts/installments');
    for (const i of insts.slice(0, 5)) {
      recordRentPayment(db, cid, { installmentId: i.id, period: i.due_date, date: i.due_date, lines: [{ method: 'cash', amountHalalas: 90000 }], discountHalalas: 10000, discountKind: DISCOUNT_AFTER_DUE, notes: '' });
    }
    // يونيو: نصفه مسدَّد وله خصم ١٠٠
    recordRentPayment(db, cid, { installmentId: insts[5].id, period: 'يونيو', date: T, lines: [{ method: 'cash', amountHalalas: 50000 }], discountHalalas: 10000, discountKind: DISCOUNT_AFTER_DUE, notes: '' });
    expect(await late(db)).toEqual([insts[5].id]); // يونيو وحده: بقي عليه ٤٠٠ بعد الخصم
    expect(templateContext(db, cid)['{المبلغ}']).toBe('400.00');
  });

  test('٤.١١ الموعد المتفق عليه والمهلة: لا «دفعة متأخرة» قبلهما · والإشعار بالموعد المتفق عليه', async () => {
    const { db, insts } = await setup();
    const { computeSchedule } = await import('@/domain/reminders');
    for (const i of insts.slice(0, 5)) db.run(`UPDATE contract_installments SET paid_halalas = amount_halalas, status = 'مدفوعة' WHERE id = ?`, [i.id]);
    db.run(`UPDATE contract_installments SET agreed_date = '2026-06-25' WHERE id = ?`, [insts[5].id]); // يونيو أُجّل
    db.run(`UPDATE contract_installments SET grace_until = '2026-07-05' WHERE id = ?`, [insts[6].id]);
    expect(await late(db)).toEqual([]);
    const fire = computeSchedule(db, T).find((s) => s.entityId === insts[5].id);
    expect(fire?.body).toContain('25/06/2026');
  });
});

describe('٤.١٢ نقل وحدة إلى عقار آخر يعيد وسم كل ما تحتها', () => {
  test('كل صف صار من العقار الجديد يُعاد رفعه · وما يحمل العقار نصاً يُحدَّث', async () => {
    const { memDb } = await import('./helpers/testDb');
    const { addProperty, addBank, contractInput } = await import('./helpers/fixtures');
    const { confirmContract, recordRentPayment, recordBulkRentPayment } = await import('@/domain/contracts/service');
    const { saveClaim } = await import('@/domain/claims');
    const { savePurchase } = await import('@/domain/purchases');
    const { saveInvoice, payInvoice } = await import('@/domain/invoices');
    const { recordKeyMoneyDeal } = await import('@/domain/keymoney');
    const { saveUnit } = await import('@/domain/propertiesService');
    const { SYNC_TABLES } = await import('@/db/syncTables');
    const { rowPids } = await import('@/sync/acl');
    const db = memDb();
    const A = addProperty(db, { name: 'عقار أ' });
    const B = addProperty(db, { name: 'عقار ب' });
    const unitInput = (p: string) => ({ propertyId: p, unitNo: 'N-1', floor: '', type: 'سكني', subtype: '', rentMonthlyHalalas: 0,
      rooms: [{ name: 'غرفة', items: [{ name: 'باب', descr: '' }] }], meters: [{ kind: 'كهرباء', number: '100' }] });
    const unit = saveUnit(db, unitInput(A));
    const bank = addBank(db, 'بنك نقل', 1000000);
    const cid = confirmContract(db, contractInput(unit, { tenant: 'مستأجر نقل', start: '2026-01-01', end: '2026-12-31', valueHalalas: 1200000, cycle: 'شهرية', depositHalalas: 50000 }));
    const insts = db.all<{ id: string }>(`SELECT id FROM contract_installments WHERE contract_id = ? ORDER BY due_date`, [cid]);
    recordRentPayment(db, cid, { installmentId: insts[0].id, period: 'يناير', date: '2026-01-05', lines: [{ method: 'bank', bankId: bank, amountHalalas: 100000 }], discountHalalas: 0, notes: '' });
    recordBulkRentPayment(db, cid, { installmentIds: [insts[1].id, insts[2].id], date: '2026-02-05', lines: [{ method: 'cash', amountHalalas: 200000 }], notes: '' });
    saveClaim(db, { contractId: cid, amountHalalas: 5000, reason: 'تلف', date: '2026-02-10' });
    recordKeyMoneyDeal(db, { unitId: unit, contractId: cid, outgoing: 'أ', incoming: 'ب', amountHalalas: 100000, date: '2026-02-11', commissionHalalas: 5000, method: 'cash', notes: '' });
    const pur = savePurchase(db, { supplier: 'مورد نقل', date: '2026-02-12', due: '2026-02-28', category: 'صيانة', incorpItem: '', amortize: false, amortizeMonths: null, exempt: false, excludeFromVat: false, subtotalHalalas: 3000, taxHalalas: 0, totalHalalas: 3000, unitId: unit, propertyId: A });
    const inv = saveInvoice(db, { customer: 'عميل نقل', customerVat: '', issue: '2026-02-13', due: '2026-02-28', notes: '', unitId: unit, propertyId: A, lines: [{ descr: 'خدمة', qty: 1, priceHalalas: 1000, taxPct: 0 }] } as never, 'مستحقة');
    payInvoice(db, inv, { method: 'cash', bankId: null, date: '2026-02-14' });

    // وسم كل صف قبل النقل · المرجع هو rowPids نفسها التي يرفع بها المحرّك
    const tagsNow = () => {
      const m = new Map<string, string>();
      for (const t of SYNC_TABLES) {
        for (const r of db.all<Record<string, unknown>>(`SELECT *, ${t.pk(`"${t.name}"`)} AS __pk FROM "${t.name}"`)) {
          m.set(t.name + '|' + r.__pk, rowPids(db, t.name, r as never).sort().join(','));
        }
      }
      return m;
    };
    const before = tagsNow();
    db.run(`UPDATE sync_ctl SET v = 1 WHERE k = 'capture'`);
    db.run(`DELETE FROM sync_outbox`);
    const meterId = db.get<{ id: string }>(`SELECT id FROM meters WHERE owner_id = ?`, [unit])!.id;
    saveUnit(db, { ...unitInput(B), meters: [{ id: meterId, kind: 'كهرباء', number: '100' }] }, unit);

    expect(db.get<{ p: string }>(`SELECT property_id AS p FROM purchases WHERE id = ?`, [pur])!.p).toBe(B);
    expect(db.get<{ p: string }>(`SELECT property_id AS p FROM invoices WHERE id = ?`, [inv])!.p).toBe(B);
    const queued = new Set(db.all<{ k: string }>(`SELECT tbl || '|' || pk AS k FROM sync_outbox`).map((r) => r.k));
    const missing: string[] = [];
    let changed = 0;
    for (const [k, tags] of tagsNow()) {
      if (before.get(k) === tags) continue;
      changed++;
      if (!queued.has(k)) missing.push(k.split('|')[0]);
    }
    expect([...new Set(missing)]).toEqual([]);
    expect(changed).toBeGreaterThan(20);
    expect(queued.size).toBeGreaterThan(20);
  });
});

describe('٤.١٣ المبلغ بالحروف صحيح نحوياً', () => {
  test.each([
    [100000, 'مئة ألف ريال فقط لا غير'],
    [200000, 'مئتا ألف ريال فقط لا غير'],
    [300000, 'ثلاثمئة ألف ريال فقط لا غير'],
    [103000, 'مئة وثلاثة آلاف ريال فقط لا غير'],
    [1100000, 'مليون ومئة ألف ريال فقط لا غير'],
    [2000, 'ألفان ريال فقط لا غير'],
    [3000, 'ثلاثة آلاف ريال فقط لا غير'],
    [11000, 'أحد عشر ألفاً ريال فقط لا غير'],
    [115000, 'مئة وخمسة عشر ألفاً ريال فقط لا غير'],
    [101000, 'مئة ألف وألف ريال فقط لا غير'],
    [202000, 'مئتا ألف وألفان ريال فقط لا غير'],
    [200000000, 'مئتا مليون ريال فقط لا غير'],
    [4250, 'أربعة آلاف ومئتان وخمسون ريال فقط لا غير'],
  ])('%i ← %s', async (riyals, words) => {
    const { moneyToArabicWords } = await import('@/domain/numberWords');
    expect(moneyToArabicWords(riyals * 100)).toBe(words);
  });
});

describe('٤.١٦ حسم التعارض بساعة الخادم لا ساعة الجهاز', () => {
  test('جهاز ساعته متقدمة عشر دقائق لا يغلب تعديلاً أحدث منه فعلاً', async () => {
    const { memDb } = await import('./helpers/testDb');
    const { addProperty, addUnit, contractInput } = await import('./helpers/fixtures');
    const { MemoryRemote } = await import('./helpers/memoryRemote');
    const { enableSync, syncOnce, getSyncState } = await import('@/sync/engine');
    const { confirmContract } = await import('@/domain/contracts/service');
    const { getMeta } = await import('@/repos/settings');
    type DBT = ReturnType<typeof memDb>;
    const r = new MemoryRemote();
    const a = memDb(); const b = memDb();
    const sync = (db: DBT) => syncOnce(db, r, getMeta(db, 'device_id')!);
    enableSync(a, 'u-skew'); enableSync(b, 'u-skew');
    confirmContract(a, contractInput(addUnit(a, addProperty(a)), { tenant: 'مستأجر الساعة', start: '2026-01-01', end: '2026-12-31' }));
    // أ ساعته متقدمة عشر دقائق: تقيسها كتابته الأولى من وقت الالتزام في الخادم
    r.deviceSkewMs = 10 * 60_000;
    await sync(a);
    r.deviceSkewMs = 0;
    expect(Number(getSyncState(a, 'clock_skew_ms'))).toBeLessThan(-9 * 60_000);
    await sync(b);
    const tid = a.get<{ id: string }>(`SELECT id FROM tenants`)!.id;
    // أ يعدّل أولاً فعلاً، وساعته تختم التعديل بعد عشر دقائق
    a.run(`UPDATE tenants SET phone = '0511111111' WHERE id = ?`, [tid]);
    a.run(`UPDATE sync_outbox SET changed_at = ? WHERE tbl = 'tenants' AND pk = ?`, [new Date(Date.now() + 10 * 60_000).toISOString(), tid]);
    await new Promise((res) => setTimeout(res, 5));
    b.run(`UPDATE tenants SET phone = '0522222222' WHERE id = ?`, [tid]); // الأحدث فعلاً
    await sync(b);
    await sync(a);
    await sync(b);
    for (const db of [a, b]) expect(db.get<{ p: string }>(`SELECT phone AS p FROM tenants WHERE id = ?`, [tid])!.p).toBe('0522222222');
    a.close(); b.close();
  });
});

describe('٤.١٧ بنود صغرى', () => {
  test('سنة رقم الفاتورة من تاريخ إصدارها لا من تاريخ الجهاز', async () => {
    const { memDb } = await import('./helpers/testDb');
    const { saveInvoice } = await import('@/domain/invoices');
    const db = memDb();
    const id = saveInvoice(db, { customer: 'عميل ديسمبر', customerVat: '', issue: '2019-12-30', due: '2020-01-15', notes: '',
      lines: [{ descr: 'خدمة', qty: 1, priceHalalas: 1000, taxPct: 0 }] }, 'مستحقة');
    expect(db.get<{ no: string }>(`SELECT no FROM invoices WHERE id = ?`, [id])!.no).toMatch(/^INV-2019-0001/);
  });

  test('تعديل تاريخ المطالبة المفتوحة وحده ينقل تاريخ قيدها', async () => {
    const { memDb } = await import('./helpers/testDb');
    const { addProperty, addUnit, contractInput } = await import('./helpers/fixtures');
    const { confirmContract } = await import('@/domain/contracts/service');
    const { saveClaim } = await import('@/domain/claims');
    const { accountBalance } = await import('@/domain/accounting/ledger');
    const db = memDb();
    const cid = confirmContract(db, contractInput(addUnit(db, addProperty(db)), { tenant: 'مستأجر مطالبة' }));
    const id = saveClaim(db, { contractId: cid, amountHalalas: 7000, reason: 'تلف', date: '2026-03-01' });
    saveClaim(db, { contractId: cid, amountHalalas: 7000, reason: 'تلف', date: '2026-04-15' }, id);
    const live = db.all<{ date: string }>(`SELECT date FROM journal_entries WHERE src_type = 'claim' AND src_id = ? AND reversed_by IS NULL AND memo NOT LIKE 'عكس%' AND memo NOT LIKE 'تعديل%'`, [id]);
    expect(live.map((e) => e.date)).toEqual(['2026-04-15']);
    expect(accountBalance(db, '1250')).toBe(7000);
  });

  test('كفاية النقد: الإيداع في البنك والمصروف النثري يُرفضان بما يتجاوز المحفظة (قائمٌ قبل المراجعة)', async () => {
    const { memDb } = await import('./helpers/testDb');
    const { addBank } = await import('./helpers/fixtures');
    const { depositCashToBank, pettyCashExpense, ownerCashIn } = await import('@/domain/cashOps');
    const db = memDb();
    const bank = addBank(db, 'بنك الإيداع');
    ownerCashIn(db, { amountHalalas: 5000, date: '2026-05-01' });
    expect(() => depositCashToBank(db, { bankId: bank, amountHalalas: 6000, date: '2026-05-02' })).toThrow(/لا يكفي/);
    expect(() => pettyCashExpense(db, { amountHalalas: 6000, descr: 'قرطاسية', date: '2026-05-02' })).toThrow(/لا يكفي/);
  });
});
