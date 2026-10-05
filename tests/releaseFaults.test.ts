/**
 * أعطال اختبار الإصدار (المالك ٢٠٢٦-١٠-٠٥) · كل اختبار يثبت ما ظهر على الهاتف ولا يعود. بيانات مصطنعة.
 */
import { memDb } from './helpers/testDb';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { confirmContract } from '@/domain/contracts/service';
import { savePurchase } from '@/domain/purchases';
import { computeTopPerformers, propertyStats, portfolioStats } from '@/domain/stats';

describe('الإحصاءات لا تعرف المحذوف إلى السلة', () => {
  test('عقارٌ ووحداته في السلة وعقودها قائمة: لا «الأكثر صرفاً» ولا إشغال «٢٢ من ٠»', () => {
    const db = memDb();
    const T = '2026-06-15';
    const p = addProperty(db, { name: 'عقار في السلة' });
    for (let i = 0; i < 3; i++) confirmContract(db, contractInput(addUnit(db, p, { unit_no: 'S-' + i }), { tenant: 'مستأجر ' + i, idNumber: '100000010' + i, phone: '050000010' + i, start: '2026-01-01', end: '2026-12-31' }));
    savePurchase(db, { supplier: 'مورد', date: '2026-03-01', due: '2026-03-31', category: 'صيانة', incorpItem: '', amortize: false, amortizeMonths: null, exempt: false, excludeFromVat: false, subtotalHalalas: 9000, taxHalalas: 0, totalHalalas: 9000, propertyId: p });
    expect(computeTopPerformers(db).topPropExpense?.id).toBe(p);
    db.run(`UPDATE units SET deleted_at = '2026-06-01T00:00:00Z'`);
    db.run(`UPDATE properties SET deleted_at = '2026-06-01T00:00:00Z'`);
    expect(computeTopPerformers(db).topPropExpense).toBeNull();
    const s = portfolioStats(db, T);
    expect([s.total, s.occupied]).toEqual([0, 0]);
    expect(propertyStats(db, p, T).occupied).toBe(0);
  });
});

describe('المزامنة لا تحجب الواجهة · وأول سحب يظهر تدريجياً', () => {
  test('جهاز جديد يسحب منشأة: التطبيق صفحات قصيرة يفسح بينها للواجهة، والتقدم ظاهر، والنتيجة كاملة', async () => {
    const { MemoryRemote } = await import('./helpers/memoryRemote');
    const { enableSync, syncOnce } = await import('@/sync/engine');
    const { recordRentPayment } = await import('@/domain/contracts/service');
    const { DISCOUNT_AFTER_DUE } = await import('@/domain/contracts/installments');
    const { getMeta } = await import('@/repos/settings');
    const { allInstallments } = await import('@/domain/stats');
    const T = '2026-06-15';
    const src = memDb();
    const p = addProperty(src, { name: 'عقار السحب' });
    for (let u = 0; u < 24; u++) {
      const c = confirmContract(src, contractInput(addUnit(src, p, { unit_no: 'P-' + u }), { tenant: 'مستأجر سحب ' + u, idNumber: '10000020' + String(u).padStart(2, '0'), phone: '05000020' + String(u).padStart(2, '0'), start: '2026-01-01', end: '2026-12-31', valueHalalas: 1200000, cycle: 'شهرية', depositHalalas: 0 }));
      const ins = src.all<{ id: string; due_date: string }>(`SELECT id, due_date FROM contract_installments WHERE contract_id = ? ORDER BY due_date LIMIT 5`, [c]);
      for (const [k, it] of ins.entries()) recordRentPayment(src, c, { installmentId: it.id, period: it.due_date, date: it.due_date, lines: [{ method: 'cash', amountHalalas: k % 2 ? 100000 : 90000 }], discountHalalas: k % 2 ? 0 : 10000, discountKind: k % 2 ? undefined : DISCOUNT_AFTER_DUE, notes: '' });
    }
    const remote = new MemoryRemote();
    enableSync(src, 'u-pull');
    await syncOnce(src, remote, getMeta(src, 'device_id')!);

    const fresh = memDb();
    enableSync(fresh, 'u-pull');
    const progress: string[] = [];
    let longest = 0, steps = 0, last = Date.now();
    const rep = await syncOnce(fresh, remote, getMeta(fresh, 'device_id')!, (m) => progress.push(m), {
      pause: async () => { const now = Date.now(); longest = Math.max(longest, now - last); steps++; await new Promise((r) => setTimeout(r, 0)); last = Date.now(); },
    });
    expect(rep.pending).toBe(0);
    // صفحات كثيرة لا خطوة واحدة، وكل خطوة قصيرة · والتقدم يُعرض بعددٍ يكبر
    expect(steps).toBeGreaterThan(10);
    expect(longest).toBeLessThan(400);
    expect(progress.filter((m) => m.startsWith('جاري تطبيق الوارد · ')).length).toBeGreaterThan(10);
    // والنتيجة كما في المصدر: لا خصم يظهر متبقياً
    const view = (d: typeof src) => allInstallments(d, T).map((i) => i.installmentId + ':' + i.paid + ':' + i.discount + ':' + i.remaining).sort().join(',');
    expect(view(fresh)).toBe(view(src));
  });

  test('خصم القسط يبدأ من القيد لا من سطور حساب الخصم كلها · في الشاشات ومحفّزات السقف', async () => {
    const { INSTALLMENT_DISCOUNT_SQL } = await import('@/domain/contracts/installments');
    const db = memDb();
    const plan = db.all<{ detail: string }>(`EXPLAIN QUERY PLAN SELECT i.id, ${INSTALLMENT_DISCOUNT_SQL} AS d FROM contract_installments i WHERE i.id = ?`, ['x'])
      .map((r) => r.detail).join('\n');
    expect(plan).not.toMatch(/ix_jl_account\b/);
    expect(plan).toMatch(/ix_jl_entry_account/);
    // والإحصاءات تبقى بعد إعادة الفتح والهجرة
    expect(Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM sqlite_stat1 WHERE idx = 'ix_jl_account'`)!.n)).toBe(1);
  });
});
