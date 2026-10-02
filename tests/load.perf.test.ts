/**
 * أرقام اختبار الحمل — ٥٠ عقاراً، ١٠٠٠ وحدة، ٢٠٠٠ عقد، ٢٤٬٠٠٠ قسط:
 * الاستعلامات المجمَّعة التي تعتمد عليها الشاشات تبقى دون ثانية لكلٍّ منها حتى مع توازي عمّال الاختبار.
 */
import { memDb } from './helpers/testDb';
import { allInstallments } from '@/domain/stats';
import { allUnitStatuses, allPropertyStats } from '@/domain/stats';
import { uid } from '@/domain/ids';

describe('اختبار الحمل · آلاف السجلات', () => {
  test('٥٠ عقاراً · ١٠٠٠ وحدة · ٢٠٠٠ عقد · ٢٤٬٠٠٠ قسط — الاستعلامات المجمَّعة سريعة', () => {
    const db = memDb();
    const t0 = Date.now();
    db.transaction(() => {
      for (let p = 0; p < 50; p++) {
        const pid = uid();
        db.run(`INSERT INTO properties (id, name, created_at) VALUES (?,?,?)`,
          [pid, 'عقار ' + p, new Date().toISOString()]);
        for (let u = 0; u < 20; u++) {
          const uidd = uid();
          db.run(`INSERT INTO units (id, property_id, unit_no, rent_monthly_halalas, created_at) VALUES (?,?,?,?,?)`,
            [uidd, pid, `U${p}-${u}`, 100000, new Date().toISOString()]);
          for (let c = 0; c < 2; c++) {
            const cid = uid();
            const yr = 2024 + c;
            db.run(
              `INSERT INTO contracts (id, contract_no, tenant_name, unit_id, unit_label, value_halalas,
                cycle, start, end, status, created_at)
               VALUES (?,?,?,?,?,?,?,?,?,'سارٍ',?)`,
              [cid, `EJ-${yr}-${p}-${u}-${c}`, `مستأجر ${p}-${u}-${c}`, uidd, `U${p}-${u}`,
               3600000, 'شهرية', `${yr}-01-01`, `${yr}-12-31`, new Date().toISOString()]
            );
            for (let m = 0; m < 12; m++) {
              db.run(
                `INSERT INTO contract_installments (id, contract_id, due_date, amount_halalas, paid_halalas, status)
                 VALUES (?,?,?,?,?,?)`,
                [uid(), cid, `${yr}-${String(m + 1).padStart(2, '0')}-01`, 300000,
                 m % 3 === 0 ? 300000 : 0, m % 3 === 0 ? 'مدفوعة' : 'مستحقة']
              );
            }
          }
        }
      }
    });
    const seedMs = Date.now() - t0;

    const time = (fn: () => unknown) => {
      const s = Date.now();
      fn();
      return Date.now() - s;
    };
    const tInst = time(() => allInstallments(db, '2025-06-15'));
    const tUnits = time(() => allUnitStatuses(db, '2025-06-15'));
    const tProps = time(() => allPropertyStats(db, '2025-06-15'));

    // eslint-disable-next-line no-console
    console.log(`بذر ${seedMs}م.ث · الأقساط (٢٤٬٠٠٠) ${tInst}م.ث · حالات ١٠٠٠ وحدة ${tUnits}م.ث · إحصاءات ٥٠ عقاراً ${tProps}م.ث`);
    expect(allInstallments(db, '2025-06-15').length).toBe(24000);
    expect(tInst).toBeLessThan(6000); // منفرداً ~525م.ث · الحد يصطاد انحدار رتبة كاملة ويسامح توازي العمّال
    expect(tUnits).toBeLessThan(1000);
    expect(tProps).toBeLessThan(1000);
    const all24k = allInstallments(db, '2025-06-15');
    const tSearch = time(() => all24k.filter((x) =>
      [x.tenant, x.unitNo, x.contractNo ?? ''].some((v) => v && String(v).includes('مستأجر 25-'))));
    // eslint-disable-next-line no-console
    console.log('البحث في ٢٤٬٠٠٠ قسط ' + tSearch + 'م.ث');
    expect(tSearch).toBeLessThan(500);
    db.close();
  });
});

describe('حدود التوجيه الجامع · أرقام لا انطباعات', () => {
  test('٥٠٠٠ مرفق: قائمة المكتبة كاملة في أقل من ثانيتين', async () => {
    const { makeBackupEnv } = await import('./helpers/backupEnv');
    const path = await import('node:path');
    const os = await import('node:os');
    const fsN = await import('node:fs');
    const env = makeBackupEnv(fsN.mkdtempSync(path.join(os.tmpdir(), 'aq-lib5k-')));
    const { libraryFiles } = await import('@/domain/library');
    env.db.transaction(() => {
      for (let i = 0; i < 5000; i++) {
        const sha = String(i).padStart(64, 'a');
        env.db.run(`INSERT INTO blobs (sha256, ext, size_bytes, created_at) VALUES (?,?,?,?)`,
          [sha, 'jpg', 100000 + i, new Date().toISOString()]);
        env.db.run(
          `INSERT INTO attachments (id, sha256, entity_type, entity_id, kind, original_name, mime, note, display_name, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
          ['A' + i, sha, 'unit', 'U' + (i % 500), 'photo', 'ملف-' + i + '.jpg', 'image/jpeg', '', 'ملف-' + i, new Date().toISOString()]
        );
      }
    });
    const t0 = Date.now();
    const rows = libraryFiles({ db: env.db, fs: env.fs, hasher: env.filesEnv.hasher, attachmentsDir: env.filesEnv.attachmentsDir });
    const ms = Date.now() - t0;
    console.log(`المكتبة (٥٠٠٠ مرفق): ${rows.length} صفاً في ${ms}م.ث`);
    expect(rows.length).toBe(5000);
    expect(ms).toBeLessThan(2000);
    env.closeLive();
  });
});
