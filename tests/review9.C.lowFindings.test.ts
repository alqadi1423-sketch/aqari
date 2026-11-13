/**
 * ثلاثة أخطاء منخفضة/متوسطة في الجزء C · بيانات مصطنعة · كل اختبارٍ يفشل على الكود الحالي ويقرّر السلوك الصحيح.
 *
 * C-9 · منخفض · src/db/schema.ts:1745-1747 (الهجرة ٤٧)
 *   السيناريو: مستخدمٌ فعّل «نزع البيانات الوصفية من الصور» بنفسه قبل الهجرة ٤٦ (كان خياراً منذ قرار المالك 2026-08-20) · الترقية
 *   تمرّ بـ٤٦ (تفعيل للكل) ثم ٤٧ (إطفاء للكل) فيُطفأ اختياره صامتاً، وتعود الصور تحمل موقع التصوير (GPS) ونوع الجهاز.
 *   لماذا يهم: قرار المالك 2026-10-15 بتصحيحه «يرجع قراري 2026-08-20 كما كان» = خيارٌ في الإعدادات مطفأٌ افتراضاً، لا إلغاءٌ لاختيار
 *   من فعّله · والخصوصية تسقط بلا علم المستخدم.
 *   السلوك الصحيح: من اختار التفعيل قبل ٤٦ يبقى مفعّلاً بعد ٤٧ (تُعاد القيمة كما كانت قبل ٤٦، لا «false» للكل).
 *
 * C-10 · منخفض · src/domain/redact.ts:44-54
 *   السيناريو: سطرٌ بلا حرف عربي (واجهة بالإنجليزية أو رسالة مكتبة) فيه اسمٌ لاتيني بين علامتي تنصيص منحنيتين “…” (شكل نصوص
 *   en.json: «The supplier “{{name}}” is archived») أو بلا علامات · الحجب يغطي «» و"" والأرقام والسطر العربي وحده، فيبقى الاسم في
 *   الملف المحفوظ في التنزيلات وفي «أرسل تقرير الخطأ».
 *   لماذا يهم: DESIGN §١٣.١٩ وتعليق redact.ts: «التقرير يخرج من الجهاز… فلا يحمل اسماً» · والمستأجرون الوافدون أسماؤهم لاتينية.
 *   السلوك الصحيح: ما بين “ ” و‘ ’ يُحجب كما يُحجب ما بين «» و"" · ولا يبقى في التقرير اسمٌ لاتيني.
 *
 * C-11 · منخفض · src/files/store.ts:137-145
 *   السيناريو: امتلاء القرص أثناء كتابة مرفق (الكتابة تُخرج نصف الملف ثم ENOSPC) · يرمي putAttachment ويبقى نصف الملف في مجلد
 *   المرفقات بلا صفٍّ في blobs.
 *   لماذا يهم: قرار المالك 2026-09-02 «لا يبقى بعد أي فشل ملفٌ في attachments بلا صفّ في blobs» · ومساحةٌ تضيع على قرصٍ ممتلئ أصلاً.
 *   السلوك الصحيح: الكتابة إلى اسمٍ مؤقت ثم نقلٌ ذرّي، أو حذف ما كُتب عند أي فشل قبل التسجيل.
 */
import * as path from 'node:path';
import { tempDir, rmrf } from './helpers/testDb';
import { schemaAt } from './helpers/oldSchema';
import { makeBackupEnv } from './helpers/backupEnv';
import { migrate } from '@/db/migrations';
import { getSetting } from '@/repos/settings';
import { redactForReport } from '@/domain/redact';
import { putAttachment } from '@/files/store';
import { orphanAttachments } from '@/domain/backup/create';
import { nodeFs } from '@/files/nodeFs';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmrf(d); });

test.failing('C-9 الترقية لا تُطفئ «نزع البيانات الوصفية» لمن فعّله بنفسه قبل الهجرة ٤٦', () => {
  const d = tempDir('aq-r9c-exif-');
  dirs.push(d);
  const db = schemaAt(path.join(d, 'v45.db'), 45);
  // اختيار المستخدم قبل الترقية: مفعّل
  db.run(`INSERT OR REPLACE INTO settings (key, value_json) VALUES ('stripExif', 'true')`);
  migrate(db);
  expect(getSetting(db, 'stripExif')).toBe(true);
  db.close();
});

test.failing('C-10 تقرير العطل لا يحمل اسماً لاتينياً بين علامتي تنصيص منحنيتين أو في سطرٍ إنجليزي', () => {
  const NAME = 'ZQPROBE Holdings';
  const out = [
    redactForReport(`Error: The supplier “${NAME}” is archived · restore it from Suppliers`),
    redactForReport(`Error: Installment of ${NAME} · contract C-12 · March`),
  ];
  expect(out.filter((s) => s.includes('ZQPROBE'))).toEqual([]);
});

test.failing('C-11 امتلاء القرص أثناء كتابة مرفق لا يترك ملفاً يتيماً في مجلد المرفقات', async () => {
  const d = tempDir('aq-r9c-enospc-');
  dirs.push(d);
  const env = makeBackupEnv(d);
  // كتابةٌ تُخرج نصف الملف ثم يمتلئ القرص
  const full = {
    ...nodeFs,
    write: (p: string, b: Uint8Array) => {
      nodeFs.write(p, b.subarray(0, Math.floor(b.length / 2)));
      throw new Error('ENOSPC: no space left on device, write (محاكاة)');
    },
  };
  const bytes = new Uint8Array(4096).map((_, i) => (i * 7) & 255);
  await expect(putAttachment({ ...env.filesEnv, fs: full }, bytes, { entityType: 'library', kind: 'other', originalName: 'عقد.pdf' }))
    .rejects.toThrow();
  expect(orphanAttachments(env)).toEqual([]);
  env.closeLive();
});
