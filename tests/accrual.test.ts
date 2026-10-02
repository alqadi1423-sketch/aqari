/**
 * أساس الاستحقاق ونسبة الإشغال بالأيام.
 * حالة مصطنعة: عقد يبدأ ١٨ أغسطس بإيجار سنوي ٢٩٢٠٠ ريالاً (٨٠ ريالاً لليوم)
 * نصيبه من أغسطس ٨٦٧٫٩٥ ريالاً (١٢ يوماً من ٣١) لا الإيجار الشهري كاملاً.
 * ومعه تأكيد أن هذه الدوال لا تكتب في القاعدة حرفاً.
 */
import { memDb } from './helpers/testDb';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { confirmContract } from '@/domain/contracts/service';
import { savePurchase } from '@/domain/purchases';
import {
  inclusiveDays, dailySpread, accruedThrough, accrualShare, monthlyAccrual,
  purchaseAccrualPeriod, purchaseExpenseHalalas, purchasePeriodExpense,
  contractAccrualWindow, contractPeriodRevenue,
  periodRevenueAccrual, periodExpenseAccrual, periodRevenueExpenseAccrual,
  monthlyRevenueExpenseAccrual,
} from '@/domain/accrual';
import type { Basis } from '@/domain/accrual';
import { occupancyByDays, occupancySummary } from '@/domain/stats';
import { periodRevenueExpense } from '@/domain/accounting/ledger';
import type { DB } from '@/db/adapter';

// عقد سنوي بـ ٢٩٢٠٠ ريالاً يبدأ ١٨ أغسطس · ٣٦٥ يوماً
const VALUE = 2920000;
const START = '2026-08-18';
const END = '2027-08-17';

describe('توزيع قيمة العقد على أيامه', () => {
  test('العقد الذي يبدأ ١٨ أغسطس: نصيب أغسطس ١٤ يوماً من ٣١ بالهللة الصحيحة', () => {
    expect(inclusiveDays(START, END)).toBe(365);
    const sp = dailySpread(VALUE, START, END);
    expect(sp.days).toBe(365);
    expect(sp.perDayHalalas).toBeCloseTo(VALUE / 365, 6);

    // ١٤ يوماً من ٣١ (١٨ .. ٣١ أغسطس) = ١١٢٠ ريالاً
    const august = accrualShare(VALUE, START, END, '2026-08-01', '2026-08-31');
    expect(august).toBe(112000);
    expect(august / 100).toBeCloseTo(1120, 2);
    // لا الإيجار الشهري كاملاً (٢٤٣٣ ريالاً) كما يفعل الأساس النقدي
    expect(august).toBeLessThan(243300);
  });

  test('مجموع التوزيع على كل الأشهر = قيمة العقد بالضبط بلا هللة ضائعة', () => {
    const months = monthlyAccrual(VALUE, START, END);
    // من أغسطس ٢٠٢٦ إلى أغسطس ٢٠٢٧ · ثلاثة عشر شهراً يتقاطع العقد مع أطرافها
    expect(months).toHaveLength(13);
    expect(months[0][0]).toBe('2026-08');
    expect(months[months.length - 1][0]).toBe('2027-08');
    expect(months.reduce((s, m) => s + m[1], 0)).toBe(VALUE);
    // آخر يوم يمتص فرق التقريب: المتراكم حتى النهاية = القيمة تماماً
    expect(accruedThrough(VALUE, START, END, END)).toBe(VALUE);
    expect(accruedThrough(VALUE, START, END, '2026-08-17')).toBe(0);
  });

  test('قيمة غير قابلة للقسمة: التوزيع اليومي يظل مجموعه القيمة بالضبط', () => {
    const odd = 100003; // هللات لا تقبل القسمة على أيام المدة
    const s = '2026-03-01';
    const e = '2026-03-07';
    let sum = 0;
    for (let i = 0; i < 7; i++) {
      const d = `2026-03-0${i + 1}`;
      sum += accrualShare(odd, s, e, d, d);
    }
    expect(sum).toBe(odd);
  });

  test('شهر لا يتقاطع مع العقد = صفر', () => {
    expect(accrualShare(VALUE, START, END, '2026-07-01', '2026-07-31')).toBe(0);
    expect(accrualShare(VALUE, START, END, '2027-09-01', '2027-09-30')).toBe(0);
    expect(monthlyAccrual(VALUE, START, END).find((m) => m[0] === '2026-07')).toBeUndefined();
  });

  test('العقد الملغى يتوقف استحقاقه يوم الإلغاء لا يوم نهايته', () => {
    const c = { value_halalas: VALUE, start: START, end: END, status: 'ملغى', cancel_date: '2026-08-31' };
    const w = contractAccrualWindow(c);
    expect(w).not.toBeNull();
    expect(w!.accrueUntil).toBe('2026-08-31');
    expect(contractPeriodRevenue(c, '2026-08-01', '2026-08-31')).toBe(112000);
    expect(contractPeriodRevenue(c, '2026-09-01', '2026-09-30')).toBe(0);
    // المسودة لا تستحق شيئاً
    expect(contractAccrualWindow({ ...c, status: 'مسودة', cancel_date: null })).toBeNull();
  });

  test('النوع الصريح للأساس يُصدَّر للعرض', () => {
    const a: Basis = 'استحقاق';
    const b: Basis = 'نقدي';
    expect([a, b]).toEqual(['استحقاق', 'نقدي']);
  });
});

