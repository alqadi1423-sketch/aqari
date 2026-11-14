/**
 * المدقق الخارجي L · الجولة السادسة · حجب موضع تقرير العطل وسطر الفشل كما هو في e8d6c19 (التوجيه الرابع ٤ · ٤: «بلا بياناتٍ شخصية (لا أسماء
 * ولا أرقام ولا مبالغ)»، والمدقق H٣: اسم الملف المرفوع فيه اسم المستأجر) · البيانات مصطنعة كلها.
 *   TZ=Asia/Riyadh npx jest tests/auditL.crash.test.ts
 */
import fs from 'fs';
import path from 'path';
import { failureWhere, recordCrashReport, CRASH_ENTITY } from '@/domain/crashReport';
import { memDb } from './helpers/testDb';

describe('L٧ · اسمٌ عربي كلماته من كلمات التطبيق يعبر الحجب كاملاً', () => {
  test('«عقد باسم الشهري.pdf» يرفعه المستخدم في المكتبة فيفشل: سطر الفشل (يقرؤه الأعضاء) وتقرير العطل (يصل المالك) يحملان «باسم الشهري»', () => {
    // library.tsx: reportFailure({ title: 'تعذّر حفظ ' + (a.name ?? 'ملف'), e }) · والموضع هو العنوان (where ?? title)
    const lib = fs.readFileSync(path.join(__dirname, '..', 'app', 'library.tsx'), 'utf8');
    // وبعد إصلاح L٧ تمرّر المكتبة موضعاً ثابتاً لا يحمل اسم الملف، والحجب يبقى حارساً لما يُمرَّر بعنوانه
    expect(lib).toMatch(/reportFailure\(\{ title: 'تعذّر حفظ ' \+ \(a\.name \?\? 'ملف'\), where: LIBRARY_UPLOAD_WHERE, e \}\)/);
    const where = 'تعذّر حفظ عقد باسم الشهري.pdf';
    const line = failureWhere(where);
    const db = memDb();
    expect(recordCrashReport(db, { where, e: new Error('synthetic'), platform: 'android', at: new Date('2026-11-07T08:00:00Z') })).toBe(true);
    const report = db.get<{ entity_name: string }>(`SELECT entity_name FROM audit_log WHERE entity_type = ?`, [CRASH_ENTITY])!.entity_name;
    // وأسماء أخرى شائعة تعبر كذلك (كلٌّ منها كلمةٌ في ar.json: «باسم» حرف جرٍّ واسم، «مالك» المالك، «الشهري» الإيجار الشهري)
    const others = ['مالك الشهري', 'باسم'].map((n) => failureWhere('تعذّر حفظ ' + n));
    // eslint-disable-next-line no-console
    console.log('L7 · سطر الفشل:', line, '· موضع التقرير:', report, '· وغيره:', others);
    expect(line).not.toMatch(/باسم الشهري/);
    expect(report).not.toMatch(/باسم الشهري/);
  });
  test('حرفان عربيان (ٮ U+066E وٯ U+066F) خارج نطاق «الكلمة» الجديد فيعبران كما هما (إصلاح J١٢ للحروف الممتدة)', () => {
    const line = failureWhere('تعذّر حفظ ٯٮ');
    // eslint-disable-next-line no-console
    console.log('L7b · سطر الفشل:', line);
    expect(line).not.toMatch(/[ٮٯ]/);
  });
});
