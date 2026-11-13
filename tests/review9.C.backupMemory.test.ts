/**
 * C-2 · عالٍ · src/domain/backup/create.ts:315-388 و:418-421 · src/domain/backup/zipStream.ts:251 (out = new Uint8Array(body+cd+22)) و:429
 *
 * السيناريو (بيانات مصطنعة): مكتبة مرفقات من ١٦ ملفاً كلٌّ ١٫٥ ميغا (٢٤ ميغا) · createBackup يقرأ كل مرفقٍ كاملاً إلى الذاكرة
 * ويُبقيه في zipEntries، ثم zipYielding يبني الأرشيف كله مصفوفةً واحدة بحجمه، ثم يُكتب دفعةً واحدة، ثم verifyArchiveAt يقرؤه
 * كله من جديد ويفكّه (والمخزَّن يُنسخ raw.slice) والأولى ما زالت حيّة في النطاق · فذروة الذاكرة نحو أربعة أضعاف المكتبة.
 * ونسخة ما قبل الترقية ونسخة الأمان قبل الاستعادة والمسح والتصدير وDrive كلها بهذا المسار (والتشفير بعده يضيف ضعفين).
 *
 * لماذا يهم: المالك يحفظ الصور والعقود والمقاطع بجودتها الأصلية (قراراته 2026-08-20) والملفات باقية على الجوال ما دام التخزين
 * موقوفاً · مكتبةٌ بمئات الميغابايت تعني ذروةً بالغيغابايتات فيقتل أندرويد التطبيق أثناء النسخ. وأخطرها بوابة الترقية:
 * بعد تحديث التطبيق تُعاد النسخة عند كل فتح فيُقتل كل مرة، ولا ترقية بلا نسخة (upgrade.ts) · فيبقى المالك خارج تطبيقه،
 * و«الانهيار ليس نتيجة مقبولة لأي مسار» (قرار المالك 2026-08-20).
 *
 * السلوك الصحيح: النسخ يتدفق ملفاً ملفاً إلى الأرشيف على القرص (كتابة بالإلحاق أو ضغط أصلي على الملفات) والتحقق يقرأ من الفهرس
 * مدخلاً مدخلاً · فلا تمرّ في الذاكرة مصفوفةٌ أكبر من بضعة ميغابايت أياً كان حجم المكتبة، ولا تنمو الذروة بحجمها.
 */
import * as path from 'node:path';
import { tempDir, rmrf } from './helpers/testDb';
import { makeBackupEnv } from './helpers/backupEnv';
import { createBackup } from '@/domain/backup/create';
import { prepareRestore, abortRestore } from '@/domain/backup/restore';
import { putAttachment } from '@/files/store';
import { nodeFs } from '@/files/nodeFs';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmrf(d); });

const MB = 1 << 20;
const FILES = 16;
const FILE_SIZE = 1.5 * MB;

/** بايتات عشوائية حتمية لا تنضغط (كالصور) */
function noise(n: number, seed: number): Uint8Array {
  const b = new Uint8Array(n);
  let x = (seed * 2654435761) >>> 0 || 1;
  for (let i = 0; i < n; i++) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; b[i] = x & 255; }
  return b;
}

test.failing('C-2 نسخةٌ كاملة لا تحمل المكتبة كلها في الذاكرة: لا مصفوفة فوق ٨ ميغا لمكتبة ٢٤ ميغا', async () => {
  const d = tempDir('aq-r9c-mem-');
  dirs.push(d);
  const env = makeBackupEnv(d);
  for (let i = 0; i < FILES; i++) {
    await putAttachment(env.filesEnv, noise(FILE_SIZE, i + 1), { entityType: 'library', kind: 'other', originalName: `صورة-${i}.jpg` });
  }
  const library = FILES * FILE_SIZE;

  // أكبر مصفوفة تمرّ بين التطبيق والقرص في الاتجاهين
  let maxBuffer = 0;
  const watched = {
    ...nodeFs,
    read: (p: string) => { const b = nodeFs.read(p); maxBuffer = Math.max(maxBuffer, b.byteLength); return b; },
    write: (p: string, b: Uint8Array) => { maxBuffer = Math.max(maxBuffer, b.byteLength); nodeFs.write(p, b); },
  };
  // ذروة ذاكرة المصفوفات أثناء النسخة (تُقرأ بين تنفّساتها)
  (globalThis as { gc?: () => void }).gc?.();
  const base = process.memoryUsage().arrayBuffers;
  let peak = base;
  const timer = setInterval(() => { peak = Math.max(peak, process.memoryUsage().arrayBuffers); }, 2);
  try {
    await createBackup({ ...env, fs: watched }, path.join(d, 'out.aqbk'));
  } finally {
    clearInterval(timer);
  }
  const observed = {
    maxBufferMB: Math.round((maxBuffer / MB) * 10) / 10,
    peakOverLibrary: Math.round(((peak - base) / library) * 10) / 10,
  };
  // ثماني ميغا حدٌّ سخيّ لنسخٍ متدفق (قطعة ميغا واحدة تكفيه) · والذروة لا تبلغ حجم المكتبة نفسها
  expect({ boundedBuffer: observed.maxBufferMB <= 8, peakBelowLibrary: observed.peakOverLibrary < 1, ...observed })
    .toEqual({ boundedBuffer: true, peakBelowLibrary: true, ...observed });
  env.closeLive();
});

/**
 * والاستعادة بالمسار نفسه (src/domain/backup/restore.ts:122-131 · zipStream.ts:429 raw.slice): الأرشيف كله يُقرأ ثم تُنسخ مداخله
 * المخزَّنة نسخةً ثانية قبل أن يُكتب منها شيء إلى التجهيز · ومع التشفير ثالثة (encryption.ts:116) · فاستعادة نسخةٍ كبيرة على جوالٍ
 * جديد (الحاجة الأكبر للاستعادة) تُقتل قبل أن تبدأ.
 */
test.failing('C-2 (الاستعادة) تجهيز استعادة نسخة كبيرة لا يحمل الأرشيف كله ولا يضاعفه في الذاكرة', async () => {
  const d = tempDir('aq-r9c-mem2-');
  dirs.push(d);
  const srcDir = tempDir('aq-r9c-mem2s-');
  dirs.push(srcDir);
  const src = makeBackupEnv(srcDir);
  for (let i = 0; i < FILES; i++) {
    await putAttachment(src.filesEnv, noise(FILE_SIZE, 100 + i), { entityType: 'library', kind: 'other', originalName: `ملف-${i}.pdf` });
  }
  const archive = path.join(d, 'big.aqbk');
  await createBackup(src, archive);
  src.closeLive();
  const archiveBytes = nodeFs.size(archive);

  const dstDir = tempDir('aq-r9c-mem2d-');
  dirs.push(dstDir);
  const dst = makeBackupEnv(dstDir);
  (globalThis as { gc?: () => void }).gc?.();
  const base = process.memoryUsage().arrayBuffers;
  let peak = base;
  const timer = setInterval(() => { peak = Math.max(peak, process.memoryUsage().arrayBuffers); }, 2);
  let plan: Awaited<ReturnType<typeof prepareRestore>>;
  try {
    plan = await prepareRestore(dst, archive);
  } finally {
    clearInterval(timer);
  }
  abortRestore(dst, plan.stagingDir);
  const peakOverArchive = Math.round(((peak - base) / archiveBytes) * 10) / 10;
  expect({ peakBelowArchive: peakOverArchive < 1, peakOverArchive }).toEqual({ peakBelowArchive: true, peakOverArchive });
  dst.closeLive();
});
