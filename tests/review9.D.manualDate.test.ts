/**
 * D-2 · عالٍ · src/ui/DateField.tsx:32 (الكتابة اليدوية تمرّر أي أرقام وشرطات) ← app/(tabs)/collect.tsx:290 ← src/domain/contracts/service.ts:637
 *
 * السيناريو: في نافذة «تسجيل دفعة إيجار» يضغط المستخدم زرّ القلم بجانب «تاريخ الدفعة» ويكتب التاريخ بيده «2026-1-15»
 * (بلا صفرٍ قبل الشهر). حقل التاريخ لا يفحص الصيغة (isValidISODate معرَّفة في DateField.tsx ولا يستدعيها أحد)، فيصل النص
 * كما هو إلى recordRentPayment، والخدمة لا تفحص الصيغة أيضاً، فتُسجَّل الدفعة وقيدها بتاريخ «2026-1-15».
 *
 * لماذا يهم: التواريخ في القاعدة نصوصٌ تُقارن حرفاً حرفاً، و«2026-1-15» أكبر من «2026-01-31» وأصغر من «2026-10-01»،
 * فلا يقع في أي شهرٍ ولا أي ربع: يغيب من تقارير الشهر والربع ومن الإقرار الضريبي وهو في الرصيد. والأخطر أن قفل الربع المقدَّم
 * إقراره (isFiledDate ← quarterId يطلب شهراً من رقمين) لا يتعرّف عليه، فتُرحَّل دفعةٌ في فترةٍ مجمَّدة بلا رفض.
 *
 * السلوك الصحيح: تاريخٌ ليس بصيغة YYYY-MM-DD صحيحة يُرفض قبل أن يصل الدفتر (في الحقل نفسه، وفي الخدمة حارساً أخيراً)،
 * كما يُرفض التاريخ «2026-01-15» في الربع المقدَّم اليوم. بيانات مصطنعة.
 */
import { memDb } from './helpers/testDb';
import { addProperty, addUnit, addBank, contractInput } from './helpers/fixtures';
import { confirmContract, recordRentPayment, renewContract, RuleViolation } from '@/domain/contracts/service';
import { isISODate } from '@/domain/dates';
import { postManualEntry } from '@/domain/accounting/post';
import { correctionDate } from '@/domain/vatFilings';
import { cancelPayment } from '@/domain/contracts/cancelPayment';
import { integrityChecks, badDateCounts } from '@/domain/accounting/integrity';
import { saveInvoiceIssued, setInvoiceStatusIssued } from '@/domain/invoiceIssue';
import { setInvoiceStatus } from '@/domain/invoices';
import { t } from '@/i18n';

function setup() {
  const db = memDb();
  const bank = addBank(db, 'بنك مصطنع للمراجعة');
  const cid = confirmContract(db, contractInput(addUnit(db, addProperty(db, { name: 'عقار مصطنع للمراجعة' })),
    { tenant: 'مستأجر مصطنع للمراجعة', idNumber: '1000000901', phone: '0500000901', depositHalalas: 0,
      start: '2026-01-01', end: '2026-12-31', valueHalalas: 1200000 }));
  const inst = db.get<{ id: string }>(
    `SELECT id FROM contract_installments WHERE contract_id = ? ORDER BY due_date LIMIT 1`, [cid])!;
  const pay = (date: string) => recordRentPayment(db, cid, {
    installmentId: inst.id, period: 'يناير', date,
    lines: [{ method: 'bank', bankId: bank, amountHalalas: 50000 }], discountHalalas: 0, notes: '',
  });
  return { db, pay };
}

