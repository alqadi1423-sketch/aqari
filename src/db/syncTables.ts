/**
 * الجداول التي تُزامَن مع السحابة وترتيبها · الآباء قبل الأبناء، فتطبيق الوارد بهذا الترتيب
 * يجد كل مفتاح أجنبي قائماً.
 *
 * خارج المزامنة عمداً:
 *  - attachments و blobs: الملفات نفسها لا تحملها قاعدة المستندات · تنتقل في النسخة على Drive.
 *  - meta و settings و scheduled_notifications: تخصّ هذا الجهاز (هويته، حجم العرض، تنبيهاته).
 *  - journal_lines: تسافر داخل مستند قيدها · فالقيد وسطوره وحدة لا تنفصل.
 *  - جداول sync_* نفسها.
 */
export interface SyncTable {
  name: string;
  /** تعبير المفتاح على صف (NEW. أو OLD. أو اسم الجدول) · المفتاح المركّب يُضمّ بـ «|» */
  pk: (alias: string) => string;
  /** أعمدة المفتاح بالترتيب · للربط عند التطبيق */
  pkCols: string[];
  /** لا تعديل ولا حذف عبر المزامنة · إضافة فقط */
  appendOnly?: boolean;
}

const id = (a: string) => `${a}.id`;

export const SYNC_TABLES: SyncTable[] = [
  { name: 'accounts', pk: (a) => `${a}.code`, pkCols: ['code'] },
  { name: 'tenants', pk: id, pkCols: ['id'] },
  { name: 'suppliers', pk: id, pkCols: ['id'] },
  { name: 'banks', pk: id, pkCols: ['id'] },
  { name: 'properties', pk: id, pkCols: ['id'] },
  { name: 'property_areas', pk: id, pkCols: ['id'] },
  { name: 'property_area_items', pk: id, pkCols: ['id'] },
  { name: 'property_floor_categories', pk: (a) => `${a}.property_id || '|' || ${a}.floor_label`, pkCols: ['property_id', 'floor_label'] },
  { name: 'units', pk: id, pkCols: ['id'] },
  { name: 'unit_rooms', pk: id, pkCols: ['id'] },
  { name: 'unit_room_items', pk: id, pkCols: ['id'] },
  { name: 'meters', pk: id, pkCols: ['id'] },
  { name: 'meter_readings', pk: id, pkCols: ['id'] },
  { name: 'company', pk: id, pkCols: ['id'] },
  { name: 'company_docs', pk: id, pkCols: ['id'] },
  { name: 'message_scripts', pk: id, pkCols: ['id'] },
  { name: 'form_templates', pk: id, pkCols: ['id'] },
  { name: 'journal_entries', pk: id, pkCols: ['id'] },
  { name: 'contracts', pk: id, pkCols: ['id'] },
  { name: 'contract_installments', pk: id, pkCols: ['id'] },
  { name: 'contract_occupants', pk: id, pkCols: ['id'] },
  { name: 'occupants', pk: id, pkCols: ['id'] },
  { name: 'reservations', pk: id, pkCols: ['id'] },
  { name: 'key_money_deals', pk: id, pkCols: ['id'] },
  { name: 'contract_payments', pk: id, pkCols: ['id'] },
  { name: 'payment_lines', pk: id, pkCols: ['id'] },
  { name: 'payment_allocations', pk: id, pkCols: ['id'] },
  { name: 'deposit_settlements', pk: (a) => `${a}.contract_id`, pkCols: ['contract_id'] },
  { name: 'tenant_ratings', pk: (a) => `${a}.contract_id`, pkCols: ['contract_id'] },
  { name: 'claims', pk: id, pkCols: ['id'] },
  { name: 'invoices', pk: id, pkCols: ['id'] },
  { name: 'invoice_lines', pk: id, pkCols: ['id'] },
  { name: 'purchases', pk: id, pkCols: ['id'] },
  { name: 'bank_tx', pk: id, pkCols: ['id'] },
  { name: 'handovers', pk: id, pkCols: ['id'] },
  { name: 'audit_log', pk: id, pkCols: ['id'], appendOnly: true },
];

export const SYNC_RANK: Record<string, number> = Object.fromEntries(SYNC_TABLES.map((t, i) => [t.name, i]));
export const syncTable = (name: string): SyncTable | undefined => SYNC_TABLES.find((t) => t.name === name);

