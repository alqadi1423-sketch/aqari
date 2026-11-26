/**
 * المراجعة الشاملة 2026-11-13 · C-12 · منخفض · src/domain/backup/checks.ts · restore.ts
 *
 * ما يحدث (بيانات مصطنعة): نسخةٌ فيها قيدٌ مرحّل غير متوازن تُستعاد بملاحظة، ثم تُعتمد للسحابة فترفضها أجهزة الأعضاء بفحص المزامنة
 * (semanticIssues) فيفترق الدفتر · خلاف «لا تمرّ بيانات في أحدهما وتُرفض في الآخر» (2026-10-03 و2026-10-04).
 *
 * قرار المالك س١١ («موافق على التوصيات» 2026-11-13، تطبيقاً لقرار 2026-10-02 غير المشطوب): قيدٌ مرحّل غير متوازن في نسخة يرفض
 * الاستعادة كما ترفضه المزامنة. ويبقى إنشاء النسخة يمرّ بملاحظة (2026-10-04: الفرق المحاسبي لا يمنع أحداً من حفظ بياناته).
 * والقيد المرحّل بلا سطور من البند نفسه في فحص المزامنة (semantic.ts ١) فيُرفض معه.
 */
import * as path from 'node:path';
import { tempDir, rmrf } from './helpers/testDb';
import { makeBackupEnv } from './helpers/backupEnv';
import type { DB } from '@/db/adapter';
import { createBackup, tableCounts } from '@/domain/backup/create';
import { prepareRestore } from '@/domain/backup/restore';
import { RestoreError } from '@/domain/backup/types';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmrf(d); });

/** قيدٌ مرحّل مصطنع خارج المحفّزات · كما يأتي من ملفٍ تالف أو مصنوع */
function forgeEntry(db: DB, id: string, no: string, lines: Array<[string, number, number]>) {
  for (const t of ['trg_je_insert_balanced']) db.exec(`DROP TRIGGER IF EXISTS ${t}`);
  db.exec('PRAGMA foreign_keys = OFF');
  lines.forEach(([acc, dr, cr], i) => db.run(
    `INSERT INTO journal_lines (id,entry_id,account_code,descr,debit_halalas,credit_halalas) VALUES (?,?,?,'',?,?)`, [id + 'L' + i, id, acc, dr, cr]));
  db.run(`INSERT INTO journal_entries (id,no,date,memo,status,auto,created_at) VALUES (?,?,'2026-01-01','م','مرحّل',0,'x')`, [id, no]);
  db.exec('PRAGMA foreign_keys = ON');
}

async function archiveWith(prefix: string, forge: (db: DB) => void) {
  const d = tempDir(prefix);
  dirs.push(d);
  const src = makeBackupEnv(d);
  forge(src.db);
  const archive = path.join(d, 'forged.aqbk');
  const m = await createBackup(src, archive);
  src.closeLive();
  const t = tempDir(prefix + 't-');
  dirs.push(t);
  return { archive, manifest: m, target: makeBackupEnv(t) };
}

test('C-12 · قيدٌ مرحّل غير متوازن في نسخة يرفض الاستعادة ويسمّي القيد · والنسخة نفسها أُنشئت بملاحظة', async () => {
  const { archive, manifest, target } = await archiveWith('aq-r14c12-', (db) => forgeEntry(db, 'XZ', 'JE-9001', [['1100', 5000, 0]]));
  // الإنشاء لا يمنع (2026-10-04): فيها ملاحظة تسمّيه
  expect((manifest.notes ?? []).join(' ')).toContain('قيد مرحّل غير متوازن: JE-9001 (الفرق 50.00)');
  const before = tableCounts(target.db);
  const err = await prepareRestore(target, archive).catch((e: Error) => e);
  expect(err).toBeInstanceOf(RestoreError);
  expect((err as Error).message).toContain('قيد مرحّل غير متوازن: JE-9001 (الفرق 50.00)');
  expect(tableCounts(target.db)).toEqual(before);
  target.closeLive();
});

test('C-12 · وقيدٌ مرحّل بلا سطور كذلك (البند نفسه في فحص المزامنة)', async () => {
  const { archive, target } = await archiveWith('aq-r14c12b-', (db) => forgeEntry(db, 'XY', 'JE-9002', []));
  const err = await prepareRestore(target, archive).catch((e: Error) => e);
  expect(err).toBeInstanceOf(RestoreError);
  expect((err as Error).message).toContain('قيد مرحّل بلا سطور: JE-9002');
  target.closeLive();
});
