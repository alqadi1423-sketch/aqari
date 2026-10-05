/**
 * مخطط القاعدة · الهجرة رقم 1.
 * جدول لكل كيان، لا لقطة JSON. المبالغ كلها أعداد صحيحة بالهللات.
 * لا عمود رصيد في أي جدول · الأرصدة مشتقة (docs/DESIGN.md §٤).
 */
import { buildSyncMigration } from './syncTables';
import { LEGACY_HANDOVER_TEMPLATE, LEGACY_SEED_SCRIPTS } from './seed';

export const SCHEMA_VERSION = 26;

export const MIGRATION_1 = `
-- ─── جداول النظام ───
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL
);

-- ─── المحاسبة ───
CREATE TABLE accounts (
  code            TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  type            TEXT NOT NULL CHECK (type IN ('أصل','خصم','حقوق ملكية','إيراد','مصروف')),
  grp             TEXT,
  opening_halalas INTEGER NOT NULL DEFAULT 0,
  is_system       INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  deleted_at      TEXT
);

CREATE TABLE journal_entries (
  id          TEXT PRIMARY KEY,
  no          TEXT NOT NULL UNIQUE,
  date        TEXT NOT NULL,
  memo        TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'قيد الإنشاء' CHECK (status IN ('قيد الإنشاء','مرحّل')),
  auto        INTEGER NOT NULL DEFAULT 0,
  src_type    TEXT,
  src_id      TEXT,
  reversed_by TEXT REFERENCES journal_entries(id),
  created_at  TEXT NOT NULL,
  deleted_at  TEXT
);
CREATE INDEX ix_je_date ON journal_entries(date);
CREATE INDEX ix_je_src ON journal_entries(src_type, src_id);

CREATE TABLE journal_lines (
  id             TEXT PRIMARY KEY,
  entry_id       TEXT NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
  account_code   TEXT NOT NULL REFERENCES accounts(code),
  descr          TEXT NOT NULL DEFAULT '',
  debit_halalas  INTEGER NOT NULL DEFAULT 0 CHECK (debit_halalas  >= 0),
  credit_halalas INTEGER NOT NULL DEFAULT 0 CHECK (credit_halalas >= 0),
  CHECK (NOT (debit_halalas > 0 AND credit_halalas > 0))
);
CREATE INDEX ix_jl_entry ON journal_lines(entry_id);
CREATE INDEX ix_jl_account ON journal_lines(account_code);

-- قيد غير متوازن يُرفض · بمحفّز في القاعدة لا في الكود فقط
CREATE TRIGGER trg_je_post_balanced
BEFORE UPDATE OF status ON journal_entries
WHEN NEW.status = 'مرحّل' AND OLD.status != 'مرحّل'
BEGIN
  SELECT CASE
    WHEN (SELECT COUNT(*) FROM journal_lines WHERE entry_id = NEW.id) = 0
      THEN RAISE(ABORT, 'قيد بلا سطور')
    WHEN (SELECT COALESCE(SUM(debit_halalas - credit_halalas),0)
          FROM journal_lines WHERE entry_id = NEW.id) != 0
      THEN RAISE(ABORT, 'قيد غير متوازن')
  END;
END;

-- سطور القيد المرحّل مجمّدة
CREATE TRIGGER trg_jl_frozen_ins
BEFORE INSERT ON journal_lines
WHEN (SELECT status FROM journal_entries WHERE id = NEW.entry_id) = 'مرحّل'
BEGIN SELECT RAISE(ABORT, 'قيد مرحّل لا يُعدَّل'); END;

CREATE TRIGGER trg_jl_frozen_upd
BEFORE UPDATE ON journal_lines
WHEN (SELECT status FROM journal_entries WHERE id = OLD.entry_id) = 'مرحّل'
BEGIN SELECT RAISE(ABORT, 'قيد مرحّل لا يُعدَّل'); END;

CREATE TRIGGER trg_jl_frozen_del
BEFORE DELETE ON journal_lines
WHEN (SELECT status FROM journal_entries WHERE id = OLD.entry_id) = 'مرحّل'
  AND (SELECT deleted_at FROM journal_entries WHERE id = OLD.entry_id) IS NULL
BEGIN SELECT RAISE(ABORT, 'قيد مرحّل لا يُعدَّل'); END;

-- ─── الأطراف ───
CREATE TABLE tenants (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  vat            TEXT NOT NULL DEFAULT '',
  phone          TEXT NOT NULL DEFAULT '',
  credit_halalas INTEGER NOT NULL DEFAULT 0,
  archived       INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL,
  deleted_at     TEXT
);

CREATE TABLE suppliers (
  id                     TEXT PRIMARY KEY,
  name                   TEXT NOT NULL,
  vat                    TEXT NOT NULL DEFAULT '',
  phone                  TEXT NOT NULL DEFAULT '',
  category               TEXT NOT NULL DEFAULT '',
  default_category       TEXT NOT NULL DEFAULT '',
  default_amount_halalas INTEGER,
  utility_type           TEXT NOT NULL DEFAULT '' CHECK (utility_type IN ('','كهرباء','ماء')),
  archived               INTEGER NOT NULL DEFAULT 0,
  created_at             TEXT NOT NULL,
  deleted_at             TEXT
);

-- ─── العقارات والوحدات ───
CREATE TABLE properties (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  address             TEXT NOT NULL DEFAULT '',
  floors              INTEGER,
  activity_type       TEXT NOT NULL DEFAULT '',
  activity_subtype    TEXT NOT NULL DEFAULT '',
  ownership           TEXT NOT NULL DEFAULT 'ملك' CHECK (ownership IN ('ملك','إيجار','تشغيل')),
  deed_no             TEXT NOT NULL DEFAULT '',
  lease_value_halalas INTEGER,
  lease_cycle         TEXT,
  lease_start         TEXT,
  lease_end           TEXT,
  op_rate             REAL,
  lat                 REAL,
  lng                 REAL,
  created_at          TEXT NOT NULL,
  deleted_at          TEXT
);

CREATE TABLE property_floor_categories (
  property_id TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  floor_label TEXT NOT NULL,
  category    TEXT NOT NULL,
  PRIMARY KEY (property_id, floor_label)
);

CREATE TABLE property_areas (
  id          TEXT PRIMARY KEY,
  property_id TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  area_name   TEXT NOT NULL,
  sort        INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE property_area_items (
  id      TEXT PRIMARY KEY,
  area_id TEXT NOT NULL REFERENCES property_areas(id) ON DELETE CASCADE,
  name    TEXT NOT NULL,
  descr   TEXT NOT NULL DEFAULT '',
  sort    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE units (
  id                   TEXT PRIMARY KEY,
  property_id          TEXT NOT NULL REFERENCES properties(id),
  unit_no              TEXT NOT NULL,
  floor                TEXT NOT NULL DEFAULT '',
  type                 TEXT NOT NULL DEFAULT 'سكني',
  subtype              TEXT NOT NULL DEFAULT '',
  rent_monthly_halalas INTEGER NOT NULL DEFAULT 0,
  under_maintenance    INTEGER NOT NULL DEFAULT 0,
  created_at           TEXT NOT NULL,
  deleted_at           TEXT
);
CREATE UNIQUE INDEX ux_units_no ON units(property_id, unit_no) WHERE deleted_at IS NULL;

CREATE TABLE unit_rooms (
  id        TEXT PRIMARY KEY,
  unit_id   TEXT NOT NULL REFERENCES units(id) ON DELETE CASCADE,
  room_name TEXT NOT NULL,
  sort      INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE unit_room_items (
  id      TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES unit_rooms(id) ON DELETE CASCADE,
  name    TEXT NOT NULL,
  descr   TEXT NOT NULL DEFAULT '',
  sort    INTEGER NOT NULL DEFAULT 0
);

-- ─── العدادات ───
CREATE TABLE meters (
  id          TEXT PRIMARY KEY,
  owner_type  TEXT NOT NULL CHECK (owner_type IN ('property','unit')),
  owner_id    TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('كهرباء','ماء','إنترنت')),
  number      TEXT NOT NULL,
  supplier_id TEXT REFERENCES suppliers(id),
  deleted_at  TEXT
);
CREATE INDEX ix_meters_owner ON meters(owner_type, owner_id);
CREATE INDEX ix_meters_supplier ON meters(supplier_id);

CREATE TABLE meter_readings (
  id             TEXT PRIMARY KEY,
  meter_id       TEXT NOT NULL REFERENCES meters(id) ON DELETE CASCADE,
  date           TEXT NOT NULL,
  reading        REAL,
  amount_halalas INTEGER NOT NULL DEFAULT 0,
  ref            TEXT NOT NULL DEFAULT ''
);

-- ─── العقود ───
CREATE TABLE contracts (
  id                        TEXT PRIMARY KEY,
  contract_no               TEXT UNIQUE,
  tenant_name               TEXT NOT NULL,
  phone                     TEXT NOT NULL DEFAULT '',
  id_number                 TEXT NOT NULL DEFAULT '',
  unit_id                   TEXT NOT NULL REFERENCES units(id),
  unit_label                TEXT NOT NULL DEFAULT '',
  unit_type                 TEXT,
  value_halalas             INTEGER NOT NULL DEFAULT 0,
  cycle                     TEXT NOT NULL DEFAULT 'شهرية' CHECK (cycle IN ('شهرية','ربع سنوية','نصف سنوية','سنوية')),
  start                     TEXT,
  end                       TEXT,
  deposit_halalas           INTEGER NOT NULL DEFAULT 0,
  ejar_no                   TEXT NOT NULL DEFAULT '',
  services                  TEXT NOT NULL DEFAULT '',
  furnished                 TEXT NOT NULL DEFAULT 'غير مؤثثة',
  type_specific             TEXT NOT NULL DEFAULT '{}',
  status                    TEXT NOT NULL DEFAULT 'مسودة' CHECK (status IN ('مسودة','سارٍ','منتهٍ','ملغى')),
  cancel_date               TEXT,
  cancel_reason             TEXT,
  cancel_deduction_halalas  INTEGER,
  cancel_refund_halalas     INTEGER,
  cancel_deduction_reason   TEXT,
  renewed_from              TEXT,
  renewed_to                TEXT,
  renew_count               INTEGER NOT NULL DEFAULT 0,
  renew_note                TEXT,
  archived                  INTEGER NOT NULL DEFAULT 0,
  created_at                TEXT NOT NULL,
  deleted_at                TEXT
);
CREATE INDEX ix_contracts_unit ON contracts(unit_id);
CREATE INDEX ix_contracts_status ON contracts(status);

CREATE TABLE contract_installments (
  id              TEXT PRIMARY KEY,
  contract_id     TEXT NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  due_date        TEXT NOT NULL,
  amount_halalas  INTEGER NOT NULL,
  paid_halalas    INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'مستحقة'
                  CHECK (status IN ('مستحقة','متأخرة','مدفوعة','مدفوعة جزئياً','ملغية')),
  notes           TEXT NOT NULL DEFAULT '',
  sort            INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX ix_inst_contract ON contract_installments(contract_id);
CREATE INDEX ix_inst_due ON contract_installments(due_date);

CREATE TABLE contract_payments (
  id               TEXT PRIMARY KEY,
  contract_id      TEXT NOT NULL REFERENCES contracts(id),
  installment_id   TEXT REFERENCES contract_installments(id),
  period           TEXT NOT NULL DEFAULT '',
  date             TEXT NOT NULL,
  gross_halalas    INTEGER NOT NULL,
  discount_halalas INTEGER NOT NULL DEFAULT 0,
  net_halalas      INTEGER NOT NULL,
  method_label     TEXT NOT NULL DEFAULT '',
  notes            TEXT NOT NULL DEFAULT '',
  journal_entry_id TEXT REFERENCES journal_entries(id),
  created_at       TEXT NOT NULL
);
CREATE INDEX ix_pay_contract ON contract_payments(contract_id);

CREATE TABLE payment_lines (
  id             TEXT PRIMARY KEY,
  payment_id     TEXT NOT NULL REFERENCES contract_payments(id) ON DELETE CASCADE,
  method         TEXT NOT NULL CHECK (method IN ('bank','cash')),
  bank_id        TEXT REFERENCES banks(id),
  amount_halalas INTEGER NOT NULL
);

CREATE TABLE contract_occupants (
  id          TEXT PRIMARY KEY,
  contract_id TEXT NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  id_number   TEXT NOT NULL DEFAULT '',
  dob         TEXT,
  phone       TEXT NOT NULL DEFAULT '',
  sort        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE deposit_settlements (
  contract_id       TEXT PRIMARY KEY REFERENCES contracts(id),
  date              TEXT NOT NULL,
  deduction_halalas INTEGER NOT NULL DEFAULT 0,
  deduction_reason  TEXT NOT NULL DEFAULT '',
  refund_halalas    INTEGER NOT NULL DEFAULT 0,
  notes             TEXT NOT NULL DEFAULT ''
);

CREATE TABLE tenant_ratings (
  contract_id         TEXT PRIMARY KEY REFERENCES contracts(id),
  on_time             TEXT,
  payment_commit      TEXT,
  contract_commit     TEXT,
  unit_condition      TEXT,
  neighbor_complaints TEXT,
  notes               TEXT NOT NULL DEFAULT '',
  rated_at            TEXT
);

-- ─── الحجوزات والمطالبات والتقبيل ───
CREATE TABLE reservations (
  id                    TEXT PRIMARY KEY,
  unit_id               TEXT NOT NULL REFERENCES units(id),
  name                  TEXT NOT NULL,
  phone                 TEXT NOT NULL DEFAULT '',
  deposit_halalas       INTEGER NOT NULL DEFAULT 0,
  expiry_date           TEXT NOT NULL,
  created_date          TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'نشط' CHECK (status IN ('نشط','منتهي','محوَّل لعقد')),
  converted_contract_id TEXT,
  deleted_at            TEXT
);
CREATE INDEX ix_resv_unit ON reservations(unit_id);

CREATE TABLE claims (
  id              TEXT PRIMARY KEY,
  contract_id     TEXT NOT NULL REFERENCES contracts(id),
  amount_halalas  INTEGER NOT NULL,
  reason          TEXT NOT NULL DEFAULT '',
  date            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'مفتوحة' CHECK (status IN ('مفتوحة','محصَّلة')),
  source          TEXT NOT NULL DEFAULT 'يدوية' CHECK (source IN ('يدوية','تسوية تأمين')),
  collected_at    TEXT,
  created_at      TEXT NOT NULL,
  deleted_at      TEXT
);

CREATE TABLE key_money_deals (
  id                  TEXT PRIMARY KEY,
  unit_id             TEXT NOT NULL REFERENCES units(id),
  contract_id         TEXT,
  outgoing            TEXT NOT NULL,
  incoming            TEXT NOT NULL,
  amount_halalas      INTEGER NOT NULL,
  date                TEXT NOT NULL,
  commission_halalas  INTEGER NOT NULL DEFAULT 0,
  method              TEXT,
  notes               TEXT NOT NULL DEFAULT '',
  journal_entry_id    TEXT,
  created_at          TEXT NOT NULL,
  deleted_at          TEXT
);

-- ─── الفواتير والمشتريات والبنوك ───
CREATE TABLE invoices (
  id               TEXT PRIMARY KEY,
  no               TEXT NOT NULL UNIQUE,
  customer_name    TEXT NOT NULL,
  customer_vat     TEXT NOT NULL DEFAULT '',
  issue            TEXT NOT NULL,
  due              TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('مسودة','مستحقة','مدفوعة','متأخرة')),
  subtotal_halalas INTEGER NOT NULL,
  tax_halalas      INTEGER NOT NULL DEFAULT 0,
  total_halalas    INTEGER NOT NULL,
  notes            TEXT NOT NULL DEFAULT '',
  unit_id          TEXT,
  property_id      TEXT,
  journal_entry_id TEXT REFERENCES journal_entries(id),
  created_at       TEXT NOT NULL,
  deleted_at       TEXT
);

CREATE TABLE invoice_lines (
  id             TEXT PRIMARY KEY,
  invoice_id     TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  descr          TEXT NOT NULL DEFAULT '',
  qty            REAL NOT NULL DEFAULT 1,
  price_halalas  INTEGER NOT NULL DEFAULT 0,
  tax_pct        INTEGER NOT NULL DEFAULT 15,
  sort           INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE purchases (
  id                       TEXT PRIMARY KEY,
  no                       TEXT NOT NULL UNIQUE,
  supplier_name            TEXT NOT NULL,
  date                     TEXT NOT NULL,
  due                      TEXT NOT NULL DEFAULT '',
  category                 TEXT NOT NULL DEFAULT '',
  incorp_item              TEXT NOT NULL DEFAULT '',
  amortize                 INTEGER NOT NULL DEFAULT 0,
  amortize_months          INTEGER,
  exempt                   INTEGER NOT NULL DEFAULT 0,
  exclude_from_vat         INTEGER NOT NULL DEFAULT 0,
  unit_id                  TEXT,
  property_id              TEXT,
  subtotal_halalas         INTEGER NOT NULL,
  tax_halalas              INTEGER NOT NULL DEFAULT 0,
  total_halalas            INTEGER NOT NULL,
  paid                     INTEGER NOT NULL DEFAULT 0,
  paid_date                TEXT,
  payment_method           TEXT,
  payment_bank_id          TEXT,
  journal_entry_id         TEXT,
  payment_journal_entry_id TEXT,
  meter_id                 TEXT,
  meter_reading            REAL,
  created_at               TEXT NOT NULL,
  deleted_at               TEXT
);

CREATE TABLE banks (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  iban            TEXT NOT NULL DEFAULT '',
  opening_halalas INTEGER NOT NULL DEFAULT 0,
  opening_date    TEXT,
  created_at      TEXT NOT NULL,
  deleted_at      TEXT
);

CREATE TABLE bank_tx (
  id             TEXT PRIMARY KEY,
  bank_id        TEXT NOT NULL REFERENCES banks(id),
  date           TEXT NOT NULL,
  descr          TEXT NOT NULL,
  amount_halalas INTEGER NOT NULL,
  matched        INTEGER NOT NULL DEFAULT 0,
  journal_no     TEXT NOT NULL DEFAULT '',
  source         TEXT NOT NULL DEFAULT '',
  created_at     TEXT NOT NULL,
  deleted_at     TEXT
);
CREATE INDEX ix_banktx_bank ON bank_tx(bank_id);

-- ─── الرسائل والمنشأة والنماذج ───
CREATE TABLE message_scripts (
  id         TEXT PRIMARY KEY,
  audience   TEXT NOT NULL,
  category   TEXT NOT NULL DEFAULT 'عام',
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE company (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  name        TEXT NOT NULL DEFAULT '',
  vatno       TEXT NOT NULL DEFAULT '',
  cr          TEXT NOT NULL DEFAULT '',
  phone       TEXT NOT NULL DEFAULT '',
  address     TEXT NOT NULL DEFAULT '',
  cr_exp      TEXT,
  vat_enabled INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE company_docs (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  expiry     TEXT,
  created_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE form_templates (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  is_system     INTEGER NOT NULL DEFAULT 0,
  sections_json TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  deleted_at    TEXT
);

CREATE TABLE handovers (
  id              TEXT PRIMARY KEY,
  contract_id     TEXT,
  unit_id         TEXT,
  type            TEXT NOT NULL CHECK (type IN ('استلام','تسليم')),
  employee_name   TEXT NOT NULL DEFAULT '',
  tenant_name     TEXT NOT NULL,
  id_number       TEXT NOT NULL DEFAULT '',
  phone           TEXT NOT NULL DEFAULT '',
  address         TEXT NOT NULL DEFAULT '',
  unit_floor      TEXT NOT NULL DEFAULT '',
  contract_period TEXT NOT NULL DEFAULT '',
  date            TEXT NOT NULL,
  other_notes     TEXT NOT NULL DEFAULT '',
  tenant_sign     TEXT NOT NULL DEFAULT '',
  company_sign    TEXT NOT NULL DEFAULT '',
  sections_json   TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  deleted_at      TEXT
);

-- ─── سجل العمليات (append-only) ───
CREATE TABLE audit_log (
  id          TEXT PRIMARY KEY,
  ts          TEXT NOT NULL,
  user_name   TEXT NOT NULL DEFAULT 'مستخدم',
  module      TEXT NOT NULL,
  action_type TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_name TEXT NOT NULL,
  before_json TEXT,
  after_json  TEXT
);
CREATE TRIGGER trg_audit_no_upd BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'سجل العمليات غير قابل للتعديل'); END;
CREATE TRIGGER trg_audit_no_del BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'سجل العمليات غير قابل للتعديل'); END;

-- ─── الملفات: معنونة بالمحتوى ───
CREATE TABLE blobs (
  sha256     TEXT PRIMARY KEY,
  ext        TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE attachments (
  id            TEXT PRIMARY KEY,
  sha256        TEXT NOT NULL REFERENCES blobs(sha256),
  entity_type   TEXT NOT NULL,
  entity_id     TEXT NOT NULL DEFAULT '',
  kind          TEXT NOT NULL,
  original_name TEXT NOT NULL DEFAULT '',
  mime          TEXT NOT NULL DEFAULT '',
  note          TEXT NOT NULL DEFAULT '',
  display_name  TEXT NOT NULL DEFAULT '',
  cat_override  TEXT,
  created_at    TEXT NOT NULL,
  deleted_at    TEXT
);
CREATE INDEX ix_att_entity ON attachments(entity_type, entity_id);
CREATE INDEX ix_att_sha ON attachments(sha256);

-- ─── التنبيهات المجدولة ───
CREATE TABLE scheduled_notifications (
  id        TEXT PRIMARY KEY,
  kind      TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  fire_at   TEXT NOT NULL,
  os_id     TEXT NOT NULL
);
`;

