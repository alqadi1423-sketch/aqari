# وثيقة تصميم تطبيق «عقاري» · تابع لمنصة رِكز

> المرجع الملزم: `aqari.html` (٦٬١١١ سطراً، قُرئ كاملاً). هذه الوثيقة تشرح **ما أُعيد بناؤه**: التخزين وطبقة العرض، ثم ما أُضيف فوقهما من حساب ومزامنة ومنشأة. كل قاعدة عمل ونص عربي يُنقلان كما هما.

> **حالة التنفيذ · آخر تحديث ٥ أكتوبر ٢٠٢٦**
> مخطط القاعدة عند الإصدار **٢٣** (ثلاث وعشرون هجرة) · **٢٥ شاشة** · **٦١٠ اختبارات في ٧٥ ملفاً**: ٥٧٦ في التشغيل العادي، و٣٤ في خمسة ملفات تُتخطّى لأنها تحتاج محاكي Firestore (القسم ١٠).
> ما بعد البناء الأول من توجيهات المالك مسجَّل في القسمين **١١ (ما تغيّر بعد البناء الأول)** و**١٢ (قواعد ملزمة من المالك)**، والحساب والمزامنة والمنشأة والنسخ على Drive في القسم **١٣**. هذه الأقسام هي المرجع لكل ما استُحدث أو نُقض من الصفحات قبلها.

---

## ١. المنظومة

```
Expo (React Native) + TypeScript + Expo Router
expo-sqlite · expo-file-system · expo-crypto · expo-sharing · expo-notifications
expo-image-picker · expo-document-picker · expo-print · expo-secure-store · expo-network
react-native-webview + Leaflet مضمّن (src/ui/leafletBundle.ts) · react-native-svg · zod · date-fns
@react-native-google-signin/google-signin · Firebase Auth وFirestore وGoogle Drive عبر REST (بلا حزمة Firebase)
fflate (ضغط أرشيف النسخ الاحتياطي، JS خالص يعمل في RN وNode)
القاعدة المحلية مصدر الحقيقة · والسحابة طبقة مضافة · ويعمل بلا اتصال بعد الدخول الأول
```

الخريطة Leaflet داخل WebView: المكتبة مضمّنة في التطبيق بملف يولّده `scripts/gen-leaflet.js` من حزمة `leaflet`، فالدبابيس والتجميع والتقاط الموقع تعمل بلا اتصال، والبلاطات وحدها من الشبكة (OSM بلا مفاتيح API).

بنية المشروع:

```
D:\Aqari
├── app/                    شاشات Expo Router (تنقّل سفلي بخمسة تبويبات + مسارات «المزيد» والإعدادات)
├── src/
│   ├── db/                 المخطط + الهجرات + جداول المزامنة + محوّل SQLite (expo-sqlite للتطبيق، node:sqlite للاختبارات)
│   ├── domain/             منطق العمل الخالص (محاسبة، عقود، أقساط، قراءة PDF، نسخ احتياطي، تنبيهات، صلاحيات)
│   ├── repos/              طبقة الوصول للبيانات · كل كتابة داخل BEGIN IMMEDIATE
│   ├── files/              مخزن الملفات المعنون بالمحتوى (blobs/attachments)
│   ├── cloud/              عملاء REST خالصة: الدخول، Firestore، Google Drive، الجلسة
│   ├── sync/               محرّك المزامنة ورؤية الصفوف في المنشأة (acl)
│   ├── services/           ربط المنطق بالجهاز: الحساب والمزامنة، المنشأة، نسخ الحسابات، النسخ، الطباعة
│   ├── perf/               قياس الأداء داخل التطبيق (زمن كل انتقال وكل استعلام) · القسم ١١
│   └── ui/                 مكوّنات التصميم الأصلية (Card, BottomSheet, Chips, KPI, LeafletMap, …)
├── scripts/                gen-leaflet.js
├── firestore.rules         قواعد أمان السحابة · قسم المنشأة مولَّد (القسم ١٣)
└── tests/                  Jest · ٧٥ ملفاً (القسم ١٠)
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

كل كتابة داخل `BEGIN IMMEDIATE … COMMIT`، والمتداخلة بنقاط حفظ (`SAVEPOINT`) · وعدّاد التداخل يُضبط مرةً واحدة في كل خروج، فلا يكسر فشلُ `COMMIT` أو `RELEASE` ما بعده، وإن ألغت SQLite المعاملة بنفسها يُرمى الخطأ الأصلي لا خطأ `ROLLBACK` (`makeTransactionRunner` في `src/db/adapter.ts`). المبالغ كلها أعداد صحيحة **بالهللات** (`*_halalas INTEGER`). لا `REAL` في أي حقل مالي: `REAL` مسموح فقط لغير المال (إحداثيات GPS، قراءات العدادات، الكميات).

جدول `meta(key PRIMARY KEY, value)` يحمل `schema_version` و`device_id` وترقيم هذا التثبيت (`number_blocks` كتل الأرقام، و`inv_reserved` و`inv_issue_pending` للفاتورة، و`device_letter` الحرف القديم · القسم ١٣)، وجدول `settings(key PRIMARY KEY, value_json)` يحمل إعدادات التطبيق (المهل، مدة السلة، مقاييس العرض…).

### ٢.٢ المخطط · جدول لكل كيان

المخطط أدناه هو الهجرة الأولى، ومنه تبدأ القاعدة. ما أضافته الهجرات بعدها (حتى الإصدار ٢٣ في `SCHEMA_VERSION` بملف `src/db/schema.ts`) مسجَّل في ١١.١ و١٣.٩، ومنه جداول المزامنة `sync_*` وحسابات النظام الستة المضافة (القسم ٤).

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

**رفض القيد غير المتوازن بمحفّز داخل القاعدة** (لا في الكود فقط): القيد يُدرج بحالة `قيد الإنشاء`، تُضاف سطوره، ثم يُرقّى إلى `مرحّل`، والمحفّز يمنع الترقية إن اختلّ التوازن، ويمنع أي تعديل على سطور قيد مرحّل:

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

**الرصيد مشتقّ لا مخزَّن**: لا عمود `balance` إطلاقاً:

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
  contract_no TEXT UNIQUE,               -- NULL للمسودة (تُعرض «لا يوجد» على الشاشة، وخالية فيما يخرج) · يُمنح عند التأكيد فقط
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
CREATE TABLE deposit_settlements (     -- التصرف بالتأمين · بعد انتهاء العقد فقط
  contract_id TEXT PRIMARY KEY REFERENCES contracts(id),
  date TEXT NOT NULL, deduction_halalas INTEGER NOT NULL DEFAULT 0,
  deduction_reason TEXT DEFAULT '', refund_halalas INTEGER NOT NULL DEFAULT 0, notes TEXT DEFAULT ''
);
CREATE TABLE tenant_ratings (          -- التقييم · بعد انتهاء العقد فقط
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
CREATE TABLE handovers (               -- النموذج المعبّأ لقطة نهائية · يصلح JSON
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

`<documentDirectory>/attachments/<sha256>.<ext>`: القاعدة تحفظ المسار (المشتق من البصمة) والبصمة والحجم فقط. رفع نفس الملف مرتين = بصمة واحدة = صف واحد في `blobs` وملف واحد على القرص، فـ**منع التكرار خاصية بنيوية**. مسار رفع واحد (`filesStore.put`) يمر به كل ملف فيُسجَّل تلقائياً في `attachments` بتصنيفه، وهذا ما تعتمد عليه المكتبة.

حذف مرفق = `deleted_at` على صف `attachments`. لا يُحذف ملف من القرص إلا في كنس دوري يتحقق أن **لا صف حيّ** (attachment غير محذوف، وشعار المنشأة) يشير لبصمته، وبعد انقضاء مهلة السلة.

### ٢.٤ الحذف الناعم والسلة

كل جدول كياني يحمل `deleted_at`. «سلة المحذوفات» = استعلام موحّد على الجداول حيث `deleted_at IS NOT NULL`. الاستعادة = مسح `deleted_at` (مع إعادة ترحيل الأثر المحاسبي كما في النموذج: الفاتورة تُرحَّل من جديد، فاتورة الشراء تُستعاد **غير مسدَّدة**، الحركة البنكية تعيد أثرها). الحذف النهائي بعد انقضاء المدة المختارة من الإعدادات (٣٠/٦٠/٩٠ يوماً · `settings.trashRetention`) أو يدوياً. والقيد المرحّل لا يدخل السلة ولا يُحذف (الهجرة ١٧)، والمرتبط بغيره يُؤرشف بدل الحذف (١١.١).

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

1. تشغيل **فحوص المطابقة الأحد عشر** (القسم ٤) وكتابة نتائجها ومجاميع الدفتر في البيان. والحكم واحد في النسخ والاستعادة (`src/domain/backup/checks.ts`): التلف (مبلغ بالهللات ليس عدداً صحيحاً، ملف مفقود أو تالف، بصمة لا تطابق) يرفض، والفرق المحاسبي لا يمنع حفظ البيانات: النسخة تُنشأ وتُوسم «فيها ملاحظات» بأسماء الفحوص وأرقامها.
2. `PRAGMA wal_checkpoint(TRUNCATE)` ثم `VACUUM INTO 'tmp/data.db'`.
3. بصمة `data.db`، ثم نسخ كل ملف مرفق حيّ مع التحقق من بصمته أثناء النسخ. ملف مفقود من القرص → يُدرج في `missing_files` و`complete=false` (نسخة معلَّمة ناقصة، لا فشل صامت).
4. كتابة البيان وضغط الأرشيف.
5. **التحقق الإلزامي**: يُعاد فتح الأرشيف الناتج، تُعاد بصمة كل ملف و`db_sha256`، ويُفتح `data.db` المنسوخ وتُنفَّذ `PRAGMA integrity_check` وتُطابَق أعداد الجداول مع `table_counts`، **ولا تُسمّى النسخة ناجحة قبل ذلك**. أي فشل → حذف الأرشيف الناتج وإظهار الخطأ.
6. إن كانت وحدة التجزئة (sha256) معطّلة أو فشلت → **يُرفض إنشاء النسخة** من الأساس.
7. عند النجاح: تحديث `lastBackupAt`، وعند المشاركة خارج الجهاز: `lastExportAt` (يغذّي التذكير الأسبوعي).

### ٣.٣ الاستعادة

1. فك الأرشيف إلى مجلد مؤقت.
2. **تشغيل تجريبي**: التحقق من صيغة البيان، بصمة القاعدة، بصمة كل مرفق، `integrity_check`، مطابقة الأعداد. `schema_version` أقدم → تُطبَّق الهجرات على النسخة المؤقتة وتُفحص ثانية؛ أحدث من التطبيق → **رفض مؤدَّب** برسالة تطلب تحديث التطبيق.
3. **نسخة أمان إلزامية** من البيانات الحالية بنفس خط الإنشاء المتحقَّق، في مجلد نسخ دائم لا يُكنس. إن فشلت لا نتقدم.
4. **تبديل ذرّي**: إغلاق القاعدة → إعادة تسمية `data.db` الحالي إلى `data.db.pre-restore` → نقل الجديد مكانه → دمج المرفقات في المخزن (المعنونة بالمحتوى لا تتصادم) → إعادة الفتح والفحص.
5. أي فشل في أي خطوة → **رجوع فوري**: إعادة `data.db.pre-restore` مكانه وإعادة الفتح.
6. **القيد المرحّل لا يُحذف بالاستعادة** (`src/domain/backup/keepPosted.ts`): ما رُحّل بعد تاريخ النسخة، على هذا الجهاز أو في السحابة من غيره، يُضمّ إلى النسخة المستعادة برقمه وسطوره ويُعرض قبل التأكيد، ومعه ما يُحمل من مستنده (الدفعة وتوزيعها، حركة البنك، ربط العكسي بأصله). وما لا يُحمل مستنده يُضمّ قيده ويُدرج في أداة مراجعة الدفتر.

الفحص الدلالي (`src/domain/backup/semantic.ts`) يطبّق قواعد القاعدة على ما يرد من خارج الجهاز: لا قيد مرحّل غير متوازن، ولا قسط يتجاوز مسدَّده مع خصمه مبلغه، ولا دفعة سالبة، وكل مبلغ عدد صحيح. والدالة نفسها تفحص الصف الوارد بالمزامنة (القسم ١٣).

### ٣.٤ كلمة مرور النسخ ونسخة ما قبل الترقية

- **التشفير إجباري** لكل نسخة تخرج من الجهاز (التصدير وGoogle Drive) · قرار المالك 2026-11-07 (التوجيه الرابع ٤ · ٣). الشكل القائم نفسه (`src/domain/backup/encryption.ts`): المفتاح PBKDF2-HMAC-SHA256 بملح عشوائي و٦٠٠٬٠٠٠ دورة، والتشفير AES-256-GCM بقطع موثَّقة، فلا تُبدَّل قطعة ولا تُحذف ولا يُبتر الملف دون كشف. والملف المشفّر لا يُسلَّم قبل أن يُفكّ ويطابق بصمة ما شُفّر.
- **مفتاح الاسترداد** (`src/domain/backup/recoveryKey.ts`): ٢٥ محرفاً من أبجدية كروكفورد في خمس مجموعات، ٢٣ منها عشوائية من مولّد النظام (١١٥ بتاً) ومحرفا تحقق (مجموعٌ موزون باقي ١٠٢١) يكشفان كل خطأ في محرف وكل تبديل لجارين. يولّده الجهاز في «النسخ الاحتياطي ← مفتاح الاسترداد» ويُعرض **مرة واحدة** مع زر النسخ، ولا يُحفظ حتى يكتب المستخدم آخر مجموعة منه دليلاً على حفظه. ثم يُحفظ في مخزن النظام الآمن على هذا الجهاز وحده **لهذا الحساب** (`src/services/backupPassword.ts` · لكل حسابٍ على الجهاز سرّه)، فتُختم به كل نسخة بلا سؤال. والتأكيد بخطوتين: يُعرض المفتاح ويُنسخ، ثم يُخفى ويُكتب آخره. والكتابة تتسامح في الشرطات والمسافات وحالة الحروف وO/I/L والأرقام الهندية. ولا مفتاح خلفي: المفتاح المنسي لا يُستعاد.
- **لا نسخة بلا سرّ** (`src/domain/backup/passwordGate.ts`): بلا مفتاح ولا كلمة مرور قديمة تُرفض النسخة بـ`RecoveryKeyRequiredError` فتُفتح نافذة المفتاح · وسرٌّ وُضع وتعذّرت قراءته يُرفض كما كان. ولا زرّ يزيل السرّ، ويُمحى مع «حذف حسابي» وحده (تفريغ الجهاز).
- **النسخ القديمة**: كلمة المرور القديمة تبقى سرّ الختم حتى يُنشأ المفتاح، وبعده تبقى سرّاً سابقاً على الجهاز: النسخة غير المشفّرة تُستعاد كما هي، والمشفّرة تُجرَّب لها أسرار الحساب المحفوظة (الحالي ثم السابقة) بلا سؤال، ثم يُسأل المستخدم (مفتاحاً أو كلمة مرور).
- **نسخة قبل كل ترقية** لقاعدة فيها بيانات (`src/domain/backup/upgrade.ts`) بالتحقق الكامل نفسه، وفشلها يمنع الترقية. يُحتفظ بآخر ثلاث. **ومرفقٌ مفقود من القرص أو تالف** لا يحبس المستخدم: تكمل النسخة وتسمّيه في `missing_files`، و**تعرض بوابة الترقية اسمه** (`missingFileLabels`: الاسم الظاهر أو الأصلي، وفي البنى القديمة الأصلي) قبل أن تجري الترقية، فلا تجري إلا بعد «متابعة الترقية» (القرارات المعلّقة البند ٣ · الخيار أ).
- **نسخ هذا الجهاز** (`src/domain/backup/deviceBackups.ts`): نوعان كما بُنيا، نسخة الأمان قبل الاستعادة أو المسح (تبقى الأخيرة)، ونسخ ما قبل الترقية (آخر ثلاث). وزر «استعادة» القائم في «البيانات والمساحة» يعرضها كلها بتاريخ كلٍّ ووقتها ونوعها وحجمها إن كانت أكثر من واحدة، ويستعيد المختارة بالمسار المعتاد (القرارات المعلّقة البند ١٧ · الخيار أ). القائمة من أسماء الملفات (الاسم يحمل النوع والوقت وإصدار البنية)، والأحدث بوقته لا بحروف اسمه، واسمٌ ليس في القائمة يُرفض.
- النسخ إلى **Google Drive** في القسم ١٣.

---

## ٤. المحرّك المحاسبي

الحسابات الـ١٩ (تُزرع في أول تشغيل، والأربعة العقارية تُضمن دوماً):
`1100` النقدية والبنوك (grp نقدية) · `1200` الذمم المدينة · `1250` ذمم المطالبات · `1400` أصول ثابتة · `2100` الذمم الدائنة · `2200` ضريبة القيمة المضافة المستحقة · `2300` قروض · `2400` تأمينات المستأجرين · `2450` عرابين الحجز · `3100` رأس المال · `3200` الأرباح المرحّلة · `4100` إيرادات المبيعات · `4200` إيرادات الإيجار · `4300` إيرادات أخرى · `5100` تكلفة المبيعات · `5200` الرواتب والأجور · `5300` مصروفات إدارية وعمومية · `5400` مصروفات أخرى · `5500` مصروفات تأسيس.

وأضافت الهجرات ستة حسابات نظام تُضمن في كل قاعدة: `1260` تأمينات محتجزة لدى الغير · `1265` محفظة إيجار · `1270` ضريبة مدخلات قابلة للاسترداد · `2410` أرصدة مستأجرين دائنة · `4900` خصومات ممنوحة · `5900` فروق تقريب.

**فصل إيراد العقد** (قرار المالك ٢٠٢٦-١٠-٠٧ · الهجرة ٣٢): حسابا `4210` «إيرادات الخدمات (غاز وكهرباء ومياه)» و`4220` «إيرادات المواقف» تحت 4200، وفي العقد عمودا `services_halalas` و`parking_halalas` (فوق قيمته، و«قيمة العقد» هي «كامل قيمة الإيجار»).
- **قيمة العقد «كامل قيمة الإيجار»** لا «إجمالي قيمة العقد» (قرار المالك ٢٠٢٦-١٠-٠٧)، والخدمات والمواقف فوقها. **وإجمالي العقد** مجموع الثلاثة (`contractTotalSql` و`draftTotal`)، وهو مجموع الأقساط، وبه يُحسب الاستحقاق والمتبقي وقيمة الملغى ومتغيرا «المبلغ» و«المتبقي» في القوالب.
- الأقساط كما هي في جدول إيجار لا تُقسم، والإيراد عند كل ترحيل يُقسم بنسبتهما من إجمالي العقد (`src/domain/accounting/rentSplit.ts`): التحصيل، وتحويل الحجز، والخصم المرحَّل، والتخصيص الجماعي، وردّ ما قُبض فوق الأقساط وإبقاؤه رصيداً.
- الهللات الباقية من القسمة على الإيجار، فيطابق المجموع المحصَّل.
- العقد بلا تفصيل إيراده كله على 4200 كما كان، وإجماليه قيمته.
- مراجعة الدفتر تعدّ الحسابات الثلاثة معاً إيرادَ العقد.
- عند قراءة عقد إيجار: الخدمات مجموع الغاز والكهرباء والمياه في بياناته المالية، والمواقف ما بقي من إجمالي القيمة بعد كامل قيمة الإيجار والخدمات. وتعرض مراجعة الجدول قبل الإنشاء التفصيل.
- **إصلاحات المراجعة المستقلة (محور قيمة العقد، الصفوف ١–١٠، قرار المالك 2026-10-07):**
  - المسودة تحفظ الخدمات والمواقف وتعيدها عند فتحها، والتوثيق منها يأخذهما.
  - جدول إيجار بمبالغه كما هي: لا استبدال صامت، والفرق عن الإجمالي تنبيه أحمر في المراجعة، ولا توثيق حتى يتطابقا (`scheduleSumGap`).
  - التجديد ينقل الخدمات والمواقف (خانتان مملوءتان من السابق)، وتدخلان الأقساط وفصل الإيراد.
  - المطبوعة: قيمة الإيجار والخدمات والمواقف والإجمالي، والمبلغ بالحروف للإجمالي.
  - العرض والتقارير: إجمالي العقد في القائمة وملف المستأجر وتقرير الوحدة وتصديره، والتفصيل في صفحة العقد.
  - القوالب: `{المبلغ}` صفر حين لا يبقى قسط مفتوح، ومتغيرات `{إجمالي_العقد}` و`{الخدمات}` و`{المواقف}`.
  - قيمة الملغى بتعريف واحد للبطاقة والإحصاء: المتبقي من الأقساط الملغاة بعد المسدَّد والخصم.
  - المتبقي في التجديد من الأقساط الحيّة بعد المسدَّد والخصم (`contractRemainingHalalas`).
  - التقسيم تراكمي على مستوى العقد: نصيب كل حساب بعد الدفعة نسبته من مجموع إيراد العقد المرحَّل، فلا تتآكل الهللات.
  - بعد التحقق المستقل (6024cd7):
    - خانتا «الخدمات» و«المواقف» في نموذج العقد، فالفرق عن جدول إيجار يصحّحه المستخدم بيده.
    - قراءة ملف تكتب المبلغين صراحةً، صفراً إن لم يكن فيه خدمات ولا مواقف.
    - قيمة الملغى بالتعريف الواحد في إحصاء كل العقارات أيضاً.
    - التفصيل في تقرير الوحدة وتصديره وملف المستأجر.
    - الترتيب «حسب القيمة» بالإجمالي.
    - فحص بُعد العقد في السطور لا يُخزّن نتيجته السلبية.
    - الهجرة ٣٣: فهرس `journal_lines(contract_id, account_code)` للتقسيم التراكمي.
  - تعليق الهجرة ٣٢ في `schema.ts` يصف المبلغين بوصفهما قبل قرار «كامل قيمة الإيجار»، ويبقى كما هو لأن الترحيلة السابقة لا تُمسّ. والمرجع هذا القسم.

**مسار ترحيل واحد**: `postEntry(db, args)` في `src/domain/accounting/post.ts` هو الطريق الوحيد لإنشاء القيود؛ يُدرج القيد «قيد الإنشاء» ويضيف سطوره ثم يرقّيه «مرحّل» فيمرّ بمحفّز التوازن. ولكل حدث دالة تبني سطوره (`postContractDeposit` و`postRentCollection`…) بجدول التوجيه الملزم:

| src_type | الحدث | مدين | دائن |
|---|---|---|---|
| `contract_deposit` | استلام تأمين | 1100 (أو 1260 إن قبضته منصة إيجار، ولا قيد إن قبضه طرف آخر) | **2400** |
| `deposit_deduct` | خصم من التأمين | 2400 | 4300 (بلا ضريبة مخرجات ولو كانت المنشأة مسجّلة: تعويضٌ لا توريد · البند ١١) |
| `deposit_refund` | رد التأمين | 2400 | 1100 (أو 1260 إن رُدَّ عبر منصة إيجار، ولا قيد إن كان لدى طرف آخر) |
| `deposit_carry` | ترحيل التأمين عند التجديد | 2400 *(بأبعاد العقد القديم)* | 2400 *(بأبعاد الجديد · لا يزيد الرصيد)* |
| `reservation` | عربون حجز | 1100 | **2450** |
| `reservation_forfeit` | مصادرة العربون | 2450 | 4300 (بلا ضريبة مخرجات: تتبع العقد الذي لم يتمّ · البند ١١) |
| `reservation_convert` | تحويل الحجز لعقد (قيدٌ لكل قسط يغطيه، بأبعاد العقد) | 2450 | إيراد الإيجار (4200 وتقسيمه على 4210 و4220) |
| `claim` | مطالبة | **1250** | 4300 (بلا ضريبة مخرجات: تعويضٌ أو استرداد تكلفة · البند ١١) |
| `claim_collect` | تحصيل مطالبة | 1100 | 1250 |
| `rent` | تحصيل إيجار | 1100 (والشيك والبطاقة والتحويل ببنكها) | 4200 وتقسيمه (وفائض التحصيل الجماعي 2410) |
| `rent` *(من الرصيد الدائن)* | سداد قسط من رصيد المستأجر الدائن | 2410 | 4200 وتقسيمه |
| `key_money` | عمولة تقبيل | 1100 بالمقبوض كاملاً (وحركة البنك به) | 4300 · والمنشأة المسجّلة في الضريبة: 4300 بالصافي و**2200** بالضريبة (المقبوض شاملٌ ١٥٪، الصافي = round(المبلغ × 100 ÷ 115)) فيدخل البند ١ من الإقرار بتاريخ الصفقة، وعكسه ينقصه في فترة العكس ولا يسبق تاريخ الصفقة، ولا تُستعاد الصفقة إلى فترةٍ قُدِّم إقرارها (المراجعة الشاملة ٨ · البند ١١) |

> **كفاية البنك في العكس (A2.2):** ما يُخرجه من بنكٍ عكسُ حركات قيدٍ أو إعادةُ نسخها يُفحص برصيده قبل أي كتابة (`bankShortages` و`requireBanksCover` في `cashGuard.ts`): عكس تحصيل الفاتورة، وإلغاء التقبيل (مانعٌ في لوحة الإلغاء)، واستعادة ما سُدّد من بنك (`repostBlockers`)، وإلغاء دفعة الإيجار (`planCancelPayment`) · وإعادة التحصيل إلى البنك نفسه تُرجع ما يُخرجه عكسها فلا تُفحص وحدها.

> **المقبوض نقداً (المراجعة الشاملة 2026-11-13 · A2.1):** دفعة التحصيل تحمل المقبوض كله ومنه الفائض الذي ذهب إلى 2410، فسداد القسط من الرصيد الدائن لا يُعدّ مقبوضاً ثانية: «المحصَّل» و«الدخل المحصَّل» في تقرير الوحدة والعقار وبطاقات العقارات وكشف المستأجر تجمع `paymentCash` (صفرٌ لطريقة «من الرصيد الدائن»)، وما سُدّد به القسط (`DERIVED_PAID_SQL`) يبقى بصافيه.

*(الجدول محدَّث بمراجعة التثبيت #64 وما بعدها: كان `reservation_convert` دائنه 1200 و`deposit_refund` بلا 1260.)*

إضافة إلى قيود الفواتير (1200 / 4100 + 2200) وتحصيلها (`invoice_pay`: النقد أو البنك / 1200، الهجرة ٢٣)، والمشتريات (`purchase`): الفاتورة «غير قابلة للخصم»، وهي الافتراض، تُسجَّل مصروفاً حسب الفئة **بكامل مبلغها أساساً وضريبة** / 2100؛ والفاتورة الضريبية باسم المنشأة ورقمها الضريبي «قابلة للخصم» تُحمَّل ضريبتها على 1270 حتى تُقفل بالاسترداد (`vat_refund`: 1100 / 1270) أو بالرفض (مصروف الفئة / 1270). فلا سطر على 2200 في الشراء، وفرق التقريب المقبول على 5900. وسداد المشتريات (`purchase_pay`: 2100 / 1100)، وخصم الدفعة «بعد الاستحقاق» على 4900، ورد العربون (`reservation_refund`) وعمليات النقد (`cash_op`)، كلها عبر المسار نفسه.

**القيم المشتقة، لا شيء منها مخزَّن:**

| القيمة | الاشتقاق |
|---|---|
| رصيد أي حساب | استعلام SUM على `journal_lines` للقيود المرحّلة + الافتتاحي |
| رصيد البنك | `opening_halalas + SUM(bank_tx.amount_halalas)` للحي منها |
| رصيد المستأجر المستحق | مجموع `amount - paid` لأقساط عقوده غير الملغية (لا مسودة/ملغى) |
| حالة القسط الظاهرة | من `paid_halalas` والتاريخ (قادمة/مستحقة/متأخرة N يوماً/جزئية/مدفوعة) |
| حالة العقد الظاهرة | من `status` المخزنة + التواريخ (سينتهي قريباً ≤٦٠ يوماً…) |
| إشغال الوحدة | عقد غير مسودة وغير ملغى يشمل اليوم؛ ثم حجز نشط؛ ثم شاغرة/صيانة |
| مؤشرات الرئيسية والتحصيل والتقارير | كلها استعلامات على الدفتر والأقساط |

**فحوص المطابقة الأحد عشر** (`src/domain/accounting/integrity.ts`، تُعرض في «فحص المطابقة» وتُشغَّل قبل كل نسخة احتياطية وتُكتب في البيان). كانت ستاً ثم أُضيف إليها خمسة:

1. مجموع المدين = مجموع الدائن لكل القيود المرحّلة.
2. كل قيد مرحّل متوازن على حدة.
3. تأمينات المستأجرين = التأمينات المحتجزة غير المُسوَّاة.
4. ذمم المطالبات = المطالبات المفتوحة.
5. كل حركة بنكية مرتبطة بحساب حيّ.
6. الأصول = الالتزامات + حقوق الملكية + صافي الدخل.
7. **لا قيود يتيمة لمصادر محذوفة.**
8. **كل دفعة محصَّلة لها قيد مرحّل.**
9. **ذمم الفواتير = الفواتير المصدرة غير المحصّلة.**
10. **عربون الحجوزات = العربون المحتجز غير المسوّى.**
11. **لا سجل يتيم**: دفعة أو قسط بلا عقد، أو عقد بلا وحدة.

### ٤.١ أبعاد الدفتر ومراكز التكلفة (قرار المالك ٢٠٢٦-١٠-٠٤ · الهجرة ٢٨)

- كل سطر قيد يحمل خمسة أبعاد: `property_id` و`unit_id` و`contract_id` و`cost_center_id` و`asset_id` (الأصل للبند الرابع).
- **العقار والوحدة والعقد** تُشتق داخل `postEntry` من مستند القيد (`dimsFromSource` في `src/domain/accounting/dimensions.ts`):
  - التحصيل والخصم والفائض: من الدفعة أو القسط ثم العقد.
  - التأمين: من العقد.
  - المطالبة: من عقدها.
  - الحجز: من وحدته، ومن عقده إن تحوّل.
  - التقبيل: من عقده أو وحدته.
  - المشتريات والفواتير: من عقارها ووحدتها.
  - القيد اليدوي وعمليات النقد واسترداد الضريبة بلا عقار.
  - القيد العاكس ينسخ أبعاد أصله سطراً بسطر.
- **مركز التكلفة**:
  - تختاره الشاشة التي أنشأت القيد (`withCostCenter` حول العملية)، وافتراضه «عام» (`cc-general`)، وهو ثابت المعرّف على كل جهاز ولا يُحذف (محفّزان في الهجرة ٢٨).
  - الحقل في شاشات: التحصيل، وإنشاء العقد وتجديده وإنهائه وتسوية تأمينه والتقبيل، وعمليات النقد وإيداع المالك، والقيد اليدوي، والمشتريات وسدادها، والفواتير وتحصيلها، والمطالبات، والحجز وتسوية عربونه، وتسوية الفائض.
  - ما يُنفَّذ بضغطة بلا نموذج يرث مركز مستندها الأصلي (قرار المالك ٢٠٢٦-١٠-٠٧ · `inheritedCostCenter`)، فإن لم يكن له مركز فـ«عام»:
    - تحصيل المطالبة يرث من المطالبة، وإلغاء الحجز من الحجز.
    - قيد الخصم من المراجعة يرث من قيد الدفعة، واسترداد الضريبة ورفضها من فاتورة الشراء.
    - الفاتورة التي تصدر برقمها لاحقاً عند عودة الاتصال ترث مركزها المحفوظ معها عند حفظها (الهجرة ٣٠).
  - الترتيب في `postEntry`: الصريح، ثم اختيار الشاشة، ثم مركز المستند الأصلي، ثم «عام».
  - إدارة المراكز في الإعدادات ← بطاقة المالية، وصلاحيتها صلاحية الدفتر في جدول الأقسام. المحذوف يخرج من القائمة وتبقى سطوره بمعرّفه، ويظهر في التقرير «(محذوف)».
- **القيد المرحّل** تبقى مبالغه وحساباته مجمّدة، وتُعدَّل أبعاده وحدها، محلياً (`trg_jl_frozen_upd`) وفي السحابة (`orgOnlyLineDims`، حتى ٢٤ سطراً).
- **القيود القديمة**:
  - تعرضها «مراجعة الدفتر ← أبعاد القيود القديمة»: ما عُرف مصدره وما لم يُعرف.
  - لا يُملأ شيء إلا بضغط المالك «ملء»، ومركز المملوء «عام».
  - ما لا مصدر له يبقى فارغاً حتى يقرّ المالك إبقاءه بلا أبعاد.
- **التقارير**:
  - القوائم الأربع وميزان المراجعة وكشف الحساب وتصديرها تُصفّى بالعقار والوحدة والعقد ومركز التكلفة.
  - المصفّاة لا تشمل الأرصدة الافتتاحية، لأنها بلا أبعاد.
  - تبويب «مراكز التكلفة» يعرض إيرادات كل مركز ومصروفاته وصافيه.

### ٤.٢ الأصول (قرار المالك ٢٠٢٦-١٠-٠٤ على موجز الأصول · الهجرة ٢٩ · `src/domain/assets`)

**الحسابات**
- الفئات السبع 1410–1470 بأعمارها الافتراضية: ٨٤، ٦٠، ٦٠، ٣٦، ٣٦، ١٢٠، ٦٠ شهراً. العمر يُعدَّل لكل أصل.
- مجمع الإهلاك 1490 حسابٌ واحد، والتفصيل لكل أصل من بُعد `asset_id` في السطر.
- مصروف الإهلاك 5600، وخسارة الاستبعاد 5700، وأرباح البيع 4400.
- الحساب 1400 القائم يبقى للأصول المسجّلة يدوياً قبل هذا القسم.

**الجداول**
- `assets`؛ والحالة رمز: `in_service`، `maintenance`، `disposed`، `sold`.
- `asset_events`، و`purchase_lines`، و`depreciation_runs`.
- الحالات والمصادر وأنواع الأحداث رموزٌ ثابتة تُترجم عند العرض.

**الإهلاك**
- بالقسط الثابت، يبدأ من الشهر التالي للشراء، وآخر شهرٍ يأخذ فرق الهللات.
- ما يُرحَّل هو دائماً **المستحق حتى التاريخ ناقص المرحَّل من الدفتر**. فلا يتكرر، ويصحّح نفسه بعد التحويل والنقل والاستبعاد.
- **الآلي:**
  - على جهاز المالك وحده، بعد دورة مزامنة لم يبقَ بعدها ما ينتظر الرفع، وعند الإقلاع إن لم تكن المزامنة مفعّلة (`assets/auto.ts`).
  - قيدٌ واحد لكل شهر انتهى، بأبعاد الأصل ووحدته وعقاره والعقد الساري آخر الشهر.
  - إن رحّل جهازان الشهر نفسه ظهر التكرار في مراجعة الدفتر مع زر عكس الزائد. **معتمد مؤقتاً، وينتقل إلى الخادم بعد تفعيل الفوترة.**
- **القيمة الدفترية** مشتقة من الدفتر: سطور حساب الفئة للأصل ناقص سطور المجمع له.

**دورة الأصل**
- **بلا فاتورة:** «بانتظار تكلفة»، بلا قيد ولا إهلاك، ويظهر في مراجعة الدفتر.
  - إثبات تكلفته: مدين الفئة / دائن 3100 بتاريخ اليوم.
  - ومعه إهلاك ما فات: السنة الجارية على 5600، وما قبلها على 3200.
- **فاتورة الشراء ببنود:**
  - بند الأصل يُقيَّد على حساب فئته بأساسه ونصيبه من الضريبة، إلا «القابلة للخصم» فضريبتها في 1270.
  - الكمية تُنشئ أصولاً، والهللة الباقية على الأول.
  - البند قد يُثبت تكلفة أصلٍ قائم «بانتظار تكلفة».
  - الفاتورة بلا بنود تبقى كما هي.
  - فاتورةٌ لأصولها إهلاك أو حركة لا تُعدَّل ولا تُحذف.
- **النقل والاستبعاد والبيع:**
  - كلها بتاريخها، بعد آخر شهرٍ رُحِّل إهلاكه.
  - **النقل:** إهلاك الأيام قبله على الوحدة القديمة، ثم قيدٌ ينقل التكلفة والمجمع إلى أبعاد الجديدة.
  - **الاستبعاد:** المجمع، والقيمة الدفترية خسارةً في 5700.
  - **البيع:** النقد أو البنك مع المجمع / الفئة، والفرق ربحٌ في 4400 أو خسارة في 5700.
- **تحويل الفواتير القديمة:**
  - معاينةٌ تعرض الأصول، وقيد إعادة التصنيف، وإهلاك ما فات، والجدول سنةً بسنة، والقيمة الدفترية اليوم.
  - التنفيذ بتاريخ التحويل.
  - التراجع عمليةٌ واحدة ما لم يُنقل أصلٌ أو يُستبعد أو يُبع.
- **المحتويات إلى أصول:** الفئة مقترحة من الاسم بكلمات ملفي الترجمة، وكل بندٍ «بانتظار تكلفة».
- **الضمان:** تنبيهٌ قبل انتهائه بمدة من الإعدادات، وفي بطاقة تنبيهات الرئيسية.

**الرؤية والتقارير**
- من يرى الوحدة (الفني ومندوب الاستلام) يرى أصلها بلا تكلفته (إسقاط المبالغ). التكلفة والقيمة الدفترية لقسم الأصول.
- **قائمة التدفقات النقدية:**
  - قيود الأصول غير النقدية (الإهلاك، وإعادة التصنيف، والاستبعاد، والبيع، وإثبات التكلفة) خارج التشغيلي.
  - الاستثماري: شراء الأصول الثابتة، ومتحصّل البيع (`cashFlowFigures`).

---

## ٥. قواعد العمل الثلاث عشرة · مواضع التنفيذ

كلها في `src/domain/contracts/rules.ts` (دوال خالصة قابلة للاختبار) وتُستدعى من مسار إنشاء/تجديد/إلغاء العقد:

1. **قيد النشاط/الفئة/فئة الطابق**: نشاط العقار (غير «مختلط») يمنع عقداً على وحدة نوعها مختلف؛ فئة العقار الفرعية وفئة الطابق تمنعان اختلاف فئة الوحدة، بنفس رسائل النموذج.
2. **العقار المستأجَر من الغير**: عقد الوحدة محصور داخل `leaseStart..leaseEnd`.
3. **منع تعارض العقود** زمنياً على نفس الوحدة (`datesOverlap`، مع استثناء الملغاة بعد `cancel_date` لأن نهايتها قُصّت).
4. **الحجز بعربون** يمنع التأجير لغير صاحبه؛ والعقد يُربط بالحجز **بمعرّفه لا بالاسم** (قرار المالك 2026-10-05) فيُحوَّل الحجز لعقد (+ قيد `reservation_convert`).
5. **صفحة مراجعة إلزامية** قبل الإنشاء؛ بعد الإنشاء العقد **لا يُعدَّل ولا يُحذف**: يُلغى أو يُجدَّد فقط (مفروض في الواجهة وفي الـrepo).
6. **المسودة بلا رقم**: `contract_no = NULL` تُعرض «لا يوجد» على الشاشة، وخانته خالية في المطبوعات والتصدير والرسائل (القاعدة: «لأن قارئها لا يعلم ما حُذف»، قرار المالك 2026-09-09 والبند ٤ (أ) 2026-11-07 · `dfmtOut` وما يخرج من التطبيق)، لا تستهلك تسلسلاً، تأخذ رقمها (`EJ-YYYY-###` أو رقم إيجار) عند التأكيد. قائمتها: عرض · تعديل · حذف فقط.
7. **التجديد**: يتاح فقط عندما يتبقى ≤٦٠ يوماً، ولا يُجدَّد عقد له `renewed_to`. العقد الجديد نظيف (بلا تسوية/تقييم/إلغاء) ويُجدَّد بدوره لانهائياً. ترحيل التأمين = قيد `2400/2400`، والتأمين الإضافي = `1100/2400`. وخانة الترحيل غير مؤشَّرة كما تفتح، ولا تُعرض لتأمينٍ سُوّي، والخدمة وجهاز المالك يرفضان ترحيل تأمينٍ سُوّي (المراجعة الشاملة 2026-11-13 · A1-1) · وفحص المطابقة الثالث يستثني العقد المجدَّد حين رُحِّل تأمينه فعلاً بقيد `deposit_carry` حيّ، لا لمجرد أن له خلفاً (A1-3).
8. **التقييم والتصرف بالتأمين** لا يظهران إلا بعد انتهاء العقد (`منتهٍ` أو `ملغى` أو `end < اليوم`).
9. **التقبيل** لا يُسجَّل على عقد ملغى أو مسودة.
10. **جدول الدفعات** من جدول دفعات منصة إيجار نفسه، **وإن تعذّر يُحسب مع تنبيه** (قرار المالك 2026-10-05 و2026-10-07) بخوارزمية النموذج (عدد الدفعات من المدة/30.44 ÷ الدورة، القسط الأخير يمتص فرق التقريب بالهللات)، **ولا يُعاد توليده** أبداً.
11. **إلغاء العقد**: مصير الدفعات المتبقية (تبقى/تُلغى)، تسوية اختيارية، وإن تجاوز الخصمُ التأمينَ **تُنشأ مطالبة تلقائية بالفرق** (`source='تسوية تأمين'` + قيد `claim`)، وتُقصّ نهاية العقد لتاريخ الإلغاء.
12. **تفاصيل الوحدة/العقار عند الإنشاء فقط**، ونموذج الاستلام يُبنى آلياً منها (`buildSectionsFromUnit`: غرف الوحدة ← أقسام العقار «مشترك:» ← العدادات والمفاتيح ← الحالة العامة؛ وإلا فالقالب الافتراضي بأقسامه السبعة).
13. **العدّاد يشير لمورده**: المورد له `utility_type` (كهرباء/ماء فقط)، العدّاد يختار من موردي نوعه، واختيار المورد في فاتورة الشراء يعرض عدّاداته (مع تضييق بالعقار المرتبط)، وربط الفاتورة بعدّاد يسجل قراءة.

