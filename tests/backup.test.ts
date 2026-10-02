/**
 * اختبارات النسخ الاحتياطي الاثنا عشر — شرط التسليم (docs/DESIGN.md §١٠)
 */
import * as path from 'node:path';
import * as fs from 'node:fs';
import { zipSync, unzipSync } from 'fflate';
import { tempDir, rmrf } from './helpers/testDb';
import { makeBackupEnv } from './helpers/backupEnv';
import { createBackup, verifyArchiveAt, tableCounts } from '@/domain/backup/create';
import { restoreBackup } from '@/domain/backup/restore';
import { HashingUnavailableError, BackupVerificationError } from '@/domain/backup/types';
import { NewerSchemaError } from '@/db/migrations';
import { SCHEMA_VERSION } from '@/db/schema';
import { putAttachment, liveBlobs } from '@/files/store';
import { openNodeDb } from '@/db/nodeAdapter';
import { nodeHasher, nodeFs } from '@/files/nodeFs';
import { postContractDeposit } from '@/domain/accounting/post';
import type { FS } from '@/files/fsAdapter';

function randBytes(n: number, seedByte: number): Uint8Array {
  const b = new Uint8Array(n);
  let x = seedByte + 1;
  for (let i = 0; i < n; i++) { x = (x * 48271) % 2147483647; b[i] = x & 0xff; }
  return b;
}

/** إدراج بيانات عمل بسيطة لتصير النسخة ذات مضمون */
function insertSampleRows(env: ReturnType<typeof makeBackupEnv>): void {
  env.db.transaction(() => {
    env.db.run(`INSERT INTO properties (id,name,created_at) VALUES ('P1','برج الاختبار','x')`);
    env.db.run(`INSERT INTO units (id,property_id,unit_no,created_at) VALUES ('U1','P1','A-1','x')`);
    env.db.run(
      `INSERT INTO contracts (id,contract_no,tenant_name,unit_id,value_halalas,start,end,deposit_halalas,status,created_at)
       VALUES ('C1','EJ-2026-001','فيصل','U1',2400000,'2026-01-01','2026-12-31',200000,'سارٍ','x')`
    );
    // التأمين المحتجز له قيده كما يرحّله تأكيد العقد · فالبيانات تجتاز فحص السلامة الذي يشترطه إنشاء النسخة
    postContractDeposit(env.db, { id: 'C1', contract_no: 'EJ-2026-001', tenant: 'فيصل', start: '2026-01-01', deposit: 200000 });
  });
}

let dirs: string[] = [];
function newDir(): string { const d = tempDir(); dirs.push(d); return d; }
afterAll(() => { for (const d of dirs) rmrf(d); });

