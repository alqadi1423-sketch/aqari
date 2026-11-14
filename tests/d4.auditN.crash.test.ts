/**
 * المدقق الخارجي N · الجولة السابعة · موضع تقرير العطل وسطر الفشل (src/domain/crashReport.ts whereLabel/failureWhere) كما هو في 2cf6151.
 * الموضع يصل المالك في «تقرير عطل»، وسطر «فشل …» في سجل العمليات يقرؤه أعضاء المنشأة · بياناتٌ مصطنعة.
 *   TZ=Asia/Riyadh npx jest tests/auditN.crash.test.ts
 */
import fs from 'fs';
import path from 'path';
import { failureWhere, recordCrashReport, crashReports } from '@/domain/crashReport';
import ar from '@/i18n/locales/ar.json';
import en from '@/i18n/locales/en.json';
import { memDb } from './helpers/testDb';

const ROOT = path.join(__dirname, '..');
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const log = (...a: unknown[]) => { /* eslint-disable-next-line no-console */ console.log(...a); };

describe('N٩ · قصّ الموضع على «الكلمات الثلاث الأولى» يُعبر بفاصلٍ غير المسافة أو بمسافةٍ في أوله', () => {
  test('العنوان من الكود ثم اسمٌ (كما يحرسه الحجب في d4.auditH.crashLeak وd4.auditL.crash): الاسم يعبر إلى سطر الفشل وتقرير العطل', () => {
    // التعليق (crashReport.ts:91) وDESIGN §١٣.٢١: «لا يبقى منه بعد الكلمات الثلاث الأولى شيء، لأن ما بعدها قد يكون اسماً كلماته من كلمات التطبيق»
    // وبعد إصلاح N٩ يُقصّ بعدّ الكلمات بين أي فاصلين لا بالمسافات وحدها
    expect(read('src/domain/crashReport.ts')).toContain('if (++n === 4) { cut = m.index!; break; }');
    // أسماء ملفاتٍ مصطنعة كما يبنيها عنوانٌ «تعذّر حفظ » + الاسم (والكلمتان «باسم» و«مالك» و«الشهري» من كلمات ar.json)
    const titles = ['تعذّر حفظ باسم_الشهري.pdf', 'تعذّر حفظ مالك-الشهري.jpg', 'تعذّر حفظ باسم.الشهري', ' تعذّر حفظ عقد باسم الشهري', '\nتعذّر حفظ صورة مالك الشهري'];
    const lines = titles.map((w) => failureWhere(w));
    const db = memDb();
    titles.forEach((w, i) => recordCrashReport(db, { where: w, e: new Error('synthetic'), platform: 'android', at: new Date(Date.UTC(2026, 10, 7, 8, 0, i)) }));
    const reports = crashReports(db, 30, new Date('2026-11-07T09:00:00Z')).map((r) => r.where);
    log('N9 · سطر الفشل:', JSON.stringify(lines), '\n· موضع التقرير كما يراه المالك:', JSON.stringify(reports));
    const leaked = [...lines, ...reports].filter((s) => s.includes('الشهري'));
    expect(leaked).toEqual([]);
  });
});

describe('N١٠ · الحجب يمحو موضع العطل الذي كتبه الكود نفسه: «…» لكل عنوانٍ بالإنجليزية، ومواضع عربية مختلفة تصير موضعاً واحداً', () => {
  test('عناوين t(...) بلا where (٤١ موضعاً منها purchases.tsx:439) تصير «…» لمستخدم الإنجليزية، و«تعذّر …» لسبعة مواضع عربية مختلفة', () => {
    // مواضع من الكود (العنوان يصير الموضع: where = args.where ?? title · failureDialog.ts:66،85)
    expect(read('app/purchases.tsx')).toContain("} catch (e) { reportFailure({ title: t('common.failed'), e }); }");
    expect(read('app/chat.tsx')).toContain("reportFailure({ title: t('chat.sendFailed'), e });");
    expect(read('app/journal.tsx')).toContain("reportFailure({ title: t('journal.postFailed'), e });");
    const enTitles = [en.common.failed, en.chat.sendFailed, en.journal.postFailed];
    const enWhere = enTitles.map((x) => failureWhere(x));
    const arTitles = ['تعذّر إرفاق الإيصال', 'تعذّر الحذف', 'تعذّر الإرفاق', 'تعذّر الحذف النهائي', 'تعذّر الإيداع', 'تعذّر الملء', 'تعذّر إزالة الاتفاق'];
    const src = ['app/(tabs)/collect.tsx', 'app/(tabs)/contracts.tsx', 'app/(tabs)/properties.tsx', 'app/accounts.tsx'].map(read).join('\n')
      + ['app', 'src/ui'].flatMap((d) => fs.readdirSync(path.join(ROOT, d)).filter((f) => /\.tsx$/.test(f)).map((f) => read(path.join(d, f)))).join('\n');
    const present = arTitles.filter((x) => src.includes(`title: '${x}'`));
    const arWhere = present.map((x) => failureWhere(x));
    log('N10 · بالإنجليزية:', JSON.stringify(enTitles.map((x, i) => [x, enWhere[i]])), '\n· بالعربية (في الكود):', JSON.stringify(present.map((x, i) => [x, arWhere[i]])),
      '\n· وبالعربية purchases.tsx:439:', JSON.stringify([ar.common.failed, failureWhere(ar.common.failed)]));
    expect(present.length).toBeGreaterThanOrEqual(5);
    // المتوقع: موضعٌ من الكود يبقى مقروءاً ومميِّزاً (فلا «…» وحده، ولا موضعان مختلفان بموضعٍ واحد)
    expect(enWhere.filter((w) => w.replace(/[\s…]/g, '') === '')).toEqual([]);
    expect(new Set(arWhere).size).toBe(present.length);
  });
});