describe('إيراد الفترة ومصروفها بأساس الاستحقاق', () => {
  function seedContract(): { db: DB; unitId: string; pid: string } {
    const db = memDb();
    const pid = addProperty(db, { name: 'عقار الاستحقاق' });
    const unitId = addUnit(db, pid, { unit_no: 'A-1' });
    confirmContract(db, contractInput(unitId, {
      tenant: 'مستأجر أغسطس', valueHalalas: VALUE, depositHalalas: 0,
      cycle: 'سنوية', start: START, end: END,
    }));
    return { db, unitId, pid };
  }

  test('إيراد أغسطس بالاستحقاق نصيب أيامه، وبالنقدي صفر ما لم تُقبض دفعة', () => {
    const { db } = seedContract();
    expect(periodRevenueAccrual(db, '2026-08-01', '2026-08-31')).toBe(112000);
    // الدفتر لم يعرف إيراداً بعد: لا دفعة قُبضت
    expect(periodRevenueExpense(db, '2026-08-01', '2026-08-31').revenue).toBe(0);
    // مجموع أشهر العقد كلها = قيمته
    const months = monthlyRevenueExpenseAccrual(db, '2026-08', '2027-08');
    let sum = 0;
    for (const v of months.values()) sum += v.revenue;
    expect(sum).toBe(VALUE);
    db.close();
  });

  test('فاتورة إيجار العقار السنوية: النقدي يقفز بها في شهرها والاستحقاق يستقرّ على أشهرها', () => {
    const { db, pid } = seedContract();
    const YEARLY = 22000000; // ٢٢٠٠٠٠ ريالاً إيجار العقار السنوي
    savePurchase(db, {
      supplier: 'مالك العقار', date: '2026-01-01', due: '2026-01-01', category: 'مصروفات أخرى',
      incorpItem: '', amortize: true, amortizeMonths: 12, exempt: true, excludeFromVat: false,
      unitId: null, propertyId: pid, subtotalHalalas: YEARLY, taxHalalas: 0, totalHalalas: YEARLY,
      meterId: null, meterReading: null,
    });

    // الأساس النقدي: الفاتورة كلها في يناير
    expect(periodRevenueExpense(db, '2026-01-01', '2026-01-31').expense).toBe(YEARLY);
    expect(periodRevenueExpense(db, '2026-06-01', '2026-06-30').expense).toBe(0);

    // الاستحقاق: نصيب أيام كل شهر · يستقرّ حول ١٨٣٣٣ ريالاً شهرياً
    const jan = periodExpenseAccrual(db, '2026-01-01', '2026-01-31');
    const jun = periodExpenseAccrual(db, '2026-06-01', '2026-06-30');
    expect(jan).toBe(Math.round((YEARLY * 31) / 365));
    expect(jun).toBeGreaterThan(1750000);
    expect(jun).toBeLessThan(1900000);

    // ومجموع أشهر الفاتورة الاثني عشر = قيمتها بالضبط
    const months = monthlyRevenueExpenseAccrual(db, '2026-01', '2026-12');
    let sum = 0;
    for (const v of months.values()) sum += v.expense;
    expect(sum).toBe(YEARLY);
    db.close();
  });

  test('فاتورة بلا فترة تقع كلها في تاريخها', () => {
    const { db, pid } = seedContract();
    savePurchase(db, {
      supplier: 'مورد الصيانة', date: '2026-03-10', due: '2026-03-10', category: 'مصروفات أخرى',
      incorpItem: '', amortize: false, amortizeMonths: null, exempt: true, excludeFromVat: false,
      unitId: null, propertyId: pid, subtotalHalalas: 40000, taxHalalas: 0, totalHalalas: 40000,
      meterId: null, meterReading: null,
    });
    const p = { date: '2026-03-10', amortize: 0, amortize_months: null, tax_halalas: 0, total_halalas: 40000, tax_status: 'معفاة من الضريبة' };
    const per = purchaseAccrualPeriod(p);
    expect(per).toEqual({ start: '2026-03-10', end: '2026-03-10', spread: false });
    expect(purchaseExpenseHalalas(p)).toBe(40000);
    expect(purchasePeriodExpense(p, '2026-03-01', '2026-03-31')).toBe(40000);
    expect(purchasePeriodExpense(p, '2026-04-01', '2026-04-30')).toBe(0);
    expect(periodExpenseAccrual(db, '2026-03-01', '2026-03-31')).toBe(40000);
    db.close();
  });

  test('ضريبة المدخلات القابلة للخصم أصل مستردّ لا تكلفة فلا تدخل المصروف', () => {
    const p = {
      date: '2026-05-01', amortize: 0, amortize_months: null,
      tax_halalas: 15000, total_halalas: 115000, tax_status: 'فاتورة ضريبية · قابلة للخصم',
    };
    expect(purchaseExpenseHalalas(p)).toBe(100000);
    expect(purchaseExpenseHalalas({ ...p, tax_status: 'غير قابلة للخصم' })).toBe(115000);
  });

  test('الدالة المزدوجة بنفس توقيع نظيرتها النقدية', () => {
    const { db } = seedContract();
    const acc = periodRevenueExpenseAccrual(db, '2026-08-01', '2026-08-31');
    const cash = periodRevenueExpense(db, '2026-08-01', '2026-08-31');
    expect(Object.keys(acc).sort()).toEqual(Object.keys(cash).sort());
    expect(acc.revenue).toBe(112000);
    db.close();
  });
});