/**
 * الهجرة 2:
 * - المسودة بلا وحدة: unit_id يقبل NULL (إعادة بناء جدول العقود لأن SQLite لا يعدّل NOT NULL)
 * - نموذج الاستلام والتسليم: واحد لكل عقد، بحالة قفل · بعد الإقفال لا يُعدَّل
 */
export const MIGRATION_2 = `
CREATE TABLE contracts_new (
  id                        TEXT PRIMARY KEY,
  contract_no               TEXT UNIQUE,
  tenant_name               TEXT NOT NULL,
  phone                     TEXT NOT NULL DEFAULT '',
  id_number                 TEXT NOT NULL DEFAULT '',
  unit_id                   TEXT REFERENCES units(id),
  unit_label                TEXT NOT NULL DEFAULT '',
  unit_type                 TEXT,
  value_halalas             INTEGER NOT NULL DEFAULT 0,
  cycle                     TEXT NOT NULL DEFAULT 'شهرية' CHECK (cycle IN ('شهرية','ربع سنوية','نصف سنوية','سنوية')),
  start                     TEXT,
  end                       TEXT,
  deposit_halalas           INTEGER NOT NULL DEFAULT 0,
  ejar_no                   TEXT NOT NULL DEFAULT '',
  services                  TEXT NOT NULL DEFAULT '',
  furnished                 TEXT NOT NULL DEFAULT 'غير مؤثثة',
  type_specific             TEXT NOT NULL DEFAULT '{}',
  status                    TEXT NOT NULL DEFAULT 'مسودة' CHECK (status IN ('مسودة','سارٍ','منتهٍ','ملغى')),
  cancel_date               TEXT,
  cancel_reason             TEXT,
  cancel_deduction_halalas  INTEGER,
  cancel_refund_halalas     INTEGER,
  cancel_deduction_reason   TEXT,
  renewed_from              TEXT,
  renewed_to                TEXT,
  renew_count               INTEGER NOT NULL DEFAULT 0,
  renew_note                TEXT,
  archived                  INTEGER NOT NULL DEFAULT 0,
  created_at                TEXT NOT NULL,
  deleted_at                TEXT
);
INSERT INTO contracts_new SELECT * FROM contracts;
DROP TABLE contracts;
ALTER TABLE contracts_new RENAME TO contracts;
CREATE INDEX ix_contracts_unit ON contracts(unit_id);
CREATE INDEX ix_contracts_status ON contracts(status);

ALTER TABLE handovers ADD COLUMN locked INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX ux_handover_contract ON handovers(contract_id)
  WHERE contract_id IS NOT NULL AND deleted_at IS NULL;
`;