test('D-2 تاريخ دفعةٍ مكتوبٌ يدوياً بلا صفر «2026-1-15» يُرفض ولا يصل الدفتر', () => {
  const { db, pay } = setup();
  // اليوم: يُقبل ويُكتب القيد بتاريخٍ لا يقع في أي شهر
  expect(() => pay('2026-1-15')).toThrow();
  expect(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM journal_entries WHERE date = '2026-1-15'`)!.n).toBe(0);
  db.close();
});

test('D-2 والتاريخ نفسه لا يتجاوز قفل الربع المقدَّم إقراره', () => {
  const { db, pay } = setup();
  db.run(`INSERT INTO vat_filings (id, period_from, period_to, filed_at, snapshot, created_at) VALUES (?,?,?,?,?,?)`,
    ['2026-Q1', '2026-01-01', '2026-03-31', '2026-04-10', '{}', '2026-04-10T00:00:00.000Z']);
  // الضابط: التاريخ بصيغته الصحيحة في الربع المقدَّم يُرفض اليوم
  expect(() => pay('2026-01-15')).toThrow();
  // الخطأ: اليوم نفسه بلا صفرٍ يمرّ ويُرحَّل في الفترة المجمَّدة
  expect(() => pay('2026-1-15')).toThrow();
  db.close();
});

test('D-2 الفحص نفسه في الحقل والدومين: الصيغة كاملة واليوم قائمٌ في شهره', () => {
  for (const ok of ['2026-01-15', '2026-12-31', '2028-02-29', '2000-02-29']) expect(isISODate(ok)).toBe(true);
  for (const bad of ['2026-1-15', '2026-11', '2026-02-31', '2026-02-29', '1900-02-29', '2026-04-31', '2026-13-01',
    '2026-00-10', '2026-01-00', '2026-01-15T10:00:00', ' 2026-01-15', '', null, undefined]) expect(isISODate(bad)).toBe(false);
});

test('D-2 والقيد اليدوي بيومٍ لا يقوم في شهره «2026-02-31» يُرفض برسالةٍ عربية ولا يُكتب', () => {
  const { db } = setup();
  const entry = (date: string) => postManualEntry(db, { date, memo: 'قيد مصطنع للمراجعة',
    lines: [{ account: '1100', debit: 100, credit: 0 }, { account: '3100', debit: 0, credit: 100 }] });
  expect(() => entry('2026-02-31')).toThrow(RuleViolation);
  expect(() => entry('2026-02-31')).toThrow(/2026-02-31/);
  expect(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM journal_entries WHERE date = '2026-02-31'`)!.n).toBe(0);
  // والصحيح يمرّ كما كان
  expect(entry('2026-02-28')).not.toBeNull();
  db.close();
});

/**
 * تتمة المراجعة ١١ (D2-R11-2 وD2-R11-3 وD2-R11-4): ما كتبه الحقل القديم يُصحَّح ولا يعلق، و«فحص المطابقة» يعود سليماً بعد تصحيحه،
 * والتجديد والفاتورة المعلّقة لا يمرّ بهما تاريخٌ بغير صيغته. اليوم مثبَّت 2026-12-01. بيانات مصطنعة.
 */
