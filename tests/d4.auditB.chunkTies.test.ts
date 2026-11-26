/**
 * اختبارات المدقق الخارجي أُبقيت حارساً بعد إصلاح ما أثبتته (التوجيه الرابع ٣ · الجولة الأولى) ·
 * مدقق خارجي B · 1adf0a0 ادّعى «نتيجة القطع نتيجة العبارة الواحدة (والترتيب بعدها حيث يلزم)» · في التحصيل الجماعي ترتيب الأقساط
 * يحدد أيها يأخذ المال أولاً، والترتيب بعد القطع بالاستحقاق وحده: المتساوية في الاستحقاق تأخذ ترتيب القطع (ترتيب قائمة الإدخال)
 * لا ترتيب العبارة الواحدة · فوق ٥٠٠ قسط بالتاريخ نفسه يذهب المال إلى أقساطٍ أخرى · بيانات مصطنعة.
 */
import { memDb } from './helpers/testDb';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { confirmContract, recordBulkRentPayment } from '@/domain/contracts/service';
import { INSTALLMENT_DISCOUNT_SQL } from '@/domain/contracts/installments';
import type { DB } from '@/db/adapter';

const N = 1000;

function setup(): { db: DB; c: string; ids: string[] } {
  const db = memDb();
  const p = addProperty(db, { name: 'عقار تعادل مصطنع' });
  const u = addUnit(db, p, { unit_no: 'TIE-1' });
  const c = confirmContract(db, contractInput(u));
  db.run(
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
     INSERT INTO contract_installments (id, contract_id, due_date, amount_halalas, paid_halalas, status, sort)
     SELECT 'TIE-' || printf('%04d', i), ?, '2030-01-01', 1000, 0, 'مستحقة', 1000 + i FROM n`, [N, c]);
  const ids = db.all<{ id: string }>(`SELECT id FROM contract_installments WHERE id LIKE 'TIE-%' ORDER BY id`).map((r) => r.id);
  return { db, c, ids };
}

test('التحصيل الجماعي بألف قسطٍ متساوي الاستحقاق: الأقساط التي يُخصَّص لها المال هي ما تعطيه العبارة الواحدة (18c43c8)', () => {
  const { db, c, ids } = setup();
  const input = [...ids].reverse(); // ترتيب الاختيار في الواجهة ليس ترتيب المعرّف
  // العبارة الواحدة كما كانت في 18c43c8:src/domain/contracts/service.ts
  const reference = db.all<{ id: string }>(
    `SELECT i.id, i.due_date, i.amount_halalas, i.paid_halalas, ${INSTALLMENT_DISCOUNT_SQL} AS discount, i.status
     FROM contract_installments i
     WHERE i.contract_id = ? AND i.id IN (${input.map(() => '?').join(',')})
       AND i.status != 'ملغية' ORDER BY i.due_date`, [c, ...input]).map((r) => r.id);
  const expected = reference.slice(0, N / 2).sort();
  recordBulkRentPayment(db, c, { installmentIds: input, date: '2026-02-01', lines: [{ method: 'cash', amountHalalas: (N / 2) * 1000 } as never], notes: '' });
  const got = db.all<{ id: string }>(`SELECT installment_id AS id FROM payment_allocations ORDER BY installment_id`).map((r) => r.id);
  // eslint-disable-next-line no-console
  console.log('first allocated:', got[0], '... reference first:', expected[0]);
  expect(got.length).toBe(N / 2);
  const same = got.filter((id) => expected.includes(id)).length;
  // eslint-disable-next-line no-console
  console.log('أقساطٌ مشتركة بين التخصيص المقطَّع والعبارة الواحدة:', same, 'من', N / 2);
  expect({ first: got[0], last: got[got.length - 1], same }).toEqual({ first: expected[0], last: expected[expected.length - 1], same: N / 2 });
});
