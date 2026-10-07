/**
 * مؤشرات التقدّم (توجيه المالك ٢٠٢٦-١٠-٠٧): النسبة والحجم المنجز من الكلي وزر الإلغاء لكل تنزيل ورفع واستعادة ونسخ،
 * ودقيقةٌ بلا تقدّم تظهر مع إعادة المحاولة · والإلغاء لا يترك ملفاً جزئياً ولا يمسّ البيانات · بيانات مصطنعة.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tempDir, rmrf } from './helpers/testDb';
import { makeBackupEnv, type TestBackupEnv } from './helpers/backupEnv';
import { nodeHasher } from '@/files/nodeFs';
import {
  cancelSource, CancelledError, fmtBytes, progressView, progressLine, progressLabel, StallWatch, STALL_MS,
  type ProgressInfo,
} from '@/domain/progress';
import { uploadBackupToDrive, downloadBackupFromDrive, type DriveIO } from '@/cloud/drive';
import { createBackup } from '@/domain/backup/create';
import { prepareRestore } from '@/domain/backup/restore';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmrf(d); });
const newEnv = (): TestBackupEnv => { const d = tempDir('aq-prog-'); dirs.push(d); fs.mkdirSync(d, { recursive: true }); return makeBackupEnv(d); };

/** مرفقات حقيقية على القرص بصفّيها */
async function addAttachments(env: TestBackupEnv, n: number, size = 4096): Promise<number> {
  env.fs.mkdirp(env.attachmentsDir);
  let total = 0;
  for (let i = 0; i < n; i++) {
    const bytes = new Uint8Array(size).map((_, k) => (k * 7 + i * 13) % 251);
    const sha = await nodeHasher(bytes);
    env.fs.write(path.join(env.attachmentsDir, `${sha}.bin`).replace(/\\/g, '/'), bytes);
    env.db.run(`INSERT INTO blobs (sha256, ext, size_bytes, created_at) VALUES (?, 'bin', ?, '2026-01-01')`, [sha, size]);
    env.db.run(`INSERT INTO attachments (id, sha256, entity_type, entity_id, kind, created_at) VALUES (?, ?, 'contract', 'C1', 'عقد', '2026-01-01')`, ['A' + i, sha]);
    total += size;
  }
  return total;
}

describe('العرض والتوقّف', () => {
  test('النسبة والحجم بالبايت · والرسائل القديمة «· N من M» تُفهم عدداً', () => {
    expect(fmtBytes(512)).toBe('512 بايت');
    expect(fmtBytes(2.5 * 1024 * 1024)).toBe('2.5 م.ب');
    const v = progressView('جاري التنزيل من Google Drive', { done: 3 * 1024 * 1024, total: 12 * 1024 * 1024, unit: 'bytes' });
    expect(v).toEqual({ pct: 25, amount: '3.0 م.ب من 12.0 م.ب' });
    expect(progressLine(v)).toBe('25%، 3.0 م.ب من 12.0 م.ب');
    expect(progressView('جاري نسخ المرفقات · 3 من 12')).toEqual({ pct: 25, amount: '3 من 12' });
    expect(progressLabel('جاري نسخ المرفقات · 3 من 12')).toBe('جاري نسخ المرفقات');
    expect(progressView('جاري أخذ لقطة قاعدة البيانات')).toEqual({ pct: null, amount: null });
  });

  test('دقيقة بلا تقدّم حقيقي = توقّف · وتكرار الرسالة نفسها لا يُعدّ تقدّماً · وأي تقدّم يعيد العدّ', () => {
    let now = 0;
    const w = new StallWatch(() => now);
    w.tick('جاري التنزيل', { done: 10, total: 100, unit: 'bytes' });
    now = STALL_MS - 1;
    w.tick('جاري التنزيل', { done: 10, total: 100, unit: 'bytes' }); // العالق يعيد الرسالة ذاتها
    expect(w.stalled()).toBe(false);
    now = STALL_MS;
    expect(w.stalled()).toBe(true);
    expect(w.tick('جاري التنزيل', { done: 11, total: 100, unit: 'bytes' })).toBe(true);
    expect(w.stalled()).toBe(false);
  });

  test('الإلغاء يبلغ المشتركين مرة · ومن يشترك بعده يُبلَّغ فوراً', () => {
    const c = cancelSource();
    let n = 0;
    c.signal.onCancel(() => n++);
    c.cancel(); c.cancel();
    expect([c.signal.cancelled, n]).toEqual([true, 1]);
    c.signal.onCancel(() => n++);
    expect(n).toBe(2);
  });
});

