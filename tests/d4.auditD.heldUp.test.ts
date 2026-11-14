/**
 * المدقق الخارجي D · الجولة الثانية · ما حاولتُ كسره فصمد (اختبارات ناجحة للسجل) · بيانات مصطنعة.
 */
import { randomBytes } from 'crypto';
import {
  generateRecoveryKey, isValidRecoveryKey, normalizeKey, KEY_ALPHABET, KEY_LENGTH, confirmsRecoveryKey,
} from '@/domain/backup/recoveryKey';
import { parseDeviceBackupName } from '@/domain/backup/deviceBackups';
import { memDb } from './helpers/testDb';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { confirmContract, recordBulkRentPayment } from '@/domain/contracts/service';

const rnd = (n: number) => new Uint8Array(randomBytes(n));

test('محرف التحقق: كل استبدالٍ لمحرفٍ واحد (٣١ بديلاً في كل موضع) وكل تبديل جارين يُكشف · ٣٠٠ مفتاح', () => {
  for (let n = 0; n < 300; n++) {
    const k = generateRecoveryKey(rnd);
    for (let i = 0; i < KEY_LENGTH; i++) {
      for (const c of KEY_ALPHABET) {
        if (c === k[i]) continue;
        expect(isValidRecoveryKey(k.slice(0, i) + c + k.slice(i + 1))).toBe(false);
      }
      if (i < KEY_LENGTH - 1 && k[i] !== k[i + 1]) {
        expect(isValidRecoveryKey(k.slice(0, i) + k[i + 1] + k[i] + k.slice(i + 2))).toBe(false);
      }
    }
  }
});

test('O وI وL ليست في الأبجدية، فقراءتها 0 و1 لا تُحدث لبساً · وU مرفوضة · والتأكيد بآخر مجموعةٍ لا بأولها', () => {
  for (const c of 'OILU') expect(KEY_ALPHABET.includes(c)).toBe(false);
  const k = generateRecoveryKey(rnd);
  expect(isValidRecoveryKey(k.replace(/0/g, 'o').replace(/1/g, 'l'))).toBe(true);
  expect(normalizeKey(k.toLowerCase())).toBe(k);
  expect(confirmsRecoveryKey(k, k.slice(-5, -1))).toBe(false);
});

test('أسماء نسخ الجهاز: لا مسار ملتفّ ولا اسمٌ مصنوع يُقبل، والوقت بتوقيت UTC كما في الاسم', () => {
  for (const bad of ['pre-wipe-2026-11-07T08-05-09-120Z.aqbk/../../x', 'x/pre-wipe-2026-11-07T08-05-09-120Z.aqbk', 'pre-wipe-2026-11-07T08-05-09-120Z-empty-empty.aqbk', 'pre-upgrade-2026-11-07T08-05-09-120Z-v.aqbk']) {
    expect(parseDeviceBackupName(bad)).toBeNull();
  }
  expect(parseDeviceBackupName('pre-wipe-2026-11-07T21-30-00-000Z-empty.aqbk')).toMatchObject({ at: '2026-11-07T21:30:00.000Z', empty: true });
});

test('ترتيب المتساويات في الاستحقاق في التحصيل الجماعي بترتيب الجدول (sort) لا بترتيب الاختيار ولا بالمعرّف', () => {
  const db = memDb();
  const u = addUnit(db, addProperty(db, { name: 'عقار تعادل مصطنع' }), { unit_no: 'T-1' });
  const c = confirmContract(db, contractInput(u));
  // ثلاثة أقساط بالتاريخ نفسه، وsort عكس المعرّف
  for (const [id, sort] of [['Z-A', 3], ['Z-B', 2], ['Z-C', 1]] as const) {
    db.run(`INSERT INTO contract_installments (id, contract_id, due_date, amount_halalas, paid_halalas, status, sort) VALUES (?, ?, '2031-01-01', 1000, 0, 'مستحقة', ?)`, [id, c, sort]);
  }
  recordBulkRentPayment(db, c, { installmentIds: ['Z-A', 'Z-B', 'Z-C'], date: '2026-02-01', lines: [{ method: 'cash', amountHalalas: 1000 } as never], notes: '' });
  const got = db.all<{ id: string }>(`SELECT installment_id AS id FROM payment_allocations`).map((r) => r.id);
  expect(got).toEqual(['Z-C']);
});
