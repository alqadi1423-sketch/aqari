/**
 * المراجعة الشاملة 2026-11-13 · D-3 · متوسط · src/ui/Sheet.tsx:167 مع app/(tabs)/contracts.tsx · بيانات مصطنعة كلها.
 *
 * السيناريو: يملأ «عقد إيجار جديد» ← «مراجعة قبل الإنشاء» ← «رجوع» (أو يرفض الدومين الإنشاء فتعود الورقة)
 *   ← زر الرجوع في أندرويد أو ✕ أو خارج الورقة ← تُغلق بلا «إغلاق بلا حفظ» ويضيع ما كُتب.
 * السبب: الورقة تصفّر علامة «فيها إدخال» كلما ظهرت، والإدخال باقٍ في useContractForm ·
 *   و`SelectField` لا يعلّم الورقة أصلاً، فنموذجٌ غُيّرت اختياراته وحدها يُغلق بلا سؤال.
 * الصحيح: صاحب النموذج يمرّر `dirty` (حالة النموذج مقارنةً بما فُتح عليه) فيُقدَّم على العلامة الداخلية ·
 *   و`SelectField` يعلّم الورقة عند الاختيار.
 */
import fs from 'fs';
import path from 'path';
import { formChanged, sheetNeedsConfirm } from '@/ui/sheetDirty';

const src = (...p: string[]) => fs.readFileSync(path.resolve(__dirname, '..', ...p), 'utf8');

test('D-3 النموذج يُقارن بما فُتح عليه لا بعلامةٍ تُصفَّر عند الظهور', () => {
  const base = { tenant: '', phone: '', cycle: 'شهرية', typeSpecific: {} as Record<string, string>, pendingFile: null };
  expect(formChanged(base, { ...base })).toBe(false);
  expect(formChanged(base, { ...base, typeSpecific: {} })).toBe(false);
  expect(formChanged(base, { ...base, tenant: 'مستأجر مصطنع' })).toBe(true);
  // تغيير اختيارٍ وحده (الدورية) إدخال
  expect(formChanged(base, { ...base, cycle: 'سنوية' })).toBe(true);
  // حقلٌ متداخل وملفٌ ملتقط
  expect(formChanged(base, { ...base, typeSpecific: { activity: 'نشاط مصطنع' } })).toBe(true);
  expect(formChanged(base, { ...base, pendingFile: { uri: 'file:///x', name: 'x.pdf', mime: 'application/pdf' } } as never)).toBe(true);
});

test('D-3 خاصية dirty من صاحب النموذج تُقدَّم على العلامة الداخلية', () => {
  // بعد العودة من المراجعة: العلامة الداخلية صُفّرت، والنموذج ما زال فيه إدخال
  expect(sheetNeedsConfirm(true, false)).toBe(true);
  // ما كُتب ثم مُسح حتى عاد كما فُتح: لا استئذان
  expect(sheetNeedsConfirm(false, true)).toBe(false);
  // بلا خاصية: العلامة الداخلية كما كانت
  expect(sheetNeedsConfirm(undefined, true)).toBe(true);
  expect(sheetNeedsConfirm(undefined, false)).toBe(false);
});

test('D-3 الورقة تقرأ dirty · والعقد يمرّرها · والاختيار يعلّم الورقة', () => {
  const sheet = src('src', 'ui', 'Sheet.tsx');
  expect(sheet).toMatch(/dirty\?:\s*boolean/);
  expect(sheet).toMatch(/sheetNeedsConfirm\(\s*dirty\s*,\s*dirtyRef\.current\s*\)/);
  // SelectField: الاختيار يعلّم الورقة الحاوية
  const select = sheet.slice(sheet.indexOf('export function SelectField'));
  expect(select).toMatch(/useMarkSheetDirty\(\)/);
  expect(select).toMatch(/markDirty\(\)/);

  const contracts = src('app', '(tabs)', 'contracts.tsx');
  const formSheet = contracts.slice(contracts.indexOf('visible={formOpen}'), contracts.indexOf('<ContractFormFields'));
  expect(formSheet).toMatch(/dirty=\{form\.dirty\}/);
  const hook = src('src', 'ui', 'contractForm.tsx');
  expect(hook).toMatch(/formChanged\(/);
});