describe('Google Drive: الحجم المنجز من الكلي والإلغاء', () => {
  /** Drive وهمي ينقل على دفعات ويبلغ البايتات، ويقطع النقل عند الإلغاء كما تفعل مهام النقل على الجهاز */
  function chunkedDrive(opts: { cancelAt?: number; cancel?: () => void } = {}) {
    let stored: { bytes: Uint8Array; sha: string } | null = null;
    const io: DriveIO = {
      fetch: (async (url: string, init: { method?: string } = {}) => {
        if (url.includes('uploadType=resumable')) return { ok: true, status: 200, headers: { get: () => 'https://upload/session/1' }, text: async () => '' };
        if (init.method === 'DELETE') { stored = null; return { ok: true, status: 204, text: async () => '' }; }
        return { ok: false, status: 404, text: async () => '' };
      }) as unknown as typeof fetch,
      async putFile(_url, p, _h, onBytes, signal) {
        const bytes = new Uint8Array(fs.readFileSync(p));
        for (let done = 0; done < bytes.length;) {
          done = Math.min(bytes.length, done + 1024);
          onBytes?.(done, bytes.length);
          if (opts.cancelAt !== undefined && done >= opts.cancelAt) opts.cancel?.();
          if (signal?.cancelled) throw new CancelledError();
        }
        const sha = await nodeHasher(bytes);
        stored = { bytes, sha };
        return { status: 200, body: JSON.stringify({ id: 'F1', name: 'n.aqbk', size: String(bytes.length), sha256Checksum: sha }) };
      },
      async downloadFile(_url, p, _h, onBytes, signal) {
        const bytes = stored!.bytes;
        const out: number[] = [];
        for (let done = 0; done < bytes.length;) {
          const next = Math.min(bytes.length, done + 1024);
          out.push(...bytes.slice(done, next));
          done = next;
          onBytes?.(done, bytes.length);
          if (opts.cancelAt !== undefined && done >= opts.cancelAt) opts.cancel?.();
          if (signal?.cancelled) { fs.writeFileSync(p, Uint8Array.from(out)); throw new CancelledError(); }
        }
        fs.writeFileSync(p, Uint8Array.from(out));
        return { status: 200 };
      },
      sha256OfFile: async (p) => nodeHasher(new Uint8Array(fs.readFileSync(p))),
      sizeOf: (p) => fs.statSync(p).size,
    };
    return { io, get stored() { return stored; } };
  }

  async function archiveOf(env: TestBackupEnv): Promise<string> {
    await addAttachments(env, 6);
    const p = path.join(env.root, 'b.aqbk');
    await createBackup(env, p);
    return p;
  }

  test('الرفع والتنزيل يبلّغان البايتات حتى ١٠٠٪ بالحجم الكلي', async () => {
    const env = newEnv();
    const p = await archiveOf(env);
    const size = fs.statSync(p).size;
    const d = chunkedDrive();
    const up: ProgressInfo[] = [];
    const b = await uploadBackupToDrive(d.io, 'T', p, 'n.aqbk', { onProgress: (_m, i) => { if (i) up.push(i); } });
    expect(up[up.length - 1]).toEqual({ done: size, total: size, unit: 'bytes' });
    expect(up.length).toBeGreaterThan(3);
    const down: Array<{ m: string; i?: ProgressInfo }> = [];
    await downloadBackupFromDrive(d.io, 'T', b, path.join(env.root, 'in.aqbk'), { onProgress: (m, i) => down.push({ m, i }) });
    const bytesSteps = down.filter((x) => x.i?.unit === 'bytes');
    expect(bytesSteps[bytesSteps.length - 1].i).toEqual({ done: size, total: size, unit: 'bytes' });
    expect(progressView(bytesSteps[0].m, bytesSteps[0].i).pct).toBe(0);
    env.closeLive();
  });

  test('إلغاء الرفع في منتصفه: يُرمى الإلغاء ولا يُعتمد شيء على Drive', async () => {
    const env = newEnv();
    const p = await archiveOf(env);
    const c = cancelSource();
    const d = chunkedDrive({ cancelAt: 4096, cancel: c.cancel });
    await expect(uploadBackupToDrive(d.io, 'T', p, 'n.aqbk', { signal: c.signal })).rejects.toBeInstanceOf(CancelledError);
    expect(d.stored).toBeNull();
    env.closeLive();
  });

  test('إلغاء التنزيل في منتصفه: يُرمى الإلغاء قبل مطابقة البصمة', async () => {
    const env = newEnv();
    const p = await archiveOf(env);
    const ok = chunkedDrive();
    const b = await uploadBackupToDrive(ok.io, 'T', p, 'n.aqbk');
    const c = cancelSource();
    const d = chunkedDrive({ cancelAt: 4096, cancel: c.cancel });
    // الملف المخزَّن نفسه في Drive الثاني
    await uploadBackupToDrive(d.io, 'T', p, 'n.aqbk');
    await expect(downloadBackupFromDrive(d.io, 'T', b, path.join(env.root, 'in.aqbk'), { signal: c.signal })).rejects.toBeInstanceOf(CancelledError);
    env.closeLive();
  });
});

