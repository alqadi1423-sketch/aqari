/**
 * «لا يُحذف شيء مرتبط بغيره» · جدول تحقق المالك:
 * القاعدة نفسها ترفض (لا الواجهة فقط)، القيد المرحّل لا يُحذف أبداً،
 * الرفض يسمّي الأعداد، والأرشفة لا تغيّر في الميزان رقماً واحداً.
 */
import { memDb } from './helpers/testDb';
import { linkedRefs, refsSummary, refuseDeleteMessage } from '@/domain/refs';
import { trialBalance } from '@/domain/accounting/ledger';
import { postEntry, reverseEntryById } from '@/domain/accounting/post';
import { unlinkAttachment } from '@/files/store';
import { wipeAllData } from '@/domain/wipe';
import type { DB } from '@/db/adapter';

const seedPropertyWithLinks = (db: DB) => {
  db.run(`INSERT INTO properties (id, name, created_at) VALUES ('P1', 'عمارة الاختبار', datetime('now'))`);
  db.run(`INSERT INTO units (id, property_id, unit_no, created_at) VALUES ('U1', 'P1', '101', datetime('now'))`);
  db.run(`INSERT INTO units (id, property_id, unit_no, created_at) VALUES ('U2', 'P1', '102', datetime('now'))`);
  db.run(
    `INSERT INTO contracts (id, contract_no, tenant_name, unit_id, start, end, value_halalas, cycle, status, created_at)
     VALUES ('C1', 'CN-1', 'مستأجر', 'U1', '2026-01-01', '2026-12-31', 1200000, 'شهرية', 'سارٍ', datetime('now'))`);
};