---

## ٦. قراءة عقد الإيجار من PDF

نقل حرفي لمنطق النموذج إلى `src/domain/pdf/parseEjar.ts` (خالص، قابل للاختبار) + طبقة استخراج نص:

- استخراج نص PDF: `pdf.js` لا يعمل على محرك Hermes، فالاستخراج بمستخرج مصغّر خالص بجافاسكربت (`src/domain/pdf/miniPdfText.ts`) يغطي ملفات PDF المولَّدة رقمياً كعقود الإيجار: فك FlateDecode عبر fflate، وخرائط ToUnicode لفك رموز CID، ومجاري الكائنات المضغوطة، والتجميع سطرياً بفارق عمودي > 3 كما في النموذج. للصور: OCR عبر ML Kit (`@react-native-ml-kit/text-recognition`). · وML Kit لا يرسل الصورة ولا نصها (وما يُحفظ من نتيجتها يتبع المزامنة كبقية البيانات)، لكنه يرسل إلى قوقل بيانات استعمالٍ تقنية (الجهاز والتطبيق ومعرّف التثبيت والأحداث)، ولا يقرأ العربية · ويُستبدل في خطة الخروج من قوقل (المراجعة الشاملة 2026-11-13 · F-2).
- `parseEjarContract`: التسميات الإنجليزية الثابتة، عزل مقطع المستأجر بين `Tenant Data` و`Tenant Representative Data`، رقم العقد بنمط يحوي `/`، الجوال `966→0`، الدورة بخريطة (نصف سنوي→نصف سنوية…)، المدة بالأشهر ÷ 2629800000.
- **كشف النص المعكوس** (صُحّح بعد اصطياد العطب على عقود المالك الحقيقية): الدليل الأول والقاطع هو **أشكال العرض العربية** `[ﭐ-ﻼ]` مقابل الحروف العادية على **النص الخام**، فإن غلبت الأشكال فالنص بصري ويُعكس. والدليل الثاني عند غياب الأشكال هو `arabicIsReversed` بالكلمات المرجعية وموضع أداة التعريف. **والترتيب ملزم: الكشف على الخام ثم العكس ثم التطبيع NFKC ثم لمّ المسافات اللاتينية المبعثرة** (`M ain` تصير `Main`) · فالتطبيع قبل الكشف يمحو الدليل، وانفكاك `ﻻ` قبل العكس يقلبها فتخرج «االمير» بدل «الامير» وهو عين ما رآه المالك.
- `cleanArabicName`: نزع تسمية «الاسم» الملتصقة بمطابقة الرمز الكامل `^[اإآ]*ل?[اإآ]*سم$`، فلا تُقصّ «قاسم» ولا «الاسمري». والتسمية المقسومة على كلمتين («الا سم») تُنزع معاً.
- **أعطال قراءة العقد ٢٠٢٦-١٠-٠٧:**
  - **المسافات:** ملفات إيجار ترسم كل حرف قطعةً مستقلة وترسم المسافات حروفاً.
    - تقدير المسافة بعرضٍ ثابت للحرف كان يزيحها حرفاً في الأسماء العربية: الألف ضيّقة تخفي الفجوة، والياء الأخيرة عريضة تصنع فجوةً كاذبة.
    - الصفحة التي ترسم مسافاتها تُجمَّع بها وحدها، وما لا يرسمها يبقى على التقدير.
  - **جدول الدفعات:** في الصف تاريخان ميلاديان، الاستحقاق ونهاية مهلة السداد، وترتيب أعمدتهما في النص المستخرج يتبع الرسم.
    - الأبكر هو الاستحقاق (`due_date`)، والأبعد آخر المهلة (`grace_until`).
    - قبل إنشاء العقد يُعرض الجدول كاملاً في صفحة المراجعة: الرقم، والاستحقاق، وآخر المهلة، والمبلغ، مع تنبيه إن كان محسوباً لا مقروءاً.
    - وأداة المقارنة في «فحص المطابقة» تقارن الاستحقاق وآخر المهلة كليهما.
  - **حقل اسم المستأجر** في إنشاء العقد بلا اقتراحات من أسماء مستأجرين سابقين.
- **البنود التي لها خانة** (`src/domain/pdf/ejarExtras.ts`): تُقرأ وتُقارن بالقائم قبل الحفظ، ولا يُكتب فوق قيمة إلا بالموافقة، وبيانات المؤجر تُقارن ولا تُكتب فوق بيانات المنشأة.
  - **الغرف:** يُقرأ جدول الغرف على هيئته (النوع وعدده بأيّ الترتيبين) ويُسمّى منه: الواحدة باسم نوعها، والأكثر مرقّمة. والمقارنة تعرض الناقص من غرف الوحدة، والموافقة تضيف الناقص وحده ولا تمسّ القائمة ومحتوياتها. وجدول المكيفات يُقرأ للأصول لاحقاً.
  - **عدّاد الغاز:** نوع عدّاد ثالث بالهجرة ٣١ (إعادة بناء جدول العدادات بقيده الجديد)، فيُكتب رقمه من العقد كالكهرباء والمياه.

---

## ٧. التنبيهات (تُبنى فعلياً بـ expo-notifications)

- مصدر الحقيقة: دالة خالصة `computeReminders(db, settings, today)` تعيد قائمة (دفعة تقترب/متأخرة، عقد يقارب الانتهاء، مستند ينتهي)، بنفس منطق `dueReminders` في النموذج.
- المهل من الإعدادات: الدفعة (١/٣/٧/١٤) · العقد (١٥/٣٠/٦٠/٩٠) · المستند (١٥/٣٠/٦٠) + مفتاح تشغيل عام.
- الجدولة: `rescheduleAll()` تلغي المجدول وتعيد جدولته، وتُستدعى بعد **كل** تغيير في العقود أو الدفعات أو المستندات أو الإعدادات، وعند إقلاع التطبيق.
- تذكير أسبوعي بالتصدير خارج الجهاز + تحذير أحمر في الإعدادات إن مضى > ٧ أيام بلا تصدير (`lastExportAt`).

---

## ٨. الشاشات والتنقّل

٢٥ شاشة: خمسة تبويبات وعشرون تحت «المزيد».

**تنقّل سفلي (٥):** الرئيسية · العقارات · العقود · التحصيل · المزيد.
**تحت «المزيد» (٢٠) في خمس مجموعات** (`src/ui/moreScreens.ts`): العقار والتشغيل (الوحدات · خريطة العقارات · إنشاء النماذج · المكتبة) · المال والفوترة (الفواتير · فواتير الشراء · المطالبات · الحسابات البنكية · الحركات البنكية · التقارير المالية) · المحاسبة (دليل الحسابات · القيود اليومية · فحص المطابقة) · الأطراف والتواصل (المستأجرون · الموردون · قوالب الرسائل) · النظام (بيانات المنشأة · سجل العمليات · قياس الأداء · الإعدادات).
وللعضو في منشأة يُبنى الشريط السفلي و«المزيد» من صلاحياته، والقسم «لا» لا يظهر (القسم ١٣).

الإعدادات صفحة واحدة مسطّحة بأقسامها، ومنها الحساب والمزامنة والمنشأة، والنسخ الاحتياطي وDrive، والتنبيهات، والعرض، وسلة المحذوفات، ومنطقة الخطر. لا شريط جانبي منزلق ولا قوائم هرمية. و«المزيد» أماكن والإعدادات تفضيلات (قرار المالك 2026-10-03): دليل الحسابات في «المزيد» وحده، ولا صف له في الإعدادات (البند ٢٠ (أ) 2026-11-07).

النوافذ → `BottomSheet` أصلية بمقبض سحب وتذييل ثابت. القوائم → `FlatList` ببطاقات (سطر عنوان + سطران/ثلاثة تفاصيل + شريط إجراءات، لا سطر لكل حقل). زر رجوع في كل شاشة، وزر أندرويد: يغلق القائمة المنبثقة ← النافذة ← يرجع في المسار. أهداف لمس ≥ ٤٤ نقطة، `SafeAreaView`، وشريطا حجم العرض والخط يبقيان في الإعدادات.

الهوية: زمردي `#1E6E5C` · ذهبي `#B08D3D` · كحلي `#10192E` · ورقي `#F6F4EE` · وردي `#AE4438` · أزرق `#3A5A9C` · خط `IBM Plex Sans Arabic` · الأرقام `tabular-nums` بـ`ltr`.

---

## ٩. الغموض في النموذج وقراراته

مواضع تناقض فيها النموذج نفسه أو نصَّ التوجيه، والقرار المعتمد لكل منها:

1. **فحص تأمينات العقود** في النموذج يقارن رصيد `2300` (قروض) بدل `2400`: خطأ في النموذج؛ نعتمد `2400` (التوجيه صريح).
2. **الفحص السادس** في النموذج يرشّح بأسماء أنواع غير موجودة (`أصول`/`التزامات`…) فيخرج أصفاراً دوماً؛ نعتمد الأسماء الصحيحة (`أصل`/`خصم`/…).
3. **عمولة التقبيل** تُرحَّل في النموذج مرتين (قيد مباشر إلى **4100** + `postKeyMoneyCommission` إلى 4300)؛ نعتمد قيداً واحداً إلى **4300** كما في جدول التوجيه · والمنشأة المسجّلة في الضريبة يُفصل في القيد نفسه من المقبوض صافيه إلى **4300** وضريبته إلى **2200** (المراجعة الشاملة ٨ · البند ١١).
4. **تحويل الحجز لعقد**: النموذج يغيّر حالة الحجز دون ترحيل؛ نعتمد قيد `2450 → 1200` كما في الجدول.
5. **تسوية التأمين بعد الانتهاء**: استدعاء الترحيل في النموذج مكسور (متغير غير معرّف وأسماء حقول خاطئة) فلا يرحَّل شيء؛ نعتمد الترحيل الصحيح مرة واحدة عند حفظ التسوية (خصم: `2400/4300`، رد: `2400/1100`)، وكذلك عند الإلغاء مع تسوية.
6. **مدة السلة**: الإعداد ٣٠/٦٠/٩٠ لكن `purgeOldTrash` يثبّت ٣٠؛ نعتمد الإعداد (التوجيه صريح).
7. **حالات العقد** في النموذج خليط (`due`/`late`/`ساري`/`منتهي`/`ملغى`)؛ نوحّدها في القاعدة إلى أربع (`مسودة`/`سارٍ`/`منتهٍ`/`ملغى`) ونشتق شارات العرض (مستحقة/متأخرة/سينتهي قريباً/مسدد بالكامل) من الأقساط والتواريخ. عند التجديد يتحول القديم إلى `منتهٍ` كما في النموذج.
8. **الإشغال**: `unitCurrentContract` في النموذج لا يستثني المسودة؛ نستثنيها (المسودة لا تشغل وحدة ولا تظهر في التحصيل، كما في بقية النموذج).
9. **رصيد البنك** مخزَّن في النموذج ويُعدَّل يدوياً في كل عملية؛ نشتقه (`الافتتاحي + مجموع الحركات`)، والسلوك الظاهر مطابق.
10. **رصيد المستأجر** (`balance`) مخزَّن في النموذج ولا يُحدَّث فعلياً؛ نشتقه من أقساط عقوده (كما تفعل شاشة التحصيل نفسها بـ`tenantOutstanding`).
11. **بنود الفاتورة الافتراضية** («اشتراك شهري · النظام المحاسبي»…) بيانات تجريبية زُرعت في النموذج؛ التطبيق يبدأ ببند واحد فارغ، ولا تُنقل أي بيانات تجريبية (عملاء/فواتير/قيود seed).
12. `exportBackup` في النموذج لا يحدّث `lastExportAt` رغم اعتماد التحذير الأحمر عليه؛ نحدّثه عند كل تصدير/مشاركة ناجحة.
13. **علامة إلغاء القسط**: النموذج يستخدم `i.cancelled` في موضع و`status==='ملغية'` في آخر؛ نعتمد `status='ملغية'` وحدها.
14. **إضافة حساب محاسبي** برصيد افتتاحي من الواجهة تبقى متاحة كما في النموذج (تُخزن في `opening_halalas`).
15. **العملة النقدية**: `cashAccountFor` في النموذج يعيد `1100` دائماً (نقد وبنك سواء)؛ نبقيه.
16. أخطاء JS داخلية في النموذج (استدعاء `logAudit` بوسائط ناقصة، مراجع `products/employees` المحذوفة في مسار الاستعادة، `renewAddMonths` بـ`toISOString` UTC)؛ تُنقل الوظيفة الصحيحة لا الخطأ، والتواريخ كلها محلية (`toLocalISODate`).

---

## ١٠. الاختبارات · شرط التسليم

تعمل على Node عبر محوّل `node:sqlite` المدمج (`src/db/nodeAdapter.ts`، يلزم Node ≥ 22.5) لنفس ملفات SQL والمنطق، بـ`npm test`.

**الحصيلة اليوم:** ٧٥ ملفاً و٦١٠ اختبارات. ينجح منها ٥٧٦ في التشغيل العادي، ويُتخطّى ٣٤ في خمسة ملفات `tests/*.emulator.test.ts` (قواعد الأمان، وقواعد المنشأة، ومسار المنشأة، والتثبيت الجديد، ومسح المنشأة) لأنها تحتاج محاكي Firestore قائماً (`FIRESTORE_EMULATOR_HOST`)، وتُشغَّل به عبر `firebase emulators:exec --only firestore --project demo-aqari "npx jest <الملف>"`.

**البناء الأول:**


- **النسخ الاحتياطي (١٢)**: نسخة بـ٥٠٠٠ مرفق ← استعادة على قاعدة نظيفة ← كل بصمة مطابقة · قطع النسخ في المنتصف · قطع الاستعادة ← رجوع سليم · تعديل بايت ← رفض · حذف ملف من القرص ← نسخة معلَّمة ناقصة · مخطط أقدم ← هجرة · أحدث ← رفض مؤدَّب · امتلاء المساحة ← فشل نظيف · إغلاق قسري أثناء الحفظ ← `integrity_check` سليم · ١٠٠ دورة ← بصمة قاعدة ثابتة · نفس الصورة ٥ مرات ← ملف واحد · تعطيل التجزئة ← رفض إنشاء النسخة.
- **المحاسبة**: Σمدين=Σدائن لأي مجموعة عمليات · إعادة الاحتساب من الصفر = المعروض · الأحداث الأحد عشر تنتج قيودها الصحيحة · فحوص المطابقة تمر · المحفّز يرفض القيد غير المتوازن.
- **قواعد العمل**: اختبار لكل قاعدة من الثلاث عشرة.
- **قراءة PDF**: نص عقد بالترتيبين المنطقي والبصري ← ١٠/١٠ حقول · «قاسم» و«الاسمري» لا يُقصّان.

**المضاف بعد البناء الأول**، ومنه:

- **الأداء تحت الحمل**: ٥٠ عقاراً · ١٠٠٠ وحدة · ٢٠٠٠ عقد · ٢٤٬٠٠٠ قسط ← تجميع شاشة التحصيل والبحث وحالات الوحدات وإحصاءات العقارات كلها تحت عتباتها.
- **السلة الجماعية**: حذف ١٢٧٣ عنصراً واستعادتها بلا خرق مفتاح أجنبي واحد وبلا بقاء يتيم.
- **حراسة النصوص**: اختبار يمنع أي شرطة طويلة في المشروع، واختبار يمنع استيراد `Text` الخام خارج ثمانية مكوّنات أساس (ومعهما قاعدة eslint بالمعنى نفسه).
- **التراجع بقيد عكسي**: بقاء القيد الأصلي بلا حذف مختوماً بمن عكسه، وقيد العكس مرحّلاً ببيانه، والرصيد يعكس القيم الجديدة وحدها، والسجل يحمل القيمة قبل وبعد.
- **حالة العقد المعروضة**: عقد يبدأ مستقبلاً يُعرض «موثَّق ولم يبدأ» في كل موضع، والمقترب يُعرض بعدد أيامه.
- **المزامنة**: الطابور والتعارض على مستوى الصف والقيد المرحّل إضافة فقط (`sync`)، ومزامنة أولى كبيرة على دفعات تُستأنف بعد الانقطاع بلا ضياع ولا تكرار (`bigSync`)، والاستعادة مع المزامنة (`restoreSync`).
- **الصلاحيات**: النموذج والمسارات وكاتب المسودة (`access`)، وجدول ما تكتبه كل عملية (`opMatrix`)، وتطابق قسم المنشأة في `firestore.rules` مع المولَّد (`rulesGen`).
- **الحساب**: نسخة كل حساب على الجهاز (`accountSlots`)، و«حذف حسابي» (`accountDeletion`).
- **النسخ**: التشفير (`encryption`)، والنسخ المزوّرة (`forgedBackup`)، وحارس الأرشيف (`zipSignature`)، وترقية قاعدة ببيانات من كل إصدار بين ١ و٢٠ إلى الأحدث بلا تغيّر مبلغ ولا ضياع صف (`upgradeMatrix`).
- **الثوابت تحت تسلسلات عشوائية** (`fuzz`)، وكل تسلسل يفشل تُحفظ بذرته فيصير اختباراً ثابتاً (`fuzzRegressions`).

---

## ١١. ما تغيّر بعد البناء الأول

كل ما في هذا القسم استُحدث أو نُقض بتوجيهات المالك بعد تسليم البناء الأول، وهو **الحاكم** عند تعارضه مع ما سبقه في هذه الوثيقة.

### ١١.١ الهجرات ١٢ إلى ١٦

| # | ما فعلته |
|---|---|
| ١٢ | **الأرشفة بدل الحذف**: العقار والوحدة والبنك يُؤرشفون حين يرتبط بهم غيرهم · المؤرشف يختفي من قوائم الاختيار ويبقى في الدفتر والتقارير · ومحفّز `trg_je_frozen_del` يرفض حذف أي قيد مرحّل من القاعدة نفسها. |
| ١٣ | فهرس فواتير العدّاد (كشف العدّاد يقفز به من مسح كامل إلى قفزة فهرس). |
| ١٤ | **موعد سداد متفق عليه ومهلة** للقسط (`agreed_date` يحلّ محل الاستحقاق في الحالة والفرز، و`grace_until` يمنع احتسابه متأخراً قبلها) · وحساب **`1265` محفظة إيجار** لما صار ملكنا بعد التسوية ولم يُسحب من محفظة المنصة · و`deduct_destination` في التسوية. |
| ١٥ | ~~زرع قالب التذكير الافتراضي في القاعدة~~ · حُذف بقرار المالك 2026-10-05: لا يُزرع، والمزروع سابقاً يُحذف إن لم يُعدَّل · ولا نص مرسَل في الكود (القاعدة ٩٣). |
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
| دفعة الإيجار المسجَّلة | «إلغاء الدفعة» (قرار المالك 2026-10-03) بقيدٍ عكسي، ولا تُعدَّل: التصحيح دفعةٌ جديدة بعد الإلغاء (`cancelPayment.ts`) |

الأثر الجانبي الملزم: **أي استعلام يجمع قيود مستند يجب أن يستثني المعكوس** (`reversed_by IS NULL`) وإلا عدّ الأصل والجديد معاً.
وكل تعديل يسجَّل في سجل العمليات بالقيم **قبل وبعد** (العميل، التاريخ، قبل الضريبة، الضريبة، الإجمالي، الوضع الضريبي).

### ١١.٣ حالة العقد الظاهرة · ست حالات من دالة واحدة

الحالة المخزَّنة أربع فقط (`مسودة`/`سارٍ`/`منتهٍ`/`ملغى`)، والمعروضة **ست تُشتق من التواريخ** بترتيب أسبقية قاطع: ملغى ← مسودة ← **موثَّق ولم يبدأ** (البداية بعد اليوم) ← منتهٍ ← ينتهي قريباً (≤ ٦٠ يوماً) ← سارٍ.

ثلاث دوال في `src/domain/contracts/rules.ts` هي المصدر الوحيد، ولا يجوز لشاشة أن تعرض `status` الخام:

