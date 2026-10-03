/**
 * تقرير الخطأ يخرج من الجهاز · فلا اسم فيه ولا جوال ولا هوية ولا مبلغ،
 * وتبقى مواضع الكود في الأثر بأرقام سطورها.
 */
import { redactForReport } from '@/domain/redact';
import { semanticIssues } from '@/domain/backup/semantic';
import { memDb } from './helpers/testDb';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { confirmContract } from '@/domain/contracts/service';

const NAME = 'زيدان الاختباري';
const LATIN = 'ZQPROBE NAME';
const PHONE = '0559871234';
const ID = '1098712345';

test('رسائل الدومين تُحجب أسماؤها وأرقامها ومبالغها', () => {
  const samples = [
    `تغيّر قسط ${NAME} · 2026-02-01 منذ عرض التصحيح · أعد العرض`,
    'الخصم يتجاوز المتبقي على القسط بـ7,777.00 · لم يُسجَّل',
    'المبلغ (1,650.00) أكبر من الفائض (200.00)',
    `بصمة الملف «${LATIN} عقد.pdf» لا تطابق المسجَّلة له`,
    `رقم الوحدة "ZQ-77" مستخدَم بالفعل`,
    `تغيّر قسط ${LATIN} · ZQ-77 · 2026-02-01`,
    `UNIQUE constraint failed: tenants.national_id ${ID} ${PHONE}`,
    'المبلغ ٧٬٧٧٧ ريال',
  ];
  for (const s of samples) {
    const out = redactForReport(s);
    expect(out).not.toMatch(/\d/);
    expect(out).not.toMatch(/[٠-٩]/);
    expect(out).not.toContain(NAME);
    expect(out).not.toContain(LATIN);
    expect(out).not.toContain('ZQ-77');
  }
  // الشكل التقني الإنجليزي يبقى
  expect(redactForReport(`UNIQUE constraint failed: tenants.national_id ${ID}`)).toBe('UNIQUE constraint failed: tenants.national_id #');
});

test('سطور الأثر تبقى بمواضعها · والرسالة فوقها تُحجب', () => {
  const stack = [
    `Error: تغيّر قسط ${NAME} · 7,777.00`,
    '    at applyLedgerRepair (address at index.android.bundle:1:234567)',
    '    at anonymous (index.android.bundle:1:99)',
    'reportFailure@index.android.bundle:1:4455',
  ].join('\n');
  const out = redactForReport(stack);
  const lines = out.split('\n');
  expect(lines[0]).toBe('Error: … · #');
  expect(lines.slice(1)).toEqual(stack.split('\n').slice(1));
});

test('فحوص الاستعادة التي تسمّي المستأجر · تقريرها بلا اسمه', () => {
  const db = memDb();
  const p = addProperty(db);
  const u = addUnit(db, p, { rent: 100000 });
  const cid = confirmContract(db, contractInput(u, { tenant: NAME, phone: PHONE, idNumber: ID, valueHalalas: 1200000, depositHalalas: 0 }));
  db.exec('DROP TRIGGER IF EXISTS trg_inst_update_cap');
  db.run(`UPDATE contract_installments SET paid_halalas = amount_halalas + 5000 WHERE contract_id = ?`, [cid]);
  const issues = semanticIssues(db);
  expect(issues.join(' ')).toContain(NAME); // الرسالة للمستخدم تسمّيه
  const out = redactForReport('RestoreError: ' + issues.join(' · '));
  expect(out).not.toContain(NAME);
  expect(out).not.toMatch(/\d/);
  db.close();
});