describe('لا يُحذف شيء مرتبط بغيره', () => {
  test('القاعدة نفسها ترفض حذف عقار له وحدات · القيود المرجعية مفعّلة لا شكلية', () => {
    const db = memDb();
    seedPropertyWithLinks(db);
    expect(() => db.run(`DELETE FROM properties WHERE id = 'P1'`)).toThrow(/FOREIGN KEY/i);
    expect(db.get(`SELECT id FROM properties WHERE id = 'P1'`)).toBeTruthy();
    db.close();
  });

  test('قيد مرحّل لا يُحذف أبداً · المحفّز يردّ حتى الحذف المباشر من القاعدة', () => {
    const db = memDb();
    postEntry(db, {
      date: '2026-03-01', memo: 'قيد اختبار', auto: false,
      lines: [
        { account: '1100', debit: 5000, credit: 0 },
        { account: '4200', debit: 0, credit: 5000 },
      ],
    });
    const id = db.get<{ id: string }>(`SELECT id FROM journal_entries WHERE status = 'مرحّل'`)!.id;
    expect(() => db.run(`DELETE FROM journal_entries WHERE id = ?`, [id])).toThrow(/مرحّل/);
    expect(() => db.run(`DELETE FROM journal_lines WHERE entry_id = ?`, [id])).toThrow(/مرحّل/);
    expect(db.get(`SELECT id FROM journal_entries WHERE id = ?`, [id])).toBeTruthy();
    db.close();
  });

  test('عدّ المرتبطات يسمّي كل نوع بعدده', () => {
    const db = memDb();
    seedPropertyWithLinks(db);
    const refs = linkedRefs(db, 'property', 'P1');
    expect(refs.find((r) => r.label === 'وحدة')?.count).toBe(2);
    expect(refs.find((r) => r.label === 'عقداً')?.count).toBe(1);
    expect(refsSummary(refs)).toBe('2 وحدة · 1 عقداً');
    const msg = refuseDeleteMessage('العقار', 'عمارة الاختبار', refs);
    expect(msg).toContain('2 وحدة · 1 عقداً');
    expect(msg).toContain('أرشِفه');
    db.close();
  });

  test('وحدة بعقد وساكن: المرتبطات تعدّهما · ووحدة خالية بلا مرتبطات', () => {
    const db = memDb();
    seedPropertyWithLinks(db);
    db.run(
      `INSERT INTO occupants (id, contract_id, unit_id, name, created_at)
       VALUES ('O1', 'C1', 'U1', 'ساكن', datetime('now'))`);
    const u1 = linkedRefs(db, 'unit', 'U1');
    expect(u1.find((r) => r.label === 'عقداً')?.count).toBe(1);
    expect(u1.find((r) => r.label === 'ساكناً')?.count).toBe(1);
    expect(linkedRefs(db, 'unit', 'U2')).toHaveLength(0);
    db.close();
  });

  test('الأرشفة لا تغيّر في ميزان المراجعة رقماً واحداً', () => {
    const db = memDb();
    seedPropertyWithLinks(db);
    postEntry(db, {
      date: '2026-03-01', memo: 'إيجار محصّل', auto: false,
      lines: [
        { account: '1100', debit: 120000, credit: 0 },
        { account: '4200', debit: 0, credit: 120000 },
      ],
    });
    const before = JSON.stringify(trialBalance(db, null, '2026-12-31'));
    db.run(`UPDATE properties SET archived = 1 WHERE id = 'P1'`);
    db.run(`UPDATE units SET archived = 1 WHERE id = 'U1'`);
    const after = JSON.stringify(trialBalance(db, null, '2026-12-31'));
    expect(after).toBe(before);
    db.close();
  });

  test('عكس القيد يُبقي الأصل والعاكس معاً ويصفّر الأثر · لا محو للتاريخ', () => {
    const db = memDb();
    postEntry(db, {
      date: '2026-03-01', memo: 'قيد للعكس', auto: false,
      lines: [
        { account: '1100', debit: 7700, credit: 0 },
        { account: '4200', debit: 0, credit: 7700 },
      ],
    });
    const orig = db.get<{ id: string; no: string }>(`SELECT id, no FROM journal_entries WHERE memo = 'قيد للعكس'`)!;
    const rev = reverseEntryById(db, orig.id);
    expect(rev).toBeTruthy();
    // الأصل باقٍ مختوماً بمُعاكسه · والعاكس مرحّل بسطور مقلوبة
    const after = db.get<{ reversed_by: string; deleted_at: string | null }>(
      `SELECT reversed_by, deleted_at FROM journal_entries WHERE id = ?`, [orig.id])!;
    expect(after.reversed_by).toBe(rev!.id);
    expect(after.deleted_at).toBeNull();
    const revLines = db.all<{ account_code: string; debit_halalas: number; credit_halalas: number }>(
      `SELECT account_code, debit_halalas, credit_halalas FROM journal_lines WHERE entry_id = ? ORDER BY account_code`, [rev!.id]);
    expect(revLines).toEqual([
      { account_code: '1100', debit_halalas: 0, credit_halalas: 7700 },
      { account_code: '4200', debit_halalas: 7700, credit_halalas: 0 },
    ]);
    // الأثر الصافي صفر والعكس الثاني ممنوع
    const cash = trialBalance(db, null, '2026-12-31').find((r) => r.code === '1100')!;
    expect(cash.closingHalalas).toBe(0);
    expect(reverseEntryById(db, orig.id)).toBeNull();
    db.close();
  });

  test('نزع الربط يفكّ الملف عن سجله ويبقيه في المكتبة · لا يحذفه', () => {
    const db = memDb();
    db.run(`INSERT INTO blobs (sha256, ext, size_bytes, created_at) VALUES ('aa11', 'jpg', 2048, datetime('now'))`);
    db.run(
      `INSERT INTO attachments (id, entity_type, entity_id, kind, original_name, mime, sha256, created_at)
       VALUES ('A1', 'contract', 'C9', 'lease', 'عقد.jpg', 'image/jpeg', 'aa11', datetime('now'))`);
    unlinkAttachment(db, 'A1');
    const a = db.get<{ entity_type: string; entity_id: string; deleted_at: string | null }>(
      `SELECT entity_type, entity_id, deleted_at FROM attachments WHERE id = 'A1'`)!;
    expect(a.entity_type).toBe('library');
    expect(a.entity_id).toBe('');
    expect(a.deleted_at).toBeNull();
    db.close();
  });

  test('المسح الشامل ينشئ نسخة أمان أولاً · وفشلها يلغي المسح كله', async () => {
    const { makeBackupEnv } = await import('./helpers/backupEnv');
    const path = await import('node:path');
    const fsNode = await import('node:fs');
    const os = await import('node:os');
    const root = fsNode.mkdtempSync(path.join(os.tmpdir(), 'aq-wipe-')).replace(/\\/g, '/');
    const env = makeBackupEnv(root);
    env.db.run(`INSERT INTO properties (id, name, created_at) VALUES ('P1', 'عقار', datetime('now'))`);

    // فشل النسخة (قرص ممتلئ مفتعل) يلغي المسح والبيانات كما هي
    const failingEnv = { ...env, get db() { return env.db; }, fs: { ...env.fs, rename: () => { throw new Error('no space'); } } };
    await expect(wipeAllData(failingEnv as never)).rejects.toThrow();
    expect(env.db.get(`SELECT id FROM properties WHERE deleted_at IS NULL`)).toBeTruthy();

    // النجاح: نسخة موجودة على القرص ثم كل شيء في السلة
    const safety = await wipeAllData(env);
    expect(env.fs.exists(safety)).toBe(true);
    expect(env.db.get(`SELECT id FROM properties WHERE deleted_at IS NULL`)).toBeFalsy();
    expect(env.db.get(`SELECT id FROM properties WHERE deleted_at IS NOT NULL`)).toBeTruthy();
    env.closeLive();
  });

  test('أعمدة الأرشفة موجودة بافتراضي صفر · الهجرة ١٢', () => {
    const db = memDb();
    db.run(`INSERT INTO properties (id, name, created_at) VALUES ('P9', 'عقار', datetime('now'))`);
    expect(db.get<{ archived: number }>(`SELECT archived FROM properties WHERE id = 'P9'`)!.archived).toBe(0);
    db.run(`INSERT INTO units (id, property_id, unit_no, created_at) VALUES ('U9', 'P9', '1', datetime('now'))`);
    expect(db.get<{ archived: number }>(`SELECT archived FROM units WHERE id = 'U9'`)!.archived).toBe(0);
    db.close();
  });
});
