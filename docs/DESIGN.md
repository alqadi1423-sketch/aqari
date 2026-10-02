# وثيقة تصميم تطبيق «عقاري» — تابع لمنصة رِكز

> المرجع الملزم: `aqari.html` (٦٬١١١ سطراً — قُرئ كاملاً). هذه الوثيقة تشرح **ما يُعاد بناؤه فقط**: التخزين وطبقة العرض. كل قاعدة عمل ونص عربي يُنقلان كما هما.

> **حالة التنفيذ · آخر تحديث ٢٦ أغسطس ٢٠٢٦**
> مخطط القاعدة عند الإصدار **١٦** (ست عشرة هجرة) · **٢٥ شاشة** · **١٨٥ اختباراً في ٢٩ ملفاً** كلها ناجحة · الحزمة `arm64-v8a` وحدها.
> ما بعد البناء الأول من توجيهات المالك مسجَّل في القسمين **١١ (ما تغيّر بعد البناء الأول)** و**١٢ (قواعد ملزمة من المالك)** في آخر الوثيقة، وهما المرجع لكل ما استُحدث أو نُقض من هذه الصفحات.

---

## ١. المنظومة

```
Expo (React Native) + TypeScript + Expo Router
expo-sqlite · expo-file-system · expo-crypto · expo-sharing · expo-notifications
expo-image-picker · expo-document-picker · expo-print
react-native-maps · react-native-svg · zod · date-fns
fflate (ضغط أرشيف النسخ الاحتياطي — JS خالص يعمل في RN وNode)
لا خادم · لا حساب مستخدم · لا إنترنت · جهاز واحد
```

بنية المشروع:

```
D:\Aqari
├── app/                    شاشات Expo Router (تنقّل سفلي بخمسة تبويبات + مسارات «المزيد» والإعدادات)
├── src/
│   ├── db/                 المخطط + الهجرات + محوّل SQLite (expo-sqlite للتطبيق، node:sqlite للاختبارات)
│   ├── domain/             منطق العمل الخالص (محاسبة، عقود، أقساط، قراءة PDF، نسخ احتياطي، تنبيهات)
│   ├── repos/              طبقة الوصول للبيانات — كل كتابة داخل BEGIN IMMEDIATE
│   ├── files/              مخزن الملفات المعنون بالمحتوى (blobs/attachments)
│   ├── perf/               قياس الأداء داخل التطبيق (زمن كل انتقال وكل استعلام) — القسم ١١
│   └── ui/                 مكوّنات التصميم الأصلية (Card, BottomSheet, Chips, KPI, …)
└── tests/                  Jest — ١٨٥ اختباراً في ٢٩ ملفاً (نسخ احتياطي، محاسبة، قواعد العمل، أداء، حراسة)
```

**مبدأ الفصل:** كل منطق العمل في `src/domain` دوالّ خالصة تتعامل مع واجهة `Database` مجردة، فتعمل نفسها في التطبيق (expo-sqlite) وفي الاختبارات (`node:sqlite` المدمج في Node ≥ 22.5) دون تغيير.

---

## ٢. قاعدة البيانات

### ٢.١ الفتح والإعدادات

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA synchronous = FULL;
```

كل كتابة داخل `BEGIN IMMEDIATE … COMMIT`. المبالغ كلها أعداد صحيحة **بالهللات** (`*_halalas INTEGER`). لا `REAL` في أي حقل مالي — `REAL` مسموح فقط لغير المال (إحداثيات GPS، قراءات العدادات، الكميات).

جدول `meta(key PRIMARY KEY, value)` يحمل `schema_version` و`device_id`، وجدول `settings(key PRIMARY KEY, value_json)` يحمل إعدادات التطبيق (المهل، مدة السلة، مقاييس العرض…).

### ٢.٢ المخطط — جدول لكل كيان

```sql
-- ─── المحاسبة ───
CREATE TABLE accounts (
  code        TEXT PRIMARY KEY,              -- '1100' … '5500'
  name        TEXT NOT NULL,
  type        TEXT NOT NULL CHECK (type IN ('أصل','خصم','حقوق ملكية','إيراد','مصروف')),
  grp         TEXT,                          -- 'النقدية وما في حكمها' لحساب 1100
  opening_halalas INTEGER NOT NULL DEFAULT 0,
  is_system   INTEGER NOT NULL DEFAULT 0,    -- الحسابات الـ19 المزروعة
  created_at  TEXT NOT NULL,
  deleted_at  TEXT
);

CREATE TABLE journal_entries (
  id          TEXT PRIMARY KEY,
  no          TEXT NOT NULL UNIQUE,          -- 'JE-0001'
  date        TEXT NOT NULL,                 -- ISO yyyy-mm-dd
  memo        TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'قيد الإنشاء'
              CHECK (status IN ('قيد الإنشاء','مرحّل')),
  auto        INTEGER NOT NULL DEFAULT 0,
  src_type    TEXT,                          -- 'contract_deposit' | 'rent' | … (مسار الترحيل الموحّد)
  src_id      TEXT,
  reversed_by TEXT REFERENCES journal_entries(id),
  created_at  TEXT NOT NULL,
  deleted_at  TEXT
);

CREATE TABLE journal_lines (
  id             TEXT PRIMARY KEY,
  entry_id       TEXT NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
  account_code   TEXT NOT NULL REFERENCES accounts(code),
  descr          TEXT NOT NULL DEFAULT '',
  debit_halalas  INTEGER NOT NULL DEFAULT 0 CHECK (debit_halalas  >= 0),
  credit_halalas INTEGER NOT NULL DEFAULT 0 CHECK (credit_halalas >= 0),
  CHECK (NOT (debit_halalas > 0 AND credit_halalas > 0))
);
```

**رفض القيد غير المتوازن بمحفّز داخل القاعدة** (لا في الكود فقط): القيد يُدرج بحالة `قيد الإنشاء`، تُضاف سطوره، ثم يُرقّى إلى `مرحّل` — والمحفّز يمنع الترقية إن اختلّ التوازن، ويمنع أي تعديل على سطور قيد مرحّل:

```sql
CREATE TRIGGER trg_je_post_balanced
BEFORE UPDATE OF status ON journal_entries
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

-- سطور القيد المرحّل غير قابلة للتعديل/الإضافة/الحذف (ثلاثة محفزات INSERT/UPDATE/DELETE)
CREATE TRIGGER trg_jl_frozen_ins BEFORE INSERT ON journal_lines
WHEN (SELECT status FROM journal_entries WHERE id = NEW.entry_id) = 'مرحّل'
BEGIN SELECT RAISE(ABORT, 'قيد مرحّل لا يُعدَّل'); END;
-- … ومثلهما للتحديث والحذف
```

**الرصيد مشتقّ لا مخزَّن** — لا عمود `balance` إطلاقاً:

```sql
SELECT COALESCE(SUM(l.debit_halalas - l.credit_halalas),0)
FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
WHERE l.account_code = ? AND e.status = 'مرحّل' AND e.deleted_at IS NULL
```

الرصيد المعروض = `opening_halalas` + الصافي أعلاه (مع عكس الإشارة لحسابات الخصوم/حقوق الملكية/الإيرادات كما في النموذج: `DEBIT_NORMAL = {أصل, مصروف}`).

```sql
-- ─── الأطراف ───
CREATE TABLE tenants (           -- «customers» في النموذج، وتُعرض «المستأجرون»
  id TEXT PRIMARY KEY, name TEXT NOT NULL, vat TEXT DEFAULT '', phone TEXT DEFAULT '',
  credit_halalas INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, deleted_at TEXT
);

