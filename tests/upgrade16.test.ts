/**
 * الترقية من قاعدة الإصدار ١٦ (ما على هاتف المالك اليوم) إلى ١٨:
 * المحفّزات الجديدة تُنشأ، والبيانات القائمة لا تُمسّ (ولو كان فيها قيد مرحّل في السلة من إصدار سابق)،
 * وبنية المزامنة تُنشأ والالتقاط مطفأ حتى تسجيل الدخول.
 */
import { openNodeDb } from '@/db/nodeAdapter';
import { MIGRATIONS, SCHEMA_VERSION } from '@/db/schema';
import { migrate, currentSchemaVersion } from '@/db/migrations';
import { seed } from '@/db/seed';
import { semanticIssues } from '@/domain/backup/semantic';

test('قاعدة ١٦ ببيانات قديمة تترقّى إلى ٢٠ دون أن يتغيّر صف', () => {
  const db = openNodeDb(':memory:');
  db.exec('PRAGMA foreign_keys = OFF');
  for (let v = 0; v < 16; v++) db.exec(MIGRATIONS[v]);
  db.exec('PRAGMA user_version = 16');
  db.exec('PRAGMA foreign_keys = ON');
  seed(db);
  // قيد مرحّل متوازن ثم أُدخل السلة كما كان يفعل المسح في الإصدار السابق
  db.run(`INSERT INTO journal_entries (id,no,date,memo,status,auto,created_at) VALUES ('E','JE-0001','2026-01-01','قديم','قيد الإنشاء',1,'x')`);
  db.run(`INSERT INTO journal_lines (id,entry_id,account_code,descr,debit_halalas,credit_halalas) VALUES ('L1','E','1100','',700,0),('L2','E','4200','',0,700)`);
  db.run(`UPDATE journal_entries SET status = 'مرحّل' WHERE id = 'E'`);
  db.run(`UPDATE journal_entries SET deleted_at = 'x' WHERE id = 'E'`);
  const before = db.all(`SELECT * FROM journal_entries ORDER BY id`);

  migrate(db);
  expect(currentSchemaVersion(db)).toBe(SCHEMA_VERSION);
  expect(SCHEMA_VERSION).toBe(32);
  const triggers = db.all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'trigger'`).map((t) => t.name);
  for (const t of ['trg_je_insert_balanced', 'trg_je_posted_no_trash', 'trg_je_posted_status', 'trg_pay_insert_cap', 'trg_inst_update_cap', 'sync_contracts_ins', 'sync_journal_lines_ins', 'row_by_contracts']) {
    expect(triggers).toContain(t);
  }
  expect(db.all(`SELECT * FROM journal_entries ORDER BY id`)).toEqual(before);
  expect(db.get<{ v: number }>(`SELECT v FROM sync_ctl WHERE k = 'capture'`)!.v).toBe(0);
  expect(Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM sync_outbox`)!.n)).toBe(0);
  expect(semanticIssues(db)).toEqual([]);
  // القيد القديم في السلة لا يُحذف بعد الترقية
  expect(() => db.run(`DELETE FROM journal_entries WHERE id = 'E'`)).toThrow('قيد مرحّل لا يُحذف');
  db.close();
});
