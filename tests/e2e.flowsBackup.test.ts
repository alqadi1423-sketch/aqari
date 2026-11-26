/**
 * تدفقا الجوال الافتراضي ١٠ أ و١٠ ب (النسخ والمسح والاستعادة) يطابقان شاشة الإعدادات كما هي:
 *  - ١٠ أ سقط في كل تشغيلٍ منذ ق٠-١ (c2380e2): زرّ النسخة صار «مشاركة نسخة» ولم يبقَ «النسخ الاحتياطي» إلا عنواناً، وانتظار
 *    «.*مشاركة.*» يطابق زرّ التطبيق نفسه فلا يثبت نافذة المشاركة.
 *  - ١٠ ب سقط على 2629bb7: التمرير وقف وزرّ «امسح كل البيانات» تحت شريط التنقل فوقعت النقرة على «الرئيسية».
 * التدفقات نفسها تجري على المحاكي في جيت هب؛ هذا حارسٌ لنصوصها ومواضعها.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.join(__dirname, '..');
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const ar = JSON.parse(read('src/i18n/locales/ar.json'));
const settings = read('app/settings.tsx');

describe('١٠ أ · مفتاح الاسترداد ثم مشاركة نسخة', () => {
  const flow = read('e2e/maestro/10a-recovery-key.yaml');

  test('ينقر زرّ المشاركة باسمه في الشاشة لا «النسخ الاحتياطي» ثانياً', () => {
    expect(ar.folder.share).toBe('مشاركة نسخة');
    expect(settings).toContain("title={t('folder.share')} onPress={doBackup}");
    expect(flow).toContain('- tapOn: "مشاركة نسخة"');
    expect(flow).not.toMatch(/text: "النسخ الاحتياطي"\n\s+index: 1/);
  });

  test('انتظار نافذة المشاركة لا يطابق نصّاً من شاشة الإعدادات', () => {
    const m = /- tapOn: "مشاركة نسخة"\n- extendedWaitUntil:\n\s+visible: "([^"]+)"/.exec(flow.replace(/\n#[^\n]*/g, ''));
    expect(m).not.toBeNull();
    const re = new RegExp('^(?:' + m![1] + ')$');
    // كل نصٍّ ظاهر في الإعدادات من ملف الترجمة (قسم المجلد والنسخ) ومن الشاشة نفسها
    const texts = [...Object.values(ar.folder as Record<string, string>), 'النسخ الاحتياطي', 'استعادة من نسخة', 'اختر مجلد النسخ'];
    for (const s of texts) expect(re.test(s)).toBe(false);
    // ويطابق عنوان نافذة المشاركة الذي يمرّره التطبيق
    expect(read('src/services/backupService.ts')).toContain("dialogTitle: 'تصدير النسخة الاحتياطية'");
    expect(re.test('تصدير النسخة الاحتياطية')).toBe(true);
    expect(re.test('Share')).toBe(true);
  });
});

describe('١٠ ب · المسح ثم الاستعادة', () => {
  const flow = read('e2e/maestro/10b-wipe-restore.yaml').replace(/\n#[^\n]*/g, '');

  test('زرّ المسح آخر الصفحة، وتمريرةٌ بعد ظهوره تبلغ آخرها قبل النقر', () => {
    expect(flow).toMatch(/- scrollUntilVisible:\n\s+element: "امسح كل البيانات"\n\s+direction: DOWN\n- scroll\n- tapOn: "امسح كل البيانات"/);
    // لا بطاقة بعد بطاقة المسح: التمريرة الزائدة تقف عند آخر الصفحة وحشوها السفلي
    const iWipe = settings.indexOf('title="امسح كل البيانات"');
    expect(iWipe).toBeGreaterThan(settings.indexOf('<CardTitle>عن التطبيق</CardTitle>'));
    expect(settings.slice(iWipe, settings.indexOf('</Card>', iWipe))).not.toMatch(/<Card/);
    expect(settings.slice(settings.indexOf('</Card>', iWipe), settings.indexOf('</Screen>'))).not.toMatch(/<Card[\s>]/);
    expect(read('src/ui/Screen.tsx')).toMatch(/paddingBottom: bottomPad/);
  });

  test('لا hideKeyboard بعد كتابة «مسح»: زرّ الرجوع يغلق الورقة («إغلاق بلا حفظ» في التشغيل 45828448176)، والنقر على نص التحذير يُخفي اللوحة', () => {
    const typed = flow.slice(flow.indexOf('- inputText: "مسح"'), flow.indexOf('- tapOn: "تنفيذ المسح"'));
    expect(typed).not.toMatch(/hideKeyboard|pressKey/);
    expect(typed).toMatch(/- tapOn: "يُمسح كل شيء\.\*"/);
    // النص في الشاشة نصّ تحذيرٍ لا زرّ، داخل ورقةٍ تُخفي اللوحة بالنقر على ما ليس زراً
    expect(settings).toMatch(/<Note tone="danger">يُمسح كل شيء من هذا الجهاز/);
    expect(read('src/ui/Sheet.tsx')).toMatch(/keyboardShouldPersistTaps="handled"/);
  });

  test('«المساحة» و«استعادة» يُبلغان بالتمرير إلى صفٍّ تحتهما فلا يقعان تحت شريط التنقل', () => {
    expect(flow).toMatch(/- scrollUntilVisible:\n\s+element: "الملفات المؤقتة"\n\s+direction: DOWN\n- tapOn: "المساحة"/);
    expect(flow).toMatch(/- scrollUntilVisible:\n\s+element: "الملفات المؤقتة"\n\s+direction: DOWN\n- tapOn: "استعادة"/);
    // الترتيب في الشاشة: المساحة (وفيها «استعادة») ثم «بياناتك بالأرقام» ثم «الملفات المؤقتة»
    const iSpace = settings.indexOf('title="المساحة"');
    const iRestore = settings.indexOf('title="استعادة" onPress={doRestoreSafety}');
    const iCounts = settings.indexOf('title="بياناتك بالأرقام"');
    const iTmp = settings.indexOf('title="الملفات المؤقتة"');
    expect(iSpace).toBeGreaterThan(0);
    expect(iRestore).toBeGreaterThan(iSpace);
    expect(iCounts).toBeGreaterThan(iRestore);
    expect(iTmp).toBeGreaterThan(iCounts);
  });
});
