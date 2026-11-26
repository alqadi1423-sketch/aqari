/**
 * المراجعة الشاملة 2026-11-13 · E-4: ترقيم صفحات العقد والكشف خاطئ · الكتلة الأكبر من سعة صفحتها كانت توضع كاملة، فتفيض الصفحة الأولى
 * ويقطعها المتصفح فيظهر «صفحة ١ من ٢» في الورقة الثانية من ثلاث · الآن سعة الأولى تخصم مقدّمتها (العقد ١٢ صفاً ثم ٢٢، والكشف ١٤ ثم ٢٠)،
 * والجدول يُقسم على الصفحات برأسه في كل صفحة، فعدد الصفحات المبنية هو عدد الأوراق · بيانات مصطنعة، والمبالغ بالهللات.
 */
import { buildContractDoc, buildStatementDoc, paginateChunks, type CompanyInfo } from '@/domain/printDocs';

const CO: CompanyInfo = { name: 'منشأة مصطنعة', vatno: '', cr: '', phone: '', address: '', vatEnabled: false };
const NOW = '28/11/2026 10:00';

/** صفوف بيانات كل صفحة (صفوف tbody) */
const rowsPerPage = (doc: string): number[] =>
  doc.split('<div class="page">').slice(1).map((p) => {
    const bodies = p.match(/<tbody>[\s\S]*?<\/tbody>/g) ?? [];
    return bodies.reduce((n, b) => n + (b.match(/<tr>/g) ?? []).length, 0);
  });
const footers = (doc: string) => [...doc.matchAll(/صفحة <span class="num">(\d+)<\/span> من <span class="num">(\d+)<\/span>/g)].map((m) => [+m[1], +m[2]]);

const contract = (n: number) => buildContractDoc(CO, {
  contractNo: '20260012345', tenantName: 'مستأجر مصطنع', idNumber: '1000000074', phone: '0500000033', unitLabel: 'A-1',
  propertyName: 'عقار مصطنع', start: '2026-01-01', end: '2028-12-31', valueHalalas: n * 500_000, depositHalalas: 0, cycle: 'شهرية',
  status: 'سارٍ', installments: Array.from({ length: n }, (_, i) => ({
    dueDate: `${2026 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}-01`, amountHalalas: 500_000, paidHalalas: 0, status: 'مستحقة',
  })),
}, NOW);

const statement = (n: number) => buildStatementDoc(CO, {
  tenantName: 'مستأجر مصطنع', contractNo: 'C-1', unitLabel: 'A-1', start: '2026-01-01', end: '2026-12-31',
  rows: Array.from({ length: n }, (_, i) => ({ date: '2026-01-01', descr: i % 2 ? 'سداد' : 'قسط', debitHalalas: i % 2 ? 0 : 500_000, creditHalalas: i % 2 ? 500_000 : 0 })),
}, NOW);

test('E-4 عقدٌ بـ١٧ قسطاً: ١٢ صفاً في الأولى والباقي بعدها، والتذييل «من ٢» في كل صفحة', () => {
  const doc = contract(17);
  expect(rowsPerPage(doc)).toEqual([12, 5]);
  expect(footers(doc)).toEqual([[1, 2], [2, 2]]);
});

test('E-4 عقدٌ بـ٣٦ قسطاً: لا صفحة فوق سعتها (١٢ ثم ٢٢)، والأقساط كلها مطبوعة', () => {
  const pp = rowsPerPage(contract(36));
  expect(pp[0]).toBeLessThanOrEqual(12);
  pp.slice(1).forEach((n) => expect(n).toBeLessThanOrEqual(22));
  expect(pp.reduce((a, b) => a + b, 0)).toBe(36);
});

test('E-4 كشفٌ بـ٢٠ سطراً و٤٠ سطراً: ١٤ في الأولى ثم ٢٠، والتذييل يطابق عدد الصفحات', () => {
  const d20 = statement(20);
  expect(rowsPerPage(d20)).toEqual([14, 6]);
  expect(footers(d20)).toEqual([[1, 2], [2, 2]]);
  const d40 = statement(40);
  expect(rowsPerPage(d40)).toEqual([14, 20, 6]);
  expect(footers(d40).map((f) => f[1])).toEqual([3, 3, 3]);
});

test('E-4 paginateChunks يقسم الجدول الأكبر من سعة الصفحة برأسه في كل صفحة', () => {
  const rows = Array.from({ length: 30 }, (_, i) => `<tr><td>${i}</td></tr>`);
  const pages = paginateChunks([{ html: '', rows: 0, table: { open: '<table><thead><tr><th>#</th></tr></thead><tbody>', close: '</tbody></table>', rows, overhead: 2 } }], 12, 24);
  expect(pages.map((p) => (p.join('').match(/<td>/g) ?? []).length)).toEqual([10, 20]);
  expect(pages.every((p) => p.join('').includes('<thead>'))).toBe(true);
});
