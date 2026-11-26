/**
 * المدقق الخارجي H · الجولة الرابعة · «لم يتغيّر شيء» بعد فشل النسخ أو الاستعادة أو المسح، كما هو في 97d0beb.
 * failureDialog.ts القاعدة ٢: «لا طمأنة بلا فحص» · و«بقي أثر» لا تُقال إلا لأثرٍ حقيقي (create.ts:126 describeResidue: «نصٌّ فارغ يعني أن
 * شيئاً لم يتغيّر فعلاً»).
 * لكن reportFailure يكتب سطر الفشل وتقرير العطل (failureDialog.ts:95-103) **قبل** المقارنة (:106-110)، ومحفّزات المزامنة (syncTables.ts:180)
 * تضيف لكل منهما صفاً في sync_outbox · وdescribeResidue تستثني audit_log وحده (create.ts:132) فتعدّ نموّ الطابور «أثراً».
 * فلمن دخل بحسابه (الالتقاط مفعّل، وهو كل مستخدمٍ بعد الدخول الإلزامي) لا تظهر «بياناتك الحالية سليمة ولم يتغيّر شيء» أبداً، بل
 * «وبقي أثر: تغيّرت أعداد جداول · sync_outbox: …» بنصٍّ برمجي إنجليزي في وجه المستخدم.
 * بيانات مصطنعة · وحدات الجهاز مقلَّدة.
 */
import { tempDir, rmrf } from './helpers/testDb';
import { makeBackupEnv } from './helpers/backupEnv';

const dialogs: Array<{ title: string; body: string }> = [];
jest.mock('react-native', () => ({ Share: { share: jest.fn(async () => ({})) }, Platform: { OS: 'android' } }));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(async () => true) }));
jest.mock('@/ui/AppDialog', () => ({ showDialog: (d: { title: string; body: string }) => { dialogs.push(d); } }));
jest.mock('@/ui/Toast', () => ({ showToast: jest.fn() }));
jest.mock('@/services/errorReport', () => ({ errorReportText: () => 'تقرير', saveErrorReport: async () => '' }));
jest.mock('@/db/expoAdapter', () => ({ openedAppDb: () => null }));

import { reportFailure, arabicMessage } from '@/ui/failureDialog';
import { fingerprintData } from '@/domain/backup/create';
import { enableSync } from '@/sync/engine';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmrf(d); });

test('H7 · فشل إنشاء النسخة لمستخدمٍ داخلٍ بحسابه: الحوار يقول «بقي أثر · sync_outbox» وما تغيّر شيءٌ إلا سطر الفشل نفسه', async () => {
  const root = tempDir('aqari-auditH-residue-').replace(/\\/g, '/');
  dirs.push(root);
  const env = makeBackupEnv(root);
  const db = env.db;
  // المالك داخلٌ بحسابه: المزامنة مفعّلة والالتقاط يعمل (cloud.ts بعد الدخول)
  enableSync(db, 'U-OWNER-H');
  // ما يفعله doBackup (settings.tsx:271-292) حرفاً: البصمة قبل العملية، ثم فشلٌ لم يمسّ البيانات (تعذّر حساب بصمة مرفق)
  const before = fingerprintData(env);
  const e = new Error('تعذّر حساب بصمة الملف «مرفق.bin» · يُرفض إنشاء النسخة');
  await reportFailure({
    title: 'تعذّر إنشاء النسخة الاحتياطية', where: 'إنشاء نسخة', db, auditModule: 'النسخ الاحتياطي', auditAction: 'create',
    lead: arabicMessage(e) || 'لم يكتمل تجهيز النسخة.', before, env, e,
  });
  const body = dialogs[dialogs.length - 1]?.body ?? '';
  // eslint-disable-next-line no-console
  console.log('H7 · نص الحوار:\n' + body);
  expect(body).toContain('بياناتك الحالية سليمة ولم يتغيّر شيء.');
  expect(body).not.toMatch(/sync_outbox/);
});