describe('نسبة الإشغال بالأيام', () => {
  test('وحدتان وإحداهما سكنت نصف الشهر: النسبة بيوم-وحدة لا بالوحدة كاملة', () => {
    const db = memDb();
    const pid = addProperty(db, { name: 'عقار الإشغال' });
    const full = addUnit(db, pid, { unit_no: 'A-1' });
    const half = addUnit(db, pid, { unit_no: 'A-2' });
    confirmContract(db, contractInput(full, {
      tenant: 'ساكن الشهر كله', valueHalalas: 300000, depositHalalas: 0,
      start: '2026-06-01', end: '2026-06-30',
    }));
    confirmContract(db, contractInput(half, {
      tenant: 'ساكن نصف الشهر', valueHalalas: 150000, depositHalalas: 0,
      start: '2026-06-01', end: '2026-06-15',
    }));

    const o = occupancyByDays(db, '2026-06-01', '2026-06-30', pid);
    expect(o.units).toBe(2);
    expect(o.days).toBe(30);
    expect(o.capacityUnitDays).toBe(60);
    expect(o.occupiedUnitDays).toBe(45); // ٣٠ + ١٥
    expect(o.pct).toBe(75);

    // الوحدة التي سكنت ١٥ يوماً تُحسب ١٥ لا شهراً كاملاً ولا صفراً
    const onlyHalf = occupancyByDays(db, '2026-06-16', '2026-06-30', pid);
    expect(onlyHalf.occupiedUnitDays).toBe(15); // الأولى وحدها
    expect(onlyHalf.capacityUnitDays).toBe(30);
    expect(onlyHalf.pct).toBe(50);
    db.close();
  });

  test('المقياسان معاً: إشغال المدة بالأيام والإشغال اللحظي', () => {
    const db = memDb();
    const pid = addProperty(db, { name: 'عقار المقياسين' });
    const a = addUnit(db, pid, { unit_no: 'B-1' });
    addUnit(db, pid, { unit_no: 'B-2' });
    confirmContract(db, contractInput(a, {
      tenant: 'ساكن يونيو', valueHalalas: 300000, depositHalalas: 0,
      start: '2026-06-01', end: '2026-06-30',
    }));
    const s = occupancySummary(db, '2026-06-01', '2026-06-30', '2026-06-10', pid);
    expect(s.period.occupiedUnitDays).toBe(30);
    expect(s.period.capacityUnitDays).toBe(60);
    expect(s.period.pct).toBe(50);
    // اللحظي في ١٠ يونيو: وحدة من وحدتين
    expect(s.now).toEqual({ occupied: 1, total: 2, pct: 50 });
    // وفي يوليو لا أحد: صفر بالأيام وصفر لحظةً
    const july = occupancySummary(db, '2026-07-01', '2026-07-31', '2026-07-10', pid);
    expect(july.period.occupiedUnitDays).toBe(0);
    expect(july.period.pct).toBe(0);
    expect(july.now.occupied).toBe(0);
    db.close();
  });

  test('شهر خارج أي عقد = صفر، وفترة مقلوبة الحدين = صفر بلا انفجار', () => {
    const db = memDb();
    const pid = addProperty(db);
    addUnit(db, pid);
    expect(occupancyByDays(db, '2026-01-01', '2026-01-31', pid).pct).toBe(0);
    const bad = occupancyByDays(db, '2026-02-10', '2026-02-01', pid);
    expect(bad.days).toBe(0);
    expect(bad.capacityUnitDays).toBe(0);
    expect(bad.pct).toBe(0);
    db.close();
  });
});

