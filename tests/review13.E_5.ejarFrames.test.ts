/**
 * المراجعة الشاملة 2026-11-13 · E-5: جدول دفعات إيجار الممتد على صفحتين يُقرأ نصفه · أسطر إطار الصفحة (رقمها بالعربية أو الإنجليزية،
 * وترويسة الصفحة، وصفّ العناوين المكرر) لا تُنهي الجدول، وما سواها من نصٍّ ينهيه · وحين لا يطابق المجموع إجمالي العقد يظهر زرّ
 * «احسب الأقساط بدل جدول الملف»، والعقد بلا جدولٍ مقروء تُحسب أقساطه من قيمته · نصوص مخترعة لا بيانات حقيقية.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseEjarSchedule } from '@/domain/pdf/parseEjar';
import { memDb } from './helpers/testDb';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { confirmContract } from '@/domain/contracts/service';

const HEAD = [
  'Ejar Contract',
  'Contract No. 20260088888 / 1-2026',
  'Tenancy Start Date 2026-01-01',
  'Tenancy End Date 2026-12-31',
  'جدول سداد الدفعات',
  'No. Due Date (Hijri) Due Date (Gregorian) Payment Deadline (Gregorian) Amount',
].join('\n');
const row = (i: number) => {
  const m = String(i).padStart(2, '0');
  return `${i} 1447-0${(i % 9) + 1}-12 2026-${m}-01 2026-${m}-10 1,000.00`;
};
const rows = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, k) => row(a + k)).join('\n');

test('E-5 «صفحة ١ من ٢» بالعربية وترويسةٌ ظهرت أعلى الملف بين صفحتي الجدول: تُقرأ الصفوف الاثنا عشر بمجموع 1,200,000 هللة', () => {
  const txt = HEAD + '\n' + rows(1, 7) + '\nصفحة 1 من 2\nEjar Contract\n'
    + 'No. Due Date (Hijri) Due Date (Gregorian) Payment Deadline (Gregorian) Amount\n' + rows(8, 12) + '\nالتزامات الطرفين\n';
  const s = parseEjarSchedule(txt);
  expect(s?.length).toBe(12);
  expect(s?.reduce((x, r) => x + r.amountHalalas, 0)).toBe(1_200_000);
});

test('E-5 نصٌّ غير إطار الصفحة بعد الصفوف ما زال ينهي الجدول: لا يُضمّ جدولٌ آخر بعده', () => {
  const txt = HEAD + '\n' + rows(1, 12) + '\nPage 1 of 2\nObligations of the Parties\n'
    + '1 1447-01-01 2026-12-20 2026-12-25 5,000.00\n';
  expect(parseEjarSchedule(txt)?.length).toBe(12);
});

test('E-5 زرّ «احسب الأقساط بدل جدول الملف» في المراجعة يُسقط الجدول المقروء', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/ui/ScheduleReview.tsx'), 'utf8');
  expect(src).toMatch(/onUseComputed && scheduleSumGap/);
  expect(src).toMatch(/lease\.useComputedSchedule/);
  const screen = fs.readFileSync(path.join(__dirname, '..', 'app/(tabs)/contracts.tsx'), 'utf8');
  expect(screen).toMatch(/onUseComputed=\{\(\) => form\.set\('schedule', null\)\}/);
});

test('E-5 عقدٌ من ملف إيجار أُسقط جدوله: تُحسب أقساطه من قيمته ويوسم «محسوبة»', () => {
  const db = memDb();
  const unit = addUnit(db, addProperty(db, { name: 'عقار مصطنع' }), { unit_no: '7' });
  const id = confirmContract(db, { ...contractInput(unit, { valueHalalas: 1_200_000 }), schedule: null, fromEjarFile: true });
  const n = db.get<{ n: number; s: number }>(`SELECT COUNT(*) AS n, SUM(amount_halalas) AS s FROM contract_installments WHERE contract_id = ?`, [id])!;
  expect(Number(n.n)).toBe(12);
  expect(Number(n.s)).toBe(1_200_000);
  const src = db.get<{ s: string | null }>(`SELECT installments_source AS s FROM contracts WHERE id = ?`, [id])!.s;
  expect(src).toBe('محسوبة');
  db.close();
});
