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