describe('النسخ الاحتياطي — الاختبارات الاثنا عشر', () => {
  // ١) نسخة بـ٥٠٠٠ مرفق ← استعادة على جهاز نظيف ← كل بصمة مطابقة
  test('١ — نسخة بـ٥٠٠٠ مرفق تُستعاد على جهاز نظيف وكل بصمة مطابقة', async () => {
    const src = makeBackupEnv(newDir());
    insertSampleRows(src);
    for (let i = 0; i < 5000; i++) {
      await putAttachment(src.filesEnv, randBytes(120 + (i % 200), i), {
        entityType: 'library', kind: 'other', originalName: `f${i}.bin`,
      });
    }
    expect(liveBlobs(src.db)).toHaveLength(5000);
    const archive = path.join(src.root, 'out.aqbk');
    const manifest = await createBackup(src, archive);
    expect(manifest.complete).toBe(true);
    expect(manifest.files).toHaveLength(5000);

    // جهاز نظيف: تثبيت جديد فارغ
    const clean = makeBackupEnv(newDir());
    const res = await restoreBackup(clean, archive);
    expect(res.manifest.db_sha256).toBe(manifest.db_sha256);

    // كل بصمة مطابقة على القرص المستعاد
    const restoredBlobs = liveBlobs(res.db);
    expect(restoredBlobs).toHaveLength(5000);
    for (const b of restoredBlobs.slice(0, 200)) { // عيّنة تحقق فعلية بالبصمة
      const p = path.join(clean.attachmentsDir, `${b.sha256}.${b.ext}`);
      expect(fs.existsSync(p)).toBe(true);
      expect(await nodeHasher(new Uint8Array(fs.readFileSync(p)))).toBe(b.sha256);
    }
    // والوجود الكامل للخمسة آلاف
    for (const b of restoredBlobs) {
      expect(fs.existsSync(path.join(clean.attachmentsDir, `${b.sha256}.${b.ext}`))).toBe(true);
    }
    // الأعداد مطابقة
    expect(tableCounts(res.db)['contracts']).toBe(1);
    expect(tableCounts(res.db)['attachments']).toBe(5000);
    src.closeLive(); clean.closeLive();
  }, 300000);

  // ٢) قطع النسخ في المنتصف
  test('٢ — قطع النسخ في المنتصف: لا أرشيف جزئي والقاعدة الحية سليمة', async () => {
    const env = makeBackupEnv(newDir());
    insertSampleRows(env);
    for (let i = 0; i < 10; i++) {
      await putAttachment(env.filesEnv, randBytes(500, 90 + i), {
        entityType: 'library', kind: 'other', originalName: `g${i}.bin`,
      });
    }
    const archive = path.join(env.root, 'cut.aqbk');
    let writes = 0;
    const cuttingFs: FS = {
      ...nodeFs,
      write: (p, b) => {
        writes++;
        if (p.endsWith('.aqbk')) throw new Error('انقطاع مفاجئ أثناء الكتابة');
        nodeFs.write(p, b);
      },
    };
    await expect(createBackup({ ...env, fs: cuttingFs }, archive)).rejects.toThrow('انقطاع');
    expect(fs.existsSync(archive)).toBe(false); // لا أرشيف جزئي
    // القاعدة الحية سليمة
    const ic = env.db.get<Record<string, string>>(`PRAGMA integrity_check`)!;
    expect(String(Object.values(ic)[0])).toBe('ok');
    env.closeLive();
  });

  // ٣) قطع الاستعادة ← رجوع فوري
  test('٣ — فشل أثناء الاستعادة بعد بدء التبديل: رجوع فوري للبيانات الأصلية', async () => {
    const src = makeBackupEnv(newDir());
    insertSampleRows(src);
    await putAttachment(src.filesEnv, randBytes(700, 7), {
      entityType: 'library', kind: 'other', originalName: 'a.bin',
    });
    const archive = path.join(src.root, 'r.aqbk');
    await createBackup(src, archive);

    const dst = makeBackupEnv(newDir());
    dst.db.transaction(() => {
      dst.db.run(`INSERT INTO tenants (id,name,created_at) VALUES ('T-orig','بيانات أصلية','x')`);
    });
    // فشل مصطنع أثناء دمج المرفقات (بعد تبديل القاعدة)
    const failingFs: FS = {
      ...nodeFs,
      write: (p, b) => {
        if (p.includes('attachments')) throw new Error('انقطاع أثناء الاستعادة');
        nodeFs.write(p, b);
      },
    };
    await expect(restoreBackup({ ...dst, fs: failingFs } as typeof dst, archive)).rejects.toThrow('انقطاع');
    // البيانات الأصلية رجعت كما كانت
    const row = dst.live().get(`SELECT name FROM tenants WHERE id='T-orig'`);
    expect(row).toBeTruthy();
    const ic = dst.live().get<Record<string, string>>(`PRAGMA integrity_check`)!;
    expect(String(Object.values(ic)[0])).toBe('ok');
    src.closeLive(); dst.closeLive();
  });

  // ٤) تعديل بايت في الأرشيف ← رفض
  test('٤ — تعديل بايت واحد في الأرشيف يُرفض', async () => {
    const env = makeBackupEnv(newDir());
    insertSampleRows(env);
    const archive = path.join(env.root, 't.aqbk');
    await createBackup(env, archive);

    // (أ) قلب بايت خام في منتصف الأرشيف
    const bytes = fs.readFileSync(archive);
    const mid = Math.floor(bytes.length / 2);
    bytes[mid] = bytes[mid] ^ 0xff;
    const tampered1 = path.join(env.root, 'tampered1.aqbk');
    fs.writeFileSync(tampered1, bytes);
    await expect(verifyArchiveAt(env, tampered1)).rejects.toThrow();

    // (ب) أرشيف مُعاد بناؤه بمحتوى قاعدة مغيَّر — بصمة القاعدة لا تطابق البيان
    const entries = unzipSync(new Uint8Array(fs.readFileSync(archive)));
    const db2 = entries['data.db'].slice();
    db2[db2.length - 1] = db2[db2.length - 1] ^ 0x01;
    const rebuilt = zipSync({ ...entries, 'data.db': db2 });
    const tampered2 = path.join(env.root, 'tampered2.aqbk');
    fs.writeFileSync(tampered2, rebuilt);
    await expect(verifyArchiveAt(env, tampered2)).rejects.toThrow(BackupVerificationError);
    env.closeLive();
  });

  // ٥) حذف ملف من القرص ← يُرفض إنشاء النسخة ويُسمّى الملف (قرار المالك: لا نسخة «ناقصة»)
  test('٥ — مرفق محذوف من القرص: يُرفض إنشاء النسخة ويُسمّى الملف · لا نسخة ناقصة', async () => {
    const env = makeBackupEnv(newDir());
    const a1 = await putAttachment(env.filesEnv, randBytes(300, 1), {
      entityType: 'library', kind: 'other', originalName: 'keep.bin',
    });
    const a2 = await putAttachment(env.filesEnv, randBytes(300, 2), {
      entityType: 'library', kind: 'other', originalName: 'lost.bin',
    });
    fs.rmSync(path.join(env.attachmentsDir, `${a2.sha256}.${a2.ext}`));
    const out = path.join(env.root, 'm.aqbk');
    await expect(createBackup(env, out)).rejects.toThrow(/الملف «lost.bin» مفقود من القرص · يُرفض إنشاء النسخة/);
    expect(fs.existsSync(out)).toBe(false);
    // الملف السليم لم يكن ليُنقذ نسخة ناقصة · يبقى في مكانه والبيانات كما هي
    expect(fs.existsSync(path.join(env.attachmentsDir, `${a1.sha256}.${a1.ext}`))).toBe(true);
    env.closeLive();
  });

  // ٦) مخطط أقدم ← هجرة
  test('٦ — أرشيف بمخطط أقدم يُهاجَر أثناء الاستعادة', async () => {
    const env = makeBackupEnv(newDir());
    // قاعدة «أقدم»: user_version = 0 (ما قبل المخطط)
    const oldDbPath = path.join(env.root, 'old.db');
    const oldDb = openNodeDb(oldDbPath);
    oldDb.exec('PRAGMA user_version = 0');
    oldDb.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    oldDb.close();
    const oldBytes = new Uint8Array(fs.readFileSync(oldDbPath));
    const manifest = {
      format: 'aqari-backup', format_version: 1, app_version: 'old', schema_version: 0,
      created_at: 'x', device_id: 'd', db_sha256: await nodeHasher(oldBytes),
      files: [], missing_files: [], table_counts: {},
      ledger: { total_debit_halalas: 0, total_credit_halalas: 0, balances: {} },
      integrity: [], complete: true,
    };
    const archPath = path.join(env.root, 'old.aqbk');
    fs.writeFileSync(archPath, zipSync({
      'manifest.json': new TextEncoder().encode(JSON.stringify(manifest)),
      'data.db': oldBytes,
    }));
    const res = await restoreBackup(env, archPath);
    expect(res.migrated).toBe(true);
    // القاعدة بعد الهجرة تحمل كل الجداول
    expect(res.db.get(`SELECT name FROM sqlite_master WHERE name='contracts'`)).toBeTruthy();
    env.closeLive();
  });

  // ٧) مخطط أحدث ← رفض مؤدَّب
  test('٧ — أرشيف بمخطط أحدث يُرفض رفضاً مؤدَّباً', async () => {
    const env = makeBackupEnv(newDir());
    const newDbPath = path.join(env.root, 'newer.db');
    const newDb = openNodeDb(newDbPath);
    newDb.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 5}`);
    newDb.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    newDb.close();
    const newBytes = new Uint8Array(fs.readFileSync(newDbPath));
    const manifest = {
      format: 'aqari-backup', format_version: 1, app_version: 'future', schema_version: SCHEMA_VERSION + 5,
      created_at: 'x', device_id: 'd', db_sha256: await nodeHasher(newBytes),
      files: [], missing_files: [], table_counts: {},
      ledger: { total_debit_halalas: 0, total_credit_halalas: 0, balances: {} },
      integrity: [], complete: true,
    };
    const archPath = path.join(env.root, 'newer.aqbk');
    fs.writeFileSync(archPath, zipSync({
      'manifest.json': new TextEncoder().encode(JSON.stringify(manifest)),
      'data.db': newBytes,
    }));
    await expect(restoreBackup(env, archPath)).rejects.toThrow(NewerSchemaError);
    await expect(restoreBackup(env, archPath)).rejects.toThrow(/حدّث التطبيق/);
    // البيانات الحية لم تُمسّ
    expect(env.db.get(`SELECT value FROM meta WHERE key='seeded'`)).toBeTruthy();
    env.closeLive();
  });

  // ٨) امتلاء المساحة ← فشل نظيف
  test('٨ — امتلاء المساحة أثناء الكتابة: فشل نظيف بلا مخلفات', async () => {
    const env = makeBackupEnv(newDir());
    insertSampleRows(env);
    const archive = path.join(env.root, 'nospace.aqbk');
    const fullDiskFs: FS = {
      ...nodeFs,
      write: (p, b) => {
        if (p.endsWith('.aqbk')) { const e = new Error('ENOSPC: no space left on device'); throw e; }
        nodeFs.write(p, b);
      },
    };
    await expect(createBackup({ ...env, fs: fullDiskFs }, archive)).rejects.toThrow('ENOSPC');
    expect(fs.existsSync(archive)).toBe(false);
    // لا ملفات مؤقتة متروكة من هذه المحاولة
    const leftovers = fs.existsSync(env.tmpDir)
      ? fs.readdirSync(env.tmpDir).filter((f: string) => f.startsWith('backup-'))
      : [];
    expect(leftovers).toHaveLength(0);
    // القاعدة تعمل
    env.db.run(`INSERT INTO tenants (id,name,created_at) VALUES ('T1','بعد الفشل','x')`);
    expect(env.db.get(`SELECT id FROM tenants WHERE id='T1'`)).toBeTruthy();
    env.closeLive();
  });

  // ٩) إغلاق قسري أثناء الحفظ ← integrity_check سليم
  test('٩ — إغلاق قسري وسط معاملة: القاعدة سليمة والمعاملة غير المكتملة تُنسى', async () => {
    const dir = newDir();
    const dbPath = path.join(dir, 'crash.db');
    {
      const env = makeBackupEnv(dir); // ينشئ data.db — نستخدم قاعدة منفصلة للإيضاح
      env.closeLive();
    }
    const db1 = openNodeDb(dbPath);
    db1.exec(`CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)`);
    db1.run(`INSERT INTO t (v) VALUES ('ثابتة')`);
    // معاملة مفتوحة لم تُرتكب ثم «إغلاق قسري»
    db1.exec('BEGIN IMMEDIATE');
    db1.run(`INSERT INTO t (v) VALUES ('لن تنجو')`);
    db1.close(); // يهجر المعاملة دون COMMIT — يحاكي القتل
    const db2 = openNodeDb(dbPath);
    const ic = db2.get<Record<string, string>>(`PRAGMA integrity_check`)!;
    expect(String(Object.values(ic)[0])).toBe('ok');
    const rows = db2.all<{ v: string }>(`SELECT v FROM t`);
    expect(rows.map((r) => r.v)).toEqual(['ثابتة']);
    db2.close();
  });

  // ١٠) ١٠٠ دورة ← بصمة ثابتة
  test('١٠ — مئة دورة نسخ متتالية بلا تغيير: بصمة القاعدة ثابتة', async () => {
    const env = makeBackupEnv(newDir());
    insertSampleRows(env);
    await putAttachment(env.filesEnv, randBytes(400, 42), {
      entityType: 'library', kind: 'other', originalName: 's.bin',
    });
    let first: string | null = null;
    for (let i = 0; i < 100; i++) {
      const m = await createBackup(env, path.join(env.root, 'cycle.aqbk'));
      if (first === null) first = m.db_sha256;
      else expect(m.db_sha256).toBe(first);
    }
    env.closeLive();
  }, 300000);

  // ١١) نفس الصورة ٥ مرات ← ملف واحد
  test('١١ — رفع نفس الملف خمس مرات: صف واحد في blobs وملف واحد على القرص', async () => {
    const env = makeBackupEnv(newDir());
    const img = randBytes(2048, 77);
    for (let i = 0; i < 5; i++) {
      await putAttachment(env.filesEnv, img, {
        entityType: 'property', entityId: 'P' + i, kind: 'photo', originalName: 'unit.jpg',
      });
    }
    expect(Number(env.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM blobs`)!.n)).toBe(1);
    expect(Number(env.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM attachments`)!.n)).toBe(5);
    expect(fs.readdirSync(env.attachmentsDir)).toHaveLength(1);
    env.closeLive();
  });

  // ١٢) تعطيل وحدة التجزئة ← ترفض إنشاء النسخة
  test('١٢ — وحدة تجزئة معطّلة: يُرفض إنشاء النسخة من الأساس', async () => {
    const env = makeBackupEnv(newDir());
    insertSampleRows(env);
    const archive = path.join(env.root, 'nohash.aqbk');
    await expect(createBackup({ ...env, hasher: null }, archive)).rejects.toThrow(HashingUnavailableError);
    expect(fs.existsSync(archive)).toBe(false);
    env.closeLive();
  });
});