- `contractDisplayStatus` الحالة المنطقية (للمرشِّحات والإحصاءات، لا تتغير أبداً).
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
| `KpiCard` | بطاقة الإحصاء: خلفية الشاشة، حد رفيع بلا ظل ولا شريط، توسيط، السطر الفرعي داخل التسمية، الأحمر للمصروفات وحدها، **والبطاقة بلا قيمة تختفي بعنوانها** (قرار المالك 2026-09-09) |
| `FilterSheet` | زر «تصفية (n)» بورقة سفلية ورقاقات المفعَّل ومسح الكل |
| `Pager` | زر عدد العناصر أسفل القائمة بخيارات لا تتجاوز السجلات ويختفي عند خمسة فأقل · و«السابق» لا يظهر في الصفحة الأولى ولا «التالي» في الأخيرة، لا معطَّلين (القاعدة ٩١ والبند ٦ (أ) 2026-11-07) |
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
7. **الزر الذي لا يصح فعله لا يُعرض**: لا معطَّلاً ولا يُعرض ثم يرفض.
8. **كل رقم مجمّع يُفتح** على مكوّناته، وكل خانة تجميعية تفتح **صفحة** لا انسدالاً.
9. **صفر نص مرسَل في الكود**: كل رسالة قالب من قاعدة البيانات.
10. **الإثبات مع كل تسليم**: رقم أو اختبار أو لقطة من النسخة المسلَّمة نفسها.

ودروس النموذج الأربعة تُطبَّق إجرائياً: لا استبدال استدعاء محذوف بقيمة ثابتة؛ فحص الصياغة بعد كل حذف؛ الاختبارات تستدعي المنطق لا تكتفي بالتحميل؛ وفحص تفرّد المعرفات (هنا: قيود UNIQUE في القاعدة تتكفل بها بنيوياً).

---

## ١٣. الحساب والمزامنة والمنشأة

القاعدة المحلية تبقى مصدر الحقيقة، والسحابة طبقة مضافة فوقها. كل ما في السحابة عبر REST بلا حزمة Firebase (`src/cloud`)، ومنطقه خالص تُحقن فيه وحدات الجهاز فيُختبر على Node وعلى المحاكي، وربطه بالجهاز في `src/services/cloud.ts`. والبناء بلا إعداد Firebase (متغيرات `EXPO_PUBLIC_*` غائبة) يعمل محلياً كاملاً بلا دخول ولا مزامنة.

### ١٣.١ الدخول والجلسة

- بوابة الدخول (`src/ui/AuthGate.tsx`) لا تتابع بلا حساب: الدخول بقوقل، ثم Firebase Auth عبر REST يبدّل رمز قوقل بهوية `uid` ورمز تحديث.
- رمز التحديث والهوية والبريد في المخزن الآمن وحده (`expo-secure-store`)، ورمز الدخول القصير يُجدَّد منه عند الحاجة.
- بعد الدخول الأول يعمل التطبيق بلا اتصال، فالجلسة المحفوظة تكفي.

### ١٣.٢ نسخة كل حساب على الجهاز

البيانات للحساب لا للجهاز (`src/services/accountSlots.ts`):

- القاعدة النشطة ومرفقاتها لحساب واحد. عند الخروج أو دخول حساب آخر تُركن نسخة الحساب كما هي في `accounts/{uid}/` مقفلةً بطابورها، فلا يراها حساب آخر ولا يضيع تغيير لم يُرفع.
- عند الدخول تعود نسخة الحساب إن كانت مركونة، وإلا فنسخة جديدة تُسحب من سحابته. لا يرث حساب شيئاً من غيره.
- لا خروج ما دام شيء لم يُرفع (طابور صادر أو نسخة مستعادة لم تُعتمد).
- بيانات قائمة بلا حساب (جهاز من قبل الدخول الإلزامي) يربطها الداخل بحسابه أو يتركها جانباً، ولا تُمسح.
- هذا المسار ينقل ولا يمسح أبداً.

### ١٣.٣ المزامنة
- **المعرّفات الحتمية:** `deterministicId` أول ١٢٨ بتاً من SHA-256 للبذرة وترتيب الصف، ببادئة `s` (كانت FNV-1a بـ٦٤ بتاً ببادئة `d`، ولا تقاوم التصادم المتعمَّد · دراسة البنية، و-سدّ-الثغرتين) · والصفوف القائمة تبقى بمعرّفاتها، وجهازان بإصدارين مختلفين لا يلتقي ما يشتقانه حتى يُحدَّثا (حدّ الإصدار الأدنى يمنع المزامنة بينهما).
- **موقع القاعدة:** قاعدة Firestore للمشروع `aqari-ec12e` هي `(default)` من نوع Native في **`me-central2` (الدمام، داخل المملكة)** · قُرئ 2026-11-10 من إعداد المشروع وحده بحساب النشر (سير العمل `firestore-location.yml`، بإذن المالك في اليوم نفسه)، والناتج في فرع `ci-results` ملف `firestore-location.txt` · وحُذف سير العمل بعدها (المراجعة الشاملة 2026-11-13 · G-8) لأنه يستعمل مفتاح Firebase Admin من أي فرع، والناتج باقٍ في الفرع · وFirebase Authentication يعمل من الولايات المتحدة أياً كان موقع القاعدة.

`src/sync/engine.ts`:

- **متى**: عند الإقلاع، وعند عودة الاتصال، وعند العودة إلى التطبيق، وكل دقيقة ما دام ظاهراً. ولا تجري بلا اتصال أو بلا دخول.
- **الالتقاط**: محفّزات على كل جدول مزامَن تكتب في `sync_outbox`، ومعه `sync_inbox` و`sync_rejects` و`sync_state` و`sync_ctl` (الهجرة ١٨).
- **الدورة**: سحب ما كُتب في السحابة بعد المؤشر إلى صندوق وارد محفوظ ← تطبيقه بترتيب الآباء قبل الأبناء ← دفع الطابور الصادر. كل خطوة تُستأنف إن انقطع الاتصال في منتصفها.
- **التعارض** على مستوى الصف: الأحدث تغييراً يغلب، ثم هوية الجهاز عند التساوي. ووقت التغيير بساعة الخادم: كل جهاز يقيس فرق ساعته من وقت الالتزام في كل كتابة. ويُسجَّل التعارض في سجل العمليات إن اختلف المضمون فعلاً.
- **الوارد يُفحص قبل اعتماده**: كل صف يُكتب داخل نقطة حفظ ويمرّ بمحفّزات القاعدة ثم بالفحص الدلالي نفسه الذي في الاستعادة (القسم ٣)، محصوراً في الصف وما يمسّه. أي إخفاق يُرجع نقطة الحفظ، ويُحفظ الصف في `sync_rejects`، ولا يكسر بقية الدفعة.
- **القيد المرحّل إضافة فقط**: لا يُعدَّل ولا يُحذف بالمزامنة، ويُسمح بربطه بقيده العكسي مرة واحدة. وسطوره تسافر داخل مستند قيدها فلا تنفصل عنه.
- **خارج المزامنة عمداً** (`src/db/syncTables.ts`): الملفات (`attachments` و`blobs`) وتنتقل في النسخة على Drive، و`meta` و`settings` و`scheduled_notifications` لأنها تخص الجهاز.
- **أول تفعيل لحساب**: كل الصفوف تدخل الطابور ويُصفَّر مؤشر السحب. وفي الانضمام يغلب ما في الحساب ما يقابله على الجهاز في أول دورة، وما انفرد به الجهاز يُرفع، فجهاز ثانٍ فارغ لا يكتب قيمه الافتراضية فوق بيانات الأول.
- **ترقيم لا يتصادم** (`src/domain/numbering.ts`، قرار المالك ٢٠٢٦-١٠-٠٥): القيود والعقود والمشتريات من كتل أرقام يحجزها كل جهاز من عدّاد الحساب (`meta/counters`) بلا لاحقة، تُملأ في المزامنة حين يبقى أقل من نصفها فيعمل الجهاز بلا اتصال، والفجوات مقبولة. والفاتورة الضريبية بلا فجوات (`src/domain/invoiceIssue.ts`): المسودة برقم مؤقت لا يُطبع، ورقمها من العدّاد لحظة إصدارها، وبلا اتصال تبقى مسودةً وتصدر برقمها عند عودته. والكتل تخصّ التثبيت: تبقى مع المسح ولا تأتي مع نسخة مستعادة. الأرقام الصادرة سابقاً بحرف جهاز (`JE-0042-B`) تبقى كما هي، ولا تُسجَّل حروف بعد اليوم ولا يراها المستخدم، ويبقى حرف الجهاز القديم لما لا كتلة له.
- **استعادة نسخة والحساب داخل**: لا تُستبدل بها السحابة دون قرار المستخدم. إما اعتمادها حقيقةً للحساب، بعد ضمّ القيود المرحّلة التي في السحابة وليست في النسخة، وإما «إلغاء» فتبقى المزامنة منتظرة · **ولا «دمج»** (قرار المالك 2026-10-03، والبند ١ (أ) 2026-11-07).

### ١٣.٤ مستند الصف في السحابة

مسار المنشأة `orgs/{org}/rows/{t__k}`، ورقم المنشأة = `uid` مالكها. والمسار الأقدم `users/{uid}/rows` لصاحبه وحده: عند أول دخول للمالك بعد التحديث يُرفع ما فيه إلى منشأته، ولا يكتب فيه التطبيق بعد ذلك.

| الحقل | معناه |
|---|---|
| `t` · `k` | الجدول والمفتاح، ومعرّف المستند `t__k` |
| `d` | حقول الصف، والمبالغ أعداد صحيحة بالهللات |
| `lines` | سطور القيد، في مستند القيد وحده |
| `u` · `dev` · `ts` | وقت التغيير، والجهاز، ووقت الخادم عند الكتابة |
| `del` | شاهد الحذف: الحذف علامة لا إزالة |
| `op` | قسم العملية التي كتبت الصف، والقواعد تتحقق منه |
| `g` | رموز الرؤية «قسم\|عقار»، ويقرأ العضو الصف إن كان فيها رمز من رموزه |
| `pids` | عقارات الصف، و`*` للصف العام |
| `by` | كاتب المسودة الأول، لا يتغيّر |

وقواعد `firestore.rules` تفرض فوق ذلك: شكل المستند والحقول المعروفة وحدها، والمبالغ أعداداً صحيحة، والقيد المرحّل وسجل العمليات للإضافة فقط، ولا حذف لصف إلا في ساعة بعد طلب يكتبه صاحب البيانات بوقت الخادم في `meta/deletion`. وفي `orgs/{org}/meta` أيضاً عدّاد الترقيم (`counters`: لا ينقص عددٌ فيه ولا يُحذف، ويحجز منه المالك والعضو) وحروف الأجهزة القديمة (`devices`) وعهد المسح (`epoch`) ونقل الوحدات (`moves`).

### ١٣.٥ المنشأة والأعضاء والصلاحيات

التصميم التفصيلي في `docs/PERMISSIONS.md`، وخلاصته:

- **المستويات** لكل قسم: لا · عرض · إدخال · كامل. «إدخال» يضيف ويعدّل مسودته هو وحده قبل ترحيلها (العقد «مسودة»، وفاتورة المبيعات «مسودة»، والقيد «قيد الإنشاء»)، و«كامل» يعدّل ويلغي.
- **الأقسام** (`src/domain/access/sections.ts`) من سلوك التطبيق لا من أسماء الشاشات، و«الأعضاء والإعدادات» للمالك وحده لا تُمنح. وفوق المستوى قيد العقارات: كل العقارات أو قائمة منها.
- **الدعوة**: المالك يكتب دعوة بالبريد في `orgs/{org}/invites/{email}`، والمدعوّ ببريد موثَّق ينشئ عضويته في `members/{uid}` مرة بنص الدعوة حرفياً. قبول الدعوة يفرّغ الجهاز ثم يربطه بالمنشأة عضواً ويسحب ما تجيزه صلاحيته. والداخل بنسخة جديدة يُتحقق من دعواته أولاً.
- **بيانات العضو** (`src/domain/access/profile.ts`): الاسم الكامل والجوال إلزاميان، والهوية/الإقامة والمسمى الوظيفي اختياريان، في مستند العضوية نفسه. الجوال سعودي موحَّد والهوية عشرة أرقام أولها ١ أو ٢، والقواعد تفرض الصيغة. يملؤها المالك عند الدعوة أو بعدها، ويكملها العضو من «بياناتي» أو من شاشة الإكمال التي تظهر له بعد القبول إن نقصه الإلزامي، ولا يعدّل العضو في مستنده غيرها. الهوية لا يقرؤها إلا المالك والعضو، وفي سجل العمليات يُذكر أنها أُدخلت أو تغيّرت بلا قيمتها. والسجل يحمل اسم المنفّذ: العضو باسمه و«المالك» للمالك، وتعديل العضو بياناته يُرفع بعملية «self» ولو لم يُجز له قسمٌ إدخالاً.
- **الودجت ثلاث** («شريط اليوم» و«أزرار سريعة» و«لوحة التحصيل»)، بلا أسماء مستأجرين، والعشرون المعروضة محفوظة في `docs/ودجت/` ولا تُبنى (البند ١٦ (أ) 2026-11-07: «الودجت يبقى كما هو»، والبند مغلق).
- **الودجت** تتبع الصلاحية: عضوٌ بلا قسم التحصيل لا تُكتب مبالغه في ملفها، وأزرار الاختصار لما لا يفتحه لا تظهر.
- **الودجت وقفل التطبيق** (المراجعة الشاملة · البند ٢٣): القفل يحجب الواجهة والودجت على الشاشة الرئيسية بلا قفل، فحين يكون مفعّلاً (علامته `app-lock.flag`، وتعذّر فحصها يُعدّ مفعّلاً) تُكتب اللقطة بلا مبلغ ولا نسبة تحصيل ولا نقد، بالأعداد وحدها و`locked`، وتعرض الودجت «المبالغ مخفية». وتفعيله أو إطفاؤه يعيد كتابة اللقطة فوراً (`src/services/widgetService.ts`)، وتعذّر بنائها والقفل مفعّل يحذف اللقطة السابقة ولا يُبقيها بمبالغها. ولا تثق الودجت بـ`locked` وحده: علامة القفل في المجلد نفسه تُعدّ قفلاً في كوتلن (`AqariWidgets.kt`: `lockFlagged`)، فلقطةٌ لم تمرّ بالكتابة الأخيرة (لقطة إصدارٍ سابق قبل أول فتح، أو تعذّر حذفها) لا تُعرض مبالغها. واللقطة مشتقةٌ من القاعدة فلا تُركن مع نسخة الحساب ولا تعود معها (`src/services/accountSlots.ts`: `DERIVED`)، لأن القفل للجهاز لا للحساب.
- **تغيّر العضوية (المراجعة الشاملة 2026-11-13 · B-2):** جهاز العضو يقرأ مستند عضويته `members/{uid}` أول كل دورة، قبل عهد المسح والحد الأدنى للإصدار والسحب: صاحب المستند يقرؤه دائماً، وتلك الثلاثة يرفضها الخادم (403) لمن أُزيل، ورفض سجل النقل لا يحجب الفحص.
  - **أُزيل:** يُفرَّغ الجهاز في أول دورةٍ متصلة · **ولا يُعدّ مُزالاً إلا بدليلين معاً:** غياب مستند عضويته نفسه (رسالة الخادم «Document … not found»، لا غياب القاعدة أو المشروع · `getDocStrict` و`isDocNotFound` في `firestore.ts`)، ورفضٌ (403) لمستندٍ للأعضاء وحدهم في الدورة نفسها (سجل النقل أو عهد المسح) · وما سوى ذلك خطأ اتصالٍ يُعاد ويبقى الجهاز وعضويته.
  - **تغيّرت صلاحيته:** تُحفظ الجديدة ويُسحب بها في الدورة نفسها، ويُسجَّل التفريغ المنتظر فوراً، ويقع حين يخلو الطابور ثم يُعاد السحب من أوله · وأي 403 بعدها على جهاز عضو يعيد فحص العضوية قبل أن يُعرض خطأ.
- **الخروج من المنشأة، إزالةً أو مغادرة (B-4 · قرارا المالك س٩ وس١٠ في 2026-11-13):** لا نسخة أمان كاملة ولا «أبقِ بياناتي» (`src/domain/memberExit.ts`):
  - ما لم يُرفع من عمله وحده يُحفظ في ملف JSON (`aqari-unsynced-work`) في `backups/unsynced/` من نسخة الحساب: طابور الرفع، وما رفضته السحابة مما كتبه جهازه، ومرفقاته التي لم تُرفع (صفّ البصمة وصفوف المرفق والبايتات بترميز base64، يُبنى في مخزنٍ واحد بحجمه المحسوب) · وهو غير مختوم، لأن سرّ الختم مفتاح استرداد العضو وصاحب المنشأة لا يملكه · وفشل كتابته يوقف التفريغ، ولا ملف إن لم يبقَ شيء.
  - ثم يُفرَّغ الجهاز وسببه في سجل العمليات «بلا نسخة أمان»، وتُمحى العضوية · وتُحذف نسخ الجهاز التي صُنعت وهو عضو، تُعرف بالعضوية المحفوظة داخلها لا بساعة الجهاز، وما تعذّر حذفه يُعاد في كل دورة وكل إقلاع (`exit_drop_backups`) · و`member_since` يُحفظ عند قبول الدعوة.
  - ثم ورقة «ما ينتظر قرارك» بإشعار الخروج، وزر «أرسل الملف إلى صاحب المنشأة»، و«تم» الذي يحذف الملف، و«لاحقاً» · والمزامنة متوقفة حتى «تم» · والمغادرة تفتح نافذة الإرسال فوراً، ولا مغادرة قبل رفع الطابور.
  - **حزام الاستعادة:** نسخةٌ في قاعدتها عضوية لا تُستعاد إلا على جهاز عضوٍ في المنشأة نفسها بالعضوية نفسها (`assertMembershipRestorable` في `restore.ts`)، ونسخة المالك كما كانت.
  - **باقٍ:** تفريغ تغيّر الصلاحية ما زال يصنع نسخة أمان كاملة (نطاق B-5)، والعضو لا يستعيدها وتُحذف عند خروجه.
- **الفرض على الجهاز**: الشريط السفلي و«المزيد» والرئيسية تُبنى من الصلاحيات، ولكل مسار قسمه (`src/domain/access/routes.ts`) والحارس في التخطيط الجذري يرجع من أي مسار قسمه «لا». والزر غير المسموح لا يُعرض.
- **الفرض على الخادم**: ما تكتبه كل عملية مسجَّل في `src/domain/access/opWrites.ts` (ما تنشئه، وجداول قسمها، وحقول بعينها تمسّها في أقسام أخرى). منه يولّد `src/domain/access/rulesGen.ts` قسم المنشأة في `firestore.rules` بين علامتي `org:generated`، و`tests/rulesGen.test.ts` يُسقط الحزمة إن اختلف الملف عن المولَّد، و`tests/opMatrix.test.ts` يُسقطها إن كتبت عملية ما ليس في الجدول.
- **الأب المقفل أمام كتابة العضو** (المراجعة الشاملة 2026-11-13 · B-1 وB-3، ومدققها المستقل R11): جهاز المالك يرفض من العضو ما يلي ويعيد نسخته إلى السحابة، ويظهر المرفوض في حالة المزامنة (`lockedParentIssue` و`ownerColsIssue` في `src/sync/engine.ts`، و`OWNER_ONLY_COLS` و`POSTED_PURCHASE_COLS` في `opWrites.ts`):
  1. **الفاتورة الصادرة:** لا يتغيّر فيها من العضو إلا الحالة (مستحقة أو متأخرة أو مدفوعة) وحقول التحصيل وعقارها عند نقل الوحدة (قائمة سماح) · ورابط قيد إصدارها لا يتغيّر إلا لصادرةٍ بلا قيدٍ حيّ أو عند إخراجها من السلة بقيدها الجديد · ولا تعود مسودة ولا تُحذف.
  2. **سطور الصادرة:** ما أصدره المالك مقفلٌ كيفما كانت سطوره · وما أصدره عضو (فاتورته، أو مسودة المالك أصدرها «كامل» الفواتير) يُقفل متى اكتملت سطوره، أي أعطت رأسها كما صدر، لأن سطور العضو تصل على دفعاتٍ بعد رأسها.
  3. **أقساط العقد:** المسودة لا قسط لها إلا من كاتبها · وجدول عقد العضو لكاتبه · ومؤكِّد مسودة غيره («كامل» العقود) أول من يكتب أقساطها · وإن وصل العقد مؤكَّداً ولم يُرَ مسودة تنتظر أقساط غير كاتبه ساعةً بوقت الخادم · ويحرس ذلك جهاز المالك وحده، فقاعدةٌ لكل قسطٍ لا تسعها ميزانية القواعد.
  4. **فاتورة الشراء المرحّلة:** صافيها وضريبتها وإجماليها ووضعها الضريبي وتاريخها لا تتغيّر من عضو إلا بقيدٍ جديد مرحّلٍ لها وعكس قيدها القديم، والقاعدة (`postedPurchaseKept`) تشترط الأمرين في السحابة.
  5. **تسجيل ضريبة القيمة المضافة للمالك وحده:** لا يغيّره العضو، ولا يحذف صفّ المنشأة ولا ينشئه · وجهاز العضو يأخذ قيمته من الوارد ولو غلب تعديلُه (`adoptOwnerCols`)، وتعديل المالك المعلَّق يبقى ويُدمج مع تعديل العضو لباقي الصف.
  - **وفي القواعد** (`rulesGen.ts`): «إدخال» لا ينشئ سطراً إلا لمسودة · والصادرة لا يغيّر العضو أعمدتها المقفلة ولا يعيدها مسودة ولا يحذفها · والعضو لا يغيّر `vat_enabled` ولا يحذف صفّ المنشأة ولا ينشئه.
  - **خطرٌ باقٍ موثَّق:** جهاز المالك لا يعرف آخر من كتب الصف، فقاعدة «أول كاتب» في الأقساط تبقى لعضوٍ يسبق مؤكِّد مسودةٍ بقسط، أو يسبق صاحب عقدٍ انقطع رفعه أكثر من ساعة · وسدّه التام بحقل «آخر كاتب» تفرضه القاعدة، أو بصلاحيات الأعضاء على جهاز المالك.
- **رموز الرؤية** تُحسب عند الرفع من القاعدة المحلية (`src/sync/acl.ts` و`src/domain/access/readSections.ts`): الجدول يُقرأ لقسمه ولما يحتاجه من الأقسام سياقاً. والعضو يسحب بشرط `g array-contains-any` على دفعات من ٣٠ رمزاً، فلا يحمل جهازه إلا ما تجيزه القواعد.

### ١٣.٦ النسخ على Google Drive

`src/cloud/drive.ts` بنطاقين: `drive.appdata` (مجلد مخفي يخص التطبيق) و`drive.file` (ما أنشأه التطبيق وحده، فلا يرى غيره من ملفات المستخدم).

- **نسختان لكل رفع** (قرار المالك 2026-11-07 · التوجيه الرابع ٤ · ٣): في المجلد المخفي كما كان، وفي مجلد ظاهر «عقاري · نسخ احتياطية» في Drive المستخدم يراه ويحفظه وينقله · المجلد يُعرف بعلامته في خصائص التطبيق (`appProperties.app = aqari-backups`) فيُنشأ مرة ويُعاد استعماله ولو غيّر المستخدم اسمه، والنسخة الظاهرة الملف نفسه بمطابقة بصمته · ونطاق `drive.file` يُطلب عند أول رفض (403) لمن دخل قبل إضافته ثم يُعاد الرفع. وكلتاهما مشفّرة (القسم ٣.٤).

- **الرفع**: ملف `.aqbk` نفسه بعد اجتيازه كل تحققات الإنشاء (القسم ٣)، برفع مستأنَف يبثّ الملف من القرص، ثم تُقارن بصمة SHA-256 التي حسبها Drive ببصمة الملف المحلي، وعدم التطابق يحذف المرفوع ويرفض.
- **الاستعادة**: تنزيل إلى القرص ثم مطابقة البصمة ثم مسار الاستعادة المحلي نفسه بكل ضماناته.
- القائمة تبيّن النسخة المشفّرة والنسخة التي فيها ملاحظات محاسبية.

### ١٣.٧ «امسح كل البيانات»

للمالك (`wipeEverything` في `src/services/cloud.ts`، و`src/domain/wipe.ts`). بعده يكون التطبيق كأنه مثبَّت جديداً في كل شاشة وتقرير، على هذا الجهاز وعلى كل جهاز آخر في المنشأة وبعد إعادة التثبيت. لا يعكس القيود ولا ينقل إلى السلة، بل بالترتيب:

1. **نسخة أمان إلزامية** في مجلد النسخ الدائم بعد التحقق من أن القرص يسعها. فشلها يلغي المسح قبل أن يُمسّ شيء، وهي طريق الاسترجاع.
2. **السحابة**: يُرفع عهد المسح (`orgs/{org}/meta/epoch`) أولاً ثم تُحذف صفوف المنشأة، فيفرّغ كل جهاز نسخته عند أول مزامنة ولا يرفع قديمه.
3. **الجهاز**: تُغلق القاعدة ويُحذف ملفها والمرفقات، ثم تُفتح قاعدة جديدة بالهجرات والزرع.
4. يبقى ما يخص الجهاز والحساب وحده: هوية الجهاز وحرفه، والحساب والمنشأة وعهد المسح.

يحتاج اتصالاً ومزامنة سابقة إلى المنشأة، وبلا إعداد سحابي يُمسح الجهاز وحده.

### ١٣.٨ «حذف حسابي»

دخول جديد بقوقل للحساب نفسه، ثم بالترتيب: بيانات السحابة كلها (في نافذة الساعة بعد طلب الحذف) · نسخ التطبيق على Drive · حساب Firebase · تفريغ الجهاز (`src/services/deviceReset.ts`: القاعدة والمرفقات والمصغّرات ونسخ الأمان ولقطة الودجت وكلمة مرور النسخ، ثم قاعدة جديدة بهوية جهاز جديدة) · ثم الخروج. فشل خطوة يوقف ما بعدها ويُبلَّغ.

### ١٣.٩ الهجرات ١٧ إلى ٢٣

| # | ما فعلته |
|---|---|
| ١٧ | **إقفال الدفتر والأقساط في القاعدة** فلا يمرّ خلل من أي مسار كتابة (الخدمات والإدراج المباشر والمزامنة والاستيراد): القيد المرحّل غير المتوازن يُرفض ولو أُدرج مرحّلاً مباشرة، والقيد المرحّل لا يدخل السلة ولا يُحذف ولا تتغيّر حالته، والمسدَّد على القسط مع خصمه لا يتجاوز مبلغه، ولا مسدَّد ولا خصم ولا صافٍ سالب. |
| ١٨ | بنية المزامنة: الطابور الصادر والوارد والمرفوض ومحفّزات الالتقاط. |
| ١٩ | رقم محجوز بلا تغيير في البنية. |
| ٢٠ | **نوعا الخصم**: «بعد الاستحقاق» (القسط بقيمته والخصم مصروفاً في `4900` بقيد الدفعة) أو «تنزيل من القسط» (القسط نفسه يُخفَّض)، وحارس يشترط سطر `4900` للأول، وسقف القسط يقرأ الخصم من الدفتر. |
| ٢١ | **المسدَّد يُحسب من الدفعات وتوزيعها**، وإلغاء الدفعة لا يحذفها (`cancelled_at` وسببه وقيده العاكس). والدفعة الواردة بالمزامنة لا يرفضها فحص «المتبقي» المحلي، بل يُحدّ المسدَّد بمبلغ القسط ويظهر الزائد فائضاً للرد. |
| ٢٢ | **كاتب المسودة**: جدول يخص الجهاز ولا يُزامَن كصف، يحفظ من أنشأ كل عقد وفاتورة وقيد، لصلاحية «إدخال». |
| ٢٣ | **تحصيل فاتورة المبيعات قيدٌ** (مدين النقد أو البنك / دائن الذمم 1200) يُحفظ معرّفه وتاريخه وطريقته، بعد أن كانت «مدفوعة» تغيّر الحالة وحدها. |