describe('D-2 تتمة المراجعة ١١', () => {
  beforeEach(() => { jest.useFakeTimers({ now: new Date('2026-12-01T09:00:00Z') }); });
  afterEach(() => { jest.useRealTimers(); });

  test('تاريخ قيد التصحيح: «2026-02-31» و«2026-1-15» إلى اليوم، واللحظة القديمة بيومها، والصحيح كما هو', () => {
    const db = memDb();
    expect(correctionDate(db, '2026-02-31')).toBe('2026-12-01');
    expect(correctionDate(db, '2026-1-15')).toBe('2026-12-01');
    expect(correctionDate(db, '2026-02-10T09:00:00.000Z')).toBe('2026-02-10');
    expect(correctionDate(db, '2026-02-10')).toBe('2026-02-10');
    db.close();
  });

  test('«فحص المطابقة» يعدّ الدفعة وقيدها وحركة بنكها بتاريخٍ معيب، ويعود سليماً بعد إلغائها، ويرجع المال كما دخل', () => {
    const { db, pay } = setup();
    const pid = pay('2026-03-15');
    const p = db.get<{ je: string; no: string }>(
      `SELECT p.journal_entry_id AS je, e.no FROM contract_payments p JOIN journal_entries e ON e.id = p.journal_entry_id WHERE p.id = ?`, [pid])!;
    // كما كتبها الإصدار السابق: الدفعة وقيدها وحركة بنكها بالتاريخ المكتوب يدوياً (المحفّز يجمّد رأس القيد فيُرفع لحظة الكتابة)
    const trg = db.get<{ sql: string }>(`SELECT sql FROM sqlite_master WHERE name = 'trg_je_frozen_hdr'`)!.sql;
    db.exec('DROP TRIGGER trg_je_frozen_hdr');
    db.run(`UPDATE journal_entries SET date = '2026-3-15' WHERE id = ?`, [p.je]);
    db.exec(trg);
    db.run(`UPDATE contract_payments SET date = '2026-3-15' WHERE id = ?`, [pid]);
    db.run(`UPDATE bank_tx SET date = '2026-3-15' WHERE journal_no = ?`, [p.no]);
    expect(badDateCounts(db)).toEqual({ entries: 1, payments: 1, purchases: 0, bank: 1, invoices: 0 });
    const check = () => integrityChecks(db).find((c) => c.name === t('dates.integrityName'))!;
    expect(check().ok).toBe(false);

    // الإلغاء بتاريخه الافتراضي (اليوم) يصحّحها: لا شيء حيٌّ بتاريخٍ معيب
    cancelPayment(db, pid, { reason: 'تصحيح دفعةٍ بتاريخٍ معيب' });
    expect(badDateCounts(db)).toEqual({ entries: 0, payments: 0, purchases: 0, bank: 0, invoices: 0 });
    expect(check().ok).toBe(true);
    // ٥٠٬٠٠٠ هللة دخلت البنك و٥٠٬٠٠٠ خرجت بالإلغاء: الصافي ٠، والحركة السالبة بتاريخ الإلغاء
    expect(Number(db.get<{ s: number }>(`SELECT COALESCE(SUM(amount_halalas), 0) AS s FROM bank_tx WHERE deleted_at IS NULL`)!.s)).toBe(0);
    expect(db.get(`SELECT date FROM bank_tx WHERE amount_halalas = -50000`)).toEqual({ date: '2026-12-01' });
    db.close();
  });

  test('التجديد بتاريخٍ بغير صيغته يُرفض ولا يُنشأ عقد · والصحيح يمرّ', () => {
    const db = memDb();
    const cid = confirmContract(db, contractInput(addUnit(db, addProperty(db, { name: 'عقار تجديدٍ مصطنع' })),
      { tenant: 'مستأجر تجديدٍ مصطنع', idNumber: '1000000941', phone: '0500000941', depositHalalas: 0,
        start: '2026-01-01', end: '2026-12-31', valueHalalas: 1200000 }));
    const renew = (start: string, end: string) => renewContract(db, cid, { start, end, valueHalalas: 1200000, cycle: 'شهرية',
      carryDeposit: false, extraDepositHalalas: 0, services: '', furnished: 'غير مؤثثة', ejarNo: '', note: '' });
    const contracts = () => Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM contracts`)!.n);
    expect(() => renew('2027-1-01', '2027-12-31')).toThrow(/2027-1-01/);
    expect(() => renew('2027-01-01', '2027-02-30')).toThrow(/2027-02-30/);
    expect(contracts()).toBe(1);
    renew('2027-01-01', '2027-12-31');
    expect(contracts()).toBe(2);
    db.close();
  });

  test('مسودةٌ بتاريخٍ بغير صيغته لا تأخذ رقماً من العدّاد ولا تصدر · ولا قيد', async () => {
    const db = memDb();
    db.run(`UPDATE company SET vat_enabled = 1 WHERE id = 1`);
    const off = { takeInvoiceSeq: async (): Promise<number> => { throw new Error('offline'); } };
    const r = await saveInvoiceIssued(db, off, { customer: 'عميل مصطنع', customerVat: '', issue: '2026-03-15', due: '2026-03-15', notes: '',
      lines: [{ descr: 'خدمة مصطنعة', qty: 1, priceHalalas: 1000, taxPct: 15, taxCode: 'S' as const }] }, 'مستحقة');
    db.run(`UPDATE invoices SET issue = '2026-3-15' WHERE id = ?`, [r.id]);
    let taken = 0;
    const on = { takeInvoiceSeq: async () => ++taken };
    await expect(setInvoiceStatusIssued(db, on, r.id, 'مستحقة')).rejects.toThrow(RuleViolation);
    expect(taken).toBe(0);
    expect(db.get(`SELECT value FROM meta WHERE key = 'inv_reserved'`)).toBeFalsy();
    // وبلا عدّاد (جهازٌ لا يزامن) يُرفض كذلك
    expect(() => setInvoiceStatus(db, r.id, 'مستحقة')).toThrow(/2026-3-15/);
    expect(db.get(`SELECT status AS s FROM invoices WHERE id = ?`, [r.id])).toEqual({ s: 'مسودة' });
    expect(Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM journal_entries`)!.n)).toBe(0);
    db.close();
  });
});
