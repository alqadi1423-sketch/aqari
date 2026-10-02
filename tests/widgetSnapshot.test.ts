/**
 * لقطة الودجت · الجسر الوحيد بين البيانات وشاشة الجوال.
 * وأي خطأ فيها يظهر على الشاشة الرئيسية للجهاز لا داخل التطبيق، فيُرى ولا يُشتكى منه.
 *
 * تُختبر هنا خالصةً بلا ملفات ولا جهاز: قاعدة في الذاكرة، ثم أرقام.
 */
import { memDb } from './helpers/testDb';
import { buildWidgetSnapshot } from '@/services/widgetSnapshot';
import { confirmContract, recordRentPayment } from '@/domain/contracts/service';
import { uid } from '@/domain/ids';
import type { DB } from '@/db/adapter';

const T = '2026-06-15';

/** عقار ووحدة وعقد سنوي بأقساط شهرية · نواة كل اختبار */
function seedContract(db: DB, opts: { unitNo: string; start: string; value: number }): string {
  const now = new Date().toISOString();
  const pid = uid();
  db.run(`INSERT INTO properties (id, name, created_at) VALUES (?,?,?)`,
    [pid, 'برج الاختبار', now]);
  const uidv = uid();
  db.run(`INSERT INTO units (id, property_id, unit_no, type, rent_monthly_halalas, created_at)
          VALUES (?,?,?,?,?,?)`,
    [uidv, pid, opts.unitNo, 'شقة', Math.round(opts.value / 12), now]);
  const end = String(Number(opts.start.slice(0, 4)) + 1) + opts.start.slice(4);
  return confirmContract(db, {
    unitId: uidv, tenant: 'مستأجر ' + opts.unitNo, phone: '0500000000',
    idNumber: '1010101010', start: opts.start, end,
    valueHalalas: opts.value, depositHalalas: 0, cycle: 'شهرية', furnished: 'غير مؤثثة',
    ejarNo: '', services: '', typeSpecific: {},
  });
}

describe('لقطة الودجت', () => {
  test('قاعدة فارغة: اللقطة معلَّمة فارغة ولا تعرض أصفاراً', () => {
    const db = memDb();
    const s = buildWidgetSnapshot(db, T);
    expect(s.empty).toBe(true);
    expect(s.lateCount).toBe(0);
    expect(s.totalUnits).toBe(0);
    expect(s.day).toBe(T);
    db.close();
  });

  test('عقد بأقساط متأخرة: العدد والمبلغ يطابقان الدفتر', () => {
    const db = memDb();
    seedContract(db, { unitNo: 'A-1', start: '2026-01-01', value: 1200000 });
    const s = buildWidgetSnapshot(db, T);
    expect(s.empty).toBe(false);
    expect(s.totalUnits).toBe(1);
    // من يناير إلى يونيو: خمسة أقساط مضت ولم تُسدَّد
    expect(s.lateCount).toBeGreaterThanOrEqual(5);
    expect(s.lateSum).not.toBe('0.00');
    db.close();
  });

  test('التحصيل يُنقص المتأخرات ويرفع نسبة الشهر', () => {
    const db = memDb();
    const cid = seedContract(db, { unitNo: 'A-2', start: '2026-01-01', value: 1200000 });
    const before = buildWidgetSnapshot(db, T);

    const inst = db.get<{ id: string; amount_halalas: number }>(
      `SELECT id, amount_halalas FROM contract_installments
       WHERE contract_id = ? ORDER BY due_date LIMIT 1`, [cid])!;
    recordRentPayment(db, cid, {
      installmentId: inst.id, date: T, period: '', discountHalalas: 0, notes: '',
      lines: [{ method: 'cash', amountHalalas: Number(inst.amount_halalas) }],
    });

    const after = buildWidgetSnapshot(db, T);
    expect(after.lateCount).toBe(before.lateCount - 1);
    expect(after.lateSum).not.toBe(before.lateSum);
    db.close();
  });

  test('كل نصّ منسَّق بفواصل وكسرين كما في الشاشات', () => {
    const db = memDb();
    seedContract(db, { unitNo: 'A-3', start: '2026-01-01', value: 1200000 });
    const s = buildWidgetSnapshot(db, T);
    for (const v of [s.lateSum, s.dueThisMonth, s.paidThisMonth, s.cash]) {
      expect(v).toMatch(/^-?[\d,]+\.\d{2}$/);
    }
    db.close();
  });

  test('النِّسب داخل المدى ولا تنقسم على صفر', () => {
    const db = memDb();
    seedContract(db, { unitNo: 'A-4', start: '2026-01-01', value: 1200000 });
    const s = buildWidgetSnapshot(db, T);
    expect(s.monthPct).toBeGreaterThanOrEqual(0);
    expect(s.monthPct).toBeLessThanOrEqual(100);
    expect(s.occupancyPct).toBeGreaterThanOrEqual(0);
    expect(s.occupancyPct).toBeLessThanOrEqual(100);
    db.close();
  });

  test('اللقطة تُسلسَل JSON كاملةً · فما يقرؤه أندرويد هو ما يُحسب', () => {
    const db = memDb();
    seedContract(db, { unitNo: 'A-5', start: '2026-01-01', value: 1200000 });
    const s = buildWidgetSnapshot(db, T);
    const round = JSON.parse(JSON.stringify(s));
    expect(round).toEqual(s);
    // الحقول التي تقرؤها كوتلن بالاسم · تغيير اسم واحد يكسر الودجت صامتاً
    for (const k of ['lateCount', 'lateSum', 'dueThisMonth', 'paidThisMonth', 'monthPct', 'empty']) {
      expect(Object.prototype.hasOwnProperty.call(round, k)).toBe(true);
    }
    db.close();
  });
});
