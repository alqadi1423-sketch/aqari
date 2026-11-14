/**
 * التوجيه الرابع · ٣ · ٣: بنود القرارات المعلّقة الصغيرة (قرار المالك 2026-11-07 «نغلقها»: البنود ١ إلى ٢٠ بالخيار الموصى به) ·
 * ١ (أ) لا «دمج» عند اعتماد نسخة مستعادة · ٤ (أ) خانة خالية بدل «لا يوجد» في التصدير والمطبوعات والرسائل · ٦ (أ) «السابق» و«التالي»
 * لا يظهران معطّلين · ١٤ (أ) زر التحصيل الجماعي لا يعود · ٢٠ (أ) لا رابط لدليل الحسابات في الإعدادات · بيانات مصطنعة.
 */
import fs from 'fs';
import path from 'path';
import { resolveTemplateTokens } from '@/domain/templates';
import { letterhead, buildReceiptDoc } from '@/domain/printDocs';
import { dfmtOut } from '@/domain/dates';

const ROOT = path.join(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
/** النص بلا التعليقات: ما يُعرض أو يُكتب لا ما يشرحه */
const code = (rel: string) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

describe('البند ١ · اعتماد نسخة مستعادة: «اعتماد» أو «إلغاء» وحدهما', () => {
  test('لا زر «دمج مع السحابة» ولا مساره في الإعدادات ولا في الخدمة', () => {
    const s = code('app/settings.tsx');
    expect(s).not.toMatch(/دمج مع السحابة|أو دمجها|clearRestoredUnadopted/);
    expect(code('src/services/cloud.ts')).not.toMatch(/export async function clearRestoredUnadopted/);
  });
});

describe('البند ٤ · خانة خالية بدل «لا يوجد» فيما يخرج من التطبيق', () => {
  const OUT = ['src/services/reportExport.ts', 'src/domain/officeBuild.ts', 'src/services/print.ts', 'src/domain/printDocs.ts',
    'src/domain/templates.ts', 'src/domain/reportData.ts', 'src/domain/vatReturn.ts'];

  test.each(OUT)('%s: لا «لا يوجد» ولا تاريخٌ بـ dfmt الذي يكتبها للغائب', (f) => {
    const s = code(f);
    expect(s).not.toMatch(/لا يوجد/);
    expect(s).not.toMatch(/\bdfmt\(/);
  });

  test('الرسالة: رمزٌ بلا قيمة يُترك خالياً', () => {
    expect(resolveTemplateTokens('العقد {رقم_العقد} ينتهي {التاريخ}.', { '{رقم_العقد}': '', '{التاريخ}': '01/02/2027' }))
      .toBe('العقد  ينتهي 01/02/2027.');
  });

  test('رأس المطبوع بلا اسم منشأة، وسند القبض بلا رقم عقد ولا فترة: خانات خالية', () => {
    const co = { name: '', cr: '', vatno: '', vatEnabled: false, phone: '', address: '' } as never;
    expect(letterhead(co, 'سند قبض')).not.toMatch(/لا يوجد/);
    const html = buildReceiptDoc(co, {
      no: 'R-1', tenantName: 'مستأجر مصطنع', contractNo: '', unitLabel: '', date: '2026-02-01', period: '', methodLabel: 'نقداً', notes: '',
      grossHalalas: 100000, discountHalalas: 0, netHalalas: 100000,
    }, '2026-02-01T10:00:00.000Z');
    expect(html).not.toMatch(/لا يوجد/);
  });

  test('التاريخ الغائب في المخرجات خالٍ، والحاضر كما هو', () => {
    expect(dfmtOut(null)).toBe('');
    expect(dfmtOut('')).toBe('');
    expect(dfmtOut('2026-02-01')).toBe('01/02/2026');
  });
});

describe('البند ٦ · «السابق» و«التالي» لا يظهران معطّلين', () => {
  test('الترقيم لا يرسم زرّاً معطّلاً: «السابق» يغيب في الأولى و«التالي» في الأخيرة', () => {
    const s = code('src/ui/Pager.tsx');
    expect(s).not.toMatch(/disabled/);
  });
});

describe('البند ١٤ · التحصيل الجماعي: الزر لا يعود والمحرّك يبقى', () => {
  test('لا شاشة تنادي recordBulkRentPayment، والمحرّك قائم للبيانات القديمة ومطابقة كشف البنك', () => {
    const screens = ['app', 'src/ui'].flatMap((d) => fs.readdirSync(path.join(ROOT, d), { recursive: true }) as string[])
      .filter((f) => /\.tsx?$/.test(f));
    const hits = screens.filter((f) => {
      const p = fs.existsSync(path.join(ROOT, 'app', f)) ? path.join('app', f) : path.join('src/ui', f);
      return /recordBulkRentPayment/.test(code(p));
    });
    expect(hits).toEqual([]);
    expect(read('src/domain/contracts/service.ts')).toMatch(/export function recordBulkRentPayment/);
  });
});

describe('البند ٢٠ · دليل الحسابات مكانٌ في «المزيد» لا تفضيلٌ في الإعدادات', () => {
  test('لا صف «العملة ودليل الحسابات» في الإعدادات، ويبقى في «المزيد»', () => {
    expect(code('app/settings.tsx')).not.toMatch(/العملة ودليل الحسابات/);
    expect(code('src/ui/moreScreens.ts')).toMatch(/accounts/);
  });
});