/** فهارس الأداء المكمّلة · للجداول التي تنمو مع الاستعمال الكثيف */
export const MIGRATION_3 = `
CREATE INDEX IF NOT EXISTS ix_units_property ON units(property_id);
CREATE INDEX IF NOT EXISTS ix_unit_rooms_unit ON unit_rooms(unit_id);
CREATE INDEX IF NOT EXISTS ix_room_items_room ON unit_room_items(room_id);
CREATE INDEX IF NOT EXISTS ix_areas_property ON property_areas(property_id);
CREATE INDEX IF NOT EXISTS ix_area_items_area ON property_area_items(area_id);
CREATE INDEX IF NOT EXISTS ix_purchases_unit ON purchases(unit_id);
CREATE INDEX IF NOT EXISTS ix_purchases_property ON purchases(property_id);
CREATE INDEX IF NOT EXISTS ix_purchases_date ON purchases(date);
CREATE INDEX IF NOT EXISTS ix_audit_ts ON audit_log(ts);
CREATE INDEX IF NOT EXISTS ix_pay_date ON contract_payments(date);
CREATE INDEX IF NOT EXISTS ix_handovers_contract ON handovers(contract_id);
CREATE INDEX IF NOT EXISTS ix_handovers_unit ON handovers(unit_id);
CREATE INDEX IF NOT EXISTS ix_claims_contract ON claims(contract_id);
CREATE INDEX IF NOT EXISTS ix_contracts_dates ON contracts(start, end);
CREATE INDEX IF NOT EXISTS ix_att_created ON attachments(created_at);
`;

/**
 * جهة قبض التأمين: المكتب (نقدية) · منصة إيجار (أصل محتجز لدى الغير) · طرف آخر (بيان بلا قيد)
 */
export const MIGRATION_4 = `
ALTER TABLE contracts ADD COLUMN deposit_holder TEXT NOT NULL DEFAULT 'المكتب';
ALTER TABLE contracts ADD COLUMN deposit_holder_name TEXT NOT NULL DEFAULT '';
INSERT OR IGNORE INTO accounts (code, name, type, grp, opening_halalas, is_system, created_at)
VALUES ('1260', 'تأمينات محتجزة لدى الغير', 'أصل', 'أصول متداولة', 0, 1, datetime('now'));
`;

/**
 * مفتاح الترتيب الطبيعي لرقم الوحدة · يُحسب في الكود عند الحفظ وعند الإقلاع للبيانات القائمة
 */
export const MIGRATION_5 = `
ALTER TABLE units ADD COLUMN unit_no_key TEXT;
CREATE INDEX IF NOT EXISTS ix_units_sortkey ON units(property_id, unit_no_key);
`;

/** حساب فروق التقريب: يستوعب فرق الهللة بين مستند المورد وحساب النسبة · فيبقى الدفتر مطابقاً للمستند */
export const MIGRATION_6 = `
INSERT OR IGNORE INTO accounts (code, name, type, grp, opening_halalas, is_system, created_at)
VALUES ('5900', 'فروق تقريب', 'مصروف', NULL, 0, 1, datetime('now'));
`;

/**
 * الوضع الضريبي للفاتورة · المعيار: هل الفاتورة باسم المنشأة وبرقمها الضريبي؟
 * الافتراض «مستبعدة من الإقرار» · الاستبعاد آمن والإدراج الخاطئ مخالفة.
 * حساب 1270 ضريبة مدخلات قابلة للاسترداد (طلب المالك 1260 لكنه مشغول بمحتجزات لدى الغير · أُفصح عنه).
 * وفهارس مركّبة للمسارات الساخنة.
 */
export const MIGRATION_7 = `
ALTER TABLE purchases ADD COLUMN tax_status TEXT NOT NULL DEFAULT 'مستبعدة من الإقرار';
ALTER TABLE purchases ADD COLUMN exclude_reason TEXT NOT NULL DEFAULT '';
ALTER TABLE purchases ADD COLUMN supplier_vatno TEXT NOT NULL DEFAULT '';
ALTER TABLE purchases ADD COLUMN refund_status TEXT NOT NULL DEFAULT 'لم يُطلب';
ALTER TABLE purchases ADD COLUMN refund_date TEXT;
UPDATE purchases SET tax_status = 'معفاة' WHERE exempt = 1;
UPDATE purchases SET exclude_reason = 'سُجّلت قبل اعتماد المعيار' WHERE exempt = 0;
INSERT OR IGNORE INTO accounts (code, name, type, grp, opening_halalas, is_system, created_at)
VALUES ('1270', 'ضريبة مدخلات قابلة للاسترداد', 'أصل', NULL, 0, 1, datetime('now'));
CREATE INDEX IF NOT EXISTS ix_inst_contract_due ON contract_installments(contract_id, due_date);
CREATE INDEX IF NOT EXISTS ix_contracts_unit_status ON contracts(unit_id, status, "end");
CREATE INDEX IF NOT EXISTS ix_jl_entry_account ON journal_lines(entry_id, account_code);
`;

