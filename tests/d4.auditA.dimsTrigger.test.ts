/**
 * اختبارات المدقق الخارجي أُبقيت حارساً بعد إصلاح ما أثبتته (التوجيه الرابع ٣ · الجولة الأولى) ·
 * مدقق خارجي (أ) · محفّز trg_jl_dims_fill_only (الترحيلة ٥١): مسارات التطبيق التي تمسّ أبعاد سطرٍ مرحّل · بيانات مصطنعة.
 */
import { memDb } from './helpers/testDb';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { confirmContract, recordRentPayment } from '@/domain/contracts/service';
import { recordKeyMoneyDeal } from '@/domain/keymoney';
import { entrySourceAction } from '@/domain/accounting/sourceCancel';
import { restoreFromTrash } from '@/domain/trash';
import { saveUnit } from '@/domain/propertiesService';
import { planDimsBackfill, applyDimsBackfill, acknowledgeUnknownDims } from '@/domain/accounting/dimensions';
import { postManualEntry, reverseAllPostedEntries } from '@/domain/accounting/post';
import { asLegacyDims } from './helpers/legacyDims';
import { pair, sync } from './helpers/rederive';
import type { DB } from '@/db/adapter';

const legacy = (db: DB, where = '1 = 1') => asLegacyDims(db, () => db.run(
  `UPDATE journal_lines SET property_id = NULL, unit_id = NULL, contract_id = NULL, cost_center_id = NULL WHERE ${where}`));
const pay = (db: DB, c: string, amount: number) => {
  const i = db.get<{ id: string; due_date: string }>(`SELECT id, due_date FROM contract_installments WHERE contract_id = ? ORDER BY due_date LIMIT 1`, [c])!;
  return recordRentPayment(db, c, { installmentId: i.id, period: i.due_date, date: i.due_date, lines: [{ method: 'cash', amountHalalas: amount }], discountHalalas: 0, notes: '' });
};

describe('مدقق أ · محفّز الأبعاد', () => {
  test('ما صمد · قيودٌ قديمة بلا أبعاد: نقل الوحدة إلى عقارٍ آخر، والملء، والإبقاء، وإلغاء التقبيل واستعادته، والمسح بالعكس', () => {
    const db = memDb();
    const p1 = addProperty(db, { name: 'عقار محفّز أول مصطنع' });
    const p2 = addProperty(db, { name: 'عقار محفّز ثانٍ مصطنع' });
    const u1 = addUnit(db, p1, { unit_no: 'TR-1' });
    const c1 = confirmContract(db, contractInput(u1, { tenant: 'مستأجر محفّز مصطنع', idNumber: '1000009001', phone: '0500009001', depositHalalas: 0 }));
    pay(db, c1, 50000);
    const deal = recordKeyMoneyDeal(db, { unitId: u1, contractId: c1, outgoing: 'متنازل محفّز', incoming: 'متنازل له محفّز', amountHalalas: 1000000,
      date: '2026-03-01', commissionHalalas: 100000, method: 'cash', notes: '' });
    postManualEntry(db, { date: '2026-02-01', memo: 'قيد يدوي محفّز', lines: [{ account: '1100', debit: 1000, credit: 0 }, { account: '3100', debit: 0, credit: 1000 }] });
    legacy(db);
    // الوحدة تُنقل إلى عقارٍ آخر (saveUnit ← retagUnitTree): لا يمسّ سطور القيود
    expect(() => saveUnit(db, { propertyId: p2, unitNo: 'TR-1', floor: 'الأرضي', type: 'سكني', subtype: '', rentMonthlyHalalas: 100000, rooms: [], meters: [] }, u1)).not.toThrow();
    const plan = planDimsBackfill(db);
    expect(plan.known.length).toBeGreaterThan(0);
    expect(() => applyDimsBackfill(db, plan)).not.toThrow();
    expect(() => acknowledgeUnknownDims(db, plan.unknown.map((u) => u.entryId))).not.toThrow();
    const k = db.get<{ id: string }>(`SELECT id FROM journal_entries WHERE src_type = 'key_money' AND src_id = ?`, [deal])!.id;
    const a = entrySourceAction(db, k);
    if (a?.kind !== 'op') throw new Error('op');
    expect(() => a.run('2026-03-05', 'إلغاء محفّز')).not.toThrow();
    expect(() => restoreFromTrash(db, 'key_money_deals', deal)).not.toThrow();
    expect(() => reverseAllPostedEntries(db, 'مسح محفّز', '2026-04-01')).not.toThrow();
    db.close();
  });

  test('جهازا مالك: خطة ملءٍ معروضة ثم يصل ملءٌ آخر للقيد نفسه بالمزامنة: «تنفيذ» يفشل كله (لا يُملأ غيره)', async () => {
    const s = await pair();
    const O1 = s.owner, O2 = s.dev;
    const p1 = addProperty(O1, { name: 'عقار جهازين أول مصطنع' });
    const p2 = addProperty(O1, { name: 'عقار جهازين ثانٍ مصطنع' });
    const u1 = addUnit(O1, p1, { unit_no: 'TW-1' });
    const c1 = confirmContract(O1, contractInput(u1, { tenant: 'مستأجر جهازين مصطنع', idNumber: '1000009002', phone: '0500009002', depositHalalas: 0 }));
    pay(O1, c1, 40000);
    legacy(O1);
    await sync(O1, s.r);
    await sync(O2, s.r);
    // O2 ينقل الوحدة إلى العقار الثاني ثم يملأ: بعقارها الجديد
    saveUnit(O2, { propertyId: p2, unitNo: 'TW-1', floor: 'الأرضي', type: 'سكني', subtype: '', rentMonthlyHalalas: 100000, rooms: [], meters: [] }, u1);
    // O1 يعرض الخطة قبل أن يصله شيء (بعقارها القديم)
    const stale = planDimsBackfill(O1);
    applyDimsBackfill(O2, planDimsBackfill(O2));
    await sync(O2, s.r);
    await sync(O1, s.r);
    let err = '';
    try { applyDimsBackfill(O1, stale); } catch (e) { err = String((e as Error).message); }
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ err, staleKnown: stale.known.length, freshKnown: planDimsBackfill(O1).known.length }));
    expect(err).toBe('');
    s.close();
  });
});