### ١٣.١٠ الملفات في الخادم · النموذج المختلط (قرار المالك ٢٠٢٦-١٠-٠٧)
**البيانات على الجهاز وتُزامَن، والملف أصله في Firebase Storage ولا يُنزَّل إلا حين يُفتح.**
- **الصفوف:** المرفقات (`attachments`) وبصماتها (`blobs`) تُزامَن صفوفاً منذ الهجرة ٢٧. المرفق يقرؤه من يقرأ جهته (العقد والوحدة والمشترى…) والمكتبة، وعقاره عقار جهته. ومعه مصغّرة خفيفة للصور (`thumb`، بضعة كيلوبايت) يظهر بها الملف قبل تنزيله.
- **الملف:** `orgs/{org}/files/{بصمة}.{امتداد}`، ملف واحد للبصمة. يحمل في بياناته الوصفية رموز رؤية مرفقاته (`g`)، وقسم العملية التي رفعته (`op`)، وبصمتيه `md5` و`sha256`. وقواعد `storage.rules` تقرأ مستند العضوية من Firestore:
  - **القراءة:** للمالك، وللعضو إن كان في رموزه رمزٌ من رموز الملف.
  - **الرفع:** للمالك، ولعضو له «إدخال» في قسم العملية. الحجم دون ٥٠ م.ب، والاسم بصمة وامتداد، وmd5 الجهاز يطابق ما حسبه الخادم.
  - **الرفع فوق ملفٍ قائم:** للمالك وحده. فالعضو لا يكتب فوقه محتوىً ولا رموزاً، والمالك يصلح ملفاً سبقه إليه عضوٌ بمحتوىً آخر (#19).
  - **التعديل:** للمالك، ولعضوٍ يقرأ الملف أصلاً (#19: من عرف البصمة لا يضمّ رمزه فيقرؤه). الرموز تزيد ولا تنقص، ولا يضمّ العضو رمز «كل العقارات» (`قسم|*`)، والمحتوى لا يتغير.
    - **باقٍ:** عضوٌ يرفق ملفاً محتواه في الخادم من قبل ولا يقرؤه، لا يُرفع ملفه ويبقى «لم يُرفع» على جهازه، كما كان قبل الإصلاح.
    - **وجدول البصمات (`blobs`)** يقرؤه كل قسم: يكشف وجود ملفٍ معروف المحتوى، ولا يفتحه.
    - **ومن يقرأ الملف** يضمّ إليه رموز عقارٍ آخر أو قسمٍ آخر (القواعد لا تحلّل الرمز). ومحتواه عنده أصلاً.
    - **وعضوٌ يسبق غيره** إلى بصمةٍ بمحتوىً آخر (البصمة يقرؤها كل قسم قبل أن يُرفع ملفها): يفشل تنزيلها بمطابقة البصمة. فإن كان الملف عند المالك رفعه من جهازه فأصلحه، وإن أرفقه عضوٌ فلا إصلاح له في التطبيق اليوم (لا آلي ولا يدوي). والإصلاح بدالةٍ في الخادم تحسب البصمة، بعد الفوترة.
  - **الحذف:** للمالك وحده.
- **حال الملف على الجهاز:** `file_cache`، جدول يخص الجهاز.
  - **الملف الجديد:** يُرفع في الخلفية بعد كل مزامنة، في طابور مستقل لا يحبس البيانات، ويبقى على الجهاز حتى يُرفع ويطابق الخادم بصمته.
  - **الملف المنزَّل:** يبقى للفتح بلا اتصال حتى حدٍّ في الإعدادات (٥٠٠ م.ب افتراضياً). يُحذف منه الأقدم استعمالاً، وفي الإعدادات زر «تفريغ». وما لم يُرفع لا يُحذف أبداً.
  - **التنزيل:** يُطابَق بـ SHA-256 على اسمه. وبلا اتصال يظهر سبب عدم الفتح.
- **أول دخول على جهاز جديد** يسحب البيانات وحدها.
- **النسخ:**
  - **نسخة Drive:** البيانات وقائمة الملفات وبصماتها (`remote_files`)، ومعها ما لم يُرفع بعد، فلا يضيع ملف.
  - **«نسخة كاملة بالملفات» للتصدير اليدوي:** تُنزّل ما في الخادم أولاً.
  - **الاستعادة:** تُرجع الصفوف كلها، وتعامل كل ملف على الجهاز «لم يُرفع» حتى يطابقه الخادم.
- **المسح الشامل وحذف الحساب** يحذفان ملفات المنشأة من الخادم.
- **التفعيل:** التخزين مطفأ حتى تُنشأ الحاوية في me-central2، ويُفعَّل عند البناء:
  - `EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET`؛
  - `EXPO_PUBLIC_FILES_CLOUD=1`.

  وبدونهما تبقى الملفات على الجهاز وتحمل النسخة ملفاتها كما كانت.
- **الاختبار:** على محاكيي Firestore وStorage معاً (`tests/files.emulator.test.ts`).

### ١٣.١١ تعدد اللغات · المرحلة الأولى (قرار المالك ٢٠٢٦-١٠-٠٧)
- **الطبقة:** i18next مع react-i18next، وملفا الترجمة `src/i18n/locales/ar.json` و`en.json` بمفاتيح موحّدة. وصيغ الجمع العربية الست من `intl-pluralrules`.
- **إضافة لغة:** ملف ترجمتها وسطرها في `LANGUAGES` (`src/i18n/index.ts`)، بلا مسّ للشاشات.
- **اختيار اللغة:**
  - في الإعدادات ← العرض ← «اللغة»: لغة الجهاز (الافتراضي)، أو العربية، أو English.
  - يتبع المستخدم على كل أجهزته ويُزامَن مع حسابه (قرار المالك ٢٠٢٦-١٠-٠٧، وكان قبله لكل جهاز):
    - يُحفظ في ملف صغير خارج قاعدة البيانات فيسري قبل الدخول (`src/i18n/device.ts`)، ومعه وقت الاختيار وصاحب الحساب.
    - وفي السحابة حقلا `langPref` و`langAt` في مستند المستخدم `users/{uid}` (`src/cloud/userPrefs.ts`).
    - في كل دورة مزامنة يُوفَّق بينهما (`src/i18n/sync.ts`): الأحدث يغلب، والاختيار المحلي الذي لم يُرفع يُرفع، وجهازٌ دخله حساب آخر يأخذ لغة ذلك الحساب.
    - الاختيار قبل أول دخول، والاختيار القديم المحفوظ لكل جهاز قبل هذا القرار، يُرفعان لحساب أول من يدخل، إلا أن يكون في حسابه اختيارٌ أحدث.
    - والافتراضي لغة الجهاز حتى يختار المستخدم.
  - لغة جهاز غير مدعومة تعطي العربية.
  - «لغة الجهاز» لا تختار إلا لغةً اكتملت ترجمتها (`complete` في `LANGUAGES`)، فجهازٌ لغته الإنجليزية يبقى عربياً حتى تكتمل مرحلة نقل النصوص، والاختيار الصريح للإنجليزية متاح دائماً.
- **الاتجاه:**
  - يتبع اللغة فوراً بلا إعادة تشغيل: `DirView` يضبط اتجاه Yoga في جذر التطبيق وفي جذر كل نافذة، حين تخالف اللغةُ اتجاهَ أندرويد الأصلي وحده، وإلا ترث الشجرة اتجاهها كما كانت. فُحص على المحاكي في اللغتين وفي الفتح الأول بعد التغيير والفتح الذي يليه.
  - ومكوّنات النص والحقل والبحث تحاذي نصها للغة.
  - واتجاه أندرويد الأصلي (القوائم الأفقية والأسهم) يُحفظ ويكتمل بعد فتح التطبيق مرة، ويُنبَّه المستخدم بذلك عند التغيير.
- **مزوّد اللغة** (`LangProvider`) مستمعٌ واحد لتغيير اللغة، لا مستمع لكل نص. والنص خارج المكوّنات بـ `t()`، وداخلها بـ `useLang()`.
- **الأرقام** لاتينية في الواجهتين.
- **الاختباران:**
  - `tests/i18nKeys.test.ts`: كل مفتاح في اللغتين، ومتغيراته نفسها، وصيغ الجمع كاملة.
  - `tests/i18nLiterals.test.ts`: لا نص يراه المستخدم خارج ملفات الترجمة.
    - النصوص القائمة قبل هذه المرحلة عددها مجمّد لكل ملف في `tests/i18n-baseline.json`: لا يزيد، ويُخفَّض كلما نُقلت في مرحلة النقل.
    - الملف الجديد عدده صفر، فكل شاشة أو رسالة جديدة تُكتب بالمفاتيح باللغتين.
    - والقيمة المخزّنة التي يقارن بها الكود حتى تصير رمزاً ثابتاً تُوسم `i18n-exempt` بسببها.

### ١٣.١٢ المحادثة · وحدة مستقلة (قرار المالك ٢٠٢٦-١٠-٠٧ · على الفرع chat حتى يأذن بالدمج)
- **الوحدة** في `src/chat/`، وواجهتها مع التطبيق `src/chat/index.ts` وحدها:
  - `chatMe`: من أنا في المحادثة.
  - `runChatSync`: دورة مزامنة.
  - `setSupervisor`: إشراف عضو.
- **نقاط الربط بالتطبيق** (كل ما خارج `src/chat`):
  - شاشة `app/chat.tsx` ومدخلها في «المزيد» ومسارها `/chat` لكل عضو.
  - خيار «مشرف القسم» في ورقة العضو.
  - استدعاء `chatSyncNow` بعد كل دورة مزامنة عامة، وفشله لا يمسّها. ويقف مع ما يوقف المزامنة العامة، و`pauseSync` ينتظره.
  - الهجرة ٣٤، واستثناء جداول `chat_` من «بيانات المستخدم» في `hasUserData`.
  - خاصيتا `aqariAppId` و`aqariAppLabel` في `build.gradle` للحزمة التجريبية، والافتراضي حزمة المالك كما هي.
- **على الجهاز** (الهجرة ٣٤):
  - `chat_threads` و`chat_messages` و`chat_people`، خارج مزامنة الصفوف العامة.
  - الرسالة لا تُحذف (محفّز).
  - والمكتوبة بلا اتصال «لم تُرسل» حتى تُرفع.
- **في السحابة** تحت المنشأة:
  - `chats/{id}` و`chats/{id}/msgs/{id}`.
  - `chatDir/{uid}`: دليل الأسماء والإشراف، يكتبه صاحبه.
  - `chatRoles/{email}`: الإشراف، يكتبه المالك.
  - القواعد كتلة `<chat>` بعد الكتلة المولَّدة، إضافةً لا تغيّر قاعدة قائمة:
    - يقرأ المحادثة أطرافها. والمالك يقرأ محادثةً ليس طرفاً فيها بمراجعةٍ بسببها وحدها، لا المشرف ولا غيره (قرار المالك 2026-10-08T04:11Z، حلّ محل الاطلاع الكامل في اليوم نفسه).
      - قائمة المالك محادثاته وحدها، ولا تُسحب محادثات المنشأة في المزامنة أبداً.
      - زر «مراجعة محادثة» للمالك وحده: يختار من قائمة المحادثات (أطرافها واسمها دون رسائلها)، ويكتب السبب إلزامياً.
      - الفتح التزام واحد: سجلٌّ في `chatReviews` بالمحادثة والسبب والمراجِع ووقت الخادم، ومعه `chatReviewOpen/{chatId}`. والقواعد لا تجيز قراءة الرسائل إلا بمراجعة مفتوحة لها، ولا تفتحها بسجلٍّ سابق.
      - وفي سجل العمليات على الجهاز: المحادثة والسبب والمراجِع ووقته.
      - للقراءة فقط، ورسائلها في الذاكرة لا على الجهاز. وتنتهي بإغلاقها، أو بعد ثلاثين دقيقة في الخادم إن انقطع الاتصال قبل الإغلاق.
      - سجل المراجعات يقرؤه المالك وحده، فلا إشعار بمراجعة بعينها.
      - **ما لا يفرضه الخادم، وسببه:**
        - انتهاء المراجعة بإغلاق الشاشة: الخادم لا يرى الشاشة. التطبيق يحذف المراجعة المفتوحة عند الإغلاق والخروج، وحدّ الخادم ثلاثون دقيقة إن تعذّر الحذف.
        - ألا يحفظ الجهاز ما قرأه: القواعد تمنع الكتابة لا الحفظ. التطبيق يعرض الرسائل من الذاكرة ولا يكتبها.
        - ثبات سجل المراجعات أمام المالك نفسه: يُحذف في نافذة الحذف، والمالك يفتحها. فالسجل المحفوظ في الخادم لا يحميه من صاحب المنشأة.
        - جدوى السبب: القواعد تشترط سبباً غير فارغ لا يتجاوز ٥٠٠ حرف، ولا تحكم على معناه.
        - صف سجل العمليات يكتبه الجهاز. والمرجع في الخادم سجل `chatReviews`.
      - انضمام المالك يجعله طرفاً، فيقرأ سجل المجموعة كله بلا سبب. والأعضاء يرون «انضم المالك»، ويُسجَّل الانضمام في سجل العمليات.
    - انضمام المالك إلى مجموعة ليس فيها مسموح في التطبيق والخادم (قرار المالك 2026-10-08T04:11Z): التزام واحد يضيفه إلى أطرافها ويكتب سطر «انضم المالك» (`sys: 'join'`، ورقمه في `jm`). والقواعد ترفض الانضمام بلا سطره، والسطر بلا انضمام. والهجرة ٣٥ تضيف عمود `sys` لعرضه سطراً لا رسالة.
    - تنبيه ثابت للأعضاء في القائمة والمحادثة: «محادثات المنشأة يطّلع عليها المالك».
    - **إعدادات المجموعة ومسؤولوها** (قرار المالك 2026-10-08T05:31Z)، في مستند المجموعة، وتفرضها القواعد:
      - `s.h` سجل المنضم: `all` كل السابق (الافتراضي) أو `join` من لحظة انضمامه · `s.w` من يرسل: `all` أو `admins` · `s.ad` من يضيف: `admins` (الافتراضي) أو `all`.
      - المسؤولون: المالك دائماً، والمنشئ، ومن في `a` (يعيّنه المالك أو المنشئ من أعضائها). لهم الاسم والإعدادات. والإزالة للمالك والمنشئ (#19)، والمغادرة لصاحبها ومعها خروجه من `a`.
      - الإضافة عضواً واحداً في الالتزام: يُلحق بـ`p` ويُكتب وقت انضمامه من الخادم في `jt` ورقمه في `la`. فلا يضع الجهاز وقتاً سابقاً. والأوائل وقت انضمامهم وقت الإنشاء.
      - «من لحظة انضمامه»: القواعد لا تقارن وقت الرسالة بوقت الانضمام في استعلام السرد، فالسرد لا يُجاز في هذه المجموعة. ويجد العضو أرقام الرسائل في `ids` (وقت الخادم وحده بلا محتوى) ويطلبها رسالةً رسالة، والقاعدة تفرض على كل رسالة أنها بعد انضمامه. ويبقى للعضو أن يعرف عدد ما سبق انضمامه ووقته دون محتواه.
      - المضاف، المالك أو غيره، يرى السابق كاملاً افتراضياً، ويتغير بالإعداد. والهجرة ٣٦ تحفظ الإعدادات على الجهاز.
    - صف المراجعة في سجل العمليات بلا رموز قرّاء، فلا يصل إلا المالك (قرار المالك 2026-10-08T05:31Z). وصف الانضمام كغيره، فالأعضاء يرون «انضم المالك» أصلاً.
    - العضو يقرأ رسائله هو دائماً، ولو في «من لحظة انضمامه» بعد إعادة إضافته، فيصل «عضو سابق» (#2) إليها كلها.
    - الأطراف بلا تكرار، ولا تتغير بلا إضافة أو إزالة، والمضاف عضو في المنشأة أو مالكها.
    - **الدفعة ٢** (قرار المالك 2026-10-08T05:31Z، المرحلة أ):
      - الرد في سلسلة: الرسالة تحمل `re` رقم أصلها في المحادثة نفسها (تفرضه القواعد). والخط الرئيس بلا الردود، ولكل أصل عدد ردوده، وتُفتح سلسلته في ورقة.
      - الإشارة: `men` قائمة «u:رقم» و«s:قسم»، لا تتجاوز ثلاثين (والقواعد تفرض النوع والحد لا صيغة كل عنصر). والرسالة التي تشيرني باسمي أو بقسمٍ لي تُبرز.
      - حال المحادثة في `st` بوقت الخادم، تُسحب بمؤشر واحد: `p_رقم` التثبيت (في المجموعة لمسؤوليها، وفي الفردية لطرفيها، ولرسالة موجودة) · و`r_رقمي` قراءتي حتى وقت رسالةٍ لغيري، يكتبها صاحبها وحده ولا تتجاوز الآن.
      - من قرأ: لمرسل الرسالة، من القراءة في الحال. في الفردية «قُرئت»، وفي المجموعة العدد ثم الأسماء بالضغط المطوّل.
      - المسودة على الجهاز وحده، تُحفظ بالكتابة وتُفرَّغ بالإرسال.
      - الحصة: الحال تُسحب للمحادثة المفتوحة، ولما جاءه جديد في السحب الكامل، وللكل كل عشر دقائق.
      - المسح والحذف (#2 و#28) يصلان الحال. والهجرة ٣٧ تضيف ما يلزم على الجهاز.
      - الرد ينتظر أصله إن لم يُرسل بعد، ويُرفض معه إن رُفض. وورقة السلسلة بلا إشارات ولا مسودة ولا ضغط مطوّل في هذه الدفعة.
      - أوقات الخادم تُحفظ بصيغة واحدة (تسعة أجزاء من الثانية) وتُقارن نصاً، فلا يحلّلها محرّك الجوال.
    - **الدفعة ٣** (قرار المالك 2026-10-08T05:31Z، المرحلة أ):
      - الوسوم: `tag` عاجل أو قرار أو متابعة (تفرضها القواعد)، ويعدّلها المرسل مع نصه.
      - الإعلان المهم: `ack` في الرسالة، وكلٌّ يؤكّد اطلاعه وحده مرة (`st/a_رسالة_رقمه`، إنشاء لا تحديث، ولرسالةٍ تطلبه). ولمرسله من أكّد ومن لم يؤكّد. ويرسله المسؤولون وحدهم (قرار المالك 2026-10-08T10:24Z): المالك دائماً، وفي المجموعة مسؤولوها. والقواعد تفرضه، وخيار «إعلان مهم» لا يظهر لغيرهم.
      - التعديل لمرسلها وهو طرف، في التزام واحد: النص والوسم ورقم التعديل `ev` ووقته `et`، وما قبله في `msgs/رقم/edits/رقم-التعديل`، ورقمه في فهرسها `ids`، وإشارة `st/x_رقم` يسحبها الأطراف فيجلبون الرسالة. والقواعد تفرض كل ذلك، ولا تعديل لسطر نظام. والحذف ممنوع كما قُرّر.
      - سجل التعديل يقرؤه من يقرأ الرسالة نفسها (فالمنضم «من لحظة انضمامه» لا يقرأ سجل ما قبله)، والمالك بمراجعته، ولا يقرؤه في نافذة الحذف. والمسح يحذفه بالأرقام من `ev` في الفهرس دون قراءته.
      - البحث على الجهاز وحده في محادثاتي: بالنص والشخص والتاريخ (من وإلى) والوسم.
    - **الدفعة ٤** (قرار المالك 2026-10-08T05:31Z، المرحلة أ) · `src/chat/channels.ts`:
      - القناة مجموعة فيها `ch`: قسم `{t:'section', key}` أو إعلانات الإدارة `{t:'announce'}` أو عقار `{t:'prop', id}`. رقمها من نوعها (`g_sec_…` و`g_announce` و`g_prop_…`)، وينشئها المالك وحده، ولا تأخذ مجموعةٌ عادية أرقامها.
      - من تحق له: الإعلانات لكل عضو، والقسم لمن له عليه عرض فأكثر، والعقار لمن له كل العقارات أو هذا بعينه. والقواعد تفرضها من مستند العضوية الآن: من سُحبت صلاحيته لا يقرأ ولا يرسل ولو بقي في أطرافها.
      - العضو يضم نفسه إليها بصلاحيته (جهازه يفعل ذلك تلقائياً كل عشر دقائق، وما لم تُنشأ قناته يُعاد بعد عشر دقائق، دورة جهاز المالك). وجهاز المالك ينشئ الإعلانات، وقناةً لكل قسم له عضو، ومحادثةً لكل عقار قائم فيه عضو غير المالك (قرار المالك 2026-10-08T10:24Z)، ويُخرج من لم تعد تحق له.
      - قناة الإعلانات يرسل فيها المسؤولون وحدهم. والقنوات أعضاؤها تلقائيون، ويبقى تعيين المسؤولين فيها.
      - محادثة العقار «تجمع ما يخصه»: الربط فيها بعقود العقار ووحداته وأصوله وحدها، واسمها اسمه. والتنبيهات الآلية فيها من المرحلة ب.
      - الصلاحية الآن شرطٌ في كل كتابة أيضاً (التعديل وسجله وفهرسه وحال المحادثة). وفي القناة لا يُدخل إلا المالكُ أو العضوُ نفسه بصلاحيته.
      - الحصة: القنوات كثيرة (محادثة لكل عقار)، فتُسحب في الخلفية كل عشر دقائق، وفوراً عند فتحها أو فتح شاشة المحادثة. فرسالة القناة قد تتأخر في القائمة حتى عشر دقائق ما لم تُفتح. يُعرض على المالك.
    - **الدفعة ٥** (قرار المالك 2026-10-08T05:31Z، المرحلة أ):
      - المهمة من رسالة: `st/t_رقمها` بعنوان ومسؤولٍ من أطراف المحادثة وموعد (سنة-شهر-يوم) وإنجاز. ينشئها من يرسل، ويعدّلها منشئها، وينجزها مسؤولها (الإنجاز وحده)، ومنشئها لا يتغير. والقواعد تفرض ذلك. و«مهامي» ما أنا مسؤوله في محادثاتي.
      - الاستطلاع: `poll` في الرسالة بخياراتٍ من ٢ إلى ١٠ وهل يُختار أكثر من واحد، والسؤال نص الرسالة. والصوت `st/v_رقمها_رقمي` لنفسه ويُغيَّر، وخيارٌ واحد إلا إن سُمح، وكل رقم خيارٍ دون عدد الخيارات (تفرضه القواعد). والقواعد لا تفرض أن الخيارات نصوص (`join` يقبل الأعداد)، والجهاز يعرضها نصاً.
      - المهمة: المسؤول ينجزها بكتابة الإنجاز وحده، وتعديل المنشئ يحفظ إنجازها كما في الخادم، ولا مهمة لسطر نظام ولا لرسالة لا يقرؤها.
      - الإلغاء لمنشئها وحده (قرار المالك 2026-10-08T10:24Z): `cx` في المهمة، تُنشأ بلا إلغاء، ويغيّره منشئها وحده، ولا ينجز المسؤول ملغاة. فتبقى بحالة «ملغاة» في آخر «مهامي»، لا تُعدَّل ولا تُنجز ولا تُعاد (قراءتي لـ«فتبقى بحالة ملغاة»، تُعرض على المالك). ويُلغيها منشئها ولو غادر مسؤولها المحادثة.
      - التحويل إلى مطالبة أو فاتورة شراء: يفتح نموذج الشاشة نفسها جديداً بنص الرسالة (والعقد المربوط للمطالبة، وعقار محادثة العقار للفاتورة)، والحفظ بمسار الخدمة وصلاحيتها كما هما. والزر لا يظهر لمن لا صلاحية إضافة له.
    - **مع المزامنة العامة** (تحقق الدمج 2026-10-08): جداول المحادثة خارج المزامنة العامة والتقاطها. تفريغ الجهاز لتغيّر الصلاحية ينتظر ما لم يُرسل من المحادثة كما ينتظر طابورها، والمحادثة موقوفة أثناء كل تفريغ. والنسخة الاحتياطية تعدّ الصفوف وتأخذ اللقطة بلا انتظار بينهما، فلا يُفشلها سحب المحادثة.
    - نافذة الحذف لا تُفتح إلا من «حذف حسابي» و«مسح كل البيانات» في التطبيق، ويحرسه اختبار. أما الخادم فلا يميّز مسار من فتحها من المالك نفسه.
    - الحذف والمسح (#2 و#28) يسردان فهرس الأرقام بلا محتوى ويحذفان الرسالة بفهرسها دون قراءتها، ومعها سجل المراجعات.
    - الرسالة تُنشأ مرة بوقت الخادم، ويعدّلها مرسلها بسجلها (الدفعة ٣)، ولا تُحذف.
    - المجموعة للمالك أو مشرف قسم.
    - والمرفقات (`att`) مغلقة حتى الفوترة.
- **الأرقام ثابتة:**
  - الفردية `d_` ورقما الطرفين مرتبين.
  - والرسالة برقمها، وتُنشأ بشرط ألا تكون موجودة.
  - فإعادة الإرسال بعد انقطاع لا تكررها.
- **الربط:**
  - يُربط بعقد أو وحدة أو أصل من جهاز المرسل، ويُحفظ اسم السجل في الرسالة.
  - يفتحه من يجيز له المسار قسمه وعلى جهازه السجل، وغيره يرى الاسم وحده.
  - وطلب الصيانة مصمَّم ولا يُفتح حتى يُبنى.
- **الحزمة التجريبية** `scripts/build-chat-test.sh`:
  - مشروع Firebase تجريبي منفصل `aqari-chat-test`، بالخطة المجانية.
  - اسم الحزمة `com.aqari.app.chat`، والاسم الظاهر «عقاري · تجريبي».
  - ملف البيئة المحلي بمشروع المالك لا يدخل البناء (`EXPO_NO_DOTENV`)، ويقرؤه الفحص للمقارنة وحدها.
  - الشيفرة الأصلية التجريبية في مسار خاص بها، ولا يبقى منها شيء في مسار مخرَج بناء المالك.
  - وفحص `scripts/check-chat-test-apk.sh` يسقط إن وُجد فيها شيء من مشروع المالك، أو لم يُقارن شيئاً، أو خالف اسم الحزمة، أو غاب المشروع التجريبي.
- **الحصة المجانية:** الدليل يُكتب حين يتغير ويُقرأ كل عشر دقائق، والسحب الكامل كل دقيقتين في الخلفية وكل ٣٠ ثانية في قائمة المحادثات، والمحادثة المفتوحة وحدها كل ٨ ثوانٍ.
- **النشر:** `.firebaserc` مشروعه الافتراضي مشروع المالك، فكل نشر من هذا الفرع يحمل `--project aqari-chat-test` صراحةً.
- **قواعد المحادثة** تُنشر على المشروع التجريبي وحده، وعلى مشروع المالك عند الدمج بإذن منفصل.

### ١٣.١٣ الفاتورة الصادرة والإقرار المقدَّم وتاريخ قيد التصحيح (قرارا المالك ٢٠٢٦-١٠-٠٧ على #29 و#30 · الهجرة ٣٨)
- **الفاتورة الصادرة مقفلة:** لا تُعدَّل ولا تعود مسودة ولا تُحذف. المسودة وحدها تُعدَّل وتُحذف. وتغيير الحالة بين «مستحقة» و«متأخرة» والتحصيل وعكسه باقٍ.
- **الإشعار الدائن:** صفٌّ في الفواتير بنوعه (`kind = credit_note`) ومرجعه (`ref_invoice_id`) وسببه (`credit_reason`)، ومبالغه سالبة فتنقص بها المجاميع والإقرار في فترة تاريخه.
  - على فاتورةٍ صادرة غير محصّلة وحدها (المحصّلة يُعكس تحصيلها أولاً)، ولا يزيد على ما بقي منها، وضريبته بنسبة ضريبة الفاتورة.
  - رقمه من تسلسل الفواتير نفسه بلا فجوات (عدّاد السحابة)، وبلا اتصال لا يصدر.
  - قيده: مدين 4100 بالصافي ومدين 2200 بالضريبة / دائن 1200 بالإجمالي، ومصدره صفّه (`invoice`).
  - تحصيل الفاتورة بما بقي منها بعد إشعاراتها، والإشعار لا يُحصَّل. وفحص الذمم يحسب الإشعار ما دامت فاتورته غير محصّلة.
  - يُطبع بعنوان «إشعار دائن» ورقم فاتورته وسببه ومبالغه موجبة.
- **الإقرار المقدَّم:** «تسجيل الإقرار مقدَّماً» (لصاحب «التقارير» كاملاً) يحفظ لقطة بنوده في `vat_filings` (معرّفه «السنة-Qالربع»، تقرؤه أقسام المال ويكتبه قسم التقارير).
  - يُعرض ويُصدَّر بلقطته، والكشوف المساندة من المستندات الآن.
  - ما تغيّر بعده في مستندات فترته يظهر فرقاً بنداً بنداً، يُصحَّح في البند ١٤ من إقرار فترةٍ لاحقة.
  - والتراجع عن التسجيل (إن سُجّل خطأً) يعيد الإقرار يُحسب من مستنداته.
  - **للمنشأة كلها:** يسجّله ويتراجع عنه ذو كل العقارات وحده (القواعد تشترط `m.all`، والزر لا يظهر لغيره)، ويقرؤه ذو كل العقارات من أقسام المال وحده (رموز «قسم|@»).
  - **باقٍ:** العضو المحصور لا يعرف أن الفترة مقدَّمة، فقيد تصحيحه فيها بتاريخه الأصلي، ويظهر فرقاً في الإقرار المقدَّم عند المالك.
- **تاريخ قيد التصحيح** (`vatFilings.correctionDate`): تاريخ الأصل، إلا إن قُدِّم إقرار فترته فتاريخ اليوم.
  - العكس الافتراضي بالمعرّف وبالمصدر، وقيد القيم الجديدة بعد تعديل مطالبةٍ أو فاتورة شراء أو تسوية تأمين.
  - والاسترجاع من السلة بتاريخ العكس الذي يقابله (`repostDate`)، فإلغاءٌ بتاريخٍ اختاره المستخدم ثم استرجاعٌ يتقابلان في فترة واحدة.
  - والتاريخ الذي يختاره المستخدم لحدثه (إلغاء دفعة أو عملية بتاريخها) كما هو.
- **البند ٥ وكشفه من صفوفٍ واحدة:** كل دفعة بصافيها بلا فائضها الذي صار رصيداً دائناً، وفائضٌ قديم سُوّي رصيداً أو رُدّ ينقص في فترة تسويته. والبندان ١٠ و١١ من الحالة الضريبية (#31).
- **باقٍ يُعرض على المالك:** الخدمات (غاز وكهرباء ومياه) والمواقف المحصّلة مع الإيجار السكني تدخل البند ٥ معفاةً، ولا قرار في معاملتها الضريبية.


### ١٣.١٤ المراجعة الشاملة على ac76adc (توجيه المالك 2026-11-06 · الهجرتان ٤٨ و٤٩)
- **حذف الأب الوارد وأبناؤه** (`sync/engine.ts`): حذفٌ يفشل بالمفتاح الأجنبي ولأحد أبنائه نسخةٌ واردة غير حذف في الصندوق ينتظر حتى تُطبَّق الإضافات، فدمج المستأجرين ثم إفراغ السلة يبقي العقد على الوجهة · وما يُفكّ أو يُحذف من الأبناء يُرفع بوقت الحذف الوارد لا بوقت الآن.
- **مؤشر السحب الآمن** (`cloud/firestore.ts` و`chat/sync.ts`): `ts` وقت الطلب في الخادم لا وقت الالتزام، فالمحفوظ آخر مستندٍ وقته قبل وقت القراءة بستين ثانية، والتقليب داخل الدورة بالمؤشر · والمحادثة تعيد الاستعلام من مؤشرها ناقص النافذة.
- **النهاية المتفق عليها** (`contracts.original_end` · الهجرة ٤٨): الإلغاء يقصّ `end` ولا يمسّها، وهي مقام الاستحقاق للعقد الملغى وتنزيلاته · ومحفّزان يبقيانها مع `end` لما لم يُلغَ.
- **رمز ضريبة السطر ونسبته** متطابقان (الصفري والمعفى صفر، والخاضع بصفر مرفوض) · و**الإشعار الدائن** للفاتورة المختلطة سطرٌ لكل رمز بنسبة الباقي منه.
- **الإقرار:** لا يُقدَّم قبل انتهاء ربعه ولا يظهر زره، وقيد التصحيح في فترة مفتوحة دائماً · وكل مسار ترحيلٍ ونقد بتاريخٍ يختاره المستخدم يحترم قفل الفترة · والدفعة الملغاة بعد ربعها تبقى فيه وتُخصم في ربع إلغائها.
- **رقم الفاتورة المحجوز** يُفرَّغ مع الكتابة في معاملة واحدة، والمستعمَل منه لا يُعاد.
- **المزامنة:** إعادة التأكيد بوقت النسخة المعروفة · والانتظار بالزمن (ثلاثون يوماً، الهجرة ٤٩) ويعود المرفوض حين يصل أبوه · والرفض الدائم من الخادم (بنيةً أو حجماً فوق ١ ميغابايت) يخرج إلى سجل المرفوض · والأوقات تُقارن باللحظة لا بالنص (`sync/isoTime.ts`).
- **الخصوصية والموثوقية:** حاجز الأخطاء والمشاركة من بوابة الترقية محجوبان · وجدولة التنبيهات متسلسلة · والاستعادة تدمج WAL قبل الإغلاق وتتوقف إن فشل، والتراجع يحذف WAL المستعادة · والتشفير والفك بمصفوفة إخراجٍ واحدة والتحقق قطعةً قطعة · ومنع لقطة الشاشة يُطبَّق بعد بوابة الترقية ومن الأصلي عند الإقلاع.
- **عمولة التقبيل والضريبة** (البند ١١): المنشأة المسجّلة يُفصل من المقبوض صافيه إلى 4300 وضريبته ١٥٪ إلى 2200 (`taxCode.ts`: `splitVatInclusive`)، والبند ١ من الإقرار يقرؤها من سطور قيودها (`key_money` و`key_money_rev`) فيطابق الدفتر بالهللة · العكس لا يسبق تاريخ الصفقة، والصفقة لا تُستعاد إلى فترةٍ قُدِّم إقرارها · ومصادر 4300 الأخرى بلا ضريبة مخرجات تلقائية (القسم ٤). · **وقيدها يُرحَّل بعد صفّ صفقته** فيحمل أبعادها (عقدها ووحدته وعقاره، أو وحدتها وعقارها)، **وجهاز المالك يرفض قيد العضو بلا أبعاد** (التوجيه الرابع ٣ · ١، قرار المالك 2026-11-07 · `keymoney.ts` و`deriveSources.ts`)
- **فاتورة الشراء** (البند ٤): المسدَّدة لا تُعدَّل حتى يُتراجع عن سدادها، والمحذوفة حتى تُستعاد (`purchaseEditBlock`)، وزرّ «تعديل» يغيب بالسبب نفسه.
- **«نسيت الرمز»** (البند ٥): خروجٌ من قوقل ثم دخولٌ جديد يُفحص رمزه (الحساب نفسه، ومزوّده google.com، وصادرٌ عند الدخول)، وحدّ ثلاث إعادات في ٢٤ ساعة بساعة الخادم (`domain/lockReset.ts`)، وكل إعادة تُكتب في سجل العمليات وتنبيهٍ على الشاشة وحوارٍ في الفتح التالي حتى يُقرّ بها المالك · ويبقى أن جهازاً بلا قفل شاشة وعليه حساب المالك يعيد الضبط في حدّه.
- **دفعة العربون** (البند ٢٧): لا تُلغى دفعةٌ سُدّدت من عربون الحجز (`paidFromDeposit`)، ولا زرّ لها، وجهاز المالك يرفض إلغاءها من عضو · وأداة `cancelled_deposit` للمالك تسدّد بالعالق في 2450 من إلغاءٍ سبق المنع · و`reservation_convert_rev` خرج من مصادر «التحصيل» في القواعد المولَّدة.
- **الودجت والقفل** (البند ٢٣): في القسم ١٣.٥.
- **الاعتمادات والبناء** (البندان ٣٠ و٣١): حُذفت zod، و`npm audit fix` بلا `--force` · وترقية expo-router الرئيسية إلى ٥٨ لم تُنفَّذ، لأنها تتطلب ترقية SDK 58 كلها، وتكون معها (قرار المالك 2026-10-15 «١٣») · وapp.json لا ينتقل إلى مجلد android وحده (README، واختبار التطابق).
- **قواعد السحابة** (البندان ٢٨ و٢٧): صفّ العضو في سجل العمليات عن نفسه برموزٍ عامة وحقولٍ محدودة · مولَّدةٌ من `rulesGen.ts`، ولم تُنشر بعد.
- **المراجعة العدائية الأخيرة** (تتمات البنود ١ و٢ و٣ و١٠ و١٢ و١٤ و٢٧ و٢٨):
  - حذف الأب الوارد يُفكّ فيه محلياً، بلا رفع، الابنُ الذي تنتظره نسخةٌ واردة تنقله. فيُحذف الأب في خطوة الحذف، وتعيد نسخة الابن ربطه في الدورة نفسها، ولا تحجز القيمة الفريدة. وفشل UNIQUE وحذفُ حامل القيمة منتظرٌ يكون «إعادة» لا رفضاً.
  - المرفوض لطول الانتظار يعود حين يصل ما ينتظره، ولو كان حساباً في سطور القيد (`awaitedRefs`).
  - حال المحادثة تُسحب صفحةً صفحة (`pullState`).
  - الرقم المحجوز لا يُسقط إلا إن صدرت فاتورةٌ برقمه نفسه.
  - لا يُلغى قسطٌ بتاريخٍ قبل تاريخ دفعته.
  - الملغى في يوم نهايته بالضبط لا تُشتق نهايته من أقساطه.
  - أداتا العربون السابقتان ترحّلان بتاريخ تصحيحٍ مفتوح، وتعرضان في المعاينة التاريخ الذي ترحّلان به.
  - اللمس الجانبي للعقود يُرفع بلا `original_end` وحده، فلا يُرفض على عقود ما قبل الهجرة ٤٨.
  - سطر العضو عن نفسه بنوعٍ ووقتٍ مما يكتبه التطبيق وحده.
  - إصلاحان ردّهما المتحقق الثاني تُراجع عنهما (`2d67829` و`5b7f33d`)، وما بقي منهما في «الأعطال المعروفة المفتوحة» ٨ و٩ في الخطة.

### ١٣.١٥ نشر القواعد التلقائي (التوجيه الثالث · 2026-11-07)
- `.github/workflows/deploy-firestore.yml`: ينشر `firestore.rules` و`firestore.indexes.json` معاً من main وحده (عند دمجٍ يغيّر أياً منهما، وبالزر) · لا يُنشر شيء قبل: فحص الأنواع، ومطابقة القواعد لمولّدها، والحزمة كاملةً مع محاكيي Firestore والتخزين بلا فشلٍ ولا تعليق.
- المفتاح من السر `FIREBASE_SERVICE_ACCOUNT` إلى ملفٍ مؤقت لا يُطبع ويُحذف في خطوةٍ تجري دائماً · ويُفحص قبل النشر برمز وصول (المنتهي يُفشل برسالة التجديد) وتاريخ انتهائه (IAM أو KEY_EXPIRES_AT تنبيهاً قبله بشهر) · الأدوات في `scripts/firebase/` بلا اعتمادات.
- بعد النشر: القواعد المنشورة تطابق الملف المختبَر حرفاً حرفاً (Firebase Rules API) · وتجربةٌ حية بكود التطبيق نفسه: عضو اختبارٍ في منشأةٍ مصطنعة `orgs/ci-smoke-<run>` يكتب سطره عن نفسه فيُقبل، وبرموزٍ غير عامة فيُرفض، ثم تُحذف المنشأة والعضوية والمستخدم ويُتحقق ألا يبقى شيء.
- **إعادة الاشتقاق (التوجيه الثالث · ١):** أبعاد سطور قيد العضو تُشتق من عقد مستنده وتُطابق كالحساب والمبلغ (`entryDimsIssue`: العقد، والوحدة، والعقار أو عقارٌ نُقلت منه الوحدة بسجل النقل الدائم `unit_moves_log`) · والعاكس مرآةٌ بأبعاد أصله (`mirrorIssue`).
- **الإقرار والإلغاء (العطل ٩):** الدفعة موجبةٌ في فترتها ما لم يقع إلغاؤها فيها، والإلغاء سالبٌ في فترته ما لم تقع الدفعة فيها، أيّاً كان ترتيبهما · فالبند ٥ والإيجار التجاري يطابقان الدفتر.


### ١٣.١٦ التوجيه الرابع · إصلاحات اليوم (2026-11-07)
- **قيد عمولة التقبيل** يُرحَّل بعد صفّ صفقته فيحمل أبعادها، وجهاز المالك يرفض قيد العضو بلا أبعاد (`keymoney.ts` و`deriveSources.ts` · ٣ · ١).
- **حارس الإهلاك (العطل ١١):** موضع الأصل المقبول لقيد الإهلاك ما يصح هنا وبعد تطبيق ما في الوارد معاً (`depUnits`)، فإهلاكٌ مزوَّر بالوحدة القديمة لا يُقبل وقيد النقل الواصل معه لم يُطبَّق بعد، وما خالف ينتظر · ولا يُنتظر النقل مقدّماً لأن التاريخ حقلٌ حر.
- **قوائم `IN (…)` قطعاً** (`src/db/inList.ts` · ٣ · ٢ · دراسة التوسع المرحلة ٠): كل قائمةٍ يكبر طولها بالبيانات تُنفَّذ قطعاً من ٥٠٠ (`allIn` و`runIn`)، فلا تسقط عبارةٌ فوق 32,766 متغيراً · في إعادة حساب الأقساط، ونقل الوحدة، والمحادثة، وفحص الاستعادة الدلالي، وحذف السلة الجماعي، ودمج المستأجرين، والتحصيل بعدة أقساط، وإلغاء الدفعة · والقوائم الثابتة في الكود خارجها.
- **فهارس صندوق الوارد (الهجرة ٥٠):** `sync_inbox(tbl, pk)`، وفهرس تعبير `(tbl, json_extract(payload, '$.d.<عمود>'))` لكل عمودٍ يبحث به المحرّك وقارئ المصادر في الحمولة، و`contract_payments(cancel_entry_id)` · واختبارٌ حارس يسقط إن أُضيف بحثٌ بعمودٍ بلا فهرس · فحص المالك لثلاثة آلاف دفعة عضو خطيٌّ (×٤ للحجم ×٤، وكان ×١١٫٧) وكلفته نحو ١٦٪ فوق سحب المالك لكتاباته نفسها.
- **ما يخرج من التطبيق** (التصدير والمطبوعات والرسائل): الخانة بلا قيمة خالية لا «لا يوجد»، والتاريخ الغائب بـ`dfmtOut` (البند ٤ · ٣ · ٣).
- **الصغير من المحسوم بالقاعدة ٩٩** (٣ · ٤ · تقرير القرارات المعلّقة القسم ٥):
  - **١٣:** «فاتورة ضريبية · قابلة للخصم» للمنشأة المسجّلة في ضريبة القيمة المضافة وحدها (`taxStatusesFor`): لا يظهر الخيار لغيرها ويرفض الحفظ بسببه، وفاتورةٌ كانت كذلك من زمن التسجيل تُعدَّل بوضعها نفسه.
  - **١٨:** الرقم الضريبي فيما يخرج للمنشأة المسجّلة وحدها (`shownVatNo`): رأس المستندات، ورأس التقارير المطبوعة، وملفات إكسل (لا سطر له لغير المسجّلة، وخانةٌ خالية للمسجّلة بلا رقم).
  - **١٦:** نسخة الأمان من قاعدةٍ بلا بيانات لا تحذف ما قبلها (`makeSafetyBackup`)، وسطر المساحة «نسخ الأمان» يعدّها كلها.
  - **٣ (الترحيلة ٥١):** أبعاد سطر القيد المرحّل تُملأ مرةً ولا تُغيَّر: محفّز `trg_jl_dims_fill_only` في القاعدة، والمزامنة تملأ الفارغ وحده.
  - **١٧ (قائمة ما لم يُرفع وسببه بالعربية):** ليس صغيراً، فأسباب الرفض المخزّنة فيها معرّفات المصادر ورموز الخادم وتحتاج ترجمةً لكل سبب · في القسم ٧ (بقايا التثبيت).

### ١٣.١٨ ما أثبته المدققان الخارجيان على إصلاحات اليوم (التوجيه الرابع ٣ · الجولة الأولى · 2026-11-07)
- **نقل الأصل (`deriveSources.ts`):** قيد النقل في الوارد يُحسب «بعد الوارد» إن شهد له حدثه وحده (`evidencedTransfer`: حدث نقلٍ واحد يسمّيه بوحدتيه كما في سطوره) · وفحص الأصل المنتهي يقبل النقل إن انتهى موضعه بعده وحده أو بعد ما في الوارد من نقلٍ مشهود إلى وحدة قيد انتهائه، فنقلان ثم استبعادٌ أو بيعٌ يصلان معاً لا يحبس كلٌّ منهما الآخر (ح٥) · ووحدة النقل في يوم العملية من حدثٍ يشهد له قيده (ح٣) · وحدث نقلٍ وصل وقيده لم يصل بعد يُنتظر قيده ولا يُرفض إهلاك الشهر المشروع (ح٤).
- **عمولة التقبيل:** الاستعادة من السلة تجعل الصفقة تسمّي نسخة قيدها الحيّة، وجهاز المالك يقبل نسخة إصدارٍ أقدم ما دام المسمّى معكوساً وهي الحيّة الوحيدة، وبتاريخ عكس السابق (ك١) · وحركة بنكٍ كتبها عضوٌ برقم قيدٍ لا تُطبَّق قبل قيدها، وتُرفض معه إن رُفض (`memberBankTxCheck` · ك٢).
- **«قابلة للخصم»:** جهاز المالك يرفض قيد فاتورة الشراء وصفّها «قابلةً للخصم» من عضوٍ والمنشأة غير مسجّلة عنده، إلا ما كان هنا قابلاً للخصم (`deductibleIssue` · ض١).
- **ملء الأبعاد:** يتخطى السطر الذي مُلئ بعد عرض الخطة، فلا يُرمى الملء كله بمحفّز الترحيلة ٥١ (ب١).
- **الهجرة ٥٢ والوارد (B1):** `rows()` عبارتان مفهرستان بدل «OR»، و`claimants()` عبارتان وفهرس `ix_je_reversed_by` وخريطة الربط بفهرسٍ عكسي يُبنى مرة لكل نصٍّ محفوظ، و`taken()` من جدول `sync_inbox_lines` (معرّفات سطور قيود الوارد تحفظه ثلاثة محفّزات) بـ`CROSS JOIN` · فثلاثة آلاف فاتورة عضو ٢٫٩ ث (كانت ١٠٫٢)، وألفا عكس تحصيل ٨٫٦ ث (كانت ٥٢٫٦) وسحب المالك لكتاباته وحدها فيها ٦٫٠ ث، وكلفة الفحص دون ١٫٥ ضعف.
- **المخرجات:** المستأجر بلا هويةٍ ساكنٌ بخانةٍ خالية، والقيمة القديمة تُطبع خالية (`shownNationalId` · B6) · وترويسة المستندات للمسجّلة بلا رقمٍ بسطرٍ خالٍ كترويسة التقارير (B7) · والإقرار الضريبي برقم المنشأة المحفوظ ولو أُلغي التسجيل بعده (`vatReturnVatNo` · ن١ بالقاعدة ٩٩).
- **شاشة الوحدات:** مرشِّح «شاغرة/مؤجرة» بقائمةٍ واحدة بـ`json_each` (B5) · **والتحصيل بعدة أقساط ومعاينة إلغاء الدفعة:** المتساويات في الاستحقاق بترتيبها في الجدول ثم بمعرّفها (B4).
- **لم يُغيَّر (ب٢):** قاعدة السحابة `orgOnlyLineDims` تجيز للمالك تغيير بُعدٍ قائم والأجهزة تملأ الفارغ وحده · لا مسار في التطبيق يغيّره، والمحفّز يحرس الأجهزة · يُسجَّل للقسم ٥.

### ١٣.١٨ ب · الجولة الثانية من المدققين الخارجيين (2026-11-07)
- **سطور الوارد (ج١ · حرج · الهجرة ٥٣):** محفّزات `sync_inbox_lines` وكل `json_each` على سطور الوارد تتخطى ما ليس كائناً (`j.type = 'object'`) · كان مستند قيدٍ سطوره نصوص يرمي «malformed JSON» في الإدراج فيتوقف كل جهازٍ يسحبه.
- **موضع الأصل «بعد الوارد» بالمحاكاة (ج٢ وج٦):** النقل المشهود في الوارد يُطبَّق في `placeOf` ما دامت وحدة خروجه تحمل مبلغه، مرةً بعد مرة، ولا يُصدَّق إلا أطول بدايةٍ من السلسلة تنتهي إلى وحدة صفّ الأصل · وعكس النقل في الوارد لا يُحسب إلا مرآةً لنقلٍ مطبَّق · ووحدة النقل يوم العملية في جانب «هنا» من نقلٍ مطبَّق · ومتى طُبِّق قيد الانتهاء فالنقل بعده بنفسه، والاستبعاد والبيع ينتظران ما في الوارد من نقل · والنقل المطابق شكلاً ينتظر إن لم ينتهِ موضعه إلى وحدة صفّ الأصل ولا نقلَ مشهوداً إليها في الوارد · والعضو لا يعكس قيد نقلٍ حدثُه قائم.
- **حركة البنك (ج٣):** رفض قيدها لطول انتظاره مؤقت، فتنتظر معه ولا تُرفض.
- **التقبيل (ج٤ وج٥):** الصفقة في السلة لا يُقبل لها قيدٌ حيّ جديد · والأصل الواصل معكوساً يُقبل والصفقة تسمّي قيداً بعده منها · ونسخة الاستعادة بتاريخ عاكسٍ في الوارد لم يُطبَّق بعد.
- **سرّ النسخ لكل حساب (D١ · عالٍ):** في المخزن الآمن وعلامته باسم الحساب، والسرّ القديم للجهاز يأخذه أول حسابٍ يطلبه · والسرّ السابق (كلمة المرور القديمة أو المفتاح السابق) يبقى ويُجرَّب عند الاستعادة (D٢).
- **نسخة الأمان كما هي (D٣ · القاعدة ٩٩):** قبل الاستعادة والمسح بحكم نسخة ما قبل الترقية (`asIs`): الملف المفقود يُسمّى ولا يمنع، فتُستعاد نسخة ما قبل الترقية الناقصة · والنسخ التي يصنعها المستخدم ترفض وتسمّيه كما قرر المالك، ونصّ البوابة يقول ذلك.
- **Drive (D٤ وD٥):** تعذّر النسخة الظاهرة بعد رفع المخفية ومطابقتها يُذكر مع النجاح ولا يُعلن فشلاً · و«حذف حسابي» يحذف نسخ التطبيق في المجلد الظاهر (ويبقى المجلد، فقد يكون فيه غيرها).
- **المفتاح بخطوتين (D٦):** يُعرض ويُنسخ، ثم يُخفى ويُكتب آخره · ورسالة السرّ المتعذّر بحال المفتاح (D٩).
- **الإقرار (D٧ وD٨):** وورد يحمل المنشأة ورقمها كـPDF وإكسل · ورقمها لغير المسجّلة الآن بإقرارٍ مقدَّم لفترته وحده.

### ١٣.١٨ ج · الجولة الثالثة من المدققين الخارجيين (2026-11-07)
- **التقبيل (هـ١ وهـ٢):** صفقةٌ في السلة عند المالك ونسخة قيد استعادتها في الوارد تنتظر صفّها المستعاد ولا تُرفض (كان الصف المستعاد يصل في الدفعة التالية) · وتاريخ العاكس المعلَّق في الوارد لا يصير تاريخاً مقبولاً لقيد العمولة إلا إن ادّعاه أصلٌ من الصفقة نفسها هو مرآته.
- **الاستبعاد والبيع (هـ٣ وهـ٤):** ينتظران نقلاً في الوارد إن كانت المحاكاة تصدّقه (`placeOf(…).trusted`) وحده، فقيدٌ معلَّق أو حدثٌ يتيم لا يحبسهما · والنقل المشهود يشترط أن يسمّي الحدثُ الأصلَ نفسه (`src_id`) · وفحص الأصل المنتهي يقبل النقل في الوارد إن لم يكن قيد الانتهاء هنا أو كان النقل قبله.
- **أحداث الأصل (هـ٥):** لا يحذفها التطبيق ولا يعدّلها، فحذف العضو أو تعديله لحدثٍ قائم يُرفض على جهاز المالك («حدث الأصل لا يُحذف ولا يُعدَّل») وتُعاد نسخة المالك إلى السحابة · وعكس النقل من العضو يُرفض ما دام حدثه قائماً.
- **البُعد يوم القيد (هـ٦ وهـ٧):** بُعد قيد إثبات التكلفة وبند الأصل في فاتورة الشراء من وحدة الأصل يوم القيد (`originUnits`) لا من آخر نسخة صفّه · وإهلاك يوم تغيير الغرفة أو النقل بموضع الأصل في ذلك اليوم (النقل في الوارد بتاريخه أو قبله)، فلا ينتظر الإهلاك النقل والنقل الإهلاك.
- **السطور المشوَّهة (هـ٨):** مستند قيدٍ سطوره ليست كائنات (null أو نص أو رقم) يُرفض وحده «سطور القيد ليست سطوراً» قبل أي قراءة، ولا يرمي في دورة المزامنة · وكل قراءةٍ لسطور الوارد بـ`docLines`.
- **حركة البنك (هـ٩):** حركةٌ من عضوٍ بلا رقم قيد تُقبل للإيداع النقدي من المحفظة والسحب إليها وحدهما وبحدّ رصيدهما · وبرقم قيدٍ: مجموع حركات القيد لا يتجاوز صافي حساب البنك فيه وبإشارته · وما عداهما ينتظر ولا يُطبَّق.
- **تقارير الأعطال في السحابة (F١ وF٢):** شاهد الحذف (`del:true`) لا يمرّ بقاعدة التقرير ولا بقاعدة «العضو عن نفسه»، ومفتاح المستند يساوي معرّفه · ومسار عملية القسم يرفض صفّ سجلٍ نوعه «تقرير عطل»، فلا تقرير إلا بقاعدته وحدّها.
- **تقارير الأعطال على الجهاز (F٣ وF٤ وF٥):** الكاتب من معرّف حسابه لا من الاسم المكتوب · والحجب يشمل الحروف غير العربية والإنجليزية (الهندية والبنغالية والمليالمية والصينية وغيرها) · وحوار الفشل يكتب التقرير بقاعدة التطبيق المفتوحة إن لم تُمرَّر، فيصل من كل الشاشات (كان من ٢٦ موضعاً من ١٤١).
- **سرّ النسخ (F٦ وF٧):** السرّ القديم الواحد للجهاز لا يأخذه حساب: يُجرَّب عند الاستعادة لكل حساب، ولا يُختم به جديد، وحالته «كلمة مرور قديمة» حتى يُنشأ المفتاح · ويُحفظ لكل حسابٍ عشرون سرّاً سابقاً (كانت خمسة).
- **Drive (F٨ وF٩):** «حذف حسابي» يقرأ المجلد الظاهر صفحةً بعد صفحة فلا تبقى نسخةٌ بعد المئة · والرفع يعيد «فيها ملاحظات» فيظهر حوارها بعد الرفع كما بعد التصدير.
- **نسخة الأمان كما هي (F١٠):** ملفٌ مرفق تعذّرت قراءته أو بصمته يُسمّى مفقوداً ولا يُلغي النسخة، فلا يمنع استعادةً ولا مسحاً.

### ١٣.١٨ د · الجولة الرابعة من المدققين الخارجيين (2026-11-07)
- **حركة البنك من عضو بأثرها لا بنوعها (G١ إلى G٦):** رصيد البنك مجموع حركاته والمحفظة نقد 1100 ناقصاً حركات البنوك، فكل تغييرٍ بلا قيد (إنشاءً أو حذفاً إلى السلة أو نهائياً، أو استعادةً، أو نقلاً إلى بنكٍ آخر) يُفحص بأثره في كل بنكٍ وفي المحفظة: لا ينزل أحدها تحت الصفر، وإلا انتظر · فسحبٌ وإيداعه في رفعٍ واحد يُطبَّقان بأي ترتيب، والتحويل بين بنكين يصل، والمزوَّر ينتظر حتى يُرفض بطول انتظاره · والمصادر بلا قيد: الإيداع والسحب والتحويل صادراً ووارداً بإشارتها · وحركة قيدٍ قائم لا تُحذف ولا تُنقل ولا يتغيّر مبلغها، والجديدة منه بإشارة نقده كلها ومجموعها لا يتجاوزه · وكل صفّ حركةٍ يُفحص برقم قيده نصاً.
- **الاستعادة من السلة في التطبيق نفسه (G٤):** حركةٌ بلا قيدٍ قائم تُستعاد بفحص المحفظة إن كانت واردة والبنك إن كانت صادرة، عكس `deleteBankTx` (`requireBankTxRestorable`).
- **وحدة الأصل يوم القيد (O١ وO٢):** حدث النقل يُحسب في `originUnits` إن كان له قيدٌ هنا أو في الوارد يشهد له بوحدتيه على حساب فئة الأصل، فلا يُدخل حدثٌ «شبح» تكلفةً بأبعاد عقارٍ آخر.
- **تاريخ قيد عمولة التقبيل (K١):** سلسلةٌ من تاريخ الصفقة: عاكسُ أصلٍ من الصفقة يُقبل تاريخه إن كان ذلك الأصل بتاريخٍ مقبول وبمبالغ الصفقة، وعاكسه مرآته (`keyMoneyDates`).
- **عكس النقل (R١):** حدث النقل في الوارد لم يُطبَّق بعد كالقائم، فلا يُقبل عاكس النقل قبله.
- **السطر الذي في حقله كائن (M١):** مشوَّهٌ يُرفض وحده · ومفتاحٌ ليس قيمةً يُعدّ منتظراً لا يُربط · وإعادة الانتظار تتخطى المستند الذي يرمي فحصه.
- **تقارير الأعطال (H١ وH٢ وH٣ وH٧ وH٨):** وقت التقرير في يوم معرّفه فتحدّه القاعدة · والرتبة التي أخذها جهازٌ آخر للحساب تُعاد بالتالية حتى حدّ اليوم (`retryCrashRank`) · والموضع وسطر الفشل يُحجبان: كل رقمٍ بأي كتابة وكل كلمةٍ بغير العربية، والعربية تبقى إن كانت من كلمات التطبيق وحدها (`failureWhere`) · والأثر يُقاس قبل أن يكتب الحوار سطره وتقريره · وسطر الفشل المرفوض لعضوٍ لا يُعدّ في «مرفوض» العضو.
- **سرّ النسخ القديم (H٤):** «حذف حسابي» يُبقيه ما دام على الجهاز حسابٌ آخر مركون، ويمحوه حين لا يبقى غيره.
- **Drive (H٥ وH٦ وH٩):** كل قائمة صفحةً بعد صفحة إلى غياب الصفحة التالية (الحذف، والبحث عن المجلد الظاهر، وقائمة الاستعادة كلها) · ونسخةٌ فيها ملاحظات وتعذّرت نسختها الظاهرة يُقال فيها الأمران.
- **لم يُغيَّر (حدٌّ معروف):** قيد العضو الأصل الذي يصل معكوساً يُقبل بحسابات مصدره دون مبالغه، لأن مستنده قد يكون تغيّر بعده (تعديلٌ يعكس القديم) · فزوجٌ مزوَّر صافيه صفر بتاريخين مختلفين ينقل مبلغاً بين فترتين · يُعالج مع الأساس في القسم ٥ بسجل نسخ المستند.

### ١٣.١٨ هـ · الجولة الخامسة من المدققين الخارجيين (2026-11-07)
- **الأصل الواصل معكوساً (K٢ · حرج):** قيد الوارد المشوَّه السطور لا يُعدّ قيداً في قارئ المصادر، فأصلٌ مزوَّر عاكسه مشوَّه ينتظر ولا يُقبل (كان يُقبل ثم يُرفض العاكس فيبقى نقداً وإيراداً بلا مستند).
- **حركة البنك (I٢ وI٣ وL٥):** الحذف قيمةٌ غير فارغة كما يعدّها الرصيد والسلة، فالنص الفارغ حذفٌ يُفحص · والوارد إلى البنك برقم قيدٍ قائم يُنقص المحفظة فلا ينزل بها تحت الصفر · ووارد التحويل بين بنكين نصفُ نقلٍ صادره مطبَّق فلا يُفحص أمام المحفظة · والتطبيق لا يغيّر بنك حركةٍ بلا قيد ولا مبلغها ولا مصدرها.
- **الرصيد الافتتاحي للبنك (I١ · القاعدة ٩٩):** يضعه المالك وحده: تعديل العضو له يُرفض وتُعاد نسخة المالك، وبنك العضو الجديد بافتتاحيٍّ صفر، وحقله في نموذج البنك مقفلٌ لغير المالك.
- **الأصول (O١ب وR١ب):** شاهد النقل لوحدة الأصل يوم القيد قيدٌ مصدره نقل هذا الأصل نفسه · وحدث النقل في الوارد يمنع عاكسه أياً كانت حقوله.
- **العاكس قبل أصله (L٧):** عاكسٌ لا أصل حرّاً له هنا ينتظر إن كان في الوارد أصلٌ من مصدره هو مرآته أو يسمّيه، ولا يُرفض «عواكس أكثر من أصولها».
- **حدّان معروفان (لم يُغيَّرا):** سحب عضوٍ بلا اتصال من بنكٍ سدّد منه غيره في الوقت نفسه ينتظر ثم يُرفض ظاهراً (L٦)، وصرفان نقديان متزامنان من المحفظة نفسها يُقبلان فتصير سالبةً ظاهرة (L٥): الجهاز لا يعرف ما رآه العضو · يُحسمان بشاشة التعارضات في القسم ٥ · وأصلٌ يصل معكوساً يُقبل بحساباته إن كان عاكسه سليماً، فإن رُفض العاكس لسببٍ من أسباب المالك (عربون الحجز، ونقل أصلٍ حدثه قائم) بقي الأصل · يُعالج مع سجل نسخ المستند في القسم ٥.

### ١٣.١٨ و · الجولة السادسة من المدققين الخارجيين (2026-11-07)
- **حركات بنكٍ ينتظر بعضها بعضاً (K٢):** سببه فحص المحفظة لحركة القيد (I٢)، والقيود تُطبَّق قبل حركاتها · فأُزيل، وحلّ محله قيدُ المصدر: العملية النقدية لا حركة بنكٍ لها إلا الوارد البنكي والرسوم (حسابا 4300 و5400) · وفحص «الأثر مع المنتظر معاً» الذي جُرّب أولاً أُزيل في الجولة السابعة لأنه يعدّ ما لن يُطبَّق ويصنع مالاً وكلفته تربيعية (M١ إلى M٤).
- **اقتران التحويل (K٣):** الصادر الواحد يقابل وارداً واحداً في البنوك كلها، لا وارداً في كل بنكٍ آخر.
- **الرصيد الافتتاحي (K٤ وK٥):** العضو كاتب هذه النسخة بمسار قسمه لا منشئ الصف، فتعديل المالك لبنكٍ أنشأه عضو لا يُرفض على جهازه الثاني · وبنك العضو الجديد يُطبَّق بافتتاحيٍّ صفر وتُعاد نسخته كذلك فلا تعلق حركاته.
- **العاكس وأصله (K١ وK١ب · جذر تقطّع keyMoneyLoop):** العاكس ينتظر الأصل الوارد الذي يسمّيه قبل أي تخمين · ولا يُخمَّن له أصلٌ ربطُه المعلَّق أو نسخته الواردة تسمّي عاكساً آخر · والعاكس من عضوٍ بلا أصلٍ حرٍّ ينتظر ولا يُرفض (أصله قد يصل في دفعةٍ بعده)، والمزوَّر يُرفض بطول انتظاره بلا أثر · والأصل الواصل معكوساً بعاكسٍ طُبِّق هنا لا يسمّيه غيره يُقبل.

### ١٣.١٨ ز · الجولة السابعة من المدققين الخارجيين (2026-11-07)
- **فحص «الأثر مع المنتظر معاً» أُزيل (M١ إلى M٤ وM٨):** كان يعدّ كل حركةٍ في الوارد كأنها ستُطبَّق ولو لم تُطبَّق أبداً، فيمرّ به سحبٌ من بنكٍ فارغ بشريكٍ مزوَّر، وكلفته تربيعية بعدد المنتظر · وK٢ يُحلّ بقيد المصدر أعلاه.
- **استعادة وارد التحويل (M٦):** الاقتران بالصادر للإنشاء وحده، والاستعادة من السلة تُنقص المحفظة فتُفحص.
- **افتتاحي حسابات الدليل (M٧ · القاعدة ٩٩):** كافتتاحي البنك يضعه المالك وحده، وحقله مقفلٌ في الدليل لغير المالك.
- **العاكس وأصوله (M٥ وM١٠):** الأصل الوارد الذي يُنتظر قبل التخمين من مصدر العاكس نفسه ولم يُرفض لطول انتظاره (فقيدٌ مزوَّر بمصدرٍ آخر لا يحبسه) · وربطٌ بعاكسٍ لا وجود له هنا ولا في الوارد (في الصف أو في نسخته الواردة أو في الربط المعلَّق) لا يحجز الأصل عن عاكسه الحقيقي.
- **حدٌّ معروف (M٩، لم يُغيَّر):** أصلٌ مزوَّر بسطور المشروع نفسها يسمّي عاكسه في الدفعة نفسها لا يُميَّز منه، لأن الأصل الواصل معكوساً يُقبل بحساباته وكل شاهدٍ يُرجَّح به يُزوَّر مثله · اختباره `test.failing` يسقط حين يُصلح · يُعالج بسجل نسخ المستند في القسم ٥.
- **ملاحظةٌ للقسم ٥:** حدود الجولات الخمس الأخيرة كلها (L٥ وL٦ وM٩ والزوج المعكوس) من صنفٍ واحد: جهاز المالك يحكم على كتابات العضو بعد وقوعها ولا يعرف ما رآه العضو · والبنية التي تُختار في القسم ٢ هي حلّها الجذري.

### ١٣.١٨ ح · الجولة الثامنة من المدققين الخارجيين (2026-11-07)
- **الافتتاحي حارسه قاعدة السحابة (O٥ · تعديلٌ على I١ وK٤ وK٥ وM٧):** كان جهاز المالك يقارن افتتاحيّ نسخة العضو بما عنده، والسحابة تحفظ آخر نسخةٍ وحدها، فجهازٌ للمالك لم يرَ افتتاحيّه بعد (غائبٌ عن الشبكة أو هاتفٌ بديل) يرفض تسمية العضو للصف أو يصفّرها ثم يعيد نسخته فيمحو الافتتاحي من السحابة ومن الأجهزة كلها · صارت القاعدة (`openingKept` في `rulesGen.ts`، في فحص شكل الصف فلا تدفع الجداول الأخرى تعبيراً من حدّ الألف): العضو ينشئ البنك والحساب بافتتاحيٍّ صفر، ويحمل في كل تعديلٍ افتتاحيّ النسخة السابقة كما هو · فافتتاحيّ نسخة العضو افتتاحيّ المالك الأخير، ويُطبَّق كما هو كما يُوثق بكاتب النسخة · وجهاز العضو يرفع البنك أو الحساب الذي لم يصل السحابة بعد بافتتاحيٍّ صفر ويصفّره عنده (`prepareMemberUpload` · نموذج ما قبل e8d6c19) · و`MemoryRemote` في الاختبارات يطبّق القاعدة نفسها، واختبار المحاكي `d4.auditO.openingRules.emulator` يثبتها.
- **الحساب النظامي والمستعمل (O١ · حرج):** المحفظة نقد 1100 بنوعه وحذفه، فنوعٌ «دائن» أو حذفٌ ناعم من عضو كان يُدخلها مالاً بلا قيد · القاعدة: الحساب النظامي لا يغيّر العضو نوعه ولا مجموعته ولا حذفه ولا كونه نظامياً، ولا يجعل حساباً نظامياً · وجهاز المالك يحرس المستعمل في قيدٍ (هنا أو في الوارد) كذلك، ومجموعة أي حسابٍ، كما يمنعه `saveAccount` و`deleteBlocker`: يرفض النسخة ويعيد نسخته وفيها افتتاحيّ نسخة العضو، فلا تمحو إعادتُه افتتاحياً لم يصله.
- **حركة القيد السالبة (O٢ · القاعدة ٩٩ · سجل القرارات ٥٥):** لا تُنزل بنكها تحت الصفر، فتنتظر ما يكفيها كالحركة بلا قيد · والتطبيق كذلك في سداد فاتورة الشراء من البنك كالرسوم والسحب والتحويل · كانت حركةٌ برقم مصروفٍ نثري (سطراه سطرا الرسوم) أو سدادٍ نقداً من بنكٍ فارغ تُدخل المحفظة نقداً لا وجود له · وحدٌّ موثَّق: مع رصيدٍ يكفي أثرها نقل نقدٍ من البنك إلى المحفظة بلا قيد كالسحب.
- **العاكس المسمّى في الوارد (O٣):** يحجز الأصل إن كان مرآته وحده (صافي كل حسابٍ بعكس إشارته)، فمزوَّرٌ ينتظر بسطرٍ على حسابٍ لا وجود له لا يحجزه · وعاكس المالك لأصلٍ يحجزه عاكسٌ في الوارد ينتظره ولا يُرفض.
- **الأصل الواصل معكوساً بعاكسٍ لا يُقبل (O٤):** يُحكم عليه غير معكوس كما على الجهاز الذي سبق إليه، فيُطبَّق إن طابق مستنده والربط معلَّق · كان هاتف المالك البديل وحده يرفض قيد المالك نفسه نهائياً.

### ١٣.١٨ ط · الجولة التاسعة من المدققين الخارجيين (2026-11-07)
- **الافتتاحي بين جهازٍ وآخر (Q١ وQ١ب وQ٢):** الافتتاحي حقلٌ للمالك وحده فيُدمج بالحقل لا بالصف: جهاز المالك الذي له تعديلٌ معلَّق يُبقي افتتاحيّه ولو غلب الوارد من عضوٍ بقية الصف، ويعيد الصف إلى السحابة (لا في الانضمام: المعلَّق حينها الدليل المزروع) · ورفض نسخة عضوٍ لحسابٍ مستعمل لا يكتب افتتاحيّها فوق تعديلٍ معلَّق · وجهاز العضو يأخذ الافتتاحي من الوارد ولو غلب تعديله، فتحمله نسخته كما في السحابة.
- **حركة القيد السالبة (Q٣ · تعديلٌ على O٢):** فحص الكفاية صار للربط المتأخر وحده: حركةٌ كُتبت بعد قيدها بأكثر من ساعة بوقت الخادم، أو لقيدٍ معكوسٍ هنا، أو لعمليةٍ نقدية · وما كُتب مع قيده يُطبَّق ولو صار البنك سالباً (شيكٌ مرتجع، وسدادٌ متزامنٌ مع سحب، واستعادة فاتورةٍ مسدَّدة) · وسداد فاتورة الشراء بطريقتها في الفاتورة: لا حركة بنكٍ لقيد سدادٍ قائمٍ نقداً، والفاتورة تُنتظر إن لم تصل · وحدٌّ موثَّق: ربطٌ مزوَّر خلال ساعةٍ من قيدٍ صُرف نقده في غير العملية النقدية وسداد المشتريات يمرّ، وأثره في البنك سالبٌ ظاهر.
- **تصفير جهاز العضو (Q٤):** البنك أو الحساب الذي لم يصل السحابة: لا وقت صفٍّ له ولا كاتب (صفوف ما قبل الهجرة ٤٣ لها كاتبها).

### ١٣.١٨ ي · الجولة العاشرة من المدققين الخارجيين (2026-11-07)
- **الربط المتأخر (S١ وS١ب وS٣ · تعديلٌ على Q٣):** حركة القيد السالبة يُفحص بنكها إن كتبها غير كاتب القيد (كاتبه من row_by، وبلا كاتبٍ وارد كتبه هذا الجهاز أي المالك)، أو كان للقيد ربطٌ معلَّق أو كان معكوساً، أو كُتبت بعده بأكثر من ساعة بوقت الخادم (ts تفرضه القاعدة) لا بـ«u» الذي يكتبه العضو · فلا تمرّ حركةٌ مزوَّرة على قيد المالك ولو غيّر العضو طريقة السداد في الفاتورة.
- **الافتتاحي المعروف (S٢ وS٤):** يذكر كل جهازٍ آخر افتتاحيٍّ عرفه في السحابة لكل بنكٍ وحساب (طبّقه أو رفعه)، فيُبقي جهاز المالك افتتاحيّه على وارد العضو إن غيّره المالك هنا منذ ذلك وحده · وجهاز العضو يأخذ الافتتاحي من الوارد في مسار «الوارد أقدم مما عرفه الجهاز» أيضاً.
- **ربط أعمدة الكشف (S٥ · الهجرة ٥٦):** مع الكشف لا في صفّ البنك، فحفظ الكشف لا يعدّل صفّ البنك (لا يجيزه البنوك ٢).

### ١٣.١٩ تقارير الأعطال إلى المالك (التوجيه الرابع ٤ · ٤ · قرار المالك 2026-11-07 «نعم توصلني»)
- **الصف:** كل عطلٍ يمرّ بحوار الفشل أو تسجيله (`reportFailure` و`recordFailure`) أو بالمعالج العام والقاعدة مفتوحة يُكتب صفاً في سجل العمليات بنوع «تقرير عطل» ووحدة «تقارير الأعطال» (`src/domain/crashReport.ts`): الموضع (ما بين «» والأرقام محجوبة، ١٢٠ حرفاً)، وفي الحمولة رقم الإصدار والبناء والمنصة ونوع الخطأ والأثر محجوباً بـ`redactForReport` (لا اسم ولا رقم ولا مبلغ) مقصوصاً من آخره دون ٣٨٠٠ حرف · والقاعدة المرفوضة (`RuleViolation`) ليست عطلاً فلا تقرير لها.
- **للمالك وحده:** النوع في `OWNER_ONLY_AUDIT` فلا قسم يقرؤه ولا رموز رؤية له، فيصل جهاز المالك بالمزامنة نفسها ولا يصل عضواً · والعضو يرفعه بمسار «العضو عن نفسه» (`SELF_OP`) دائماً.
- **الحدّ:** معرّفه `crash-<حساب الكاتب>-<اليوم بتوقيت الخادم>-<الرتبة>` برتبةٍ من ٠ إلى ١٩، والجهاز يقف عند العشرين · وقاعدة السحابة `memberCrashReport` تفرض المعرّف بحساب الطلب، والرتبة دون عشرين، واليوم بين ثمانية أيامٍ مضت وغد، والإنشاء وحده، وحقول السجل بحدودها والحمولة دون ٤٠٠٠ · والمرفوض منها يخرج من الطابور بلا سطرٍ في «مرفوض» العضو.
- **العرض:** للمالك في «حالة المزامنة» سطر «تقارير الأعطال (٣٠ يوماً)» بعددها، يفتح قائمتها الأحدث أولاً (التاريخ والوقت والكاتب، والموضع والإصدار)، ولكلٍّ تفصيله ونسخه وإرساله.
- **النشر:** القاعدة الجديدة تُنشر تلقائياً حين يُدمج الفرع في main (`deploy-firestore.yml`) · وقبلها يُرفض تقرير العضو في السحابة صامتاً ويبقى على جهازه.

### ١٣.٢٠ المنطق المحاسبي النقي بالأرقام الذهبية (التوجيه الرابع ٤ · ٥ · بلا تغيير في المخطط)
- **`src/domain/ledgerCore.ts`:** دوالٌ خالصة لا تستورد شيئاً (لا قاعدة ولا وحدات جهاز ولا ترجمة)، فتعمل كما هي على الجوال وعلى أي خادمٍ تختاره البنية: النسبة المئوية لأقرب هللة، وفصل الضريبة من المبلغ الشامل (الصافي مقرَّباً والضريبة الباقي)، ونصيب الإيجار والخدمات والمواقف تراكمياً على مستوى العقد، والإهلاك بالقسط الثابت (القسط والأخير والمستحق حتى يومٍ بنسبة أيام شهره)، وسطور قيود عمولة التقبيل وفاتورتي المبيعات والشراء وقبض التأمين.
- **مصدرٌ واحد لكل حساب:** `splitVatInclusive` و`pctOf` و`rentSplit` و`monthlyAmounts` و`expectedThrough` و`keyMoneyLines` و`invoiceLedgerLines` و`purchaseLedgerLines` و`contractDepositLines` تستدعي النواة · فلا يختلف ما يرحّله الجوال عمّا يشتقه جهاز المالك أو خادمٌ لاحق.
- **الأرقام الذهبية:** `tests/golden/ledger.golden.json` حالاتٌ محسوبة يدوياً بحسابها مكتوباً بجوار كلٍّ (منها حدود التقريب: نصف الهللة، والهللة الواحدة، والمبالغ الكبيرة، وباقي القسمة في الإهلاك والخدمات) · واختبار `d4.goldenLedger` يطابقها بالنواة وبالدوال المرتبطة بالقاعدة معاً، ويحرس أن النواة لا تستورد شيئاً · ولا يُعدَّل رقمٌ ذهبي ليطابق الكود.

### ١٣.٢١ قراءة فاتورة الشراء من رمزها (التوجيه الرابع ٦ · ١ · «صورة أو PDF، ورمز QR أولاً»)
- **المصادر الثلاثة** من «قراءة QR الفاتورة» في الفاتورة الجديدة وحدها: تصوير الفاتورة، أو صورةٌ من المعرض (ML Kit للرموز على الجهاز · `services/invoiceQr.ts` · يرسل إلى قوقل بيانات استعمالٍ لا الصورة · F-2)، أو ملف الفاتورة الإلكترونية: XML بصيغة UBL، أو PDF/A-3 يضمّنه (`domain/invoiceFile.ts`: المرجع الإضافي برقم «QR»، ومجاري `/EmbeddedFile` بسقوف المستخرج) · وPDF رمزه صورةٌ لا ملف فيه يُصوَّر.
- **الرمز** Base64 لسلسلة TLV كما تشترطها الهيئة (`domain/zatcaQr.ts`): ١ البائع، ٢ رقمه، ٣ الوقت، ٤ الإجمالي، ٥ الضريبة، ووسوم المرحلة الثانية ٦ إلى ٩ تُتخطّى · وصورةٌ فيها رابط المتجر ورمز الهيئة يُختار منها رمز الهيئة (`pickZatcaQr`)، وإلا فالسبب الأقرب إليه.
- **مسودةٌ لا تُحفظ بنفسها** (`purchaseDraftFromQr`): المورد بالرقم الضريبي ثم بالاسم، وموردٌ غير مسجّل يُضاف برقمه بتأكيد المستخدم أو تُعبَّأ المبالغ وحدها · والتاريخ يوم الإصدار بتوقيت الجهاز · والمبالغ كما في الرمز والصافي الإجمالي ناقص الضريبة · والصورة أو الملف يُرفق أصلاً للفاتورة · والوضع الضريبي لا يُقرأ (الرمز لا يحمل المشتري) فيبقى الافتراض حتى يختار المستخدم · والتنبيهات تُعرض ولا تمنع: رقمٌ ليس بصيغة الهيئة (فلا يُحفظ للمورد)، ووقتٌ لا يُقرأ (فاليوم)، وضريبةٌ فوق الإجمالي، وضريبةٌ ليست ١٥٪ من الصافي.
- **«والمكررة تُرفض»** (الهجرة ٥٤): الفاتورة المقروءة تحمل `qr_key` (الرقم الضريبي ووقت الإصدار بالثانية والإجمالي والضريبة · `zatcaQrKey`) · وفاتورةٌ حيّة بالمفتاح نفسه تمنع القراءة والحفظ برقمها وتاريخها، ولا تعود من السلة فوقها · وما في السلة لا يمنع · والمُدخلة يدوياً بلا مفتاح لا تُفحص (فاتورتان متطابقتان في يومٍ واحد ممكنتان) · والتعديل يُبقي المفتاح · ولا قيد تفرّد في القاعدة: نسختان من جهازين بلا اتصال تصلان ولا تُسقطان المزامنة.
- **الصلاحيات:** من له «إضافة» في فواتير الشراء يقرأ ويضيف المورد (الموردون في القسم نفسه) · والعضو يرفع فاتورته ومفتاحها كأي فاتورة، وجهاز المالك يشتق قيدها كما هو.
- **التوسع:** فهرسٌ جزئي على المفتاح (`ix_purchases_qr_key`)، ففحص التكرار لا يكبر بعدد الفواتير.
- **الجوال الافتراضي:** ١١ أ يولّد صورة رمزٍ مصطنع (`e2e/qrInvoice.js`) ويدفعها إلى معرض المحاكي، و١١ ب يقرؤها من المعرض فيضيف المورد ويحفظ ١٠٠٠ + ١٥٠ = ١١٥٠.

- **ما أصلحته الجولة الخامسة (المدقق J):** المورد بالرقم الضريبي ثم بالاسم وحده إن لم يكن لبطاقته رقمٌ يخالف رقم البائع، وإلا اقتُرح موردٌ باسمٍ يحمل رقم البائع مع تنبيه (J١) · ورقم البطاقة بأرقامٍ عربية هندية يُطابَق (J٥) · والوقت بلا منطقة وقتُ الفاتورة المحلي، وبمنطقة يُحوَّل، والفاصل حرف T أو مسافة (J٢ وJ١٣) · والمبالغ بالأرقام العربية الهندية تُقرأ، و«115,00» فاصلةٌ عشرية لا فاصل آلاف (J٣ وJ٤) · والإشعار الدائن (InvoiceTypeCode 381 أو جذر CreditNote) لا يُعبَّأ فاتورة شراء ويُقال ذلك (J٦) · والملف المضمّن يُعرف بنوعه XML أو محتواه ولو بلا «/Type /EmbeddedFile» (J٧) · ومسح XML خطّيٌّ بحدودٍ لكل خطوة (J٨) · والوحدة غير المربوطة «حدّث التطبيق» (J٩) · وقراءة رمزٍ ثانٍ تحلّ صورتها محل صورة الرمز الأول لا محل ملفٍ أرفقه المستخدم (J١٠) · ووقتٌ لا يُقرأ بالثانية لا يصنع مفتاحاً، فلا تُرفض فاتورتان في يومٍ واحد بالمبلغ نفسه (J١٣).
- **وتقارير الأعطال (J١١ وJ١٢):** الرتبة لا تُعاد إلا ليومٍ في نافذة القاعدة (الأيام السبعة الماضية واليوم)، فعطلٌ قديم لجهازٍ عاد بلا اتصال لا يصير عشرين صفاً · والحجب يشمل حروف الكتابة العربية الممتدة (الفارسية والأردية).

- **وما أصلحته الجولة السادسة (المدقق L):** رقم البطاقة يُقارن بأرقامه وحدها (شرطات، مسافات، علامة اتجاه) · والوقت يُقرأ بأرقامٍ عربية هندية، ويومٌ ليس في التقويم («2026-02-30») لا يُقرأ ويُنبَّه · والمفتاح من وقتٍ بالثانية وحده · والمورد المؤرشف يُنبَّه ليُعاد من الموردين وتُعبَّأ المبالغ وحدها · وتسلسل UTF-8 غير صالح سببه الصيغة لا رميٌ يُسقط بقية رموز الصورة، وما يرمي بعد القراءة يُقال · وفتح فاتورةٍ للتعديل يمسح صورة رمزٍ معلّقة من فاتورةٍ جديدة لم تُحفظ.
- **وموضع تقرير العطل (L٧):** لا يبقى منه بعد الكلمات الثلاث الأولى شيء، لأن ما بعدها قد يكون اسماً كلماته من كلمات التطبيق · ورفع الملف إلى المكتبة يمرّر موضعاً ثابتاً لا يحمل اسم الملف.

- **وما أصلحته الجولة السابعة (المدقق N):** بطاقة المورد تُطابَق برقمه إن كان فيها مقطعٌ منه (رقمٌ ضريبي ومعه السجل التجاري) · وعلامات الاتجاه في رقم الرمز تُهمل · واسم البائع الفارغ «ناقص» · والتعبئة تمسح العدّاد المختار لموردٍ قبله · وقراءةٌ بدأت لفاتورةٍ جديدة لا تكتب في نموذجٍ تغيّر أثناءها (رقمُ قراءة) · وتنبيه المورد المؤرشف يسمّيه · ونموذج الفاتورة يُفتح بلا موردين فتضيف «قراءة QR الفاتورة» المورد، والحفظ يطلبه · و«استعادة الكل» تقول ما بقي في السلة، ورفض المكررة رسالةُ قاعدةٍ لا تقرير عطل.
- **وما أصلحته الجولة الثامنة (المدقق P):** ما لا يُرى في نصوص الرمز (علامات الاتجاه ALM وLRM وRLM والتضمين والعزل، والمحارف الصفرية وBOM والواصلة اللينة) يُزال من الوسوم كلها قبل قراءتها: فالرقم والوقت يُقرآن، واسمٌ منها وحدها «ناقص» · والاسم يُطابَق بلا ما لا يُرى وبمسافاتٍ موحّدة · والبطاقة تحمل الرقم إن كان في مقطعٍ منها مجموعاتُ أرقامٍ متتالية هي الرقم كله (فيُعرف «الرقم - السجل»)، وبين البطاقات الحاملة: غير المؤرشفة، ثم رقمها هو الرقم وحده، ثم اسمها اسم البائع (سجل القرارات ٥٤) · والتعبئة تضع فئة المورد الافتراضية كاختياره يدوياً · وإغلاق النموذج وحفظه يُبطلان قراءةً جارية · و«فاتورة شراء» من المحادثة تُفتح بلا موردين.
- **وما أصلحته الجولة التاسعة (المدقق R):** منتصف الليل المحشوّ «T00:00:00» تاريخٌ وحده فلا مفتاح منه (رمز فواتير التطبيق نفسه يكتبه) · وبصمة المرحلة الثانية (الوسم ٦) مفتاح الفاتورة إن وُجدت · وفاتورةٌ بلا مفتاح تشبه الرمز (اليوم والإجمالي والضريبة، والمورد برقمه أو اسمه) يُسأل عنها قبل التعبئة («هي فاتورةٌ أخرى») · ولا مبلغ سالب في فاتورة الشراء، رفضٌ بقاعدةٍ لا قيدُ القاعدة · والاسم بيونيكود موحَّد (NFKC) · والبطاقة المؤرشفة المطابقة رقماً واسماً تُنبَّه ولا تغلبها بطاقةٌ أخرى (المؤرشف تفاضلٌ أخير) · والوقت ذو المنطقة يومه بتوقيت المملكة، والوقت الذي لا يُقرأ ويومه صحيح يُؤخذ يومه، والمنطقة بعد مسافة تُقرأ · و«المبالغ وحدها» تفرغ المورد · والمرفق أثناء القراءة لا يُستبدل.
- **وما أصلحته الجولة العاشرة (المدقق T):** وقت الإصدار يُقرأ بمحلّلٍ واحد (`parseIssued`: الساعة وحدها في المنطقة «+03»، و« UTC» و« GMT» و«[UTC]»، والسنة بين 1990 و2100، والساعة 24 لا تُقرأ) · ويوم الفاتورة المكتوب لتاريخٍ وحده أو لمنتصف ليلٍ محشوّ، وبتوقيت المملكة لذي المنطقة · والمفتاح يحمل حقائقه («T» لحظةٌ بالثانية أو «D» يومٌ، والمبلغان، والبصمة)، والتكرار يُحكم بالحقائق (`qrKeysExact` و`qrKeysAlike`) فتُقرأ مفاتيح الإصدارات السابقة · والبصمة نفسها في يومين فاتورتان · والشبيهة بلا مفتاح تشمل بطاقةً بلا رقم · والاستعادة ترفض الشبيهة أيضاً · والضريبة لا تزيد على الإجمالي · والتعبئة تلغي تأكيد «الفاتورة باسم المنشأة».
- **وموضع تقرير العطل (N٩ وN١٠):** عنوانٌ يطابق حرفاً بحرف عنوان فشلٍ مكتوباً في الكود (`failureTitles.json` يولّده اختبارها ويحرس أن لا عنوان من بيانات المستخدم بلا موضعٍ ثابت) أو نصاً في ملفَي الترجمة يبقى كما هو · وما سواه يُقصّ بعد الكلمة الثالثة بين أي فاصلين ثم يُحجب.

### ١٣.٢٢ كشف البنك (التوجيه الرابع ٦ · ٢ · الهجرات ٥٥ إلى ٦١)
البحث في [دراسة-كشف-البنك](التقارير/دراسة-كشف-البنك-2026-11-07.md). وما حُسم بالقاعدة ٩٩ في سجل القرارات ٥٦.
- **الصيغ بترتيب الواقع:** PDF بطبقة نص (أغلب كشوف الأفراد)، ثم Excel وCSV، ثم MT940 (للمنشآت) · والصورة أخيراً بأقل ثقة: قارئ النص في الجوال (ML Kit) لا يقرأ العربية، فتُقرأ منها الأرقام والتواريخ وحدها.
- **قارئٌ عام لا محلّلٌ لكل بنك:** النص بمواضعه أو الخلايا ← صفوفٌ تبدأ بتاريخ ← أدوار الأعمدة بقاموس العناوين العربي والإنجليزي ثم بشكل القيم ← فرضيات (عمودا مدين ودائن أو مبلغٌ موقَّع، والترتيب) يُختار منها ما تتسلسل به الأرصدة ويطابق الافتتاحي والختامي ومجاميعهما · وإن لم تثبت فرضية فلا يُحفظ شيء ويُقال أي فحصٍ سقط.
- **الربط لكل حساب بنكي:** بصمة صف العناوين وأدوار الأعمدة وصيغة التاريخ ونوع المبلغ تُحفظ مع الكشف (الهجرة ٥٦) ويُقرأ بربط آخر كشفٍ حيٍّ للبنك ما بعده · وأول مرةٍ للبنك أو لشكلٍ جديد تُعرض الأعمدة بأدوارها المخمَّنة وصيغة التاريخ «أعمدة الكشف» فيؤكدها المستخدم أو يصححها (الدور الواحد لعمودٍ واحد) وتُعاد القراءة بالمصحَّح (قرار المالك 2026-10-09 أ.٣ · U٩) · وإن لم تُعرف الأعمدة أصلاً عُرض صفّ العناوين المرجَّح (ما قبل أول صفٍّ بتاريخ) ليحدّد المستخدم أدواره.
- **الافتتاحي مع الحركات يساوي الختامي:** لكل سطرٍ طُبع رصيده، ولكل كشف، وبين الكشفين (ختامي السابق افتتاحي اللاحق) · بالهللة · وما قبل أول رصيدٍ مطبوع يشهد له الافتتاحي، وما بعد آخره الختامي، وإلا طُلبا من رأس الكشف (الافتتاحي معبّأً بما اشتُق، والختامي يُكتب من الرأس فلا يصير الفحص تحصيل حاصل) · والكشف الذي لا يثبت فحصه يُنبَّه به، ويُحفظ «غير متحقَّق» بتأكيدٍ صريح إن عُرفت إشارات حركاته كلها (`unverifiedResult` · الهجرة ٥٧: `bank_statements.verified = 0`) فتبدأ مطابقته وينبّه به تقرير الشهر (قرار المالك أ.٤ · سجل القرارات ٥٨).
- **لا كشف ولا سطر مرتين:** بصمة الملف، وبصمة السطر (البنك والتاريخ والمبلغ الموقَّع والرصيد والبيان المطبَّع) مع رقم تكرارها في الكشف، فالكشفان المتداخلان لا يضيفان السطر نفسه · ومرجع البنك وحده لا يكفي.
- **المطابقة المقترحة بدرجة ثقة (٠ إلى ١٠٠):** المبلغ والاتجاه شرط، ثم قرب التاريخ، ثم ما يشتركان فيه من رموز (رقم القيد والعقد والفاتورة، والاسم) · «جاهزة للاعتماد» من ٨٥، و«تحتاج مراجعة» بسببها من ٥٠، وما دونها لا يُعرض · ولا اعتماد بلا موافقة.
- **الإيداع بالتحصيل (`collect.ts` · قرار المالك 2026-10-09 ج.١ وج.٢ وج.٥ وج.٧):** الإيداع المفتوح الذي لا حركة له في الدفاتر يُقترح له قسطٌ قائم (أقدم القائم في عقده، أو ما يستحق في أسبوع السطر) بمتبقّيه، أو أقساطٌ متتالية من أقدم القائم لعقدٍ واحد بمجموع متبقّيها (تحويلٌ واحد لعدة أقساط، حتى اثني عشر)، أو مطالبةٌ مفتوحة بمبلغها، أو فاتورةٌ مستحقة بمتبقّيها · الدرجة: المبلغ ٥٠ (والأقساط المتعددة ٤٥)، وقرب الاستحقاق حتى ٢٠، والاسم في البيان ٢٠، والرقم المشترك (العقد أو إيجار أو الفاتورة) ١٥، والوحيد +٥ والمتعادل −١٥ · فالجاهز يحتاج ما يعرّف صاحبه (اسماً أو رقماً) · والاعتماد بموافقةٍ صريحة، فرداً أو «اعتماد الجاهزة» بعد عرضها، يسجّل التحصيل بمساره المعتاد في بنك الكشف بتاريخ السطر ومبلغه (`recordRentPayment` و`recordBulkRentPayment` و`collectClaim` ببنكه و`payInvoice`) ثم يطابق السطر بحركته، كله أو لا شيء، وكل اعتمادٍ سطرٌ في سجل العمليات «اعتماد تحصيلٍ من كشف البنك» · ومعرّفات ما يكتبه الاعتماد حتميةٌ من السطر والهدف ورقم الاعتماد (`withDeterministicIds`)، فجهازان يعتمدان الإيداع نفسه للهدف نفسه بلا اتصال يكتبان الصفوف نفسها فتلتقي تحصيلاً واحداً (W١)، وهدفان مختلفان للسطر نفسه يظهر ثانيهما «في الدفاتر وحدها» في التقرير · والاسم الذي يعرّف صاحب الإيداع اسم المستأجر الأول أو اسمان منه (الصدر المركّب «عبد» و«أبو» مع ما بعده، والعائلة وحدها لا تكفي · W٥)، والمرجع رقم العقد أو إيجار أو الفاتورة كاملاً لا السنة وحدها (W٤) · والأقساط تُفحص قائمةً عند الاعتماد (W٣)، وسطور الربع المقدَّم إقراره لا يُقترح لها تحصيل، و«اعتماد الجاهزة» يكمل بعد ما يُرفض (W٦) · والمجمَّع من منصة إيجار لعدة مستأجرين ينتظر طريقة «عبر إيجار» وحساب «قيد التحويل» (القسم ٥ · ٤) ثم ملف إيجار (٦ · ٣).
- **غير المطابق (قرار المالك ج.٤):** فرقٌ يظهر في التقرير، وله «تسجيل» يفتح نموذج التطبيق نفسه معبأً (رسوم بنك، أو وارد، أو سحب، أو إيداع، أو تحويلٌ بين حسابين بنكيين) فيحفظه المستخدم من مساره، أو «مصروف» يفتح فواتير الشراء و«تحصيل جديد» يفتح التحصيل ثم يُطابَق السطر بحركته، أو «استبعاد» بسبب، أو يبقى معلّقاً · ولا إنشاء جماعي (الاستيراد موقوفٌ بقرار المالك 2026-10-24).
- **تقرير المطابقة لكل بنك وشهر:** افتتاحي الكشف وختاميه مقابل رصيد البنك في التطبيق، والمطابق، وغير المطابق في الطرفين، و«في الطريق» (حركةٌ في دفاتر الشهر سطرُ كشفها في شهرٍ آخر، وعكسه · U١٤)، والمستبعد بسببه، والفجوات والتداخل بين الكشوف، والكشف غير المتحقَّق.
- **القارئ بعد المدقق V:** الصف الذي فيه مبلغ مدينٍ أو دائن حركةٌ أياً كانت كلمات بيانه («ACCOUNT OPENING DEPOSIT» · V٢)، والصف المؤرَّخ بلا مبلغ حركة ليس حركة (ختم الطباعة · V١٣)، ورقم الحساب في خلية كلمته أو التي تليها وحدها (V٧)، وعنوان «Cr/Dr» عمود نوع (V٨)، وتسلسل Excel بكسر الوقت يومه جزؤه الصحيح (V٩)، وفحص الفترة في القراءة الجزئية كالناجحة (V١١) · والاقتراحات بفهرسٍ بالمبلغ ونافذة تاريخ (V١٠: سنةٌ لمئة وحدة كانت ست ثوانٍ لكلٍّ منهما)، والسنة وحدها ليست رقماً مشتركاً.
- **بعد الجولة الثانية عشرة (X وY):** معرّف الكشف حتميٌّ من البنك وبصمة الملف، ومعرّف السطر من البنك وبصمته، فالملف نفسه يُقرأ على جهازين بلا اتصال فيلتقي كشفاً وسطوراً واحدة، وبذرة الاعتماد واحدة (Y٣ وX٢) · و`shared_keys` بصمات سطور الكشف كلها، فسطرٌ يحتاجه كشفٌ حيٌّ لا يُحذف ولا يُحيا وله سطرٌ حيٌّ آخر (X١)، وإحياؤه لا يمحو مطابقةً حيّةً هنا، ويرفعها الجهاز تعديلاً منه، وتصحيح جهاز المالك يغلبه أي تعديلٍ وارد ولو تساوى الوقت (Y٧) · والإلغاء لا رجعة فيه: نسخةٌ تُحيي دفعةً ملغاة أو تجعل فاتورةً «مدفوعة» بقيدٍ معكوس لا تُطبَّق ويرفع جهاز المالك نسخته (Y١ وY٢ وX٣) · ومعرّف الاعتماد محجوزٌ إن عرفه الجهاز وارداً أو مرفوضاً (Y٤) · والقيد نفسه برقمٍ آخر في السحابة يُرفع برقمه هناك، واسم رقمه لا يُسجَّل إلا لقيدٍ سطوره سطوره ورقمه ليس رقم قيدٍ آخر (Y٥ وY٦) · ورقم الحساب بكلمته «Account No/Number» لا «Account» وحدها والتاريخ ليس رقماً (X٤)، و«Debit/Credit» عمود نوع إلا مع كلمة المبلغ (X٥)، والصفر في المدين والدائن ليس حركة والافتتاحي المؤرَّخ من عمود الرصيد (X٦)، والفارغ في ورقة الأرصدة «لم يُكتب» (X٨)، والاقتراحات بنافذتين (أقدم القائم ٤٥ يوماً وما بعده أسبوع) وبقوالب مشتركة (X٧: ثلاثمئة وحدة).
- **بعد الجولة الثالثة عشرة (Z١ وZ٢ · الهجرة ٥٩):** قيد التحصيل من الكشف يحمل سطره (`journal_entries.stmt_line_id`)، فقيدٌ حيٌّ ثانٍ من عضوٍ للسطر نفسه يُرفض على جهاز المالك وتسقط معه دفعته وحركته، ويُطابَق السطر بحركة التحصيل الباقي (Z٢-١) · وبين قيدين حيّين من المصدر نفسه في الوارد معاً ينتظر الأكبر معرّفاً وحده، والتحصيل الثاني لمطالبةٍ أو فاتورة مرفوض، وصفّ المطالبة «محصَّلة» ينتظر قيد تحصيله (Z٢-٦) · والنهائي في المزامنة: الدفعة الملغاة، والقيد المعكوس (نسخته المعكوسة تغلب)، والمطالبة المحصَّلة (لا تُحذف ولا يتغيّر مبلغها ولا يُعكس قيدها من عضو)، والفاتورة المدفوعة بقيدٍ حيّ (Z١-١ وZ٢-٢ إلى Z٢-٤) · ودفعةٌ تصل حيّةً وقيدها معكوس هنا تُصلح ملغاةً بعاكسه، وإلغاء الدفعة بمعرّفاتٍ حتمية من معرّفها · وصفّ الكشف أو سطره المنشأ ثانيةً بالمعرّف نفسه لا يغلب الأقدم إنشاءً (Z١-٤)، وإعادة القراءة بعد الحذف بمعرّفاتٍ جديدة فهي إدخالٌ يجيزه «البنوك ٢» (Z١-٥)، وسطران حيّان بالبصمة نفسها يبقى منهما المطابَق ثم الأقدم (X١) · والإحياء يُبقي مطابقة هذا الجهاز غير المرفوعة وحدها (Z١-٣)، وعلامة التصحيح بوقت صفّ الطابور (Z١-٦ وZ٢-٧) · وبصمة السطر تحمل الرصيد المطبوع لاحقةً تفرّق حركتين باليوم والمبلغ نفسيهما ولا تمنع مطابقة صيغةٍ بلا رصيد (Z١-٢) · والفاتورة المحصَّلة لا يُعاد تحصيلها من الكشف (Z٢-٥)، وحركة قيدٍ معكوس لا تُقترح للمطابقة (Z٢-٩)، ولا «مرفوض» لقيدٍ عرف الجهاز رقمه في السحابة (Z٢-٨).
- **بعد الجولة الرابعة عشرة (A٢ وB٢):** ما يكتبه العضو رابطاً بالمال لا يُصدَّق إلا بأثر ماله: قيدٌ يحمل سطر الكشف لا يحجز الإيداع إلا وحركته في بنك السطر بمبلغه وتاريخه، هنا أو في الوارد (B٢-١)، والحارس بالإيداع (بصمته) لا بمعرّف السطر، فحذف الكشف وإعادة قراءته لا يفتحان تحصيلاً ثانياً (B٢-٤)، وينتظر لا يرفض إن كان عكس القيد الحيّ معلَّقاً (B٢-٣ وA٢-٣) · وعاكس العضو لتحصيلٍ من الكشف، وربط أصله به، ينتظران حركات البنك السالبة برقم العاكس، فعاكسٌ وحيد مزوَّر لا يُلغي الدفعة (B٢-٥) · وصفّ الفاتورة «مدفوعة» بقيدٍ غائب ينتظره أو يُرفض كصفّ المطالبة (A٢-١) · ووقائع السطر من البنك (البنك والبصمة والتاريخ والمبلغ والرصيد والبيان والمرجع) لا يعدّلها عضو (B٢-٩)، وإعادة ربط السطر بحركةٍ أخرى بالتاريخ نفسه وبحركةٍ لا يحملها سطرٌ آخر (B٢-٢) · والسطر المطابَق أو المستبعَد هنا لا يغلبه وارد «مفتوح» أياً كان الأقدم إنشاءً، إلا واردٌ يفكّ المطابقة صراحةً (A٢-٤ وB٢-٨) · وبصمة السطر: الرصيد المطبوع يميّزه حيث وُجد، ورقم التكرار حيث لا رصيد، فالحوالة نفسها في كشف الشهر وفي صورة صفحته سطرٌ واحد (A٢-٥)، والبحث عنها بمدى الفهرس (A٢-٧) · وإلغاء الدفعة بمعرّفاتٍ من معرّفها وتاريخ الإلغاء، وحقول الإلغاء وتاريخ حركة القيد لا يغيّرها عضو (A٢-٦)، ويفكّ مطابقة سطر الكشف بحركتها فيعود الإيداع للاقتراح (B٢-٧) · وقيدٌ في الوارد عاكسه لا وجود له لا يحبس قيداً آخر من مصدره (B٢-٦).
- **بعد الجولة الخامسة عشرة (C٢ وD٢):** بصمتان بلا رصيد «#1» و«#2» حوالتان، وبرصيدين حوالتان، وما بلا رصيدٍ مع ذي رصيدٍ قد يكونان حوالةً واحدة؛ والتوأم يُحسم بعدّ الحفظ نفسه بقاعدةٍ لا يغيّرها ترتيب الوصول: كل ذي رصيدٍ حركة، و«#n» حركةٌ أخرى إن جاوز n عددَ ذوات الرصيد، وإلا يبقى من المجموعة عددُ ذوات الرصيد بالأولوية (C٢-١) · والقيد المعكوس، أياً كان ما عكسه (إلغاء دفعة أو تحصيل فاتورة أو عملية نقد)، يعيد سطر الكشف المطابَق بحركته مفتوحاً، وجهاز المالك يفعل ذلك لما وصله عكسه ويرفعه، ولا يقبل سطراً مطابَقاً بحركة قيدٍ معكوس (C٢-٢ وC٢-٣) · والقارئ: رقم الصفحة في التذييل خانةٌ فارغة (D٢-٤)، و«الرصيد المرحَّل» ختاميٌّ إن لم تأتِ بعده حركة وإلا لا يغلب ختامي الرأس (D٢-٥)، وعمود «نوع العملية» تحكمه الأرصدة المطبوعة إن ناقضته (D٢-٦)، والهجري بجانب الميلادي في الصورة وفي العنوان «التاريخ هـ» ليس التاريخ (D٢-٧ وD٢-٨)، و«CR/DR» ملتصقةً بالمبلغ (D٢-٩)، والعنوان بصفّين «المبلغ» فوق «مدين | دائن» (D٢-١٠)، و«المدين/الدائن» عمود نوع (D٢-١٣)، ورفض «format» و«empty» يعرض أعمدة الكشف المخمَّنة لتُصحَّح (قرار المالك أ.٣) · والاقتراح: من حمل البيانُ اسمه كاملاً هو الدافع، فمن وافق اسمُه الأول كلمةً منه وحدها لا يأخذ درجة الاسم (D٢-٢)، والأقساط المتتالية بمداها من ٤٥ يوماً قبل أقدمها إلى ٤٥ بعد آخرها فسداد المتأخرات يُقترح (D٢-١١)، واقتراح المطابقة يُحسب مرةً لحالة القاعدة (D٢-١٢) · والشاشة: «السطور المطابَقة» بـ«إلغاء المطابقة» لمن له البنوك ٣ (D٢-٣).
- **بعد الجولة السادسة عشرة (E٢ وF٢ · الهجرة ٦٠):** عدد حركات القاعدة (اليوم والمبلغ) أكبرُ عددٍ لها في كشفٍ حيٍّ واحد، فـ«#1» بلا رصيد و«@الرصيد» من كشفٍ رصيده آخر اليوم وحده حوالتان (E٢-١) · وحذف كشفٍ ينقل إلى الكشف المتداخل ما تخطّاه وحده بالعدد (E٢-٣) · والتحصيلات من قاعدةٍ لا تجاوز عدد إيداعاتها الحيّة، والسطر نفسه أو بصمته إيداعٌ واحد ولو لم يصل سطره بعد فيُقرأ من الوارد (E٢-٤) · ووقائع السطر بأول ما قُرئ به على جهاز المالك: نسخة العضو بوقائع أخرى (تصديرٌ آخر، أو توأمٌ جديد بالبصمة نفسها) تُطبَّق بوقائعه هنا ولا تُرفض (E٢-٢ وE٢-٥) · وفي تقرير الشهر افتتاحي كشفٍ بلا أرصدة قبل سطوره في يومه (F٢-١) · والاسم: أقوى الأسماء الكاملة في البيان (فيه الاسم الأول بأكثر الكلمات) هو الدافع (F٢-٢)، ومدى المتتالية بدورة عقدها (F٢-٨) · والقارئ: إشارات عمود النوع التي ناقضتها الأرصدة لا تُعرض للحفظ، والسطر بلا رصيد يبقى بإشارة نوعه (F٢-٣)، ورقم الصفحة بأشكاله وختم الطباعة بوقته في التذييل (F٢-٤)، و«CR» ملتصقةً في الصورة (F٢-٥)، والتاريخ ليس مبلغ ملخص (F٢-٦)، و«1,000.00 CR» قيمةٌ لا عنوان (F٢-٧)، والافتتاحي قبل الحركات أو بعدها كلها وفي وسطها رصيدٌ منقول بين صفحتين (F٢-٩).
- **بعد الجولة السابعة عشرة (G٢ وH٢ · الهجرة ٦١):** الحفظ يقابل كل محفوظٍ بسطرٍ واحد من الملف، ويضيف ما يكمل أكبرَ العددين (المحفوظ وما في الملف) وذواتِ الرصيد المختلفة (G٢-١) · وعدّ بصمات كل كشفٍ محسوبٌ مرةً له (G٢-٦) · وحارس الإيداع يعدّ سطور اليوم والمبلغ وكشوفها في الوارد أيضاً (الهجرة ٦١: فهرس بصمة السطر في الوارد · G٢-٣ وG٢-٤)، ويعدّ الإيداع المطابَق هنا بتحصيلٍ يدويٍّ حيٍّ محجوزاً، ومطابقةٌ واردة لا تثبت لا تمحو مطابقةً حيّةً هنا (G٢-٢) · ووقائع السطر ومطابقته تنتقل إلى سطر العضو الذي قد يكون الإيداع نفسه بصيغةٍ أخرى (G٢-٥)، وتصحيح جهاز المالك بوقت النسخة الواردة (G٢-٧) · والاسم بكلماته المختلفة (H٢-١)، والمركّب مفصولاً وموصولاً اسمٌ واحد (H٢-٢) · وخط زمن التقرير يُكمل سلسلة الكشف الجاري قبل افتتاحي كشفٍ آخر عند الرصيد نفسه (H٢-٣)، ولا يضع افتتاحي كشفٍ بدأ يومه بسطورٍ هنا من كشفٍ آخر · والقارئ: الهجري في صفّ الفترة يُترك (H٢-٤)، والتاريخ باسم الشهر ليس مبلغ ملخص (H٢-٥)، و«الرصيد المنقول/السابق» افتتاحيٌّ في أول الكشف زمنياً وحده و«الافتتاحي/السابق» في أوله أو ملخص آخره إلا أن يساوي رصيد آخر حركةٍ قبله فهو رصيدٌ منقول (H٢-٦ وJ٢-٤)، وصيغة التاريخ المصحَّحة تُقدَّم إن قُرئت بها التواريخ كلها (H٢-٧)، وصفوف الملخص في الصورة بمواضعها (H٢-٨)، وكلمة ملخصٍ بلا قيمة بيانٌ مكمِّل (H٢-٩).
- **بعد الجولة الثامنة عشرة (I٢ وJ٢):** الحفظ والمزامنة يعدّان حركات القاعدة بالقاعدة نفسها: أكبرُ عددٍ لها في كشفٍ واحد، أو عددُ بصماتها برصيدٍ المختلفة في الكشوف الحيّة كلها، فثلاثة ملفاتٍ (صفحتان مصوّرتان وكشفٌ بلا رصيد) لا تُضيع حوالة ولا تقطعها المزامنة (I٢-٢ وI٢-٣) · وحارس الإيداع يقرأ أحدث نسخةٍ للسطر من الوارد، ويعدّ المطابقة اليدوية بنسختيها وحركتها هنا أو في الوارد (I٢-١) · ومطابقة سطر المالك المحذوف توأماً تنتقل إلى الباقي إن لم تثبت مطابقته (I٢-٤)، والإحياء ببصمة السطر المحيا نفسه (I٢-٥) · في خط زمن التقرير افتتاحيٌّ عند الرصيد نفسه يؤخذ ولا يحوّل السلسلة إلى كشفه (J٢-١)، وافتتاحيٌّ لم يتّصل في يومه ولكشفه سطورٌ بعده ينتقل إلى ما بعده (صورة صفحةٍ بفترة الشهر كله · J٢-٢) · وصيغة التاريخ المصحَّحة تُقدَّم إن قرأت ما تقرؤه الأخرى (J٢-٣)، ورقم المرجع أو البطاقة في خلية كلمة الملخص ليس مبلغاً (J٢-٥)، والصف المؤرَّخ بوقتٍ وفيه مبلغٌ بكسرين حركة (J٢-٦).
- **بعد الجولة التاسعة عشرة (K٢ وL٢):** المزامنة تعدّ حركات القاعدة بكشوف البنك الحيّة كلها وبكشوفه في الوارد، كما يعدّها الحفظ (K٢-١ وK٢-٢)، ومطابقةٌ يدوية عكسُ قيدها في الوارد تُنتظر ولا تحجز الإيداع (K٢-٣) · و«الافتتاحي/السابق» في آخر الكشف رصيدٌ منقول بعد صفّ عناوين مكرر وحده، فشهرٌ صافيه صفر يبقى افتتاحيه (L٢-١)، وأول كشفٍ للبنك يبدأ بافتتاحيٍّ ليس رصيداً مطبوعاً في يومه (L٢-٢)، و«Abdul/Abu» مع ما بعدها اسمٌ واحد (L٢-٣) · وبعد الجولة العشرين (N٢): «bin/ibn» وصلةٌ كـ«بن» (N٢-١)، ويُستبعد افتتاحيٌّ برصيد سطرٍ من كشفٍ آخر لا من كشفه (N٢-٢)، والمنقول فوق صفّ العناوين المكرر رصيدٌ منقول كالذي تحته (N٢-٣) · وكشفٌ محذوف في الوارد لا يُعدّ في حارس الإيداع ولا نسخته الحيّة هنا (M٢-١) · وبعد الجولة الحادية والعشرين (O٢ وP٢): كل حركةٍ حيّة في البنك تحجز السطر الذي طابقته، بلا رقم قيد (إيداع نقدٍ من المحفظة) أو بقيدٍ هنا أو في الوارد، إلا حركة القيد الوارد نفسه وما عُكس قيده (O٢-١ وO٢-٢) · وجدول الملخص بصفّين بعد الحركات يُقرأ كالذي قبلها (P٢-١)، وصفحتان تبدأ كلٌّ منهما من رصيدٍ في الأخرى في يومٍ واحد: الأولى ما تنتهي سطورها أبكر حين يستبعد الشرط السابق المرشحين كليهما وحده (P٢-٢ وR٢-٢) · وبعد الجولة الثانية والعشرين (Q٢ وR٢): حركة البنك التي تحجز السطر بأحدث نسخها، في الوارد قبل ما هنا (Q٢-١ وQ٢-٢)، وصفّ ملخصٍ قيمه في خلاياه لا يُعدّ صفّ عناوين، ولا يُعدّ صفّ حركةٍ مؤرَّخ قيماً (R٢-١)، والملخص قبل العناوين بصفّين ما قُرئت قيمه من الصف التالي وحده (R٢-٣).
- **حدٌّ معروف (A٢-٢ · ينتظر القسم ٥ · ٢):** جهازا المالك نفسه بلا اتصال يعتمدان الإيداع نفسه لهدفين، فلا حَكَم بينهما لأن الحارس على كتابة العضو، والحسم يحتاج مرجعاً واحداً لترتيب الكتابة · اختباره `test.failing` يسقط حين يُصلح.
- **الصورة (`photo.ts` · U١٢):** كلمات قارئ النص بمواضعها ← صفوفٌ بموضعها العمودي مقارنةً بمتوسط الصف (فالمائلة قليلاً صفٌّ واحد) ← في كل صفٍّ تاريخٌ ومبالغ بكسرين (والفاصلة قبل الكسرين كسرٌ قُرئ فاصلة) ← الرصيد أبعد المبالغ عن التاريخ (العربي من اليمين والإنجليزي من اليسار) والحركة غير الصفر الأقرب إليه ← ومع رصيدٍ لكل حركة تُترك العلامات وتُحدَّد الإشارة من التسلسل ← القارئ العام بعناوين مصنوعة · وO وl وS وأمثالها تصير أرقاماً داخل ما يصير بها مبلغاً أو تاريخاً وحده · والافتتاحي والختامي الإنجليزيان يُقرآن والعربيان يُطلبان · وربط الصورة لا يُحفظ ربطاً للبنك، والقراءة تنبّه «من صورة». · والصف الذي فيه تاريخٌ ومبلغٌ ورصيد حركةٌ ولو حمل «FROM» (V٣)، وكل كلمة ملخصٍ بالمبلغ الذي يليها (V١٢).

- **البناء:** القارئ النقي في `src/domain/bankStatement` (`read.ts` و`normalize.ts` و`columns.ts` بقاموسه `dictionary.json` و`pdfTable.ts` و`xlsx.ts` و`csv.ts` و`mt940.ts`)، والحفظ والمطابقة والتقرير في `store.ts`، والصورة في `photo.ts`، والشاشة `app/bankStatement.tsx` من «كشف الحساب والمطابقة» في بيانات البنك، وقراءة الملف والصورة (ML Kit) في `services/bankStatement.ts` · الهجرة ٥٥: `bank_statements` و`bank_statement_lines` (حالة السطر مفتوح أو مطابَق بحركةٍ واحدة أو مستبعَد بسببه)، و`banks.stmt_mapping` (بلا استعمالٍ منذ الهجرة ٥٦) · ويُزامَن الجدولان بقسم البنوك (القراءة ١، والإنشاء ٢، والتعديل والحذف ٣).
- **الدرجة (من ١٠٠):** المبلغ والاتجاه ٥٠ شرطاً، والتاريخ ٣٠ في اليوم نفسه و٢٦ بعد يوم و٢٠ في ثلاثة و١٢ في أسبوع و٥ في أسبوعين، والرقم المشترك ١٥، والكلمة المشتركة ٣، والمرشح الوحيد +٥ والمتعادلان −١٥ · الحركة الواحدة لأعلى سطورها · والاعتماد بالمبلغ نفسه وحده.
- **تقرير الشهر:** افتتاحي الكشف وختاميه من خط زمن الكشوف (في اليوم الواحد بتسلسل الأرصدة لا بترتيب الحفظ، وافتتاحي الكشف حيث يتّصل: عند رصيدٍ يساويه أو قبل سطرٍ يتسلسل منه · D٢-١، والرصيد المطبوع أولى): افتتاحي الشهر افتتاحي أول كشفٍ يبدأ فيه إن كان أول أحداثه (ولو بعد فجوة · U١٥)، وإلا الجاري عند بدايته، وشهرٌ بلا حدثٍ في كشفٍ يغطيه افتتاحيه وختاميه الجاري (U١٦) · والدفاتر من افتتاحي البنك وحركاته · والفرق = فرق الافتتاحيين + ما في الكشف وحده + المستبعَد + ما في الكشف «في الطريق» − ما في الدفاتر وحدها − ما فيها «في الطريق»، وما بقي «غير مفسَّر».
- **الحذف والمزامنة:** حذف كشفٍ فيه مطابَقٌ يُرفض حتى تُلغى مطابقته، وسطوره التي تخطّاها كشفٌ حيٌّ آخر عند حفظه لأنها هنا (بصماتها في `shared_keys` · الهجرة ٥٨) تُنقل إليه ولا تُحذف، وما سواها يُحذف ولو وقع في فترته (U١٧ وV١) · وجهازٌ حذف كشفاً ولم يعرف الكشف المتداخل يعيد سطوره المشتركة حيّةً إليه حين يصله، وسطرٌ حيٌّ في كشفٍ محذوف (اعتُمد على جهازٍ آخر بعد الحذف) يُحذف معه، والكشف المحذوف الوارد تُحذف معه سطوره الحيّة هنا (`statementCascade` · V٤ وV٥) · وحذف حركة البنك أو تفريغ السلة يفكّ ما طابقها، وتفريغ بنكٍ يحذف كشوفه · وكل جهازٍ يطبّق سطر الكشف الوارد «مطابَقاً» بشروط الاعتماد نفسها (حركةٌ حيّة من بنكه بمبلغه لا يمسكها سطرٌ آخر)، وسطران يمسكان الحركة نفسها يبقى أصغرهما معرّفاً، وما سواه يعود مفتوحاً ويرفعه جهاز المالك مصحَّحاً (`statementLineCheck` · U٢٣) · وقاعدة السحابة: سطر الكشف الجديد ممن له البنوك ٢ مفتوحٌ بلا حركة (`blobShapeOk` · U٢٤) · وكشف حسابٍ آخر (آيبانه أو رقمه في الرأس يخالف آيبان البنك) لا يُحفظ في البنك (U٢١).

| العمل | البنوك ١ | البنوك ٢ | البنوك ٣ |
|---|---|---|---|
| يرى الكشوف وتقرير المطابقة | ✓ | ✓ | ✓ |
| يقرأ كشفاً ويحفظ سطوره، ويحفظ ربط أعمدته لبنكه | — | ✓ | ✓ |
| يعتمد مطابقةً أو يلغيها، ويستبعد سطراً بسبب | — | — | ✓ |
| يسجّل حركةً لسطرٍ غير مطابق | بصلاحية النموذج الذي يفتحه | | |
| يعتمد تحصيلاً مقترحاً لإيداع | — | — | ✓ ومعه «إدخال» في التحصيل للقسط، أو «كامل» في المطالبات أو الفواتير كشاشتيهما (`collectPermission` · سجل القرارات ٥٩) |

### ١٣.٢٣ المرحلة ١ من المراجعة الشاملة (2026-11-13)

ما أصلحته المرحلة ١ ولم يُكتب في قسمه (وA1-1 وA1-3 وA2.1 وA2.2 في أقسامها، وB-1 إلى B-4 في §١٣.٥). لكل بندٍ مدققٌ مستقل كتب اختبارات تفشل، ثم أُصلح ما ثبت منها.
- **A2.3 · «الأعلى دخلاً» و«الأكثر صرفاً» للعقار والوحدة** (`computeTopPerformers` في `src/domain/stats.ts`): من سطور الدفتر المرحّلة بأبعادها لا من المستندات · الدخل دائن ناقص مدين لحسابات «إيراد»، والصرف مدين ناقص دائن لحسابات «مصروف» (فلا تدخل ضريبة المدخلات القابلة للخصم، ولا ما رُسمل) · سطر الوحدة يُحسب لعقارها الحالي، والصافي الموجب وحده يُعرض، ولها فترة اختيارية على تاريخ القيد · والسطر بلا أبعاد خارجها حتى تملأه أداة «أبعاد القيود القديمة»، إلا سطور استرداد الضريبة ورفضه (`vat_refund` وعاكسه) فتُرحَّل بلا أبعاد عمداً وتُنسب في الاستعلام إلى عقار فاتورة الشراء ووحدتها عن طريق `src_id` (المدقق R11).
- **C-1 · الاستعادة وضمّ المرحّل** (`keepPosted.ts`): القيد المرحّل في المصدر (الجهاز قبل الاستعادة أو لقطة السحابة) وهو في النسخة مسودةٌ بمعرّفه نفسه يُضمّ مرحّلاً كما رُحّل: تُحذف سطور المسودة ويأخذ رأسُها رأسَ المرحّل وسطورَه، ثم يُرحَّل فيمرّ بمحفّز التوازن · ويُذكر في حوار التأكيد «كان مسودةً في النسخة ورُحّل بعدها» · وتُستبدل المسودات قبل أي قيدٍ مضمومٍ آخر، فرقمها القديم في النسخة لا يُعدّ تصادماً ولو تغيّر بترقيم الانضمام (المدقق R11).
- **C-3 · التبديل في الاستعادة** (`restore.ts`): نقلُ القاعدة الحية جانباً محميّ وفشلُه يعيدها مكانها مفتوحة · والقاعدة السابقة (`data.db.pre-restore`) لا تُحذف إلا بعد آخر خطوة قد تفشل (مطابقة `file_cache` بالقرص)، وفشلها يُرجع كل شيء · وإن غابت السابقة عند الرجوع لا يُحذف شيء: تبقى المستعادة بمرفقاتها والرسالة لا تدّعي الرجوع · فبعد أي فشل يبقى ملف قاعدةٍ صالح مفتوح.
- **C-2 · نسخة ما قبل الترقية بلا الملفات** (قرار المالك س٣): القاعدة والبيان و`local_files` (البصمة والامتداد والحجم) بلا الملفات نفسها، فالهجرات لا تمسّ ملفات المرفقات · يُقرأ كل ملف وحده لبصمته ثم يُترك (أكبر ما في الذاكرة ملفٌ واحد)، والغائب أو التالف (ولو بقي بحجمه) أو المتعذّر يُسمّى في `missing_files` وتعرضه شاشة البوابة قبل الترقية، والمساحة المطلوبة للبوابة مساحة القاعدة وحدها · والاستعادة منها تُبقي الملفات في مكانها وتطابق على الجهاز ما في `local_files` و`missing_files` ببصماتها، وما غاب أو تغيّر يُسمّى قبل التأكيد ولا يمنع عودة البيانات، ويُفحص شكل الأسماء قبل أن يُبنى منها مسار (المدقق R11) · والتصدير وDrive ونسخ الأمان قبل الاستعادة والمسح كاملةٌ بملفاتها كما هي.
- **D-2 · قاعدة التاريخ** (قرار المالك س٢٤): التاريخ في القاعدة نصٌّ يُقارن حرفاً حرفاً، فلا يُقبل إلا بصيغة YYYY-MM-DD ويومٍ قائم في شهره، ويفحصه `isISODate` في `src/domain/dates.ts` وحده، على ثلاث طبقات: (١) حقل التاريخ لا يمرّر إلى النموذج إلا تاريخاً صحيحاً أو الفراغ، ويظلَّل بالأحمر ويذكر التاريخ المعتمد الذي سيُحفظ · (٢) الدومين: `requireISODate` في `postEntry` و`requireOpenPeriod`، وقبل كل فحصٍ للربع المقدَّم في الدفعات والفواتير والمشتريات والعقود (التوثيق والتجديد والإلغاء) · (٣) جهاز المالك يرفض قيد العضو بتاريخٍ معيب إن وصل الخادم بعد 2026-11-13 (`MEMBER_ISO_DATE_SINCE`)، وما قبله يُقبل ويظهر في «فحص المطابقة» (الفحص الخامس عشر) · وما كتبه الإصدار السابق بتاريخٍ معيب: قيد تصحيحه بتاريخ اليوم المفتوح (`correctionDate`)، والمسودة المعلّقة به لا تأخذ رقماً ولا توقف طابور الإصدار (المدقق R11) · **باقٍ:** الحقل الأحمر لا يمنع الحفظ بعدُ، بل يذكر التاريخ الذي سيُحفظ، وسدّه بربط صلاحية الحقل بالنموذج في ملفاته الثلاثة والعشرين.
- **D-1 · رابط التحصيل** (`/collect?pay=<القسط>`): يُقرأ قسطه من القاعدة بعينه (`collectPayTarget` في `src/domain/stats.ts`) لا من قائمة الشاشة المؤجَّلة عن أول رسم، ثم يُستهلك المعامل بعد قراءته (`setParams` بـ`pay` فارغ) فيعمل كل وصولٍ ولو تكرّر للقسط نفسه · ولا تُفتح النافذة بلا صلاحية الإضافة، ولا لقسطٍ مسدَّد أو ملغى، بقاعدة بطاقة القسط وجدول العقد نفسها، ومتأخرات العقد الملغى تبقى تُحصَّل (المدقق R11 لم يجد فيه عيباً).
- **E-1 · قفل محضر الاستلام والتسليم في المزامنة** (قرار المالك س٢٩ · `handoverLock` في `src/sync/engine.ts`): المحضر المقفَل نهائي والقفل باتجاهٍ واحد · تُقارن المزامنة «بنود النموذج» (`HANDOVER_FORM`) لا الصف كله · نسخةٌ غير مقفلة تصل جهازاً مقفلاً لا تفتحه ولا تغيّر بنوده: يُسجَّل الوارد مرفوضاً فيظهر في «حالة المزامنة»، وتُعاد النسخة المقفلة إلى السحابة بوقتها (من جهاز المالك دائماً، ومن جهاز العضو إن كان مُقفلها) · والقفل الوارد يغلب نسخة الجهاز غير المقفلة ولو كانت أحدث أو معلَّقة · ونسخةٌ غير مقفلة ببنود المقفلة نفسها (نافذة أمان السحب، أو إعادة رفعٍ لنقل الوحدة) ليست تعديلاً متأخراً فلا رفض لها · **وبين قفلين مختلفين يغلب ما بلغ السحابة أولاً** (`sync_state` بمفتاح `handover_lock:<المعرّف>`، لا يتقدّم بنقل الوحدة ولا بالسلة)، وهذا معنى «المُقفَل لا يُعدَّل» بلا هجرة: ما رآه الجميع مقفلاً في السحابة لا يتغيّر بعده (قرارٌ تقني، القاعدة ٩٩) · وما سوى البنود والقفل (السلة ونقل الوحدة) يمضي بالحسم المعتاد، والتصحيح بعد القفل بنموذجٍ تصحيحي منفصل (المدقق R11، ثلاث نتائج) · **باقٍ:** حارسٌ في قواعد السحابة يرفض تحديث صفٍّ مقفل لم يُبنَ بعد، فسباق رفعٍ قد يكتب فوق القفل في السحابة لحظةً حتى يزامن جهاز القفل.
- **A1-2 · التأمين يسدّد الأقساط المتأخرة** (قرار المالك س١): خانة «منها مقابل أقساطٍ متأخرة» (`arrearsHalalas`) في «التصرف بالتأمين» و«إلغاء العقد» · لا تتجاوز الخصم ولا المتبقي على الأقساط التي حلّت بتاريخ التسوية، وافتراضها الأقل منهما (وفي تعديل تسويةٍ قائمة ما سدّده التأمين منها)، ولا مقابل بلا خصم ولا إن كان التأمين لدى طرف آخر · تُسدَّد الأقساط بترتيب الاستحقاق ثم الجدول ثم المعرّف، لكل قسطٍ دفعةٌ «من التأمين» وقيدها `deposit_rent`: مدين 2400 ودائن إيراد العقد بتقسيمه، وما بقي من الخصم أضرارٌ في 4300 · وإن زاد الخصم على التأمين سُدّدت الأقساط منه أولاً والمطالبة التلقائية بما زاد على الأقساط وحده · ودفعة التأمين لا تُلغى وحدها (`paidFromSettlement`): تعديل التسوية يعكس قيودها ويسمها ملغاة ثم يعيد التطبيق · و`deposit_rent` ومعكوسه في `RENT_SOURCES` و`DOCUMENT_SOURCES` وإعادة الاشتقاق على جهاز المالك، ويقرؤه من يقرأ دفعته (التحصيل) فيرى عضو التحصيل القسط مدفوعاً · واستعادة نسخةٍ قبل التسوية لا تحمل دفعة «من التأمين» بلا صفّ تسويتها، وقيدها اليتيم يُعكس (المدقق R11، أربع نتائج) · **باقٍ:** التسويات السابقة لهذا الإصلاح بقيودها في 4300 بلا أداة، ويصحّحها المالك بتعديل التسوية وإدخال المقابل.
- **A2.4 · افتتاحي البنوك في الدفتر (الهجرة ٦٢ · قرار المالك س٢):** حساب النظام 3300 «أرصدة افتتاحية» (حقوق ملكية) · افتتاحي كل بنكٍ حيّ يُشتق من `banks.opening_halalas` عند كل قراءة رصيد (`ledgerBankOpenings` و`withBankOpening` في `ledger.ts`): مدينٌ في 1100 ودائنٌ في 3300، بلا قيدٍ مخزَّن فلا يتكرر بين جهازي المالك، فيأخذه ميزان المراجعة والقوائم الأربع وفحص المطابقة ٦ والنقد في الرئيسية ودليل الحسابات · والمحفظة كما هي، والبنك المحذوف يخرج افتتاحيه من الطرفين معاً · وفي الحساب حقلان: `opening_halalas` الافتتاحي الفعلي للعرض والأرصدة، و`seeded_halalas` المكتوب في الدليل ويعدّله النموذج وحده وينبّه بما يُضاف من البنوك · ولا يدخل الافتتاحي الدفتر إلا إذا كان 3300 حساب النظام نفسه، فإن كان الرمز لحسابٍ أنشأه المستخدم قبل الترقية بقيت افتتاحيات البنوك خارج الدفتر ظاهرةً في الفرق الافتتاحي (قرارٌ تقني، القاعدة ٩٩) · والهجرة تطفئ الالتقاط فلا ترفع صفاً بوقت الترقية، وتحذف صفّ 3300 الذي في السلة إن كان غير نظامي وبلا سطر قيد (المدقق R11، ثلاث نتائج).
- **A2.5 · الافتتاحي بعد أول قيد (قرار المالك س١٨):** يُحفظ كما أُدخل، ويُسجَّل قبله وبعده في سجل العمليات، ويُرفض على جهاز العضو برسالة · وجهاز المالك يرفض كتابة العضو التي تحذف بنكاً افتتاحيه غير صفر أو تستعيده من السلة ويعيد نسخته (`bankOpeningLocked`)، ولا يظهر زر الحذف للعضو على هذا البنك · **باقٍ:** حارس القواعد في السحابة لذلك، فحتى يعالجه جهاز المالك يرى غيره البنك محذوفاً.
- **R12-UI-1 حقل التاريخ والتاريخ الفارغ:** حقل التاريخ لا يمرّر إلى النموذج إلا تاريخاً صحيحاً بيومٍ قائم في شهره. ولا يمرّر الفراغ إلا للحقل الاختياري (خاصية optional: انتهاء السجل والوثيقة، وبداية عقد إيجار العقار ونهايته، والموعد المتفق عليه والمهلة، وانتهاء الضمان، واستحقاق فاتورة الشراء، و«من/إلى» في التقارير ولوحة البداية). والحقل اللازم إن مُسح بقي فيه التاريخ المعتمد، وظهر تحته بالأحمر «الحقل فارغ · يبقى المعتمد …». ومتى خالف المكتوبُ ما في النموذج سمّت الرسالة الحمراء ما سيُحفظ: التاريخ المعتمد، أو «يُعتمد الحقل بلا تاريخ» للاختياري الممسوح (dates.invalidEmpty). ويرفض إلغاء العقد ودفعة الإيجار والتحصيل الجماعي وصفقة التقبيل التاريخ الفارغ برسالة (requireGivenDate) بدل أن تأخذ تاريخ اليوم بصمت. السبب: الفراغ كان يُحفظ تاريخ اليوم، فيُلغى العقد في غير الشهر المقصود، ويُحسب «مقابل الأقساط المتأخرة» صفراً.
- **R12-UI-2 الرجوع عن «مدفوعة» والبنك:** في ورقة «تغيير حالة الفاتورة» يُخفى خيارا «مستحقة» و«متأخرة · يعكس قيد التحصيل» متى كان عكس التحصيل يُنزل بنكه تحت الصفر، كما يُخفيان حين لا يكفي النقد، ويظهر مكانهما السبب باسم البنك ورصيده والمبلغ (collectionBankShortages، وهو الفحص نفسه الذي يرفض به العكس). السبب: قاعدة المالك 2026-08-24 أن الزر الذي لا يصح لا يُعرض ثم يُرفض، والقرار ٥٥ أن لا بنك تحت الصفر.
- **R12-SYN-1 عطل القاعدة أثناء تطبيق الوارد:** إن ألغت SQLite المعاملة بنفسها (قرصٌ ممتلئ، خطأ إدخال وإخراج) يرمي مدير المعاملات (src/db/adapter.ts) TransactionAbortedError برسالة الخطأ الأصلي، وتفشل به كل معاملةٍ متداخلة بعده حتى تنتهي الخارجية، ويُكشف الإلغاء بسؤال القاعدة هل المعاملة قائمة (isTransaction في node وisInTransactionSync في expo). وعطل القاعدة (امتلاء، إدخال وإخراج، انشغال، ذاكرة، تلف) يُعرف بما رماه المشغّل نفسه، توسمه المحوّلات عند الحدّ (driverCall) برمزه، لا بنصّ رسالة، فرسالة رفضٍ تحمل نصاً كتبه عضو ليست عطلاً. وفي المزامنة يعيد applyOne رمي العطل فتُلغى صفحة الوارد كلها وتبقى في الصندوق للدورة التالية، وreject يكتب سطر سجل العمليات في معاملةٍ متداخلة ويعيد رمي العطل، وapplySteps يتحقق بعد كل مستند أن معاملة الصفحة قائمة قبل حذفه من الصندوق، وquiet لا يترك الالتقاط مفتوحاً. السبب: العطل العابر كان يُسجَّل رفضاً للمستند ويحذفه من الصندوق للأبد، وما طُبّق بعد الإلغاء خارج المعاملة كان يُلتقط في طابور المالك فيُرفع باسمه.
- **R12-SYN-2 سطور فاتورة الموظف الصادرة التي تصل متأخرة:** ما كتبه التطبيق مع إصدار فاتورة الموظف يُقبل على جهاز المالك ولو وصل بعد أن اكتمل مجموعها، ما دام كُتب في ساعة إصدارها بوقت الخادم، وبقيت السطور معه ومع ما في الطريق منها تعيد صافيها وضريبتها كما صدرت، وإلا انتظر بقيتها حتى تمضي الساعة. وما بعد الساعة أو ما يغيّر المبالغ مرفوضٌ كما كان، وفاتورة المالك مقفلةٌ تماماً. ووقت الإصدار محفوظٌ في sync_state بلا تغيير في المخطط. السبب: السطر بسعرٍ صفر (بندٌ مجاني أو سطرٌ تُرك فارغاً) وسطرا الإضافة والخصم كانت تُرفض وتُحذف من السحابة ومن جوال الموظف، فتتغيّر الفاتورة الضريبية بعد إصدارها.
- **R12-SYN-3 حدّ الصفر للبنك على جهاز المالك لما يكتبه الموظف الذي لا يرى حركات البنك (قرار المالك ٥٥):** إلغاء التحصيل، وإعادة الفاتورة المحصَّلة إلى «مستحقة»، واستعادة فاتورة الشراء المسدَّدة من السلة، وكل قيدٍ جديد من موظفٍ بقسمٍ لا يقرأ حركات البنك، يُفحص على جهاز المالك قبل أن يدخل الدفتر (memberBankOutCheck). الرصيد هو المطبَّق مع ما ينتظر في الوارد من حركاته داخلةً وخارجة مما يسبق قيد العضو في ترتيب الكتابة في السحابة، وما كتبه المالك يُحسب أياً كان وقته، فيحكم جهازا المالك بالحكم نفسه. فإن أنزل القيد بنكاً تحت الصفر رُفض مع حركته البنكية وما يتبعه معاً (وسم الدفعة الملغاة، وفاتورة الشراء المستعادة ونسخ قيودها)، وأُعيدت نسخة المالك وظهر السبب في حالة المزامنة. واستعادة فاتورة الشراء عمليةٌ واحدة ولو وصلت على دفعتين: تنتظر نسخة قيد الفاتورة نسخة سدادها، وصفّها المستعاد قيديه، ساعةً بوقت الخادم. ويبقى استثناء Q٣ لما كتبه المالك من جهازه الآخر أو موظفٌ يقرأ حركات البنك. السبب: جوال الموظف يرى رصيد البنك افتتاحيّه وما كتبه هو فقط، فكان حدّ A2.2 على جهازه لا يمنع شيئاً.
- **R12-DEP-1 تسوية التأمين والترحيل على جهاز المالك:** جهاز المالك يحرس الاتجاهين. يرفض من العضو ترحيل تأمينٍ سُوّي (A1-1)، ويرفض الآن تسوية تأمينٍ رُحِّل إلى التجديد بسبب «تسوية تأمينٍ رُحِّل إلى العقد المجدَّد»، ويشمل ذلك قيود الخصم والرد وسداد الأقساط منه وصفّ التسوية. فالأول وصولاً يغلب في الترتيبين ولا يُقبل الاثنان. وحين يُرفض ترحيل العضو لأن العقد السابق سُوّي، يُصحَّح تأمين العقد المجدَّد في صفّه إلى ما قبضه الدفتر له فعلاً (قيود contract_deposit الحيّة وما في الوارد منها لدى المكتب والمنصة، وفي حالة الجهاز لدى «طرف آخر»)، ويُرفع الصف إلى السحابة ويُسجَّل التصحيح في سجل العمليات. فتُرحَّل الزيادة المقبوضة ولا تنتظر للأبد، ولا تعرض شاشة التسوية ردّ ما لم يُقبض. السبب: التأمين المقبوض مرةً يُحسب مرةً أياً كان ترتيب الوصول.
- **R12-DEP-2 أقساط العقد السابق من التأمين المرحَّل:** خانة «منها مقابل أقساطٍ متأخرة» ترى أقساط العقد نفسه، وأقساط كل عقدٍ رُحِّل تأمينه إليه في سلسلة التجديد بترحيلٍ حيّ (depositCarryChain)، مرتبةً بالاستحقاق ثم الجدول ثم المعرّف. دفعة «من التأمين» تُكتب على عقد القسط، وقيدها مصدره العقد الذي يحمل التأمين: مدين 2400 بأبعاده، ودائن إيراد عقد القسط بتقسيمه وبُعده. وجهاز المالك يقبلها من العضو بالسلسلة نفسها. وفي الاستعادة تُحمل الدفعة متى كان في النسخة صفّ تسوية العقد صاحب التأمين (مصدر قيدها)، فيُحمل إلغاء دفعة قسط العقد السابق بتعديل تسوية المجدَّد مع عاكسه (مراجعة الإصلاح). السبب: التأمين المرحَّل هو تأمين العقد السابق نفسه، والسابق لا يُسوّى بعد ترحيله، فكان قسطه المتأخر لا يُسدَّد من التأمين أبداً (قرار س١).
- **R12-DEP-3 دفعة «من التأمين» لا يلغيها العضو وحدها:** جهاز المالك يقبل من العضو عكس سداد قسطٍ من التأمين وإلغاء دفعته ضمن تعديل التسوية فقط، وشاهد التعديل نسخةٌ من صفّ التسوية مكتوبةٌ معه أو بعده. والإلغاء الذي سببه غير «تعديل تسوية التأمين» يُرفض بسببٍ ظاهر في حالة المزامنة، وما بقي ينتظر وصول صفّ التسوية. السبب: جوالٌ بإصدارٍ أقدم من A1-2 يرى الدفعة عادية فيلغيها، فيعود القسط مستحقاً وقد سُدّد من التأمين.
- **R12-DEP-4 كشف المستأجر حين يُستعمل رصيده الدائن في عقدٍ آخر:** كل كشفٍ يتوازن وحده. التحصيل يظهر بمبلغه كله، ومعه سطرٌ مدين «فائضٌ حُوّل إلى رصيد المستأجر الدائن» بقدر دائن 2410 في قيده، وكذلك الفائض القديم المحوَّل بأداة الفائض. والسداد من الرصيد الدائن يظهر بمبلغه في العقد الذي استُعمل فيه. و«إجمالي محصَّل» العقد و«دخل العقد» وcontractCollectedValue بالقاعدة نفسها. وتقارير الوحدة والعقار والمحفظة باقيةٌ على النقد المقبوض. السبب: الرصيد الدائن للمستأجر لا للعقد، فقد يُستعمل في التجديد أو بعد دمج مستأجرَين، وكان كشف العقد الجديد بعد A2.1 يطالب بقسطٍ سُدّد من الرصيد.
- **R12-DEP-1 (مراجعة الإصلاح):** تسوية العضو لتأمينٍ رُحِّل تُرفض كلها كتابةً واحدة: صفّ التسوية، وقيود الخصم والرد والسداد من التأمين، ومطالبة الزيادة التلقائية («تسوية تأمين») مع قيدها وتحصيلها، بالسبب نفسه. والمطالبة القائمة على جهاز المالك قبل الترحيل تمرّ كما هي. ومصدرها المخزَّن صار ثابتاً مشتركاً (SETTLEMENT_CLAIM_SOURCE) بين الخدمة والاشتقاق والمزامنة.
- **R12-BAK-1 حساب القيد المضموم في الاستعادة:** حين يُضمّ قيدٌ مرحّل بعد النسخة وسطرُه على حسابٍ ليس حيّاً في دليل النسخة، يُحمل صفّ الحساب الحيّ من الجهاز أولاً ثم من لقطة السحابة، ويُدرج قبل القيد، ويُذكر في الحوار «ومعه حسابه». وإن لم يوجد للحساب صفّ حيّ في أي مصدر تُرفض الاستعادة قبل أي كتابة برسالة عربية تسمّي القيد ومبلغه والحساب (وأنه في السلة إن كان فيها). والمسار نفسه يخدم اعتماد نسخةٍ استُعيدت قبل الدخول، وصارت لقطة السحابة تحفظ صفوف الحسابات كاملة. السبب: مفتاح الحساب كان يرفض السطر فتفشل الاستعادة كلها برسالة «FOREIGN KEY» الإنجليزية، فلا تُستعاد أي نسخة أقدم من أول حساب جديد رُحّل عليه.
- **R12-BAK-2 دفعة «من التأمين» في الاستعادة:** تُحمل الدفعة بقيدها في حالة واحدة: أن يكون صفّ التسوية في النسخة هو التسوية التي سُدّدت بها (التاريخ والخصم والرد ووجهة المخصوم كما في المصدر)، وألا يذهب أيّ قيد من قيود تسوية العقد المضمومة إلى المراجعة. وإلا لا تُحمل الدفعة ويُراجَع قيدها مع أخواته، فتعديل التسوية بعد النسخة يُحمل كله أو يُراجَع كله. السبب: وجود أيّ صفّ تسوية للعقد كان يكفي للحمل، فتصرف المستندات التأمين مرة ونصفاً ويحمرّ فحص التأمينات بلا خطأ حقيقي. ومع R12-DEP-2: تسوية دفعة «من التأمين» تسوية العقد حامل التأمين (مصدر قيدها)، وإلغاء دفعةٍ في النسخة بعاكس قيدها المضموم المربوط بأصله يُحمل معه، ويُراجَع العاكس مع قيد الردّ، فلا تقلبه المزامنة (Z١-١ وY١). وحفظ التسوية بعد الاستعادة يعكس كل قيدٍ حيّ منها ولو بلا دفعته، ويلغي الدفعة التي عُكس قيدها بعاكسها القائم، ويعيد ما ضُمّ من قيودها داخل المطابقة ويخرجه من أداة المراجعة («قيد بعد الاستعادة صار له مستند»)، فالفحوص خضراء بعد الاستعادة وبعد الحفظ في العقد الواحد والسلسلة، وعلى الجهاز الثاني والمنضمّ.
- **R12-BAK-3 البنوك والمحفظة في الاستعادة:** حين تُضمّ قيود مرحّلة بعد النسخة تُحمل معها حركات نقل النقد بلا قيد بين المحفظة والبنوك (إيداع وسحب وتحويل) كما هي في المصدر. ما ليس في النسخة يُدرج، وساقا التحويل تُحملان معاً أو لا تُحملان، ويُعرض عددها في الحوار. ثم يُحسب رصيد كل بنك والمحفظة بعد الضمّ قبل أي كتابة، فإن نزل أحدها تحت الصفر بسبب الضمّ تُرفض الاستعادة (واعتمادها بعد الدخول) برسالة تسمّي البنك أو المحفظة والرصيد والناقص. السبب: القيد المضموم كان يصرف من بنكٍ لم يُحمل الإيداع الذي موّله، فيصير البنك سالباً وفي المحفظة نقدٌ ليس في اليد، خلافاً للقرار ٥٥.
- **R12-BAK-4 هوية الجهاز في الاستعادة:** تُكتب هوية هذا الجهاز وحرفه وكتل أرقامه ورقم فاتورته المحجوز وما ينتظر إصداره وعلامة الزرع، ومعها علامة «استُعيدت ولم تُعتمد للسحابة» متى كان للقاعدة الحية أو المستعادة حساب مزامنة، في القاعدة المجهَّزة قبل نقلها مكان الحالية. وعند الإقلاع، وقبل كنس tmp، تُكمَل استعادةٌ انقطعت بعد التبديل: تُنقل مرفقاتها من مجلد التجهيز إلى مجلد المرفقات، وتُطابَق حال الملفات من القرص. السبب: قرار 2026-08-20 أن الاستعادة تتمّ كاملة أو لا تتمّ ولا حالة ثالثة، وكان الانقطاع بعد التبديل يترك قاعدةً بهوية الجوال الذي صنع النسخة وأرقامه، وتُكنس المرفقات، وتُدمج مع السحابة دون اعتماد.
- **R12-BAK-5 حساب النظام 3300 والسحابة:** مستند السحابة لرمز 3300 قديمٌ أبداً حين يكون حساباً غير نظامي محذوفاً أو شاهدَ حذفه، فلا يُكتب فوق حساب النظام الحيّ على الجهاز، سواء كان جوالاً بدأ من السحابة بعد الترقية أو جهازاً ترقّى قبل أن يصله صدى حذفه. وحذف «3300» الذي أنشأه المستخدم بعد الترقية بلا سطر قيد عليه يحلّ محلّه حساب النظام على كل جهاز بقاعدة الهجرة ٦٢: المستقبِل حين يصله الحذف، والكاتب بصدى حذفه في أول مزامنة بعده. ولا يُرفع شيء إلى السحابة. السبب: أجهزة المنشأة الواحدة كانت تفترق في رصيد 1100، فيخرج افتتاحي البنوك من دفتر الجوال الجديد بصمت خلافاً لقرار س٢.
- **R12-BAK-1 (مراجعة الإصلاح):** حسابٌ في سلة النسخة استُعيد من السلة بعدها ثم رُحّل عليه يعود حيّاً بصفّه في المصدر بكل أعمدته، وحسابٌ في السلة في كل مصدر يمنع الاستعادة برسالة تقول إنه في السلة، لأن استعادته من السلة تحلّه. فلا يبقى قيدٌ مرحّل على حسابٍ محذوف خارج الميزان.
- **R12-BAK-3 (مراجعة الإصلاح):** حركات نقل النقد تُحمل بحالها في المصدر في الاتجاهين: ما في سلة المصدر يُنقل إلى السلة، وما في سلة النسخة وحيٌّ في المصدر يخرج من السلة، وما حُذف نهائياً بعد النسخة وشاهد حذفه في السحابة يُنقل إلى السلة بوقت حذفه. وحركةٌ حيّة في النسخة لا أثر لها على الجهاز ولا في السحابة تعود كما في النسخة ويُذكر عددها في الحوار. ومانع النقص في اعتماد نسخةٍ استُعيدت قبل الدخول يقول إنها لم تُعتمد ولم يُرفع منها شيء.
- **R12-BAK-2 (المراجعة الثانية والثالثة):** حكم «صار له مستند» على القيد المعلَّم بعد الاستعادة مشتقٌّ لا يُخزَّن لكل قيد (orphans.ts: documentedSql): كل سطر حفظٍ يعيد ترحيل قيود مستنده يسمّي ذلك المستند (REPOSTED_KEY: حفظ تسوية التأمين، وإلغاء العقد بتسوية، وحذف المطالبة وتعديلها)، وكل علامةٍ تسمّي ما كان لمستندها من سطور الحفظ حين كُتبت (saves)، فحفظٌ لا تسمّيه العلامة وقع بعدها أياً كان كاتبه ولو عضواً، فإن كان القيد المعلَّم في زوجٍ أثره صفر عاد داخل المطابقة وخرج من أداة المراجعة، ولا ينقلب الحكم إن عُكست قيود ذلك الحفظ أو عُلّمت في استعادةٍ لاحقة. وعند اعتماد الاستعادة يُكتب سطرٌ واحد (KEPT_FOREIGN_ENTITY) يسمّي ما ضمّه الاعتماد من السحابة من علاماتٍ وسطور حفظٍ واعتماد، فلا تعمل هنا لأنها من خطٍّ زمنيٍّ لم تعد إليه البيانات (foreignAuditIds). وجهاز المالك يلغي بعد كل تطبيقٍ وارد دفعة «من التأمين» الحيّة التي قُبل عاكس قيدها، بتاريخ العاكس وسبب تعديل التسوية، ويرفعها (sync/engine.ts: cancelReversedDepositRent). وورقة التسوية بعد الاستعادة تملأ «منها مقابل أقساطٍ متأخرة» بما سدّدته تسوية النسخة (قرار س١).
- **R12-BAK-2 (المراجعة الرابعة):** جوال الموظف بلا قسم «سجل العمليات» لا تصله علامات المراجعة، فكانت ورقة التسوية عنده تملأ خانة الأقساط المتأخرة صفراً بعد الاستعادة، وحفظها كما تظهر يقيد الإيجار أضراراً. فصار ما يشتقه جهاز المالك من علاماته مكتوباً في صفٍّ يُزامَن إلى العضو، هو سبب إلغاء الدفعة: ضمّ الاستعادة يحمل إلغاء دفعة «من التأمين» مع عاكسها المعلَّم بسببٍ خاص (DEPOSIT_RENT_KEPT_REASON «تعديل تسوية التأمين بعد النسخة المستعادة») على نسخةٍ من الصف، وجوال العضو يعدّها به (depositArrearsPaid) وجهاز المالك يبقى على علاماته، وكل حفظٍ للتسوية يعيده سبب التعديل، وجهاز المالك بعد المزامنة يعيده إن وثّق العاكسَ حفظُ عضوٍ لا يرى الدفعات (unkeepDocumentedDepositRent). وجداول المراجعة (fx وmk وsv و«تمّت مراجعته») مجسَّدة (MATERIALIZED) فيُمسح سجل العمليات مرةً لكلٍّ منها لا لكل علامة، وحال المراجعة تُحسب مرةً للورقة (reviewState)، وخانة الورقة تُحسب عند فتحها لا مع كل حرف. بلا تغيير في المخطط.
- **حارسا السحابة (E-1 وA2.4):** قاعدة السحابة صارت تحرس ما كان يحرسه جهاز المالك وحده: محضر الاستلام والتسليم المقفل في السحابة (d.locked = 1) لا يغيّر العضو بنوده (HANDOVER_FORM_COLS، قائمةٌ واحدة للجهاز والقاعدة) ولا يفتح قفله ولا يحذفه حذفاً ناعماً ولا يستعيده، ويعيد رفعه كما هو (rulesGen: handoverLockKept من lockedUpdateOk). والبنك الذي افتتاحيّه في السحابة غير صفر لا يحذفه العضو حذفاً ناعماً ولا يستعيده من السلة (openingKeptD)، وتغيير افتتاحيّه وحذفه النهائي كانا مرفوضين قبلُ (openingKept وMEMBER_NO_HARD_DELETE). والمالك بلا قيد، وميزانية القواعد كما كانت. ولا تُنشر القواعد إلا بعد الدمج في main.
- **A1-1 (البيانات القائمة):** أداةٌ في «فحص المطابقة» تحت الفحص الثالث (contracts/carryRepair.ts) تسرد كل عقدٍ مجدَّد له قيد ترحيل تأمينٍ حيّ وسابقه له صفّ تسوية، ولكلٍّ منها زرّ «عكس الترحيل وتصفير تأمين الجديد» للمالك وحده بحوارٍ يسمّي رقمَي العقدين والمبلغ وتاريخ العكس. يعكس الزرّ قيد الترحيل بعاكسه (بأبعاد أصله وتاريخه، إلا في ربعٍ قُدِّم إقراره فتاريخ التصحيح)، وينزل تأمين المجدَّد بالمرحَّل ولا ينزله تحت ما قبضه الدفتر له، ويكتب سطراً في سجل العمليات، ولا يغيّر شيئاً إن طُبّق ثانية. والجهات كالترحيل نفسه: المكتب والمنصة والطرف الآخر، والطرف الآخر يُسرد ولو كان الفحص أخضر لأن تسويته كانت تعرض ردّه ثانية. وتظهر الأداة موقوفةً بسببها بلا زرّ في حالتين: المجدَّد سُوّي تأمينه بعد الترحيل، أو رُحِّل تأمينه بعدُ إلى تجديدٍ آخر. وجهاز المالك يرفض عاكس الترحيل من عضو، ويُبقي تأمين عقدٍ ترحيله حيٌّ عنده إن غيّره عضو ويرفعه.
- **R12-BAK-3 (قرار المالك 2026-11-14):** حركات نقل النقد بين المحفظة والبنوك بعد النسخة (إيداع وسحب وتحويل) تُحمل في الاستعادة وفي اعتمادها بعد الدخول ولو لم يُضمّ معها قيدٌ مرحّل، بالقواعد نفسها: حالة السلة في الاتجاهين، وشاهد الحذف في السحابة ينقلها إلى السلة، وساقا التحويل معاً، والحركة على بنكٍ أُنشئ بعد النسخة لا تُحمل، ومانع النقص يسمّي البنك أو المحفظة والرصيد والناقص ويقول إن السبب حمل حركات نقل النقد. ويذكر الحوار عددها وعدد ما يعود كما في النسخة، ولا يُعدّ العائد على جهازٍ لا يعرف بنكها (جوالٌ جديد). السبب: قرار المالك، فنقل النقد حركة مالٍ حقيقية والمال فعلاً في البنك.

### ١٣.٢٤ الخروج من قوقل · ق٠ (2026-11-14)

ما بُني من المرحلة ق٠ لخطة الخروج من قوقل (تقرير F §٨) بقرار المالك «مابي التطبيق يرتبط بقوقل».
- **ق٠-٢ الخط (F-7):** خط IBM Plex Sans Arabic يُحمَّل من `assets/fonts` (الأوزان 400 و500 و700 ورخصة OFL في `OFL.txt`) بـ`useFonts` من `expo-font` وبأسماء العائلات نفسها في `src/ui/theme.ts`، بلا حزمة خطوط قوقل، فلا رابط `fonts.gstatic.com` في كود التطبيق. واختبار `q0_2.fontLocal` يمنع رجوع الحزمة.

### ١٣.١٧ الإصدارات وسجل التغييرات (التوجيه الرابع ٤ · ٢ · 2026-11-07)
- **رقمٌ واحد** في `src/version.ts` (`APP_VERSION` بصيغة رئيسي.فرعي.تصحيح، و`APP_BUILD` عددٌ يزيد دائماً)، ويطابقه `app.json` (`version` و`android.versionCode`) و`package.json` و`android/app/build.gradle` (`versionName` و`versionCode`) باختبار `tests/d4.version.test.ts`.
- **يظهر** في الإعدادات (`1.1.0 (2)`)، وفي كل تقرير عطل (`errorReportText`: «الإصدار:»)، وفي بيان كل نسخة احتياطية (`appVersion`).
- **سجل التغييرات بالعربية** في `docs/سجل-التغييرات.md`: قسمٌ `## <الرقم>` لكل إصدار بلغة المستخدم.
- **الوسم والنشرة** (`.github/workflows/apk-release.yml` و`scripts/ci/apkRelease.js`): فرع `apk` يحمل الحزمة وحدها فلا يُشغَّل منه سير عمل، فيُفحص رأسه من الفرع الرئيسي عند الدفع وكل ساعة وبالزر · رسالة حزمته تسمّي التزام مصدرها، ومن المصدر يُقرأ الرقم وقسمه، فيُوسَم المصدر `v<الرقم>` وتُنشر النشرة ومعها الحزمة وبصمتها · ورقمٌ موسوم لالتزامٍ آخر يُفشل التشغيل: **لكل حزمةٍ رقمٌ جديد**.