/**
 * التسميات المهنية للوضع الضريبي (بلغة الهيئة لا الدردشة)،
 * والمستأجر كياناً: هوية وطنية فريدة في tenants وربط contracts.tenant_id ·
 * الربط الفعلي يجري في كود الإقلاع (backfillTenantLinks) لأنه يحتاج توليد معرفات.
 */
export const MIGRATION_8 = `
UPDATE purchases SET tax_status = 'فاتورة ضريبية · قابلة للخصم' WHERE tax_status = 'خاضعة باسمنا';
UPDATE purchases SET tax_status = 'غير قابلة للخصم' WHERE tax_status = 'مستبعدة من الإقرار';
UPDATE purchases SET tax_status = 'معفاة من الضريبة' WHERE tax_status = 'معفاة';
UPDATE purchases SET tax_status = 'خاضعة بنسبة صفرية' WHERE tax_status = 'خاضعة صفرية';
ALTER TABLE tenants ADD COLUMN national_id TEXT NOT NULL DEFAULT '';
ALTER TABLE tenants ADD COLUMN email TEXT NOT NULL DEFAULT '';
ALTER TABLE tenants ADD COLUMN notes TEXT NOT NULL DEFAULT '';
CREATE UNIQUE INDEX IF NOT EXISTS ux_tenants_national_id ON tenants(national_id) WHERE national_id != '' AND deleted_at IS NULL;
ALTER TABLE contracts ADD COLUMN tenant_id TEXT REFERENCES tenants(id);
CREATE INDEX IF NOT EXISTS ix_contracts_tenant ON contracts(tenant_id);
`;

/** الشرطة الطويلة لا تدخل واجهة عربية: القيمة المخزَّنة تتبع القاعدة */
export const MIGRATION_9 = `
UPDATE purchases SET tax_status = 'فاتورة ضريبية · قابلة للخصم'
WHERE tax_status LIKE 'فاتورة ضريبية %قابلة للخصم' AND tax_status != 'فاتورة ضريبية · قابلة للخصم';
`;

/**
 * التحصيل الجماعي: دفعة واحدة تُوزَّع على أقساط بترتيب استحقاقها (payment_allocations)
 * والفائض رصيد دائن للمستأجر (حساب 2410). وساكنو الوحدة سجلٌّ كامل بتواريخ سكن ومغادرة.
 */
export const MIGRATION_10 = `
CREATE TABLE IF NOT EXISTS payment_allocations (
  id              TEXT PRIMARY KEY,
  payment_id      TEXT NOT NULL REFERENCES contract_payments(id) ON DELETE CASCADE,
  installment_id  TEXT NOT NULL REFERENCES contract_installments(id),
  amount_halalas  INTEGER NOT NULL CHECK (amount_halalas > 0)
);
CREATE INDEX IF NOT EXISTS ix_alloc_payment ON payment_allocations(payment_id);
CREATE INDEX IF NOT EXISTS ix_alloc_installment ON payment_allocations(installment_id);
CREATE TABLE IF NOT EXISTS occupants (
  id           TEXT PRIMARY KEY,
  contract_id  TEXT NOT NULL REFERENCES contracts(id),
  unit_id      TEXT REFERENCES units(id),
  name         TEXT NOT NULL,
  national_id  TEXT NOT NULL DEFAULT '',
  phone        TEXT NOT NULL DEFAULT '',
  relation     TEXT NOT NULL DEFAULT 'نفسه',
  nationality  TEXT NOT NULL DEFAULT '',
  moved_in     TEXT,
  moved_out    TEXT,
  created_at   TEXT NOT NULL,
  deleted_at   TEXT
);
CREATE INDEX IF NOT EXISTS ix_occupants_contract ON occupants(contract_id);
CREATE INDEX IF NOT EXISTS ix_occupants_unit ON occupants(unit_id);
INSERT OR IGNORE INTO accounts (code, name, type, grp, opening_halalas, is_system, created_at)
VALUES ('2410', 'أرصدة مستأجرين دائنة', 'خصم', NULL, 0, 1, datetime('now'));
INSERT INTO occupants (id, contract_id, unit_id, name, national_id, phone, relation, moved_in, created_at)
SELECT co.id, co.contract_id, c.unit_id, co.name, co.id_number, co.phone, 'أخرى', c.start, datetime('now')
FROM contract_occupants co JOIN contracts c ON c.id = co.contract_id
WHERE co.id NOT IN (SELECT id FROM occupants);
`;

/**
 * توحيد المفردات المخزّنة:
 * التأثيث: كانت شاشة الإنشاء تكتب «مفروشة جزئياً» وشاشة التجديد «مؤثثة جزئياً» فتنشقّ البيانات.
 * الضريبة: افتراضي العمود القديم «مستبعدة من الإقرار» يظل في تعريف الجدول، فأي صف
 * أُدرج دون قيمة صريحة يحمل مفردة لا يعرفها الإقرار · يُطبَّع هنا (تكرارها آمن).
 */
export const MIGRATION_11 = `
UPDATE contracts SET furnished = 'مؤثثة جزئياً' WHERE furnished = 'مفروشة جزئياً';
UPDATE purchases SET tax_status = 'غير قابلة للخصم' WHERE tax_status = 'مستبعدة من الإقرار';
UPDATE purchases SET tax_status = 'معفاة من الضريبة' WHERE tax_status = 'معفاة';
`;

/**
 * «لا يُحذف شيء مرتبط بغيره»: العقار والوحدة يُؤرشفان بدل الحذف حين يرتبط بهما غيرهما.
 * المؤرشف يختفي من قوائم الاختيار ويبقى في الدفتر والتقارير · الميزان لا يتغيّر فيه رقم.
 */
export const MIGRATION_12 = `
ALTER TABLE properties ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
ALTER TABLE units ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
ALTER TABLE banks ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
CREATE TRIGGER IF NOT EXISTS trg_je_frozen_del
BEFORE DELETE ON journal_entries
WHEN OLD.status = 'مرحّل' AND OLD.deleted_at IS NULL
BEGIN SELECT RAISE(ABORT, 'قيد مرحّل لا يُحذف · يُعكس'); END;
`;

/** فهرس فواتير العداد · استعلامات كشف العداد تقفز به من مسح كامل إلى قفزة فهرس */
export const MIGRATION_13 = `
CREATE INDEX IF NOT EXISTS ix_purchases_meter ON purchases(meter_id);
`;

/**
 * موعد سداد متفق عليه ومهلة للقسط: agreed_date يحلّ محل الاستحقاق في الحالة والفرز،
 * وgrace_until يمنع احتسابه متأخراً قبلها · وحساب 1265 «محفظة إيجار» لما صار ملكنا
 * بعد التسوية ولم يُسحب من محفظة المنصة.
 */
export const MIGRATION_14 = `
ALTER TABLE contract_installments ADD COLUMN agreed_date TEXT;
ALTER TABLE contract_installments ADD COLUMN grace_until TEXT;
ALTER TABLE deposit_settlements ADD COLUMN deduct_destination TEXT NOT NULL DEFAULT '';
INSERT OR IGNORE INTO accounts (code, name, type, grp, opening_halalas, is_system, created_at)
VALUES ('1265', 'محفظة إيجار', 'أصل', NULL, 0, 1, datetime('now'));
`;

/**
 * كل نص يُرسَل قالبٌ من قاعدة البيانات لا من الكود: التذكير الافتراضي يُزرع قالباً
 * قابلاً للتعديل من الإعدادات · برموزه التي تتعبأ من بيانات القسط.
 */
export const MIGRATION_15 = `
INSERT OR IGNORE INTO message_scripts (id, audience, category, title, body, created_at)
VALUES ('ms-reminder-default', 'مستأجرون', 'تذكير', 'تذكير بالدفعة',
'السلام عليكم {الاسم}، نذكّركم بدفعة الإيجار المستحقة بتاريخ {تاريخ الاستحقاق} بمبلغ {المبلغ} عن وحدة {الوحدة}. شاكرين تعاونكم.',
datetime('now'));
`;

/**
 * صف المنشأة قد يغيب في قاعدة بُذرت بنسخة قديمة (البذر يجري مرة واحدة بحارس
 * seeded) فتنهار شاشة بيانات المنشأة على قراءة صف غير موجود ويضيع حفظها ·
 * الترحيل يضمن وجوده أينما كان أصل القاعدة.
 */
export const MIGRATION_16 = `
INSERT OR IGNORE INTO company (id) VALUES (1);
`;

/**
 * إقفال الدفتر والأقساط في القاعدة نفسها · فلا يمرّ خلل من أي مسار كتابة:
 * الخدمات والإدراج المباشر والمزامنة والاستيراد سواء.
 *
 * ١) القيد المرحّل غير المتوازن يُرفض حتى لو أُدرج بحالة «مرحّل» مباشرة (INSERT لا UPDATE وحده).
 * ٢) القيد المرحّل لا يدخل السلة ولا يُحذف ولا تتغيّر حالته · الإلغاء بقيد عكسي فقط،
 *    وسطوره لا تُحذف ولو كان في السلة من إصدار سابق.
 * ٣) المسدَّد على القسط مع مجموع خصومه لا يتجاوز مبلغه، ولا مسدَّد ولا خصم ولا صافي سالب:
 *    على إدراج الدفعة وتعديلها، وعلى إدراج القسط وتعديل مسدَّده أو مبلغه ·
 *    ومعها فهرس الدفعات بالقسط الذي تقرأ به المحفّزات.
 */