describe('قراءة واشتقاق فقط', () => {
  test('لا تكتب الدوال حرفاً: عدّ الصفوف قبل وبعد', () => {
    const db = memDb();
    const pid = addProperty(db, { name: 'عقار الحالة' });
    const unitId = addUnit(db, pid, { unit_no: 'C-1' });
    confirmContract(db, contractInput(unitId, {
      tenant: 'مستأجر الحالة', valueHalalas: VALUE, depositHalalas: 0,
      cycle: 'سنوية', start: START, end: END,
    }));
    savePurchase(db, {
      supplier: 'مورد الحالة', date: '2026-01-01', due: '2026-01-01', category: 'مصروفات أخرى',
      incorpItem: '', amortize: true, amortizeMonths: 12, exempt: true, excludeFromVat: false,
      unitId: null, propertyId: pid, subtotalHalalas: 22000000, taxHalalas: 0, totalHalalas: 22000000,
      meterId: null, meterReading: null,
    });

    const TABLES = [
      'journal_entries', 'journal_lines', 'contracts', 'contract_installments',
      'contract_payments', 'purchases', 'invoices', 'bank_tx', 'audit_log',
      'reservations', 'units', 'properties',
    ];
    const snapshot = () => {
      const out: Record<string, number> = {};
      for (const t of TABLES) {
        out[t] = Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t}`)!.n);
      }
      return out;
    };
    const before = snapshot();

    periodRevenueAccrual(db, '2026-08-01', '2026-08-31');
    periodExpenseAccrual(db, '2026-01-01', '2026-12-31');
    periodRevenueExpenseAccrual(db, null, null);
    monthlyRevenueExpenseAccrual(db, '2026-01', '2026-12');
    occupancyByDays(db, '2026-08-01', '2026-08-31');
    occupancySummary(db, '2026-08-01', '2026-08-31', '2026-08-25');

    expect(snapshot()).toEqual(before);
    // ولا قيد صار محذوفاً ولا حالته تغيّرت
    expect(Number(db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM journal_entries WHERE deleted_at IS NOT NULL`
    )!.n)).toBe(0);
    db.close();
  });
});