const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ','now')`;
const CAPTURE = `(SELECT v FROM sync_ctl WHERE k = 'capture') = 1`;

function upsertOutbox(table: string, pkExpr: string, op: 'upsert' | 'delete'): string {
  return `INSERT INTO sync_outbox (tbl, pk, op, changed_at) VALUES ('${table}', ${pkExpr}, '${op}', ${NOW})
    ON CONFLICT(tbl, pk) DO UPDATE SET op = excluded.op, changed_at = excluded.changed_at;`;
}

/**
 * الهجرة ١٨ · بنية المزامنة: طابور صادر (outbox) يلتقط كل كتابة بمحفّزات القاعدة نفسها
 * فلا يفلت مسار كتابة واحد، وصندوق وارد يُحفظ قبل التطبيق فلا يضيع بانقطاع، وسجل للمرفوض.
 * الالتقاط لا يعمل إلا بعد تفعيل المزامنة بتسجيل الدخول، ويتوقف أثناء تطبيق الوارد فلا يرتدّ صداه.
 */
export function buildSyncMigration(): string {
  const parts: string[] = [`
CREATE TABLE IF NOT EXISTS sync_ctl (k TEXT PRIMARY KEY, v INTEGER NOT NULL);
INSERT OR IGNORE INTO sync_ctl (k, v) VALUES ('capture', 0);
CREATE TABLE IF NOT EXISTS sync_state (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS sync_outbox (
  tbl        TEXT NOT NULL,
  pk         TEXT NOT NULL,
  op         TEXT NOT NULL CHECK (op IN ('upsert','delete')),
  changed_at TEXT NOT NULL,
  last_error TEXT,
  PRIMARY KEY (tbl, pk)
);
CREATE TABLE IF NOT EXISTS sync_inbox (
  doc        TEXT PRIMARY KEY,
  tbl        TEXT NOT NULL,
  pk         TEXT NOT NULL,
  rank       INTEGER NOT NULL,
  payload    TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  device_id  TEXT NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS ix_sync_inbox_rank ON sync_inbox(rank, updated_at);
CREATE TABLE IF NOT EXISTS sync_rejects (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  doc     TEXT NOT NULL,
  tbl     TEXT NOT NULL,
  pk      TEXT NOT NULL,
  reason  TEXT NOT NULL,
  payload TEXT NOT NULL,
  at      TEXT NOT NULL
);`];
  for (const t of SYNC_TABLES) {
    parts.push(`
CREATE TRIGGER IF NOT EXISTS sync_${t.name}_ins AFTER INSERT ON ${t.name} WHEN ${CAPTURE}
BEGIN ${upsertOutbox(t.name, t.pk('NEW'), 'upsert')} END;
CREATE TRIGGER IF NOT EXISTS sync_${t.name}_upd AFTER UPDATE ON ${t.name} WHEN ${CAPTURE}
BEGIN ${upsertOutbox(t.name, t.pk('NEW'), 'upsert')} END;
CREATE TRIGGER IF NOT EXISTS sync_${t.name}_del AFTER DELETE ON ${t.name} WHEN ${CAPTURE}
BEGIN ${upsertOutbox(t.name, t.pk('OLD'), 'delete')} END;`);
  }
  // سطور القيد تُعلِّم قيدها · فالمستند الواحد يحمل القيد وسطوره
  parts.push(`
CREATE TRIGGER IF NOT EXISTS sync_journal_lines_ins AFTER INSERT ON journal_lines WHEN ${CAPTURE}
BEGIN ${upsertOutbox('journal_entries', 'NEW.entry_id', 'upsert')} END;
CREATE TRIGGER IF NOT EXISTS sync_journal_lines_upd AFTER UPDATE ON journal_lines WHEN ${CAPTURE}
BEGIN ${upsertOutbox('journal_entries', 'NEW.entry_id', 'upsert')} END;
CREATE TRIGGER IF NOT EXISTS sync_journal_lines_del AFTER DELETE ON journal_lines WHEN ${CAPTURE}
  AND EXISTS (SELECT 1 FROM journal_entries WHERE id = OLD.entry_id)
BEGIN ${upsertOutbox('journal_entries', 'OLD.entry_id', 'upsert')} END;`);
  return parts.join('\n');
}