export const MIGRATION_17 = `
CREATE TRIGGER IF NOT EXISTS trg_je_insert_balanced
BEFORE INSERT ON journal_entries
WHEN NEW.status = 'مرحّل'
BEGIN
  SELECT CASE
    WHEN (SELECT COUNT(*) FROM journal_lines WHERE entry_id = NEW.id) = 0
      THEN RAISE(ABORT, 'قيد بلا سطور')
    WHEN (SELECT COALESCE(SUM(debit_halalas - credit_halalas),0)
          FROM journal_lines WHERE entry_id = NEW.id) != 0
      THEN RAISE(ABORT, 'قيد غير متوازن')
  END;
END;

CREATE TRIGGER IF NOT EXISTS trg_je_posted_no_trash
BEFORE UPDATE OF deleted_at ON journal_entries
WHEN OLD.status = 'مرحّل' AND OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'قيد مرحّل لا يدخل السلة · يُلغى بقيد عكسي'); END;

CREATE TRIGGER IF NOT EXISTS trg_je_posted_status
BEFORE UPDATE OF status ON journal_entries
WHEN OLD.status = 'مرحّل' AND NEW.status != 'مرحّل'
BEGIN SELECT RAISE(ABORT, 'قيد مرحّل لا تتغيّر حالته · يُلغى بقيد عكسي'); END;

DROP TRIGGER IF EXISTS trg_je_frozen_del;
CREATE TRIGGER trg_je_frozen_del
BEFORE DELETE ON journal_entries
WHEN OLD.status = 'مرحّل'
BEGIN SELECT RAISE(ABORT, 'قيد مرحّل لا يُحذف · يُلغى بقيد عكسي'); END;

DROP TRIGGER IF EXISTS trg_jl_frozen_del;
CREATE TRIGGER trg_jl_frozen_del
BEFORE DELETE ON journal_lines
WHEN (SELECT status FROM journal_entries WHERE id = OLD.entry_id) = 'مرحّل'
BEGIN SELECT RAISE(ABORT, 'قيد مرحّل لا يُعدَّل'); END;

-- المحفّزات أدناه تجمع خصوم القسط في كل كتابة · والفهرس يجعل الجمع قفزةً لا مسحاً للدفعات كلها
CREATE INDEX IF NOT EXISTS ix_pay_installment ON contract_payments(installment_id);

-- الدفعة لا تتجاوز مبلغ القسط وحدها · وخصمها مع المسدَّد الحالي وخصوم القسط لا يتجاوزه ·
-- وصافيها يُحتسب حين يُحدَّث مسدَّد القسط (المحفّز التالي) لا هنا: فالمزامنة قد تأتي بالقسط
-- ومسدَّده النهائي قبل دفعته، فلا يُحسب الصافي مرتين
CREATE TRIGGER IF NOT EXISTS trg_pay_insert_cap
BEFORE INSERT ON contract_payments
WHEN NEW.installment_id IS NOT NULL
BEGIN
  SELECT CASE
    WHEN NEW.discount_halalas < 0 OR NEW.net_halalas < 0
      THEN RAISE(ABORT, 'دفعة بصافٍ أو خصم سالب')
    WHEN NEW.net_halalas + NEW.discount_halalas
         > (SELECT amount_halalas FROM contract_installments WHERE id = NEW.installment_id)
      THEN RAISE(ABORT, 'الدفعة مع الخصم تتجاوز مبلغ القسط')
    WHEN (SELECT i.paid_halalas + NEW.discount_halalas
                 + COALESCE((SELECT SUM(p.discount_halalas) FROM contract_payments p
                             WHERE p.installment_id = i.id), 0)
          FROM contract_installments i WHERE i.id = NEW.installment_id)
         > (SELECT amount_halalas FROM contract_installments WHERE id = NEW.installment_id)
      THEN RAISE(ABORT, 'الخصم يتجاوز المتبقي على القسط')
  END;
END;

CREATE TRIGGER IF NOT EXISTS trg_pay_update_cap
BEFORE UPDATE OF discount_halalas, net_halalas, installment_id ON contract_payments
WHEN NEW.installment_id IS NOT NULL
BEGIN
  SELECT CASE
    WHEN NEW.discount_halalas < 0 OR NEW.net_halalas < 0
      THEN RAISE(ABORT, 'دفعة بصافٍ أو خصم سالب')
    WHEN (SELECT i.paid_halalas + NEW.discount_halalas
                 + COALESCE((SELECT SUM(p.discount_halalas) FROM contract_payments p
                             WHERE p.installment_id = i.id AND p.id != NEW.id), 0)
          FROM contract_installments i WHERE i.id = NEW.installment_id)
         > (SELECT amount_halalas FROM contract_installments WHERE id = NEW.installment_id)
      THEN RAISE(ABORT, 'الخصم يتجاوز المتبقي على القسط')
  END;
END;

CREATE TRIGGER IF NOT EXISTS trg_inst_insert_cap
BEFORE INSERT ON contract_installments
WHEN NEW.paid_halalas < 0 OR NEW.paid_halalas > NEW.amount_halalas
BEGIN SELECT RAISE(ABORT, 'المسدَّد يتجاوز مبلغ القسط أو سالب'); END;

CREATE TRIGGER IF NOT EXISTS trg_inst_update_cap
BEFORE UPDATE OF paid_halalas, amount_halalas ON contract_installments
BEGIN
  SELECT CASE
    WHEN NEW.paid_halalas < 0
      THEN RAISE(ABORT, 'مسدَّد سالب على القسط')
    WHEN NEW.paid_halalas + COALESCE((SELECT SUM(p.discount_halalas) FROM contract_payments p
                                      WHERE p.installment_id = NEW.id), 0) > NEW.amount_halalas
      THEN RAISE(ABORT, 'المسدَّد مع الخصم يتجاوز مبلغ القسط')
  END;
END;
`;

/** بنية المزامنة: الطابور الصادر والوارد والمرفوض ومحفّزات الالتقاط · انظر syncTables.ts */
export const MIGRATION_18 = buildSyncMigration();

/**
 * الإصدار ١٩ بلا تغيير في البنية · كان يحمل إصلاحاً للبيانات القديمة أُزيل قبل أن يُطبَّق على أي جهاز،
 * وبقي رقمه محجوزاً فتبدأ الترحيلات بعده من ٢٠.
 */
export const MIGRATION_19 = `
-- لا تغيير في البنية
SELECT 1;
`;

/**
 * نوعا الخصم والحارس وسقف القسط بخصم الدفتر:
 * ١) نوع الخصم مع الدفعة: «بعد الاستحقاق» (القسط بقيمته، والإيراد كاملاً، والخصم مصروفاً في 4900 بقيد الدفعة نفسه)
 *    أو «تنزيل من القسط» (القسط نفسه يُخفَّض والإيراد بالمخفَّض ولا سطر خصم). وفارغ في دفعات ما قبله.
 * ٢) حساب 4900 «خصومات ممنوحة» بنوع مصروف · بالرقم والاسم والنوع أينما وُجد فلا يتعارض في المزامنة.
 * ٣) الحارس: دفعة خصمها «بعد الاستحقاق» لا تُحفظ إلا وفي الدفتر سطر 4900 بقيمته، في قيدها نفسه
 *    أو في قيد خصم مربوط بها (ما يُنشأ بأثر رجعي، فالقيد المرحّل لا يُعدَّل).
 * ٤) سقف القسط يقرأ الخصم من الدفتر لا من صفوف الدفعات: محفّزات الهجرة ١٧ الثلاثة التي تجمع الخصم
 *    تُستبدل هنا (ونص ١٧ كما هو)، فخصم «تنزيل من القسط» نزل من مبلغ القسط ولا يُعدّ ثانية.
 *    وخصم الدفعة القديمة الذي لا سطر له في الدفتر يُعدّ بقيمته في صفّها ما لم يكن لعقدها قيود خصم،
 *    حتى يُحدَّد نوعه · ونصّ الحساب نفسه في INSTALLMENT_DISCOUNT_SQL.
 */
