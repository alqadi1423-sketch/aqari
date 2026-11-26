/**
 * تدفقا الجوال الافتراضي ١٠ أ و١٠ ب (النسخ والمسح والاستعادة) يطابقان شاشة الإعدادات كما هي:
 *  - ١٠ أ سقط في كل تشغيلٍ منذ ق٠-١ (c2380e2): زرّ النسخة صار «مشاركة نسخة» ولم يبقَ «النسخ الاحتياطي» إلا عنواناً، وانتظار
 *    «.*مشاركة.*» يطابق زرّ التطبيق نفسه فلا يثبت نافذة المشاركة.
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
