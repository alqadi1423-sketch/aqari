/**
 * المراجعة الشاملة 2026-11-13 · A1-10 · منخفض · app/(tabs)/contracts.tsx (ReviewSheet) · بيانات مصطنعة.
 *
 * ما كان: ملخص «عدد الدفعات × المبلغ» في صفحة المراجعة الإلزامية يُحسب من (النهاية − البداية) ÷ 30.4375 ومن قيمة الإيجار وحدها،
 * والإنشاء من (الأيام شاملةً) ÷ 30.44 ومن إجمالي العقد (الإيجار والخدمات والمواقف).
 * المثال الذهبي: من 2026-01-01 إلى 2026-02-15 شهرياً بـ١٬٠٠٠٫٠٠ · الملخص «١ دفعة × ١٬٠٠٠» والإنشاء دفعتان بـ٥٠٠٫٠٠ ·
 * ومعها خدمات ٢٠٠٫٠٠: دفعتان بـ٦٠٠٫٠٠.
 * الصحيح: الملخص من الصفوف نفسها التي يعرضها جدول المراجعة ويُنشئها التوثيق.
 */
import fs from 'fs';
import path from 'path';
import { memDb } from './helpers/testDb';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import * as service from '@/domain/contracts/service';

type Rows = { read: boolean; rows: Array<{ due: string; amount: number }> } | null;
const rowsOf = (a: Record<string, unknown>): Rows =>
  (service as unknown as { reviewScheduleRows: (x: Record<string, unknown>) => Rows }).reviewScheduleRows(a);

test('A1-10 صفوف المراجعة تطابق ما يُنشئه التوثيق بالعدد والمبلغ', () => {
  expect(rowsOf({ start: '2026-01-01', end: '2026-02-15', totalHalalas: 100000, cycle: 'شهرية' })!.rows.map((r) => r.amount))
    .toEqual([50000, 50000]);
  const db = memDb();
  const u = addUnit(db, addProperty(db, { name: 'عقار مراجعة مصطنع' }), { unit_no: 'RV-1' });
  const id = service.confirmContract(db, { ...contractInput(u, { tenant: 'مستأجر مراجعة مصطنع', idNumber: '1000001010', valueHalalas: 100000,
    start: '2026-01-01', end: '2026-02-15', depositHalalas: 0 }), servicesHalalas: 20000 });
  const made = db.all<{ a: number }>(`SELECT amount_halalas AS a FROM contract_installments WHERE contract_id = ? ORDER BY sort`, [id]).map((r) => Number(r.a));
  expect(made).toEqual([60000, 60000]);
  expect(rowsOf({ start: '2026-01-01', end: '2026-02-15', totalHalalas: 120000, cycle: 'شهرية' })!.rows.map((r) => r.amount)).toEqual(made);
  db.close();
});

test('A1-10 جدول الملف المقروء يحكم الصفوف كالتوثيق', () => {
  const r = rowsOf({ start: '2026-01-01', end: '2026-12-31', totalHalalas: 1200000, cycle: 'شهرية',
    schedule: [{ dueDate: '2026-01-10', amountHalalas: 600000 }, { dueDate: '2026-07-10', amountHalalas: 600000 }] })!;
  expect([r.read, r.rows.map((x) => [x.due, x.amount])]).toEqual([true, [['2026-01-10', 600000], ['2026-07-10', 600000]]]);
});

test('A1-10 صفحة المراجعة لا تحسب العدد بطريقةٍ ثانية · تبنيه من صفوف الجدول وبإجمالي العقد', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '..', 'app', '(tabs)', 'contracts.tsx'), 'utf8');
  const sheet = src.slice(src.indexOf('function ReviewSheet('), src.indexOf('function ContractDetailSheet('));
  expect(sheet).not.toMatch(/Math\.round\(months \/ per\)/);
  expect(sheet).toMatch(/reviewScheduleRows\(/);
  const review = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'ui', 'ScheduleReview.tsx'), 'utf8');
  expect(review).toMatch(/reviewScheduleRows\(/);
});