export const MIGRATION_20 = `
ALTER TABLE contract_payments ADD COLUMN discount_kind TEXT;

INSERT OR IGNORE INTO accounts (code, name, type, grp, opening_halalas, is_system, created_at)
VALUES ('4900', 'خصومات ممنوحة', 'مصروف', NULL, 0, 1, datetime('now'));

CREATE TRIGGER IF NOT EXISTS trg_pay_discount_kind_ins
BEFORE INSERT ON contract_payments
WHEN NEW.discount_kind IS NOT NULL
BEGIN
  SELECT CASE
    WHEN NEW.discount_kind NOT IN ('بعد الاستحقاق', 'تنزيل من القسط')
      THEN RAISE(ABORT, 'نوع خصم غير معروف')
    WHEN NEW.discount_halalas <= 0
      THEN RAISE(ABORT, 'نوع خصم بلا خصم')
  END;
END;

CREATE TRIGGER IF NOT EXISTS trg_pay_discount_kind_upd
BEFORE UPDATE OF discount_kind, discount_halalas ON contract_payments
WHEN NEW.discount_kind IS NOT NULL
BEGIN
  SELECT CASE
    WHEN NEW.discount_kind NOT IN ('بعد الاستحقاق', 'تنزيل من القسط')
      THEN RAISE(ABORT, 'نوع خصم غير معروف')
    WHEN NEW.discount_halalas <= 0
      THEN RAISE(ABORT, 'نوع خصم بلا خصم')
  END;
END;

CREATE TRIGGER IF NOT EXISTS trg_pay_discount_booked_ins
BEFORE INSERT ON contract_payments
WHEN NEW.discount_kind = 'بعد الاستحقاق'
BEGIN
  SELECT CASE
    WHEN COALESCE((SELECT SUM(l.debit_halalas - l.credit_halalas)
                FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id AND l.account_code = '4900'
                WHERE (e.id = NEW.journal_entry_id OR (e.src_type = 'discount' AND e.src_id = NEW.id))
                  AND e.status = 'مرحّل' AND e.reversed_by IS NULL), 0) != NEW.discount_halalas
      THEN RAISE(ABORT, 'خصم بعد الاستحقاق بلا سطر خصم مساوٍ له في الدفتر')
  END;
END;

CREATE TRIGGER IF NOT EXISTS trg_pay_discount_booked_upd
BEFORE UPDATE OF discount_kind, discount_halalas, journal_entry_id ON contract_payments
WHEN NEW.discount_kind = 'بعد الاستحقاق'
BEGIN
  SELECT CASE
    WHEN COALESCE((SELECT SUM(l.debit_halalas - l.credit_halalas)
                FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id AND l.account_code = '4900'
                WHERE (e.id = NEW.journal_entry_id OR (e.src_type = 'discount' AND e.src_id = NEW.id))
                  AND e.status = 'مرحّل' AND e.reversed_by IS NULL), 0) != NEW.discount_halalas
      THEN RAISE(ABORT, 'خصم بعد الاستحقاق بلا سطر خصم مساوٍ له في الدفتر')
  END;
END;

DROP TRIGGER IF EXISTS trg_pay_insert_cap;
CREATE TRIGGER trg_pay_insert_cap
BEFORE INSERT ON contract_payments
WHEN NEW.installment_id IS NOT NULL
BEGIN
  SELECT CASE
    WHEN NEW.discount_halalas < 0 OR NEW.net_halalas < 0
      THEN RAISE(ABORT, 'دفعة بصافٍ أو خصم سالب')
    WHEN NEW.discount_kind IS NOT NULL
         AND NEW.net_halalas + (CASE WHEN NEW.discount_kind = 'بعد الاستحقاق' THEN NEW.discount_halalas ELSE 0 END)
             > (SELECT amount_halalas FROM contract_installments WHERE id = NEW.installment_id)
      THEN RAISE(ABORT, 'الدفعة مع الخصم تتجاوز مبلغ القسط')
    WHEN (SELECT paid_halalas FROM contract_installments WHERE id = NEW.installment_id)
         + COALESCE((SELECT SUM(l.debit_halalas - l.credit_halalas)
                FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id AND l.account_code = '4900'
                WHERE e.src_type = 'discount' AND e.src_id = NEW.installment_id
                  AND e.status = 'مرحّل' AND e.reversed_by IS NULL), 0)
       + COALESCE((SELECT SUM(l.debit_halalas - l.credit_halalas)
                FROM contract_payments p JOIN journal_entries e ON e.id = p.journal_entry_id
                JOIN journal_lines l ON l.entry_id = e.id AND l.account_code = '4900'
                WHERE p.installment_id = NEW.installment_id AND p.id != NEW.id
                  AND e.status = 'مرحّل' AND e.reversed_by IS NULL), 0)
       + COALESCE((SELECT SUM(l.debit_halalas - l.credit_halalas)
                FROM contract_payments p JOIN journal_entries e ON e.src_type = 'discount' AND e.src_id = p.id
                JOIN journal_lines l ON l.entry_id = e.id AND l.account_code = '4900'
                WHERE p.installment_id = NEW.installment_id AND p.id != NEW.id
                  AND e.status = 'مرحّل' AND e.reversed_by IS NULL), 0)
       + COALESCE((SELECT SUM(p.discount_halalas) FROM contract_payments p
                WHERE p.installment_id = NEW.installment_id AND p.id != NEW.id AND p.discount_kind IS NULL AND p.discount_halalas > 0
                  AND NOT EXISTS (SELECT 1 FROM journal_lines l WHERE l.entry_id = p.journal_entry_id AND l.account_code = '4900')
                  AND NOT EXISTS (SELECT 1 FROM journal_entries e WHERE e.src_type = 'discount' AND e.src_id = p.id)
                  AND NOT EXISTS (SELECT 1 FROM contract_installments i2
                                  JOIN journal_entries e ON e.src_type = 'discount' AND e.src_id = i2.id
                                  WHERE i2.contract_id = p.contract_id)), 0)
         + COALESCE((SELECT SUM(l.debit_halalas - l.credit_halalas)
                FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id AND l.account_code = '4900'
                WHERE (e.id = NEW.journal_entry_id OR (e.src_type = 'discount' AND e.src_id = NEW.id))
                  AND e.status = 'مرحّل' AND e.reversed_by IS NULL), 0) + (CASE WHEN NEW.discount_kind IS NULL AND NEW.discount_halalas > 0
             AND NOT EXISTS (SELECT 1 FROM journal_lines l WHERE l.entry_id = NEW.journal_entry_id AND l.account_code = '4900')
             AND NOT EXISTS (SELECT 1 FROM journal_entries e WHERE e.src_type = 'discount' AND e.src_id = NEW.id)
             AND NOT EXISTS (SELECT 1 FROM contract_installments i2
                             JOIN journal_entries e ON e.src_type = 'discount' AND e.src_id = i2.id
                             WHERE i2.contract_id = NEW.contract_id)
           THEN NEW.discount_halalas ELSE 0 END)
         > (SELECT amount_halalas FROM contract_installments WHERE id = NEW.installment_id)
      THEN RAISE(ABORT, 'الخصم يتجاوز المتبقي على القسط')
  END;
END;

DROP TRIGGER IF EXISTS trg_pay_update_cap;
CREATE TRIGGER trg_pay_update_cap
BEFORE UPDATE OF discount_halalas, net_halalas, installment_id, discount_kind, journal_entry_id ON contract_payments
WHEN NEW.installment_id IS NOT NULL
BEGIN
  SELECT CASE
    WHEN NEW.discount_halalas < 0 OR NEW.net_halalas < 0
      THEN RAISE(ABORT, 'دفعة بصافٍ أو خصم سالب')
    WHEN (SELECT paid_halalas FROM contract_installments WHERE id = NEW.installment_id)
         + COALESCE((SELECT SUM(l.debit_halalas - l.credit_halalas)
                FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id AND l.account_code = '4900'
                WHERE e.src_type = 'discount' AND e.src_id = NEW.installment_id
                  AND e.status = 'مرحّل' AND e.reversed_by IS NULL), 0)
       + COALESCE((SELECT SUM(l.debit_halalas - l.credit_halalas)
                FROM contract_payments p JOIN journal_entries e ON e.id = p.journal_entry_id
                JOIN journal_lines l ON l.entry_id = e.id AND l.account_code = '4900'
                WHERE p.installment_id = NEW.installment_id AND p.id != NEW.id
                  AND e.status = 'مرحّل' AND e.reversed_by IS NULL), 0)
       + COALESCE((SELECT SUM(l.debit_halalas - l.credit_halalas)
                FROM contract_payments p JOIN journal_entries e ON e.src_type = 'discount' AND e.src_id = p.id
                JOIN journal_lines l ON l.entry_id = e.id AND l.account_code = '4900'
                WHERE p.installment_id = NEW.installment_id AND p.id != NEW.id
                  AND e.status = 'مرحّل' AND e.reversed_by IS NULL), 0)
       + COALESCE((SELECT SUM(p.discount_halalas) FROM contract_payments p
                WHERE p.installment_id = NEW.installment_id AND p.id != NEW.id AND p.discount_kind IS NULL AND p.discount_halalas > 0
                  AND NOT EXISTS (SELECT 1 FROM journal_lines l WHERE l.entry_id = p.journal_entry_id AND l.account_code = '4900')
                  AND NOT EXISTS (SELECT 1 FROM journal_entries e WHERE e.src_type = 'discount' AND e.src_id = p.id)
                  AND NOT EXISTS (SELECT 1 FROM contract_installments i2
                                  JOIN journal_entries e ON e.src_type = 'discount' AND e.src_id = i2.id
                                  WHERE i2.contract_id = p.contract_id)), 0)
         + COALESCE((SELECT SUM(l.debit_halalas - l.credit_halalas)
                FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id AND l.account_code = '4900'
                WHERE (e.id = NEW.journal_entry_id OR (e.src_type = 'discount' AND e.src_id = NEW.id))
                  AND e.status = 'مرحّل' AND e.reversed_by IS NULL), 0) + (CASE WHEN NEW.discount_kind IS NULL AND NEW.discount_halalas > 0
             AND NOT EXISTS (SELECT 1 FROM journal_lines l WHERE l.entry_id = NEW.journal_entry_id AND l.account_code = '4900')
             AND NOT EXISTS (SELECT 1 FROM journal_entries e WHERE e.src_type = 'discount' AND e.src_id = NEW.id)
             AND NOT EXISTS (SELECT 1 FROM contract_installments i2
                             JOIN journal_entries e ON e.src_type = 'discount' AND e.src_id = i2.id
                             WHERE i2.contract_id = NEW.contract_id)
           THEN NEW.discount_halalas ELSE 0 END)
         > (SELECT amount_halalas FROM contract_installments WHERE id = NEW.installment_id)
      THEN RAISE(ABORT, 'الخصم يتجاوز المتبقي على القسط')
  END;
END;

DROP TRIGGER IF EXISTS trg_inst_update_cap;
CREATE TRIGGER trg_inst_update_cap
BEFORE UPDATE OF paid_halalas, amount_halalas ON contract_installments
BEGIN
  SELECT CASE
    WHEN NEW.paid_halalas < 0
      THEN RAISE(ABORT, 'مسدَّد سالب على القسط')
    WHEN NEW.paid_halalas + COALESCE((SELECT SUM(l.debit_halalas - l.credit_halalas)
                FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id AND l.account_code = '4900'
                WHERE e.src_type = 'discount' AND e.src_id = NEW.id
                  AND e.status = 'مرحّل' AND e.reversed_by IS NULL), 0)
       + COALESCE((SELECT SUM(l.debit_halalas - l.credit_halalas)
                FROM contract_payments p JOIN journal_entries e ON e.id = p.journal_entry_id
                JOIN journal_lines l ON l.entry_id = e.id AND l.account_code = '4900'
                WHERE p.installment_id = NEW.id
                  AND e.status = 'مرحّل' AND e.reversed_by IS NULL), 0)
       + COALESCE((SELECT SUM(l.debit_halalas - l.credit_halalas)
                FROM contract_payments p JOIN journal_entries e ON e.src_type = 'discount' AND e.src_id = p.id
                JOIN journal_lines l ON l.entry_id = e.id AND l.account_code = '4900'
                WHERE p.installment_id = NEW.id
                  AND e.status = 'مرحّل' AND e.reversed_by IS NULL), 0)
       + COALESCE((SELECT SUM(p.discount_halalas) FROM contract_payments p
                WHERE p.installment_id = NEW.id AND p.discount_kind IS NULL AND p.discount_halalas > 0
                  AND NOT EXISTS (SELECT 1 FROM journal_lines l WHERE l.entry_id = p.journal_entry_id AND l.account_code = '4900')
                  AND NOT EXISTS (SELECT 1 FROM journal_entries e WHERE e.src_type = 'discount' AND e.src_id = p.id)
                  AND NOT EXISTS (SELECT 1 FROM contract_installments i2
                                  JOIN journal_entries e ON e.src_type = 'discount' AND e.src_id = i2.id
                                  WHERE i2.contract_id = p.contract_id)), 0) > NEW.amount_halalas
      THEN RAISE(ABORT, 'المسدَّد مع الخصم يتجاوز مبلغ القسط')
  END;
END;
`;

