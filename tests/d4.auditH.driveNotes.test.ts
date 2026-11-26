/**
 * المدقق الخارجي H · الجولة الرابعة · بعد إصلاح F٩ (uploadBackupToDrive يعيد notes) كما هو في 97d0beb.
 * قرار المالك 2026-11-07 «نسخة في مجلد ظاهر على Drive» · وD٤: تعذّر النسخة الظاهرة بعد نجاح المخفية «يُذكر للمستخدم مع النجاح».
 *
 * app/settings.tsx:579-580 (doDriveBackup):
 *   if (b.notes) notesDialog(…)
 *   else if (b.visibleFailed) dialog({ title: t('drive.visibleFailed'), … })
 * كان b.notes لا يُعاد أبداً (F٩) فكان حوار visibleFailed يظهر دائماً · بعد الإصلاح نسخةٌ فيها ملاحظات محاسبية وتعذّرت نسختها الظاهرة
 * (منها: من رفض إذن drive.file، فلا تنجح له نسخةٌ ظاهرة أبداً · cloud.ts:1098-1107) لا يُقال لصاحبها إن المجلد الظاهر بلا نسخة.
 * والشاشة لا تعمل تحت Node، فيُقرأ فرعها من المصدر حرفاً ويُشغَّل بدوالّ مقلَّدة.
 * بيانات مصطنعة.
 */
import fs from 'fs';
import path from 'path';
import { uploadBackupToDrive, type DriveIO } from '@/cloud/drive';

test('H9 · رفع Drive بنسخةٍ فيها ملاحظات وتعذّرت نسختها الظاهرة: لا يُذكر تعذّر النسخة الظاهرة أبداً', async () => {
  // ١) ما يعيده الرفع المخفي الآن لنسخةٍ فيها ملاحظات (cloud.ts:1093: meta = { encrypted: true, notes: !!manifest.notes?.length })
  const res = (status: number, body: unknown, loc?: string) => ({
    ok: status < 300, status, text: async () => JSON.stringify(body), headers: { get: () => loc ?? null },
  }) as unknown as Response;
  const io: DriveIO = {
    fetch: (async () => res(200, {}, 'https://upload/session')) as unknown as typeof fetch,
    putFile: async () => ({ status: 200, body: JSON.stringify({ id: 'F1', name: 'n', size: '3', sha256Checksum: 'abc' }) }),
    downloadFile: async () => ({ status: 500 }),
    sha256OfFile: async () => 'abc',
    sizeOf: () => 3,
  };
  const hidden = await uploadBackupToDrive(io, 'tok', '/tmp/x.aqbk', 'نسخة مصطنعة', { encrypted: true, notes: true });
  // ٢) ثم تعذّرت النسخة الظاهرة: backupToDrive يعيد { ...b, visibleFailed } (cloud.ts:1104-1106)
  const b = { ...hidden, visibleFailed: 'رُفض إذن الملفات' };

  // ٣) فرع الشاشة كما هو في المصدر
  const src = fs.readFileSync(path.join(__dirname, '..', 'app', 'settings.tsx'), 'utf8');
  const m = /const b = await backupToDrive\(db, setProgress, signal\);\s*bump\(\);\s*([\s\S]*?)\n\s*\} catch \(e\)/.exec(src);
  expect(m).toBeTruthy();
  const shown: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const branch = new Function('b', 'notesDialog', 'dialog', 'toast', 't', 'reviewData', 'db', 'libSizeLabel', m![1]);
  branch(b,
    (title: string) => shown.push('ملاحظات: ' + title),
    (d: { title: string }) => shown.push('حوار: ' + d.title),
    (msg: string) => shown.push('إشعار: ' + msg),
    (k: string) => k,
    () => ({ notes: ['فرقٌ محاسبي مصطنع'] }),
    null,
    () => '3 بايت');
  // eslint-disable-next-line no-console
  console.log('H9 · ما يعيده الرفع:', JSON.stringify(b), '\n· ما يراه المستخدم:', shown);
  expect(shown.some((s) => s.includes('drive.visibleFailed'))).toBe(true);
});
