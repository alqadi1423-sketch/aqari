/**
 * مراجعة التثبيت #24 · المؤشرات والتقارير تطابق الدفتر · بيانات مصطنعة:
 *  مؤشرات التحصيل بلا الأقساط الملغاة · والمحصَّل ما قُبض فعلاً · ومصروف تقرير الوحدة كما رحّله الدفتر
 */
import { memDb } from './helpers/testDb';
import { addBank, addProperty, addUnit, contractInput } from './helpers/fixtures';
import { confirmContract, recordRentPayment, cancelContract } from '@/domain/contracts/service';
import { allInstallments, collectKpis, propertyStats } from '@/domain/stats';
import { savePurchase } from '@/domain/purchases';
import { unitReportData } from '@/domain/reportData';

test('#٢٤ مؤشرات التحصيل بلا الملغاة · والمحصَّل صافي الدفعات · والمصروف بلا الضريبة القابلة للاسترداد ولا الأصول', () => {
  const db = memDb();
  const bank = addBank(db);
  const p = addProperty(db, { name: 'عقار مؤشرات مصطنع' });
  const u = addUnit(db, p, { unit_no: 'S-1' });
  const cid = confirmContract(db, contractInput(u, { tenant: 'مستأجر مؤشرات مصطنع', idNumber: '1000000181', phone: '0500000121',
    valueHalalas: 1200000, cycle: 'شهرية', start: '2026-01-01', end: '2026-12-31', depositHalalas: 0 }));
  const insts = db.all<{ id: string }>(`SELECT id FROM contract_installments WHERE contract_id = ? ORDER BY due_date`, [cid]).map((r) => r.id);
  // دفعة جزئية ٤٠٠ ريال على يناير
  recordRentPayment(db, cid, { installmentId: insts[0], period: 'يناير', date: '2026-01-05', notes: '', discountHalalas: 0,
    lines: [{ method: 'bank', bankId: bank, amountHalalas: 40000 }] });
  expect(propertyStats(db, p, '2026-01-31').income).toBe(40000);
  // إلغاء العقد بإلغاء أقساطه الباقية: لا تدخل المستحق ولا نسبة التحصيل
  cancelContract(db, cid, { date: '2026-01-20', reason: 'إلغاء مصطنع', installmentsFate: 'cancel', settle: false, deductionHalalas: 0, refundHalalas: 0, deductionReason: '' });
  const k = collectKpis(allInstallments(db, '2026-01-31'), '2026-01-31');
  const live = allInstallments(db, '2026-01-31').filter((x) => x.status !== 'ملغية');
  expect(k.collectionPct).toBe(Math.round((live.reduce((s, x) => s + x.paid, 0) / live.reduce((s, x) => s + x.amount, 0)) * 100));
  // فاتورة خاضعة قابلة للخصم ببند أصل: المصروف ١٠٠ ريال (التركيب) لا ٤٦٠
  db.run(`INSERT INTO suppliers (id, name, vat, created_at) VALUES ('SP1', 'مورد ضريبي مصطنع', '300000000000003', '2026-01-01T00:00:00.000Z')`);
  savePurchase(db, {
    supplier: 'مورد ضريبي مصطنع', date: '2026-02-15', due: '2026-02-15', category: 'صيانة', incorpItem: '', amortize: false, amortizeMonths: null,
    exempt: false, excludeFromVat: false, taxStatus: 'فاتورة ضريبية · قابلة للخصم', unitId: u,
    subtotalHalalas: 40000, taxHalalas: 6000, totalHalalas: 46000,
    lines: [{ descr: 'مكيف مصطنع', qty: 1, amountHalalas: 30000, isAsset: true, category: '1410', unitId: u, room: '' },
      { descr: 'تركيب مصطنع', qty: 1, amountHalalas: 10000, isAsset: false }],
  } as never);
  expect(unitReportData(db, u, '2026-01-01', '2026-12-31')!.totals.expenses).toBe(10000);
  db.close();
});