/** خصم القسط NEW.installment_id من الدفتر · كنص الهجرة ٢٠ والدفعة الملغاة خارجه */
const M21_INST_DISCOUNT = (inst: string, self: string) => `
         COALESCE((SELECT SUM(l.debit_halalas - l.credit_halalas)
                FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id AND l.account_code = '4900'
                WHERE e.src_type = 'discount' AND e.src_id = ${inst}
                  AND e.status = 'مرحّل' AND e.reversed_by IS NULL), 0)
       + COALESCE((SELECT SUM(l.debit_halalas - l.credit_halalas)
                FROM contract_payments p JOIN journal_entries e ON e.id = p.journal_entry_id
                JOIN journal_lines l ON l.entry_id = e.id AND l.account_code = '4900'
                WHERE p.installment_id = ${inst} AND p.id != ${self}
                  AND e.status = 'مرحّل' AND e.reversed_by IS NULL), 0)
       + COALESCE((SELECT SUM(l.debit_halalas - l.credit_halalas)
                FROM contract_payments p JOIN journal_entries e ON e.src_type = 'discount' AND e.src_id = p.id
                JOIN journal_lines l ON l.entry_id = e.id AND l.account_code = '4900'
                WHERE p.installment_id = ${inst} AND p.id != ${self}
                  AND e.status = 'مرحّل' AND e.reversed_by IS NULL), 0)
       + COALESCE((SELECT SUM(p.discount_halalas) FROM contract_payments p
                WHERE p.installment_id = ${inst} AND p.id != ${self} AND p.cancelled_at IS NULL
                  AND p.discount_kind IS NULL AND p.discount_halalas > 0
                  AND NOT EXISTS (SELECT 1 FROM journal_lines l WHERE l.entry_id = p.journal_entry_id AND l.account_code = '4900')
                  AND NOT EXISTS (SELECT 1 FROM journal_entries e WHERE e.src_type = 'discount' AND e.src_id = p.id)
                  AND NOT EXISTS (SELECT 1 FROM contract_installments i2
                                  JOIN journal_entries e ON e.src_type = 'discount' AND e.src_id = i2.id
                                  WHERE i2.contract_id = p.contract_id)), 0)`;

/** خصم الدفعة الجديدة نفسها في الدفتر أو في صفها · كنص الهجرة ٢٠ */
const M21_OWN_DISCOUNT = `
         COALESCE((SELECT SUM(l.debit_halalas - l.credit_halalas)
                FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id AND l.account_code = '4900'
                WHERE (e.id = NEW.journal_entry_id OR (e.src_type = 'discount' AND e.src_id = NEW.id))
                  AND e.status = 'مرحّل' AND e.reversed_by IS NULL), 0) + (CASE WHEN NEW.discount_kind IS NULL AND NEW.discount_halalas > 0
             AND NOT EXISTS (SELECT 1 FROM journal_lines l WHERE l.entry_id = NEW.journal_entry_id AND l.account_code = '4900')
             AND NOT EXISTS (SELECT 1 FROM journal_entries e WHERE e.src_type = 'discount' AND e.src_id = NEW.id)
             AND NOT EXISTS (SELECT 1 FROM contract_installments i2
                             JOIN journal_entries e ON e.src_type = 'discount' AND e.src_id = i2.id
                             WHERE i2.contract_id = NEW.contract_id)
           THEN NEW.discount_halalas ELSE 0 END)`;

/** الوارد بالمزامنة قيد التطبيق · فحص «المتبقي» للمسجَّل على هذا الجهاز وحده */
const M21_LOCAL_WRITE = `COALESCE((SELECT v FROM sync_ctl WHERE k = 'applying'), 0) = 0`;

/**
 * المسدَّد يُحسب من الدفعات وتوزيعها، وإلغاء الدفعة (قرارا المالك ٢٠٢٦-١٠-٠٣) · وانظر src/domain/contracts/paid.ts:
 * ١) إلغاء الدفعة لا يحذفها: cancelled_at وسببه وقيده العاكس · والملغاة خارج المسدَّد والخصم.
 * ٢) sync_ctl.applying يُرفع أثناء تطبيق الوارد · فدفعةٌ سُجّلت على جهاز آخر بلا اتصال لا يرفضها
 *    فحص «المتبقي» المحلي، بل تدخل ويُحدّ المسدَّد بمبلغ القسط ويظهر الزائد فائضاً للرد.
 *    وفحص الدفعة وحدها (لا تتجاوز مبلغ قسطها، ولا صافٍ أو خصم سالب) باقٍ على كل كتابة.
 * ٣) محفّزات السقف الثلاثة تُستبدل بذلك (ونصّ ١٧ و٢٠ كما هو).
 */