describe('الضغط على قطع', () => {
  test('مدخلٌ كبير مخزَّن وآخر مضغوط: تقدّمٌ بالبايت داخل المدخل الواحد · والأرشيف يُفكّ كما هو بأداتنا وبأداة أخرى', async () => {
    const { zipYielding, unzipYielding } = await import('@/domain/backup/zipStream');
    const { unzipSync } = await import('fflate');
    const big = new Uint8Array(3 * 1024 * 1024 + 123).map((_, k) => (k * 31) % 256);
    const text = new TextEncoder().encode('سطر مصطنع للضغط '.repeat(200000));
    const steps: Array<[number, number]> = [];
    const arch = await zipYielding([
      { name: 'big.bin', bytes: big, level: 0 },
      { name: 'data.db', bytes: text, level: 6 },
    ], (d, t) => steps.push([d, t]));
    expect(steps.length).toBeGreaterThan(5);
    expect(steps[steps.length - 1]).toEqual([big.length + text.length, big.length + text.length]);
    expect(steps.filter(([d]) => d < big.length).length).toBeGreaterThan(1); // داخل المدخل الأول
    const ours = await unzipYielding(arch);
    expect(Buffer.from(ours['big.bin']).equals(Buffer.from(big))).toBe(true);
    expect(Buffer.from(ours['data.db']).equals(Buffer.from(text))).toBe(true);
    const theirs = unzipSync(arch);
    expect(Buffer.from(theirs['data.db']).equals(Buffer.from(text))).toBe(true);

    // مضغوطٌ يتجاوز الميغابايت بعد ضغطه · يُفكّ على قطع ويبلّغ بالبايتات
    const noisy = new Uint8Array(require('node:crypto').randomBytes(3 * 1024 * 1024));
    const arch2 = await zipYielding([{ name: 'data.db', bytes: noisy, level: 6 }]);
    const read: number[] = [];
    const back = await unzipYielding(arch2, undefined, (d) => read.push(d));
    expect(Buffer.from(back['data.db']).equals(Buffer.from(noisy))).toBe(true);
    expect(read.length).toBeGreaterThan(2);
    expect(Buffer.from(unzipSync(arch2)['data.db']).equals(Buffer.from(noisy))).toBe(true);
  });
});

describe('النسخ والاستعادة: الحجم والإلغاء بلا أثر', () => {
  test('إنشاء النسخة يبلّغ حجم المرفقات المنجز من الكلي · والإلغاء في منتصفه لا يترك أرشيفاً', async () => {
    const env = newEnv();
    const total = await addAttachments(env, 10);
    const seen: ProgressInfo[] = [];
    const zip: ProgressInfo[] = [];
    const out = path.join(env.root, 'b.aqbk');
    await createBackup(env, out, (m, i) => {
      if (i && m.startsWith('جاري نسخ المرفقات')) seen.push(i);
      if (i && m === 'جاري ضغط الأرشيف') zip.push(i);
    });
    expect(seen.every((i) => i.total === total && i.unit === 'bytes')).toBe(true);
    expect(seen.map((i) => i.done)).toEqual([...seen.map((i) => i.done)].sort((a, b) => a - b));
    // والضغط بالبايتات حتى نهايته
    expect(zip[zip.length - 1].done).toBe(zip[zip.length - 1].total);
    expect(zip[zip.length - 1].total).toBeGreaterThan(total);

    const c = cancelSource();
    const out2 = path.join(env.root, 'c.aqbk');
    let n = 0;
    await expect(createBackup(env, out2, (_m, i) => { if (i && ++n === 4) c.cancel(); }, { signal: c.signal }))
      .rejects.toBeInstanceOf(CancelledError);
    expect(fs.existsSync(out2)).toBe(false);
    const leftovers = fs.existsSync(env.tmpDir) ? fs.readdirSync(env.tmpDir).filter((f) => f.startsWith('backup-')) : [];
    expect(leftovers).toEqual([]);
    env.closeLive();
  });

  test('إلغاء تجهيز الاستعادة: يُكنس مجلد التجهيز ولا تُمسّ البيانات الحية', async () => {
    const src = newEnv();
    await addAttachments(src, 8);
    src.db.run(`INSERT INTO properties (id, name, created_at) VALUES ('PX', 'عقار مصطنع للإلغاء', 'x')`);
    const archive = path.join(src.root, 'b.aqbk');
    await createBackup(src, archive);
    src.closeLive();

    const env = newEnv();
    const c = cancelSource();
    let n = 0;
    await expect(prepareRestore(env, archive, (_m, i) => { if (i && ++n === 3) c.cancel(); }, { signal: c.signal }))
      .rejects.toBeInstanceOf(CancelledError);
    const staging = fs.existsSync(env.tmpDir) ? fs.readdirSync(env.tmpDir).filter((f) => f.startsWith('restore-staging-')) : [];
    expect(staging).toEqual([]);
    expect(env.db.get(`SELECT 1 FROM properties WHERE id = 'PX'`)).toBeUndefined();
    env.closeLive();
  });
});
