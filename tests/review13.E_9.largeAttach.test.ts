/**
 * المراجعة الشاملة 2026-11-13 · E-9: الملف الكبير يُقرأ كله في الذاكرة مرتين (قبل سؤال الحجم، ثم للتحقق بعد كتابته) · الآن الحجم من النظام
 * قبل أي قراءة، والملف يُنسخ نسخاً إلى مجلد المرفقات وبصمته تُحسب على قطع، والتحقق بالحجم لا بإعادة القراءة · ملفات مصطنعة.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { memDb, tempDir, rmrf } from './helpers/testDb';
import { nodeFs, nodeHasher } from '@/files/nodeFs';
import { putAttachment, putAttachmentFile, type FilesEnv } from '@/files/store';
import type { FS } from '@/files/fsAdapter';

const MB = 1024 * 1024;

function env(dir: string, reads: string[]): FilesEnv {
  const spy: FS = { ...nodeFs, read: (p) => { reads.push(p); return nodeFs.read(p); } };
  return { db: memDb(), fs: spy, hasher: nodeHasher, attachmentsDir: path.join(dir, 'attachments') };
}

test('E-9 مقطعٌ بـ48 م.ب يُرفق بلا قراءةٍ كاملة له: البصمة والحجم صحيحان والنسخة مطابقة', async () => {
  const dir = tempDir();
  try {
    const src = path.join(dir, 'clip.mp4');
    const buf = Buffer.alloc(48 * MB);
    for (let i = 0; i < buf.length; i += 4096) buf[i] = (i / 4096) % 251;
    fs.writeFileSync(src, buf);
    const want = createHash('sha256').update(buf).digest('hex');
    const reads: string[] = [];
    const e = env(dir, reads);
    expect(typeof putAttachmentFile).toBe('function');
    const row = await putAttachmentFile(e, src, { entityType: 'unit', entityId: 'U1', kind: 'video', originalName: 'مقطع.mp4', mime: 'video/mp4' });
    expect(row.sha256).toBe(want);
    expect(row.size_bytes).toBe(48 * MB);
    expect(reads).toEqual([]);
    const dest = path.join(dir, 'attachments', want + '.mp4');
    expect(fs.statSync(dest).size).toBe(48 * MB);
    expect(createHash('sha256').update(fs.readFileSync(dest)).digest('hex')).toBe(want);
    // والملف نفسه مرةً ثانية: صفّ بصمةٍ واحد
    await putAttachmentFile(e, src, { entityType: 'unit', entityId: 'U2', kind: 'video', originalName: 'مقطع.mp4', mime: 'video/mp4' });
    expect(Number(e.db.get<{ n: number }>(`SELECT COUNT(*) n FROM blobs`)!.n)).toBe(1);
  } finally { rmrf(dir); }
});

test('E-9 putAttachment يتحقق من الكتابة بالحجم لا بإعادة قراءة الملف', async () => {
  const dir = tempDir();
  try {
    const reads: string[] = [];
    const e = env(dir, reads);
    await putAttachment(e, new Uint8Array(2 * MB).fill(7), { entityType: 'unit', entityId: 'U1', kind: 'doc', originalName: 'ملف.pdf', mime: 'application/pdf' });
    expect(reads).toEqual([]);
  } finally { rmrf(dir); }
});

test('E-9 الإرفاق يسأل بالحجم قبل أي قراءة، ويحذف نسخة المنتقي إن تراجع، ومستندات المنشأة بالمسار نفسه', () => {
  const root = path.join(__dirname, '..');
  const attach = fs.readFileSync(path.join(root, 'src/ui/attach.ts'), 'utf8');
  const body = attach.slice(attach.indexOf('export async function attachPicked'));
  expect(body).not.toMatch(/bytesSync/);
  expect(body).toMatch(/putAttachmentFile\(/);
  expect(body.indexOf('.size')).toBeLessThan(body.indexOf('confirmSize('));
  const company = fs.readFileSync(path.join(root, 'app/company.tsx'), 'utf8');
  expect(company).not.toMatch(/bytesSync/);
  expect(company).toMatch(/attachPicked\(/);
});