export const MIGRATION_21 = `
ALTER TABLE contract_payments ADD COLUMN cancelled_at TEXT;
ALTER TABLE contract_payments ADD COLUMN cancel_reason TEXT NOT NULL DEFAULT '';
ALTER TABLE contract_payments ADD COLUMN cancel_entry_id TEXT;
INSERT OR IGNORE INTO sync_ctl (k, v) VALUES ('applying', 0);

-- حارس خصم «بعد الاستحقاق» كنصّ الهجرة ٢٠ · والدفعة الملغاة خارجه: قيدها وخطّ خصمها معكوسان بالإلغاء نفسه
DROP TRIGGER IF EXISTS trg_pay_discount_booked_ins;
CREATE TRIGGER trg_pay_discount_booked_ins
BEFORE INSERT ON contract_payments
WHEN NEW.discount_kind = 'بعد الاستحقاق' AND NEW.cancelled_at IS NULL
BEGIN
  SELECT CASE
    WHEN COALESCE((SELECT SUM(l.debit_halalas - l.credit_halalas)
                FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id AND l.account_code = '4900'
                WHERE (e.id = NEW.journal_entry_id OR (e.src_type = 'discount' AND e.src_id = NEW.id))
                  AND e.status = 'مرحّل' AND e.reversed_by IS NULL), 0) != NEW.discount_halalas
      THEN RAISE(ABORT, 'خصم بعد الاستحقاق بلا سطر خصم مساوٍ له في الدفتر')
  END;
END;

DROP TRIGGER IF EXISTS trg_pay_discount_booked_upd;
CREATE TRIGGER trg_pay_discount_booked_upd
BEFORE UPDATE OF discount_kind, discount_halalas, journal_entry_id, cancelled_at ON contract_payments
WHEN NEW.discount_kind = 'بعد الاستحقاق' AND NEW.cancelled_at IS NULL
BEGIN
  SELECT CASE
    WHEN COALESCE((SELECT SUM(l.debit_halalas - l.credit_halalas)
                FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id AND l.account_code = '4900'
                WHERE (e.id = NEW.journal_entry_id OR (e.src_type = 'discount' AND e.src_id = NEW.id))
                  AND e.status = 'مرحّل' AND e.reversed_by IS NULL), 0) != NEW.discount_halalas
      THEN RAISE(ABORT, 'خصم بعد الاستحقاق بلا سطر خصم مساوٍ له في الدفتر')
  END;
END;

DROP TRIGGER IF EXISTS trg_pay_insert_cap;
CREATE TRIGGER trg_pay_insert_cap
BEFORE INSERT ON contract_payments
WHEN NEW.installment_id IS NOT NULL AND NEW.cancelled_at IS NULL
BEGIN
  SELECT CASE
    WHEN NEW.discount_halalas < 0 OR NEW.net_halalas < 0
      THEN RAISE(ABORT, 'دفعة بصافٍ أو خصم سالب')
    WHEN NEW.discount_kind IS NOT NULL
         AND NEW.net_halalas + (CASE WHEN NEW.discount_kind = 'بعد الاستحقاق' THEN NEW.discount_halalas ELSE 0 END)
             > (SELECT amount_halalas FROM contract_installments WHERE id = NEW.installment_id)
      THEN RAISE(ABORT, 'الدفعة مع الخصم تتجاوز مبلغ القسط')
    WHEN ${M21_LOCAL_WRITE}
         AND (SELECT paid_halalas FROM contract_installments WHERE id = NEW.installment_id)
         + ${M21_INST_DISCOUNT('NEW.installment_id', 'NEW.id')}
         + ${M21_OWN_DISCOUNT}
         > (SELECT amount_halalas FROM contract_installments WHERE id = NEW.installment_id)
      THEN RAISE(ABORT, 'الخصم يتجاوز المتبقي على القسط')
  END;
END;

DROP TRIGGER IF EXISTS trg_pay_update_cap;
CREATE TRIGGER trg_pay_update_cap
BEFORE UPDATE OF discount_halalas, net_halalas, installment_id, discount_kind, journal_entry_id ON contract_payments
WHEN NEW.installment_id IS NOT NULL AND NEW.cancelled_at IS NULL
BEGIN
  SELECT CASE
    WHEN NEW.discount_halalas < 0 OR NEW.net_halalas < 0
      THEN RAISE(ABORT, 'دفعة بصافٍ أو خصم سالب')
    WHEN ${M21_LOCAL_WRITE}
         AND (SELECT paid_halalas FROM contract_installments WHERE id = NEW.installment_id)
         + ${M21_INST_DISCOUNT('NEW.installment_id', 'NEW.id')}
         + ${M21_OWN_DISCOUNT}
         > (SELECT amount_halalas FROM contract_installments WHERE id = NEW.installment_id)
      THEN RAISE(ABORT, 'الخصم يتجاوز المتبقي على القسط')
  END;
END;

DROP TRIGGER IF EXISTS trg_inst_update_cap;
CREATE TRIGGER trg_inst_update_cap
BEFORE UPDATE OF paid_halalas, amount_halalas ON contract_installments
BEGIN
  SELECT CASE
    WHEN NEW.paid_halalas < 0
      THEN RAISE(ABORT, 'مسدَّد سالب على القسط')
    WHEN NEW.paid_halalas + ${M21_INST_DISCOUNT('NEW.id', "''")} > NEW.amount_halalas
      THEN RAISE(ABORT, 'المسدَّد مع الخصم يتجاوز مبلغ القسط')
  END;
END;
`;

/**
 * الهجرة ٢٢ · كاتب المسودة (صلاحيات الأقسام · docs/PERMISSIONS.md): صاحب «إدخال» يعدّل مسودته هو وحده.
 * جدولٌ يخص الجهاز ولا يُزامَن كصف: من أنشأ كل عقد وفاتورة وقيد. يملؤه المحفّز عند الإنشاء المحلي
 * (والالتقاط مطفأ أثناء تطبيق الوارد فلا يُنسب الوارد لصاحب الجهاز)، وتملؤه المزامنة من حقل by للوارد.
 */
export const MIGRATION_22 = `
CREATE TABLE IF NOT EXISTS row_by (
  tbl TEXT NOT NULL,
  pk  TEXT NOT NULL,
  uid TEXT NOT NULL,
  PRIMARY KEY (tbl, pk)
);
${['contracts', 'invoices', 'journal_entries'].map((t) => `
CREATE TRIGGER IF NOT EXISTS row_by_${t} AFTER INSERT ON ${t}
WHEN (SELECT v FROM sync_ctl WHERE k = 'capture') = 1 AND (SELECT v FROM sync_state WHERE k = 'uid') IS NOT NULL
BEGIN
  INSERT OR IGNORE INTO row_by (tbl, pk, uid) VALUES ('${t}', NEW.id, (SELECT v FROM sync_state WHERE k = 'uid'));
END;`).join('\n')}
`;

/**
 * الهجرة ٢٣ · تحصيل فاتورة المبيعات (المراجعة ٤.٢): كانت «مدفوعة» تُغيّر الحالة وحدها بلا قيد، فتتراكم الذمم 1200
 * ولا يزيد النقد. الآن التحصيل قيدٌ (مدين النقد أو البنك / دائن الذمم) يُحفظ معرّفه وتاريخه وطريقته كسداد المشتريات.
 */
export const MIGRATION_23 = `
ALTER TABLE invoices ADD COLUMN paid_date TEXT;
ALTER TABLE invoices ADD COLUMN payment_method TEXT;
ALTER TABLE invoices ADD COLUMN payment_bank_id TEXT;
ALTER TABLE invoices ADD COLUMN payment_journal_entry_id TEXT;
-- مآل العربون (المراجعة ٤.٤ و٤.٥): محوَّل · مصادَر · مردود، وتاريخ التسوية · والفارغ محتجزٌ بعد
ALTER TABLE reservations ADD COLUMN deposit_outcome TEXT;
ALTER TABLE reservations ADD COLUMN deposit_settled_date TEXT;
`;

/**
 * الهجرة ٢٤ · أقساط عقود إيجار من جدول ملفها (قرار المالك ٢٠٢٦-١٠-٠٥): الجدول المقروء يُحفظ مع المسودة
 * فيُبنى منه جدول الأقساط عند التوثيق، ومصدر التواريخ يُحفظ مع العقد: «ملف» قُرئت من جدوله، و«محسوبة» قُرئ
 * العقد من ملف وتعذّر جدوله فحُسبت وينبَّه عليها، والفارغ عقدٌ أُدخل يدوياً.
 */
export const MIGRATION_24 = `
ALTER TABLE contracts ADD COLUMN ejar_schedule TEXT;
ALTER TABLE contracts ADD COLUMN installments_source TEXT;
`;

/**
 * الهجرة ٢٥ · المزامنة لا تحجب الواجهة (أعطال ٢٠٢٦-١٠-٠٥): علامة الحذف عموداً في الصندوق الوارد بفهرسٍ
 * لترتيب التطبيق، فلا تُفكّ كل الحمولات لكل صفحة · وفهرس قيد الدفعة الذي يقرؤه فحص الأيتام بعد كل تطبيق.
 */
export const MIGRATION_25 = `
ALTER TABLE sync_inbox ADD COLUMN del INTEGER NOT NULL DEFAULT 0;
UPDATE sync_inbox SET del = COALESCE(json_extract(payload, '$.del'), 0);
CREATE INDEX IF NOT EXISTS ix_sync_inbox_apply ON sync_inbox(del, rank, updated_at, doc);
CREATE INDEX IF NOT EXISTS ix_pay_journal ON contract_payments(journal_entry_id);
`;

const sq = (s: string) => "'" + s.replace(/'/g, "''") + "'";
/** نص التذكير الذي زرعته الهجرة ١٥ · حرفياً */
const LEGACY_REMINDER_BODY = 'السلام عليكم {الاسم}، نذكّركم بدفعة الإيجار المستحقة بتاريخ {تاريخ الاستحقاق} بمبلغ {المبلغ} عن وحدة {الوحدة}. شاكرين تعاونكم.';
/** جهاز العضو لا يحذف ما لا يملكه · يصله حذف المالك بالمزامنة */
const NOT_MEMBER = `NOT EXISTS (SELECT 1 FROM sync_state WHERE k = 'membership' AND v IS NOT NULL)`;

/**
 * الهجرة ٢٦ · لا محتوى مزروعاً (قرار المالك ٢٠٢٦-١٠-٠٥): يُحذف ما زرعته الإصدارات السابقة ولم يُعدَّل ·
 * قالب الاستلام والتسليم، وقوالب الرسائل الأربعة، و«تذكير بالدفعة» · وما عُدّل يبقى كما هو.
 * والحذف يُلتقط فيُرفع شاهده، فيُحذف من السحابة ومن بقية الأجهزة.
 */
export const MIGRATION_26 = `
DELETE FROM message_scripts WHERE ${NOT_MEMBER} AND (
  ${LEGACY_SEED_SCRIPTS.map((s) => `(audience = ${sq(s.audience)} AND title = ${sq(s.title)} AND body = ${sq(s.body)})`).join('\n  OR ')}
  OR (title = 'تذكير بالدفعة' AND body = ${sq(LEGACY_REMINDER_BODY)})
);
DELETE FROM form_templates WHERE ${NOT_MEMBER} AND id = 'FT-HANDOVER' AND name = 'نموذج استلام وتسليم'
  AND sections_json = ${sq(JSON.stringify(LEGACY_HANDOVER_TEMPLATE))};
`;

/** الهجرات بالترتيب · الفهرس 0 = الهجرة إلى الإصدار 1 */
export const MIGRATIONS: string[] = [MIGRATION_1, MIGRATION_2, MIGRATION_3, MIGRATION_4, MIGRATION_5, MIGRATION_6, MIGRATION_7, MIGRATION_8, MIGRATION_9, MIGRATION_10, MIGRATION_11, MIGRATION_12, MIGRATION_13, MIGRATION_14, MIGRATION_15, MIGRATION_16, MIGRATION_17, MIGRATION_18, MIGRATION_19, MIGRATION_20, MIGRATION_21, MIGRATION_22, MIGRATION_23, MIGRATION_24, MIGRATION_25, MIGRATION_26];