CREATE TABLE suppliers (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, vat TEXT DEFAULT '', phone TEXT DEFAULT '',
  category TEXT DEFAULT '', default_category TEXT DEFAULT '',
  default_amount_halalas INTEGER,
  utility_type TEXT NOT NULL DEFAULT '' CHECK (utility_type IN ('','كهرباء','ماء')),
  archived INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, deleted_at TEXT
);

-- ─── العقارات والوحدات ───
CREATE TABLE properties (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, address TEXT DEFAULT '',
  floors INTEGER, activity_type TEXT DEFAULT '', activity_subtype TEXT DEFAULT '',
  ownership TEXT NOT NULL DEFAULT 'ملك' CHECK (ownership IN ('ملك','إيجار','تشغيل')),
  deed_no TEXT DEFAULT '',
  lease_value_halalas INTEGER, lease_cycle TEXT, lease_start TEXT, lease_end TEXT,
  op_rate REAL,
  lat REAL, lng REAL,
  created_at TEXT NOT NULL, deleted_at TEXT
);
CREATE TABLE property_floor_categories (
  property_id TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  floor_label TEXT NOT NULL, category TEXT NOT NULL,
  PRIMARY KEY (property_id, floor_label)
);
CREATE TABLE property_areas (           -- أقسام العقار ومحتوياتها
  id TEXT PRIMARY KEY, property_id TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  area_name TEXT NOT NULL, sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE property_area_items (
  id TEXT PRIMARY KEY, area_id TEXT NOT NULL REFERENCES property_areas(id) ON DELETE CASCADE,
  name TEXT NOT NULL, descr TEXT DEFAULT '', sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE units (
  id TEXT PRIMARY KEY, property_id TEXT NOT NULL REFERENCES properties(id),
  unit_no TEXT NOT NULL, floor TEXT DEFAULT '', type TEXT NOT NULL DEFAULT 'سكني',
  subtype TEXT DEFAULT '', rent_monthly_halalas INTEGER NOT NULL DEFAULT 0,
  under_maintenance INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, deleted_at TEXT
);
CREATE UNIQUE INDEX ux_units_no ON units(property_id, unit_no) WHERE deleted_at IS NULL;
CREATE TABLE unit_rooms (               -- غرف الوحدة ومحتوياتها
  id TEXT PRIMARY KEY, unit_id TEXT NOT NULL REFERENCES units(id) ON DELETE CASCADE,
  room_name TEXT NOT NULL, sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE unit_room_items (
  id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES unit_rooms(id) ON DELETE CASCADE,
  name TEXT NOT NULL, descr TEXT DEFAULT '', sort INTEGER NOT NULL DEFAULT 0
);

-- ─── العدادات: العدّاد يشير لمورده، عدادات كثيرة لمورد واحد، الميزة لنوعين فقط ───
CREATE TABLE meters (
  id TEXT PRIMARY KEY,
  owner_type TEXT NOT NULL CHECK (owner_type IN ('property','unit')),
  owner_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('كهرباء','ماء','إنترنت')),
  number TEXT NOT NULL,
  supplier_id TEXT REFERENCES suppliers(id),   -- يُملأ فقط لكهرباء/ماء
  deleted_at TEXT
);
CREATE TABLE meter_readings (
  id TEXT PRIMARY KEY, meter_id TEXT NOT NULL REFERENCES meters(id) ON DELETE CASCADE,
  date TEXT NOT NULL, reading REAL, amount_halalas INTEGER NOT NULL DEFAULT 0, ref TEXT DEFAULT ''
);

-- ─── العقود ───
CREATE TABLE contracts (
  id TEXT PRIMARY KEY,                   -- معرّف داخلي دائم (uuid)
  contract_no TEXT UNIQUE,               -- NULL للمسودة (تُعرض «—») — يُمنح عند التأكيد فقط
  tenant_name TEXT NOT NULL, phone TEXT DEFAULT '', id_number TEXT DEFAULT '',
  unit_id TEXT NOT NULL REFERENCES units(id),
  unit_label TEXT NOT NULL DEFAULT '', unit_type TEXT,
  value_halalas INTEGER NOT NULL DEFAULT 0,
  cycle TEXT NOT NULL DEFAULT 'شهرية' CHECK (cycle IN ('شهرية','ربع سنوية','نصف سنوية','سنوية')),
  start TEXT, end TEXT,
  deposit_halalas INTEGER NOT NULL DEFAULT 0,
  ejar_no TEXT DEFAULT '', services TEXT DEFAULT '',
  furnished TEXT DEFAULT 'غير مؤثثة',
  type_specific TEXT NOT NULL DEFAULT '{}',      -- JSON: {activity, crNo} حسب نوع الوحدة
  status TEXT NOT NULL DEFAULT 'مسودة' CHECK (status IN ('مسودة','سارٍ','منتهٍ','ملغى')),
  cancel_date TEXT, cancel_reason TEXT,
  cancel_deduction_halalas INTEGER, cancel_refund_halalas INTEGER, cancel_deduction_reason TEXT,
  renewed_from TEXT, renewed_to TEXT, renew_count INTEGER NOT NULL DEFAULT 0, renew_note TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, deleted_at TEXT      -- الحذف للمسودات فقط
);

CREATE TABLE contract_installments (   -- يُولَّد آلياً عند الإنشاء ولا يُعاد توليده
  id TEXT PRIMARY KEY, contract_id TEXT NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  due_date TEXT NOT NULL, amount_halalas INTEGER NOT NULL,
  paid_halalas INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'مستحقة'
         CHECK (status IN ('مستحقة','متأخرة','مدفوعة','مدفوعة جزئياً','ملغية')),
  notes TEXT DEFAULT '', sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE contract_payments (
  id TEXT PRIMARY KEY, contract_id TEXT NOT NULL REFERENCES contracts(id),
  installment_id TEXT REFERENCES contract_installments(id),
  period TEXT DEFAULT '', date TEXT NOT NULL,
  gross_halalas INTEGER NOT NULL, discount_halalas INTEGER NOT NULL DEFAULT 0,
  net_halalas INTEGER NOT NULL,
  method_label TEXT DEFAULT '', notes TEXT DEFAULT '',
  journal_entry_id TEXT REFERENCES journal_entries(id),
  created_at TEXT NOT NULL
);
CREATE TABLE payment_lines (           -- السداد المتعدد: بنك + نقد في دفعة واحدة
  id TEXT PRIMARY KEY, payment_id TEXT NOT NULL REFERENCES contract_payments(id) ON DELETE CASCADE,
  method TEXT NOT NULL CHECK (method IN ('bank','cash')),
  bank_id TEXT REFERENCES banks(id),
  amount_halalas INTEGER NOT NULL
);

CREATE TABLE contract_occupants (
  id TEXT PRIMARY KEY, contract_id TEXT NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  name TEXT NOT NULL, id_number TEXT DEFAULT '', dob TEXT, phone TEXT DEFAULT '',
  sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE deposit_settlements (     -- التصرف بالتأمين — بعد انتهاء العقد فقط
  contract_id TEXT PRIMARY KEY REFERENCES contracts(id),
  date TEXT NOT NULL, deduction_halalas INTEGER NOT NULL DEFAULT 0,
  deduction_reason TEXT DEFAULT '', refund_halalas INTEGER NOT NULL DEFAULT 0, notes TEXT DEFAULT ''
);
CREATE TABLE tenant_ratings (          -- التقييم — بعد انتهاء العقد فقط
  contract_id TEXT PRIMARY KEY REFERENCES contracts(id),
  on_time TEXT, payment_commit TEXT, contract_commit TEXT,
  unit_condition TEXT, neighbor_complaints TEXT, notes TEXT DEFAULT '', rated_at TEXT
);

-- ─── الحجوزات والمطالبات والتقبيل ───
CREATE TABLE reservations (
  id TEXT PRIMARY KEY, unit_id TEXT NOT NULL REFERENCES units(id),
  name TEXT NOT NULL, phone TEXT DEFAULT '',
  deposit_halalas INTEGER NOT NULL DEFAULT 0,
  expiry_date TEXT NOT NULL, created_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'نشط' CHECK (status IN ('نشط','منتهي','محوَّل لعقد')),
  converted_contract_id TEXT, deleted_at TEXT
);
CREATE TABLE claims (
  id TEXT PRIMARY KEY, contract_id TEXT NOT NULL REFERENCES contracts(id),
  amount_halalas INTEGER NOT NULL, reason TEXT DEFAULT '', date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'مفتوحة' CHECK (status IN ('مفتوحة','محصَّلة')),
  source TEXT NOT NULL DEFAULT 'يدوية' CHECK (source IN ('يدوية','تسوية تأمين')),
  collected_at TEXT, created_at TEXT NOT NULL, deleted_at TEXT
);
CREATE TABLE key_money_deals (
  id TEXT PRIMARY KEY, unit_id TEXT NOT NULL REFERENCES units(id), contract_id TEXT,
  outgoing TEXT NOT NULL, incoming TEXT NOT NULL,
  amount_halalas INTEGER NOT NULL, date TEXT NOT NULL,
  commission_halalas INTEGER NOT NULL DEFAULT 0, method TEXT, notes TEXT DEFAULT '',
  journal_entry_id TEXT, created_at TEXT NOT NULL, deleted_at TEXT
);

-- ─── الفواتير والمشتريات والبنوك ───
CREATE TABLE invoices (
  id TEXT PRIMARY KEY, no TEXT NOT NULL UNIQUE, customer_name TEXT NOT NULL,
  customer_vat TEXT DEFAULT '', issue TEXT NOT NULL, due TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('مسودة','مستحقة','مدفوعة','متأخرة')),
  subtotal_halalas INTEGER NOT NULL, tax_halalas INTEGER NOT NULL DEFAULT 0,
  total_halalas INTEGER NOT NULL, notes TEXT DEFAULT '',
  unit_id TEXT, property_id TEXT,
  journal_entry_id TEXT REFERENCES journal_entries(id),
  created_at TEXT NOT NULL, deleted_at TEXT
);
CREATE TABLE invoice_lines (
  id TEXT PRIMARY KEY, invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  descr TEXT DEFAULT '', qty REAL NOT NULL DEFAULT 1,
  price_halalas INTEGER NOT NULL DEFAULT 0, tax_pct INTEGER NOT NULL DEFAULT 15,
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE purchases (
  id TEXT PRIMARY KEY, no TEXT NOT NULL UNIQUE,        -- 'PUR-001'
  supplier_name TEXT NOT NULL, date TEXT NOT NULL, due TEXT DEFAULT '',
  category TEXT DEFAULT '', incorp_item TEXT DEFAULT '',
  amortize INTEGER NOT NULL DEFAULT 0, amortize_months INTEGER,
  exempt INTEGER NOT NULL DEFAULT 0, exclude_from_vat INTEGER NOT NULL DEFAULT 0,
  unit_id TEXT, property_id TEXT,
  subtotal_halalas INTEGER NOT NULL, tax_halalas INTEGER NOT NULL DEFAULT 0,
  total_halalas INTEGER NOT NULL,
  paid INTEGER NOT NULL DEFAULT 0, paid_date TEXT, payment_method TEXT, payment_bank_id TEXT,
  journal_entry_id TEXT, payment_journal_entry_id TEXT,
  meter_id TEXT, meter_reading REAL,
  created_at TEXT NOT NULL, deleted_at TEXT
);

CREATE TABLE banks (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, iban TEXT DEFAULT '',
  opening_halalas INTEGER NOT NULL DEFAULT 0, opening_date TEXT,
  created_at TEXT NOT NULL, deleted_at TEXT
  -- لا عمود رصيد: الرصيد = opening_halalas + SUM(bank_tx.amount_halalas)
);
CREATE TABLE bank_tx (
  id TEXT PRIMARY KEY, bank_id TEXT NOT NULL REFERENCES banks(id),
  date TEXT NOT NULL, descr TEXT NOT NULL, amount_halalas INTEGER NOT NULL,  -- موجب/سالب
  matched INTEGER NOT NULL DEFAULT 0, journal_no TEXT DEFAULT '', source TEXT DEFAULT '',
  created_at TEXT NOT NULL, deleted_at TEXT
);

-- ─── الرسائل والمنشأة والنماذج ───
CREATE TABLE message_scripts (
  id TEXT PRIMARY KEY, audience TEXT NOT NULL, category TEXT DEFAULT 'عام',
  title TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL, deleted_at TEXT
);
CREATE TABLE company (                 -- صف واحد id=1
  id INTEGER PRIMARY KEY CHECK (id = 1),
  name TEXT DEFAULT '', vatno TEXT DEFAULT '', cr TEXT DEFAULT '', phone TEXT DEFAULT '',
  address TEXT DEFAULT '', cr_exp TEXT, vat_enabled INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE company_docs (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, expiry TEXT, created_at TEXT NOT NULL, deleted_at TEXT
);
CREATE TABLE form_templates (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, is_system INTEGER NOT NULL DEFAULT 0,
  sections_json TEXT NOT NULL,          -- [{section, items:[أسماء]}]
  created_at TEXT NOT NULL, deleted_at TEXT
);
CREATE TABLE handovers (               -- النموذج المعبّأ لقطة نهائية — يصلح JSON
  id TEXT PRIMARY KEY, contract_id TEXT, unit_id TEXT,
  type TEXT NOT NULL CHECK (type IN ('استلام','تسليم')),
  employee_name TEXT DEFAULT '', tenant_name TEXT NOT NULL, id_number TEXT DEFAULT '',
  phone TEXT DEFAULT '', address TEXT DEFAULT '', unit_floor TEXT DEFAULT '',
  contract_period TEXT DEFAULT '', date TEXT NOT NULL, other_notes TEXT DEFAULT '',
  tenant_sign TEXT DEFAULT '', company_sign TEXT DEFAULT '',
  sections_json TEXT NOT NULL,          -- [{section, items:[{name,count,receiveCondition,deliverCondition,notes}]}]
  created_at TEXT NOT NULL, deleted_at TEXT
);

-- ─── سجل العمليات (غير قابل للتعديل) ───
CREATE TABLE audit_log (
  id TEXT PRIMARY KEY, ts TEXT NOT NULL, user_name TEXT NOT NULL DEFAULT 'مستخدم',
  module TEXT NOT NULL, action_type TEXT NOT NULL, entity_type TEXT NOT NULL,
  entity_name TEXT NOT NULL, before_json TEXT, after_json TEXT
);

-- ─── الملفات: معنونة بالمحتوى ───
CREATE TABLE blobs (
  sha256 TEXT PRIMARY KEY, ext TEXT NOT NULL, size_bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE attachments (
  id TEXT PRIMARY KEY, sha256 TEXT NOT NULL REFERENCES blobs(sha256),
  entity_type TEXT NOT NULL,            -- 'property'|'contract'|'purchase'|'claim'|'handover'|'company'|'company_doc'|'library'|…
  entity_id TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL,                   -- 'deed'|'lease'|'tenant_id'|'claim'|'receipt'|'purchase'|'handover'|'company'|'photo'|'other'|'logo'
  original_name TEXT NOT NULL DEFAULT '', mime TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  display_name TEXT NOT NULL DEFAULT '',   -- إعادة التسمية من المكتبة
  cat_override TEXT,                       -- «نقل إلى مجلد» من المكتبة
  created_at TEXT NOT NULL, deleted_at TEXT
);

-- ─── التنبيهات المجدولة (مرآة لما جُدول في النظام) ───
CREATE TABLE scheduled_notifications (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, entity_id TEXT NOT NULL,
  fire_at TEXT NOT NULL, os_id TEXT NOT NULL
);
```

### ٢.٣ الملفات على القرص

`<documentDirectory>/attachments/<sha256>.<ext>` — القاعدة تحفظ المسار (المشتق من البصمة) والبصمة والحجم فقط. رفع نفس الملف مرتين = بصمة واحدة = صف واحد في `blobs` وملف واحد على القرص — **منع التكرار خاصية بنيوية**. مسار رفع واحد (`filesStore.put`) يمر به كل ملف فيُسجَّل تلقائياً في `attachments` بتصنيفه — وهذا ما تعتمد عليه المكتبة.

حذف مرفق = `deleted_at` على صف `attachments`. لا يُحذف ملف من القرص إلا في كنس دوري يتحقق أن **لا صف حيّ** (attachment غير محذوف، وشعار المنشأة) يشير لبصمته، وبعد انقضاء مهلة السلة.

### ٢.٤ الحذف الناعم والسلة

كل جدول كياني يحمل `deleted_at`. «سلة المحذوفات» = استعلام موحّد على الجداول حيث `deleted_at IS NOT NULL`. الاستعادة = مسح `deleted_at` (مع إعادة ترحيل الأثر المحاسبي كما في النموذج: الفاتورة تُرحَّل من جديد، فاتورة الشراء تُستعاد **غير مسدَّدة**، الحركة البنكية تعيد أثرها). الحذف النهائي بعد انقضاء المدة المختارة من الإعدادات (٣٠/٦٠/٩٠ يوماً — `settings.trashRetention`) أو يدوياً.

---

## ٣. النسخ الاحتياطي والاستعادة

### ٣.١ صيغة الأرشيف

ملف واحد `عقاري-نسخة-YYYY-MM-DD.aqbk` (zip عبر fflate):

```
manifest.json
data.db
attachments/<sha256>.<ext> …
```

`manifest.json`:

```json
{
  "format": "aqari-backup", "format_version": 1,
  "app_version": "…", "schema_version": N,
  "created_at": "…", "device_id": "…",
  "db_sha256": "…",
  "files": [{ "sha256": "…", "ext": "jpg", "size": 12345 }],
  "missing_files": ["…"],
  "table_counts": { "contracts": 12, "journal_entries": 90, "...": 0 },
  "ledger": { "total_debit_halalas": 0, "total_credit_halalas": 0,
              "balances": { "1100": 0, "2400": 0, "...": 0 } },
  "integrity": [ { "name": "…", "ok": true, "value": "…" } ],
  "complete": true
}
```

### ٣.٢ الإنشاء

1. تشغيل **فحوص المطابقة الستة** وكتابة نتائجها ومجاميع الدفتر في البيان.
2. `PRAGMA wal_checkpoint(TRUNCATE)` ثم `VACUUM INTO 'tmp/data.db'`.
3. بصمة `data.db`، ثم نسخ كل ملف مرفق حيّ مع التحقق من بصمته أثناء النسخ. ملف مفقود من القرص → يُدرج في `missing_files` و`complete=false` (نسخة معلَّمة ناقصة، لا فشل صامت).
4. كتابة البيان وضغط الأرشيف.
5. **التحقق الإلزامي**: يُعاد فتح الأرشيف الناتج، تُعاد بصمة كل ملف و`db_sha256`، ويُفتح `data.db` المنسوخ وتُنفَّذ `PRAGMA integrity_check` وتُطابَق أعداد الجداول مع `table_counts` — **ولا تُسمّى النسخة ناجحة قبل ذلك**. أي فشل → حذف الأرشيف الناتج وإظهار الخطأ.
6. إن كانت وحدة التجزئة (sha256) معطّلة أو فشلت → **يُرفض إنشاء النسخة** من الأساس.
7. عند النجاح: تحديث `lastBackupAt`، وعند المشاركة خارج الجهاز: `lastExportAt` (يغذّي التذكير الأسبوعي).

### ٣.٣ الاستعادة

1. فك الأرشيف إلى مجلد مؤقت.
2. **تشغيل تجريبي**: التحقق من صيغة البيان، بصمة القاعدة، بصمة كل مرفق، `integrity_check`، مطابقة الأعداد. `schema_version` أقدم → تُطبَّق الهجرات على النسخة المؤقتة وتُفحص ثانية؛ أحدث من التطبيق → **رفض مؤدَّب** برسالة تطلب تحديث التطبيق.
3. **نسخة أمان إلزامية** من البيانات الحالية بنفس خط الإنشاء المتحقَّق — إن فشلت لا نتقدم.
4. **تبديل ذرّي**: إغلاق القاعدة → إعادة تسمية `data.db` الحالي إلى `data.db.pre-restore` → نقل الجديد مكانه → دمج المرفقات في المخزن (المعنونة بالمحتوى لا تتصادم) → إعادة الفتح والفحص.
5. أي فشل في أي خطوة → **رجوع فوري**: إعادة `data.db.pre-restore` مكانه وإعادة الفتح.

---

## ٤. المحرّك المحاسبي

الحسابات الـ١٩ (تُزرع في أول تشغيل، والأربعة العقارية تُضمن دوماً):
`1100` النقدية والبنوك (grp نقدية) · `1200` الذمم المدينة · `1250` ذمم المطالبات · `1400` أصول ثابتة · `2100` الذمم الدائنة · `2200` ضريبة القيمة المضافة المستحقة · `2300` قروض · `2400` تأمينات المستأجرين · `2450` عرابين الحجز · `3100` رأس المال · `3200` الأرباح المرحّلة · `4100` إيرادات المبيعات · `4200` إيرادات الإيجار · `4300` إيرادات أخرى · `5100` تكلفة المبيعات · `5200` الرواتب والأجور · `5300` مصروفات إدارية وعمومية · `5400` مصروفات أخرى · `5500` مصروفات تأسيس.

**مسار ترحيل واحد** — `postEvent(db, event)` في `src/domain/accounting/post.ts` هو الطريق الوحيد لإنشاء قيود آلية، بجدول التوجيه الملزم:

| src_type | الحدث | مدين | دائن |
|---|---|---|---|
| `contract_deposit` | استلام تأمين | 1100 | **2400** |
| `deposit_deduct` | خصم من التأمين | 2400 | 4300 |
| `deposit_refund` | رد التأمين | 2400 | 1100 |
| `deposit_carry` | ترحيل التأمين عند التجديد | 2400 | 2400 *(لا يزيد الرصيد)* |
| `reservation` | عربون حجز | 1100 | **2450** |
| `reservation_forfeit` | مصادرة العربون | 2450 | 4300 |
| `reservation_convert` | تحويل الحجز لعقد | 2450 | 1200 |
| `claim` | مطالبة | **1250** | 4300 |
| `claim_collect` | تحصيل مطالبة | 1100 | 1250 |
| `rent` | تحصيل إيجار | 1100 | 4200 |
| `key_money` | عمولة تقبيل | 1100 | 4300 |

إضافة إلى قيود الفواتير (1200 / 4100 + 2200) والمشتريات (مصروف حسب الفئة **بكامل المبلغ أساساً وضريبة** / 2100 — بتوجيه المالك 2026-08-20: كل فواتير الشراء تُسجَّل بالكامل ولا تُخصم ضريبتها، فلا سطر على 2200 في الشراء أبداً، والاستبعاد من الإقرار وسم للمستند فقط؛ وفرق التقريب المقبول على 5900) وسدادها (2100 / 1100) — كلها عبر نفس الدالة.

**القيم المشتقة — لا شيء منها مخزَّن:**

| القيمة | الاشتقاق |
|---|---|
| رصيد أي حساب | استعلام SUM على `journal_lines` للقيود المرحّلة + الافتتاحي |
| رصيد البنك | `opening_halalas + SUM(bank_tx.amount_halalas)` للحي منها |
| رصيد المستأجر المستحق | مجموع `amount - paid` لأقساط عقوده غير الملغية (لا مسودة/ملغى) |
| حالة القسط الظاهرة | من `paid_halalas` والتاريخ (قادمة/مستحقة/متأخرة N يوماً/جزئية/مدفوعة) |
| حالة العقد الظاهرة | من `status` المخزنة + التواريخ (سينتهي قريباً ≤٦٠ يوماً…) |
| إشغال الوحدة | عقد غير مسودة وغير ملغى يشمل اليوم؛ ثم حجز نشط؛ ثم شاغرة/صيانة |
| مؤشرات الرئيسية والتحصيل والتقارير | كلها استعلامات على الدفتر والأقساط |

**فحوص المطابقة الثمانية** (تُعرض في «فحص المطابقة» وتُشغَّل قبل كل نسخة احتياطية وتُكتب في البيان) — كانت ستاً وأُضيف إليها اثنان بعد التشغيل الفعلي:

1. مجموع المدين = مجموع الدائن لكل القيود المرحّلة.
2. كل قيد مرحّل متوازن على حدة.
3. تأمينات المستأجرين = التأمينات المحتجزة غير المُسوَّاة.
4. ذمم المطالبات = المطالبات المفتوحة.
5. كل حركة بنكية مرتبطة بحساب حيّ.
6. الأصول = الالتزامات + حقوق الملكية + صافي الدخل.
7. **لا قيود يتيمة لمصادر محذوفة.**
8. **كل دفعة محصَّلة لها قيد مرحّل.**

---

## ٥. قواعد العمل الثلاث عشرة — مواضع التنفيذ

كلها في `src/domain/contracts/rules.ts` (دوال خالصة قابلة للاختبار) وتُستدعى من مسار إنشاء/تجديد/إلغاء العقد:

1. **قيد النشاط/الفئة/فئة الطابق**: نشاط العقار (غير «مختلط») يمنع عقداً على وحدة نوعها مختلف؛ فئة العقار الفرعية وفئة الطابق تمنعان اختلاف فئة الوحدة — بنفس رسائل النموذج.
2. **العقار المستأجَر من الغير**: عقد الوحدة محصور داخل `leaseStart..leaseEnd`.
3. **منع تعارض العقود** زمنياً على نفس الوحدة (`datesOverlap`، مع استثناء الملغاة بعد `cancel_date` لأن نهايتها قُصّت).
4. **الحجز بعربون** يمنع التأجير لغير صاحبه؛ نفس الاسم → يُحوَّل الحجز لعقد (+ قيد `reservation_convert`).
5. **صفحة مراجعة إلزامية** قبل الإنشاء؛ بعد الإنشاء العقد **لا يُعدَّل ولا يُحذف** — يُلغى أو يُجدَّد فقط (مفروض في الواجهة وفي الـrepo).
6. **المسودة بلا رقم**: `contract_no = NULL` تُعرض `—`، لا تستهلك تسلسلاً، تأخذ رقمها (`EJ-YYYY-###` أو رقم إيجار) عند التأكيد. قائمتها: عرض · تعديل · حذف فقط.
7. **التجديد**: يتاح فقط عندما يتبقى ≤٦٠ يوماً، ولا يُجدَّد عقد له `renewed_to`. العقد الجديد نظيف (بلا تسوية/تقييم/إلغاء) ويُجدَّد بدوره لانهائياً. ترحيل التأمين = قيد `2400/2400`، والتأمين الإضافي = `1100/2400`.
8. **التقييم والتصرف بالتأمين** لا يظهران إلا بعد انتهاء العقد (`منتهٍ` أو `ملغى` أو `end < اليوم`).
9. **التقبيل** لا يُسجَّل على عقد ملغى أو مسودة.
10. **جدول الدفعات** يُولَّد آلياً عند الإنشاء (خوارزمية النموذج: عدد الدفعات من المدة/30.44 ÷ الدورة، القسط الأخير يمتص فرق التقريب بالهللات) **ولا يُعاد توليده** أبداً.
11. **إلغاء العقد**: مصير الدفعات المتبقية (تبقى/تُلغى)، تسوية اختيارية، وإن تجاوز الخصمُ التأمينَ **تُنشأ مطالبة تلقائية بالفرق** (`source='تسوية تأمين'` + قيد `claim`)، وتُقصّ نهاية العقد لتاريخ الإلغاء.
12. **تفاصيل الوحدة/العقار عند الإنشاء فقط**، ونموذج الاستلام يُبنى آلياً منها (`buildSectionsFromUnit`: غرف الوحدة ← أقسام العقار «مشترك:» ← العدادات والمفاتيح ← الحالة العامة؛ وإلا فالقالب الافتراضي بأقسامه السبعة).
13. **العدّاد يشير لمورده**: المورد له `utility_type` (كهرباء/ماء فقط)، العدّاد يختار من موردي نوعه، واختيار المورد في فاتورة الشراء يعرض عدّاداته (مع تضييق بالعقار المرتبط)، وربط الفاتورة بعدّاد يسجل قراءة.

---

## ٦. قراءة عقد الإيجار من PDF

نقل حرفي لمنطق النموذج إلى `src/domain/pdf/parseEjar.ts` (خالص، قابل للاختبار) + طبقة استخراج نص:

- استخراج نص PDF: `pdf-lib` لا يستخرج نصاً — نستخدم منطق النموذج نفسه عبر تضمين `pdfjs-dist` (يعمل في RN بـpolyfills) أو وحدة أصلية؛ التجميع سطرياً بفارق `transform[5] > 3` كما في النموذج. للصور: OCR عبر ML Kit (`@react-native-ml-kit/text-recognition`).
- `parseEjarContract`: التسميات الإنجليزية الثابتة، عزل مقطع المستأجر بين `Tenant Data` و`Tenant Representative Data`، رقم العقد بنمط يحوي `/`، الجوال `966→0`، الدورة بخريطة (نصف سنوي→نصف سنوية…)، المدة بالأشهر ÷ 2629800000.
- **كشف النص المعكوس** (صُحّح بعد اصطياد العطب على عقود المالك الحقيقية): الدليل الأول والقاطع هو **أشكال العرض العربية** `[ﭐ-ﻼ]` مقابل الحروف العادية على **النص الخام**، فإن غلبت الأشكال فالنص بصري ويُعكس. والدليل الثاني عند غياب الأشكال هو `arabicIsReversed` بالكلمات المرجعية وموضع أداة التعريف. **والترتيب ملزم: الكشف على الخام ثم العكس ثم التطبيع NFKC ثم لمّ المسافات اللاتينية المبعثرة** (`M ain` تصير `Main`) · فالتطبيع قبل الكشف يمحو الدليل، وانفكاك `ﻻ` قبل العكس يقلبها فتخرج «االمير» بدل «الامير» وهو عين ما رآه المالك.
- `cleanArabicName`: نزع تسمية «الاسم» الملتصقة بمطابقة الرمز الكامل `^[اإآ]*ل?[اإآ]*سم$` — فلا تُقصّ «قاسم» ولا «الاسمري».

---

## ٧. التنبيهات (تُبنى فعلياً بـ expo-notifications)

- مصدر الحقيقة: دالة خالصة `computeReminders(db, settings, today)` تعيد قائمة (دفعة تقترب/متأخرة، عقد يقارب الانتهاء، مستند ينتهي) — نفس منطق `dueReminders` في النموذج.
- المهل من الإعدادات: الدفعة (١/٣/٧/١٤) · العقد (١٥/٣٠/٦٠/٩٠) · المستند (١٥/٣٠/٦٠) + مفتاح تشغيل عام.
- الجدولة: `rescheduleAll()` تلغي المجدول وتعيد جدولته — تُستدعى بعد **كل** تغيير في العقود أو الدفعات أو المستندات أو الإعدادات، وعند إقلاع التطبيق.
- تذكير أسبوعي بالتصدير خارج الجهاز + تحذير أحمر في الإعدادات إن مضى > ٧ أيام بلا تصدير (`lastExportAt`).

---

## ٨. الشاشات الإحدى والعشرون والتنقّل

**تنقّل سفلي (٥):** الرئيسية · العقارات · العقود · التحصيل · المزيد.
**تحت «المزيد» (١٠):** الوحدات · خريطة العقارات · المطالبات · قوالب الرسائل · الفواتير · فواتير الشراء · الموردون · الحسابات البنكية · الحركات البنكية · الإعدادات.
**من الإعدادات (٩):** بيانات المنشأة · التقارير المالية · قوالب الرسائل · إنشاء النماذج · المكتبة · سجل العمليات · فحص المطابقة · دليل الحسابات · القيود اليومية.

الإعدادات صفحة واحدة مسطّحة بأقسامها الأحد عشر (الشاشات · المحاسبة · البيانات والنسخ الاحتياطي · تنبيهات المواعيد · تذكير النسخ الأسبوعي · سلة المحذوفات · المال والفوترة · العرض · بياناتك بالأرقام · عن التطبيق · منطقة الخطر). لا شريط جانبي منزلق ولا قوائم هرمية.

النوافذ الـ٣٩ → `BottomSheet` أصلية بمقبض سحب وتذييل ثابت. القوائم → `FlatList` ببطاقات (سطر عنوان + سطران/ثلاثة تفاصيل + شريط إجراءات — لا سطر لكل حقل). زر رجوع في كل شاشة، وزر أندرويد: يغلق القائمة المنبثقة ← النافذة ← يرجع في المسار. أهداف لمس ≥ ٤٤ نقطة، `SafeAreaView`، وشريطا حجم العرض والخط يبقيان في الإعدادات.

الهوية: زمردي `#1E6E5C` · ذهبي `#B08D3D` · كحلي `#10192E` · ورقي `#F6F4EE` · وردي `#AE4438` · أزرق `#3A5A9C` · خط `IBM Plex Sans Arabic` · الأرقام `tabular-nums` بـ`ltr`.

---

## ٩. الغموض في النموذج وقراراته

مواضع تناقض فيها النموذج نفسه أو نصَّ التوجيه — القرار المعتمد لكل منها:

1. **فحص تأمينات العقود** في النموذج يقارن رصيد `2300` (قروض) بدل `2400` — خطأ في النموذج؛ نعتمد `2400` (التوجيه صريح).
2. **الفحص السادس** في النموذج يرشّح بأسماء أنواع غير موجودة (`أصول`/`التزامات`…) فيخرج أصفاراً دوماً — نعتمد الأسماء الصحيحة (`أصل`/`خصم`/…).
3. **عمولة التقبيل** تُرحَّل في النموذج مرتين (قيد مباشر إلى **4100** + `postKeyMoneyCommission` إلى 4300) — نعتمد قيداً واحداً إلى **4300** كما في جدول التوجيه.
4. **تحويل الحجز لعقد**: النموذج يغيّر حالة الحجز دون ترحيل — نعتمد قيد `2450 → 1200` كما في الجدول.
5. **تسوية التأمين بعد الانتهاء**: استدعاء الترحيل في النموذج مكسور (متغير غير معرّف وأسماء حقول خاطئة) فلا يرحَّل شيء — نعتمد الترحيل الصحيح مرة واحدة عند حفظ التسوية (خصم: `2400/4300`، رد: `2400/1100`)، وكذلك عند الإلغاء مع تسوية.
6. **مدة السلة**: الإعداد ٣٠/٦٠/٩٠ لكن `purgeOldTrash` يثبّت ٣٠ — نعتمد الإعداد (التوجيه صريح).
7. **حالات العقد** في النموذج خليط (`due`/`late`/`ساري`/`منتهي`/`ملغى`) — نوحّدها في القاعدة إلى أربع (`مسودة`/`سارٍ`/`منتهٍ`/`ملغى`) ونشتق شارات العرض (مستحقة/متأخرة/سينتهي قريباً/مسدد بالكامل) من الأقساط والتواريخ. عند التجديد يتحول القديم إلى `منتهٍ` كما في النموذج.
8. **الإشغال**: `unitCurrentContract` في النموذج لا يستثني المسودة — نستثنيها (المسودة لا تشغل وحدة ولا تظهر في التحصيل، كما في بقية النموذج).
9. **رصيد البنك** مخزَّن في النموذج ويُعدَّل يدوياً في كل عملية — نشتقه (`الافتتاحي + مجموع الحركات`)، والسلوك الظاهر مطابق.
10. **رصيد المستأجر** (`balance`) مخزَّن في النموذج ولا يُحدَّث فعلياً — نشتقه من أقساط عقوده (كما تفعل شاشة التحصيل نفسها بـ`tenantOutstanding`).
11. **بنود الفاتورة الافتراضية** («اشتراك شهري — النظام المحاسبي»…) بيانات تجريبية زُرعت في النموذج — التطبيق يبدأ ببند واحد فارغ، ولا تُنقل أي بيانات تجريبية (عملاء/فواتير/قيود seed).
12. `exportBackup` في النموذج لا يحدّث `lastExportAt` رغم اعتماد التحذير الأحمر عليه — نحدّثه عند كل تصدير/مشاركة ناجحة.
13. **علامة إلغاء القسط**: النموذج يستخدم `i.cancelled` في موضع و`status==='ملغية'` في آخر — نعتمد `status='ملغية'` وحدها.
14. **إضافة حساب محاسبي** برصيد افتتاحي من الواجهة تبقى متاحة كما في النموذج (تُخزن في `opening_halalas`).
15. **العملة النقدية**: `cashAccountFor` في النموذج يعيد `1100` دائماً (نقد وبنك سواء) — نبقيه.
16. أخطاء JS داخلية في النموذج (استدعاء `logAudit` بوسائط ناقصة، مراجع `products/employees` المحذوفة في مسار الاستعادة، `renewAddMonths` بـ`toISOString` UTC) — تُنقل الوظيفة الصحيحة لا الخطأ، والتواريخ كلها محلية (`toLocalISODate`).

---

## ١٠. الاختبارات — شرط التسليم

تعمل على Node عبر محوّل `better-sqlite3` لنفس ملفات SQL والمنطق:

- **النسخ الاحتياطي (١٢)**: نسخة بـ٥٠٠٠ مرفق ← استعادة على قاعدة نظيفة ← كل بصمة مطابقة · قطع النسخ في المنتصف · قطع الاستعادة ← رجوع سليم · تعديل بايت ← رفض · حذف ملف من القرص ← نسخة معلَّمة ناقصة · مخطط أقدم ← هجرة · أحدث ← رفض مؤدَّب · امتلاء المساحة ← فشل نظيف · إغلاق قسري أثناء الحفظ ← `integrity_check` سليم · ١٠٠ دورة ← بصمة قاعدة ثابتة · نفس الصورة ٥ مرات ← ملف واحد · تعطيل التجزئة ← رفض إنشاء النسخة.
- **المحاسبة**: Σمدين=Σدائن لأي مجموعة عمليات · إعادة الاحتساب من الصفر = المعروض · الأحداث الأحد عشر تنتج قيودها الصحيحة · الفحوص الستة تمر · المحفّز يرفض القيد غير المتوازن.
- **قواعد العمل**: اختبار لكل قاعدة من الثلاث عشرة.
- **قراءة PDF**: نص عقد بالترتيبين المنطقي والبصري ← ١٠/١٠ حقول · «قاسم» و«الاسمري» لا يُقصّان.

**المضاف بعد البناء الأول** (المجموع اليوم ١٨٥ اختباراً في ٢٩ ملفاً):

- **الأداء تحت الحمل**: ٥٠ عقاراً · ١٠٠٠ وحدة · ٢٠٠٠ عقد · ٢٤٬٠٠٠ قسط ← تجميع شاشة التحصيل والبحث وحالات الوحدات وإحصاءات العقارات كلها تحت عتباتها.
- **السلة الجماعية**: حذف ١٢٧٣ عنصراً واستعادتها بلا خرق مفتاح أجنبي واحد وبلا بقاء يتيم.
- **حراسة النصوص**: اختبار يمنع أي شرطة طويلة في المشروع، واختبار يمنع استيراد `Text` الخام خارج ثمانية مكوّنات أساس (ومعهما قاعدة eslint بالمعنى نفسه).
- **التراجع بقيد عكسي**: بقاء القيد الأصلي بلا حذف مختوماً بمن عكسه، وقيد العكس مرحّلاً ببيانه، والرصيد يعكس القيم الجديدة وحدها، والسجل يحمل القيمة قبل وبعد.
- **حالة العقد المعروضة**: عقد يبدأ مستقبلاً يُعرض «موثَّق ولم يبدأ» في كل موضع، والمقترب يُعرض بعدد أيامه.

---

## ١١. ما تغيّر بعد البناء الأول

كل ما في هذا القسم استُحدث أو نُقض بتوجيهات المالك بعد تسليم البناء الأول، وهو **الحاكم** عند تعارضه مع ما سبقه في هذه الوثيقة.

### ١١.١ الهجرات ١٢ إلى ١٦

| # | ما فعلته |
|---|---|
| ١٢ | **الأرشفة بدل الحذف**: العقار والوحدة والبنك يُؤرشفون حين يرتبط بهم غيرهم · المؤرشف يختفي من قوائم الاختيار ويبقى في الدفتر والتقارير · ومحفّز `trg_je_frozen_del` يرفض حذف أي قيد مرحّل من القاعدة نفسها. |
| ١٣ | فهرس فواتير العدّاد (كشف العدّاد يقفز به من مسح كامل إلى قفزة فهرس). |
| ١٤ | **موعد سداد متفق عليه ومهلة** للقسط (`agreed_date` يحلّ محل الاستحقاق في الحالة والفرز، و`grace_until` يمنع احتسابه متأخراً قبلها) · وحساب **`1265` محفظة إيجار** لما صار ملكنا بعد التسوية ولم يُسحب من محفظة المنصة · و`deduct_destination` في التسوية. |
| ١٥ | زرع قالب التذكير الافتراضي في القاعدة — فلا نص مرسَل في الكود. |
| ١٦ | ضمان وجود صف المنشأة في أي قاعدة مهما كان أصلها (قاعدة بُذرت بنسخة قديمة كانت تُسقط شاشة بيانات المنشأة). |

### ١١.٢ المحاسبة: التصحيح بقيد عكسي لا بإخفاء

**القاعدة الملزمة: القيد المرحّل لا يُمسّ ولا يُخفى.** كل تصحيح يسجَّل قيد عكس مرآة يبقى الأصل بجانبه في الدفتر، لأن البيان يُقدَّم لجهة رسمية والقيد المخفي يمحو الحدث كأنه لم يكن.

| المسار | السلوك |
|---|---|
| تعديل فاتورة مبيعات مرحّلة · إعادتها مسودة | عكس الأصل ثم ترحيل قيد القيم الجديدة |
| تعديل فاتورة شراء مرحّلة | كذلك |
| التراجع عن سداد فاتورة شراء | قيد عكس + **حركة بنكية معاكسة** (لا إخفاء للحركة) فيبقى الكشف صادقاً مع الدفتر |
| حذف فاتورة أو مطالبة · تعديل مطالبة · تعديل تسوية التأمين | عكسية أصلاً |
| القيد اليدوي المرحّل | لا يُعدَّل ولا يُحذف · إجراؤه «عكس القيد»، والمحفّز يرفض الحذف |
| دفعة الإيجار المسجَّلة | لا مسار تعديل ولا تراجع لها في التطبيق كله |

الأثر الجانبي الملزم: **أي استعلام يجمع قيود مستند يجب أن يستثني المعكوس** (`reversed_by IS NULL`) وإلا عدّ الأصل والجديد معاً.
وكل تعديل يسجَّل في سجل العمليات بالقيم **قبل وبعد** (العميل، التاريخ، قبل الضريبة، الضريبة، الإجمالي، الوضع الضريبي).

### ١١.٣ حالة العقد الظاهرة · ست حالات من دالة واحدة

الحالة المخزَّنة أربع فقط (`مسودة`/`سارٍ`/`منتهٍ`/`ملغى`)، والمعروضة **ست تُشتق من التواريخ** بترتيب أسبقية قاطع: ملغى ← مسودة ← **موثَّق ولم يبدأ** (البداية بعد اليوم) ← منتهٍ ← ينتهي قريباً (≤ ٦٠ يوماً) ← سارٍ.

ثلاث دوال في `src/domain/contracts/rules.ts` هي المصدر الوحيد، ولا يجوز لشاشة أن تعرض `status` الخام:

- `contractDisplayStatus` الحالة المنطقية (للمرشِّحات والإحصاءات — لا تتغير أبداً).
- `contractStatusLabel` النص المعروض، و«ينتهي قريباً» وحدها تُعرض بعدد أيامها: «ينتهي اليوم» · «ينتهي غداً» · «ينتهي بعد يومين» · «ينتهي بعد ٧ أيام» · «ينتهي بعد ١٢ يوماً».
- `contractStatusKind` لون الشارة.

تسري على: قائمة العقود · تفاصيله · ملف المستأجر · ورقتَي الوحدة · التنبيهات · تقرير الوحدة · مطبوعة العقد.

### ١١.٤ التأمين: الرقم ملوّناً وحده

لا شارة نصية ولا مفتاح ألوان في أي قائمة أو تفاصيل. اللون وحده يقول أين المبلغ: **أزرق** محتجز لدى منصة إيجار (`1260`) · **أخضر** لدينا (`1100`) · **ذهبي** في محفظة إيجار (`1265`) بعد تسوية بخصم · **رمادي** لدى طرف آخر. والنص في المطبوعات وحدها لأن اللون يضيع في الطباعة.

### ١١.٥ الأداء وأداة قياسه

- **أداة القياس داخل التطبيق** (`src/perf` + شاشة «قياس الأداء»): تسجّل زمن كل انتقال من رفع الإصبع حتى الظهور، وتشرّحه (تجهيز ثم رسم)، وتحصي زمن كل استعلام وأبطأها، وتحفظ العينات في القاعدة فتنجو من إغلاق التطبيق، وتُنسخ تقريراً نصياً واحداً. القياس على **مسار الملاحة** لا على تركيب الشاشات، وإلا غابت الشاشة الحية التي لا يعاد تركيبها.
- **الإقلاع**: لا صيانة قبل أول رسم · إعمار البيانات وجدولة التنبيهات مؤجلة بعده (كانت تكلّف ٢٠ ثانية على البيانات الحقيقية).
- **الشاشات**: `freezeOnBlur` مطفأ (قيس أن إذابة المجمَّد أغلى من إبقائها حية) · هيكل تحميل فوري قبل الجاهزية · قوائم `FlatList` بدفعات أولى صغيرة · وأقسام الرئيسية مقفلة بمغلّف تثبيت فلا يعاد تصييرها بلا تغيير بيانات.
- **الأوراق**: النافذة تنزلق فوراً ومحتواها يُركَّب بعد إطار تحت غطاء الحركة · وورقة قائمة الإجراءات لا تُركَّب إلا عند فتحها (كانت كل بطاقة صف تحمل ورقة مركَّبة).

### ١١.٦ مكوّنات موحّدة (المصدر الواحد لكل نمط)

| المكوّن | ما يوحّده |
|---|---|
| `AppDialog` | كل حوارات التطبيق · أزرار حقيقية · لا نص إنجليزي · ثلاثة خيارات فأكثر تُعرض عمودياً · ولا كسر داخل كلمة |
| `BTN_SIZES` + `BtnIcon` | الأحجام الثلاثة: عادي ٤٠ · صغير ٣٠ · أيقونة ٣٤ بلا إطار (زر ⋮ والإغلاق) |
| `KpiCard` | بطاقة الإحصاء: خلفية الشاشة، حد رفيع بلا ظل ولا شريط، توسيط، السطر الفرعي داخل التسمية، الأحمر للمصروفات وحدها، و«لا يوجد» بخط التسمية |
| `FilterSheet` | زر «تصفية (n)» بورقة سفلية ورقاقات المفعَّل ومسح الكل |
| `Pager` | زر عدد العناصر أسفل القائمة بخيارات لا تتجاوز السجلات ويختفي عند خمسة فأقل |
| `Screen` / `Sheet` | الحواف الجانبية `Math.max(16, insets)` و`Math.max(18, insets)` |
| `ErrorBoundary` | يلتقط أي استثناء شاشة ويعرض نصه قابلاً للنسخ ويسجّله، فلا يخرج التطبيق |

### ١١.٧ شاشات وصفحات كيانات

٢٥ شاشة اليوم. كل كيان يُعرض في قائمة له صفحة تفاصيل تُفتح بالضغط: المورد (بياناته وملخصه المالي وفواتيره المقسَّمة والمفلترة وعدّاداته ومدفوعاته وقيوده ومرفقاته) · البنك (رصيده وحركاته وكل حركة تفتح مستندها) · المستأجر · الوحدة · العقار · العدّاد · الحساب. و**الضغط يفتح العرض لا التعديل**، والتعديل زر داخل صفحة العرض.

### ١١.٨ التقارير والتصدير

شريط تصدير واحد أسفل القائمة المعروضة · المرشحات في ثلاث مجموعات معنونة (السنة · الربع · نوع القائمة) · والقوائم المالية الأربع والميزان تُصدَّر بثلاث صيغ، وملف إكسل يحمل **صيغاً حية** (`SUM` ومراجع خلايا) لصفوف المجاميع لا قيماً ثابتة.

---

## ١٢. قواعد ملزمة من المالك

قواعد عامة تسري على كل بند قادم، مستخلصة من توجيهاته:

1. **التعميم**: أي حل لمشكلة في شاشة يُطبَّق على نظائرها كلها، وتُسلَّم قائمة المواضع.
2. **الاستبدال يزيل القديم**: لا يُترك القديم بجانب الجديد.
3. **لا تُضف ما لم يُطلب**، ولا ملاحظات شرح في الواجهة.
4. **صفر شرطات طويلة** في أي موضع (محروسة باختبار).
5. **كل أيقونة SVG**، وكل مبلغ برمز الريال SVG لا نصاً.
6. **لا حذف لمرتبط**: أرشفة، والقيد يُصحَّح بعكسي.
7. **الزر الذي لا يصح فعله لا يُعرض** — لا معطَّلاً ولا يُعرض ثم يرفض.
8. **كل رقم مجمّع يُفتح** على مكوّناته، وكل خانة تجميعية تفتح **صفحة** لا انسدالاً.
9. **صفر نص مرسَل في الكود**: كل رسالة قالب من قاعدة البيانات.
10. **الإثبات مع كل تسليم**: رقم أو اختبار أو لقطة من النسخة المسلَّمة نفسها.

ودروس النموذج الأربعة تُطبَّق إجرائياً: لا استبدال استدعاء محذوف بقيمة ثابتة؛ فحص الصياغة بعد كل حذف؛ الاختبارات تستدعي المنطق لا تكتفي بالتحميل؛ وفحص تفرّد المعرفات (هنا: قيود UNIQUE في القاعدة تتكفل بها بنيوياً).
