/**
 * المدقق الخارجي H · الجولة الرابعة · الحجب في تقرير العطل بعد إصلاح F٥ (failureDb → openedAppDb) كما هو في 97d0beb.
 * قرار المالك 2026-11-07 «نعم توصلني»: تقارير أعطال الأعضاء تصل المالك **بعد الحجب (لا اسم ولا رقم ولا مبلغ)**.
 *
 * إصلاح F٥ جعل كل حوار فشلٍ بلا db يكتب تقريراً بقاعدة التطبيق المفتوحة · ومن هذه المواضع (١١٥) موضعٌ يبني العنوان من بيانات المستخدم:
 *   app/library.tsx:280  reportFailure({ title: 'تعذّر حفظ ' + (a.name ?? 'ملف'), e })
 * والعنوان يصير الموضع (where = args.where ?? title) فيُكتب في entity_name للتقرير بعد whereLabel، وهي لا تحجب إلا ما بين «» والأرقام
 * اللاتينية والعربية (src/domain/crashReport.ts:61-62) · فاسم الملف (وفيه اسم المستأجر غالباً: «هوية …»، «عقد …») يصل المالك ونصّه
 * المنسوخ كما هو.
 * بيانات مصطنعة · وحدات الجهاز مقلَّدة كما في tests/d4.auditF.crashCoverage.test.ts.
 */
import fs from 'fs';
import path from 'path';
import { memDb } from './helpers/testDb';
import type { DB } from '@/db/adapter';

const opened: { db: DB | null } = { db: null };
jest.mock('react-native', () => ({ Share: { share: jest.fn(async () => ({})) }, Platform: { OS: 'android' } }));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(async () => true) }));
jest.mock('@/ui/AppDialog', () => ({ showDialog: jest.fn() }));
jest.mock('@/ui/Toast', () => ({ showToast: jest.fn() }));
jest.mock('@/services/errorReport', () => ({ errorReportText: () => 'تقرير', saveErrorReport: async () => '' }));
// القاعدة مفتوحة على الجهاز (ما ترجع إليه failureDb حين لا تُمرَّر قاعدة)
jest.mock('@/db/expoAdapter', () => ({ openedAppDb: () => opened.db }));

import { reportFailure } from '@/ui/failureDialog';
import { CRASH_ENTITY, crashReports } from '@/domain/crashReport';

test('H3 · اسم الملف المرفوع إلى المكتبة (وفيه اسم المستأجر ورقمه) يصل المالك في موضع تقرير العطل بلا حجب', async () => {
  // الموضع كما في الشاشة حرفاً
  const src = fs.readFileSync(path.join(__dirname, '..', 'app', 'library.tsx'), 'utf8');
  // وبعد L٧ تمرّر المكتبة موضعاً ثابتاً، والحجب يبقى حارساً لما يُمرَّر بعنوانه (كما يفعل الاختبار أدناه)
  expect(src).toContain(`reportFailure({ title: 'تعذّر حفظ ' + (a.name ?? 'ملف'), where: LIBRARY_UPLOAD_WHERE, e });`);

  // جهاز عضوٍ بقسم المكتبة · القاعدة مفتوحة
  const db = memDb();
  db.run(`INSERT OR REPLACE INTO sync_state (k, v) VALUES ('uid', 'U-LIB-H')`);
  db.run(`INSERT OR REPLACE INTO sync_state (k, v) VALUES ('membership', ?)`, [JSON.stringify({ org: 'ORG-H', profile: { name: 'عضو مكتبة مصطنع' } })]);
  opened.db = db;

  // أسماء ملفاتٍ مصطنعة كما يختارها المستخدم من المنتقي (DocumentPicker: a.name)
  const names = ['هوية محمد العتيبي.pdf', 'Ahmed Alzahrani Iqama.pdf', 'عقد راجيش ۰۵۵۱۲۳۴۵۶۷.pdf'];
  for (const name of names) {
    // عطلٌ غير متوقع في الحفظ (القرص ممتلئ) · ليس RuleViolation فيُكتب له تقرير
    await reportFailure({ title: 'تعذّر حفظ ' + (name ?? 'ملف'), e: new Error('database or disk is full (code 13 SQLITE_FULL)') });
  }
  const rows = db.all<{ entity_name: string }>(`SELECT entity_name FROM audit_log WHERE entity_type = ? ORDER BY id`, [CRASH_ENTITY]);
  const shown = crashReports(db).map((c) => c.where);
  // eslint-disable-next-line no-console
  console.log('H3 · موضع التقرير كما يصل المالك (where):\n' + rows.map((r) => '  ' + r.entity_name).join('\n'), '\n· في قائمة الأعطال:', shown);
  // (في 2847c51 لا تقرير لهذا الموضع أصلاً، فلا تسرّب: العيب جديد بإصلاح F٥)
  const leaked = ['محمد', 'العتيبي', 'Ahmed', 'Alzahrani', 'راجيش', '۰۵۵۱'].filter((w) => rows.some((r) => r.entity_name.includes(w)));
  expect(leaked).toEqual([]);
});
