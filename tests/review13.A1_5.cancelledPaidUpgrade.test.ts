/**
 * A1-5 · البيانات القائمة: قسطٌ ملغى بقي مسدَّده بعد إلغاء دفعته (قبل الإصلاح) يُصحَّح مرةً عند الترقية،
 * وقسطٌ ملغى عليه دفعةٌ حيّة يبقى مسدَّده كما هو، والحالة «ملغية» لا تُمسّ في الحالين. بيانات مصطنعة كلها.
 * الأرقام الذهبية: عقد ١٢٬٠٠٠ بأقساط ربع سنوية ٣٬٠٠٠ = ٣٠٠٠٠٠ هللة للقسط.
 */
import { memDb } from './helpers/testDb';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { confirmContract, cancelContract, recordRentPayment } from '@/domain/contracts/service';
import { recomputePaidOnUpgrade, recomputeInstallments } from '@/domain/contracts/paid';
import { ownerCashIn } from '@/domain/cashOps';

function setup() {
  const db = memDb();
  ownerCashIn(db, { amountHalalas: 500000, date: '2026-01-01' });
  const u = addUnit(db, addProperty(db, { name: 'عقار ترقية مصطنع' }), { unit_no: 'U-5' });
  const cid = confirmContract(db, contractInput(u, { tenant: 'مستأجر ترقية مصطنع', idNumber: '1000000968',
    valueHalalas: 1200000, cycle: 'ربع سنوية', start: '2026-01-01', end: '2026-12-31', depositHalalas: 0 }));
  const inst = (due: string) => db.get<{ id: string }>(`SELECT id FROM contract_installments WHERE contract_id = ? AND due_date = ?`, [cid, due])!.id;
  const q2 = inst('2026-04-01');
  const q3 = inst('2026-07-01');
  // ١٬٠٠٠ مقدماً من قسط الربع الثاني، ثم إلغاء العقد بإلغاء الأقساط بعده
  recordRentPayment(db, cid, { installmentId: q2, period: '', date: '2026-03-20',
    lines: [{ method: 'cash', amountHalalas: 100000 }], discountHalalas: 0, notes: '' });
  cancelContract(db, cid, { date: '2026-03-25', reason: 'إنهاء مصطنع', installmentsFate: 'cancel', settle: false,
    deductionHalalas: 0, refundHalalas: 0, deductionReason: '' });
  return { db, q2, q3 };
}
const row = (db: ReturnType<typeof memDb>, id: string) =>
  db.get<{ status: string; paid: number }>(`SELECT status, paid_halalas AS paid FROM contract_installments WHERE id = ?`, [id]);

test('A1-5 الترقية تصحّح مسدَّداً ميتاً على قسطٍ ملغى مرةً واحدة، وتُبقي الحيّ والحالة', () => {
  const { db, q2, q3 } = setup();
  // حال قاعدةٍ قبل الإصلاح: القسط الثالث ملغى ومسدَّده ٥٠٠ بلا دفعة (بقي بعد إلغاء دفعته)
  db.run(`UPDATE contract_installments SET paid_halalas = 50000 WHERE id = ?`, [q3]);
  db.run(`INSERT OR REPLACE INTO meta (key, value) VALUES ('paid_derived_v21', 'x')`);
  db.run(`DELETE FROM meta WHERE key = 'paid_derived_cancelled_a15'`);

  const changed = recomputePaidOnUpgrade(db)!;
  expect(changed.map((c) => [c.installmentId, c.fromPaid, c.toPaid])).toEqual([[q3, 50000, 0]]);
  expect(row(db, q3)).toEqual({ status: 'ملغية', paid: 0 });
  // دفعة الـ١٬٠٠٠ حيّة فيبقى مسدَّد قسطها ١٠٠٠٠٠ وحالته «ملغية»
  expect(row(db, q2)).toEqual({ status: 'ملغية', paid: 100000 });
  // مرةً واحدة: الأعلام قائمة فلا تعمل ثانيةً
  expect(recomputePaidOnUpgrade(db)).toBeNull();
  // وإعادة الحساب العادية لا تغيّر شيئاً بعدها
  expect(recomputeInstallments(db)).toEqual([]);
  db.close();
});
