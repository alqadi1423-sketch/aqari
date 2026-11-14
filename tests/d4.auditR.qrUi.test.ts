/**
 * المدقق الخارجي R · الجولة التاسعة · شاشة فواتير الشراء حول قراءة الرمز (app/purchases.tsx) كما هي في e7c151c · إثباتٌ من المصدر (وحدات
 * الواجهة لا تعمل على Node) ومعه أثره في منطق المجال حيث يُمكن · كل حالةٍ تفشل على الكود الحالي وتمرّ حين يُصلح · بياناتٌ مصطنعة.
 *   TZ=Asia/Riyadh npx jest tests/d4.auditR.qrUi.test.ts
 */
import fs from 'fs';
import path from 'path';
import { decodeZatcaQr, zatcaQrKey, type ZatcaQr } from '@/domain/zatcaQr';
import { purchaseDraftFromQr } from '@/domain/purchaseQr';
import { savePurchase, TS_DEDUCTIBLE } from '@/domain/purchases';
import { saveSupplier } from '@/domain/suppliers';
import { vatReturnData } from '@/domain/vatReturn';
import { memDb } from './helpers/testDb';

const SRC = fs.readFileSync(path.join(__dirname, '..', 'app', 'purchases.tsx'), 'utf8');
const between = (from: string, to: string) => {
  const a = SRC.indexOf(from);
  const b = SRC.indexOf(to, a + from.length);
  if (a < 0 || b < 0) throw new Error('تغيّر المصدر: ' + from);
  return SRC.slice(a, b);
};
const lineOf = (s: string) => SRC.slice(0, SRC.indexOf(s)).split('\n').length;
const u8 = (v: string) => Array.from(new TextEncoder().encode(v));
const tlv = (pairs: Array<[number, string]>) =>
  Buffer.from(Uint8Array.from(pairs.flatMap(([t, v]) => { const b = u8(v); return [t, b.length, ...b]; }))).toString('base64');
const ok = (r: ReturnType<typeof decodeZatcaQr>): ZatcaQr => { if (!r.ok) throw new Error('لم يُقرأ'); return r.qr; };
const sup = (name: string, vat: string) => ({ name, vat, phone: '', category: '', amountHalalas: null, utility: '' });
const log = (...a: unknown[]) => { /* eslint-disable-next-line no-console */ console.log(...a); };

describe('R٩ · (إصلاح N٧ ناقص) «المبالغ وحدها» والمورد المؤرشف: النموذج يُبقي أول موردٍ أبجدياً (openNew) فتُحفظ فاتورة البائع باسم غيره ورقمه', () => {
  test('apply(\'\') لا يمسح المورد، وopenNew يختار suppliers[0]: الفاتورة بمفتاح رمز البائع تُخصم برقمٍ ضريبي لموردٍ آخر', () => {
    const openNew = between('const openNew = () => {', 'setFormOpen(true);');
    const fill = between('const fillFromQr = async', 'const startQr = () =>');
    const preselects = openNew.includes("setSupplier(suppliers[0]?.name ?? '')");
    const keepsOnEmpty = /if \(name\) \{ setSupplier\(name\);/.test(fill) && !/else\s*\{?\s*setSupplier\(''\)/.test(fill);
    const amountsOnly = /label: t\('purchaseQr\.keepSupplier'\)[^\n]*apply\(''\)/.test(fill);
    const archivedOnly = /supplierArchived'\)\) \{ apply\(''\); return; \}/.test(fill);
    // الأثر في المجال: موردٌ أول أبجدياً برقمٍ ضريبي، والبائع في الرمز غيره وليس في الموردين، فيختار المستخدم «المبالغ وحدها»
    const db = memDb();
    db.run(`UPDATE company SET vat_enabled = 1, vatno = '399999999999993' WHERE id = 1`);
    saveSupplier(db, null, sup('أ مؤسسة الألف المصطنعة', '322222222222223'));
    saveSupplier(db, null, sup('ي مؤسسة الياء المصطنعة', '333333333333333'));
    const first = db.get<{ name: string }>(`SELECT name FROM suppliers WHERE archived = 0 AND deleted_at IS NULL ORDER BY name LIMIT 1`)!.name;
    const qr = ok(decodeZatcaQr(tlv([[1, 'متجر الأدوات المصطنع'], [2, '300000000000003'], [3, '2026-11-01T09:15:42'], [4, '1150.00'], [5, '150.00']])));
    const d = purchaseDraftFromQr(db, qr, () => '2026-11-07');
    // ما في النموذج بعد apply(''): المورد كما وضعه openNew، والتاريخ والمبالغ والمفتاح من الرمز · ثم «قابلة للخصم» وتأكيدها، فالحفظ
    const id = savePurchase(db, {
      supplier: first, date: d.date, due: '', category: 'صيانة', incorpItem: '', amortize: false, amortizeMonths: null,
      exempt: false, excludeFromVat: false, taxStatus: TS_DEDUCTIBLE, subtotalHalalas: d.subtotalHalalas, taxHalalas: d.taxHalalas,
      totalHalalas: d.totalHalalas, qrKey: zatcaQrKey(qr),
    });
    const row = db.get<{ supplier_name: string; supplier_vatno: string; qr_key: string }>(`SELECT supplier_name, supplier_vatno, qr_key FROM purchases WHERE id = ?`, [id])!;
    const sched = vatReturnData(db, 2026, 4).schedules.deductiblePurchases.map((p) => ({ supplier: p.supplier, vat: p.supplierVatno }));
    log('R9 · openNew يختار suppliers[0] (سطر', lineOf("setSupplier(suppliers[0]?.name ?? '')") + '):', preselects,
      '· apply(\'\') لا يمسحه (سطر', lineOf('if (name) { setSupplier(name);') + '):', keepsOnEmpty,
      '· «المبالغ وحدها» تستدعي apply(\'\'):', amountsOnly, '· والمؤرشف:', archivedOnly,
      '\n· المسودة:', JSON.stringify({ supplier: d.supplier, newSupplierVat: d.newSupplierVat }), '· المحفوظ:', JSON.stringify(row),
      '\n· جدول المشتريات القابلة للخصم في الإقرار:', JSON.stringify(sched));
    expect(preselects && amountsOnly && archivedOnly).toBe(true);
    expect(row.supplier_vatno).toBe('322222222222223');
    // المتوقع: «المبالغ وحدها» (والمؤرشف) تُفرغ حقل المورد فيطلب الحفظ مورداً يختاره المستخدم، لا أن يبقى موردٌ لم يقله الرمز ولا المستخدم
    expect(preselects && keepsOnEmpty).toBe(false);
  });
});

describe('R١٠ · apply يقرأ الملف المرفق من لقطة ما قبل القراءة: ملفٌ أرفقه المستخدم أثناء القراءة يُستبدل صامتاً بصورة الرمز (تتمة J١٠)', () => {
  test('الشرط بعد await يقرأ pendingFile/qrFile من الإغلاق، وزرّ الإرفاق لا يُعطَّل أثناء القراءة', () => {
    const fill = between('const fillFromQr = async', 'const startQr = () =>');
    const firstAwait = fill.indexOf('await ');
    const cond = fill.indexOf('if (!pendingFile || pendingFile === qrFile)');
    const functional = /setPendingFile\(\(\w+\)\s*=>/.test(fill) || /pendingFileRef|qrFileRef/.test(fill);
    const attach = /onPress=\{async \(\) => \{ const f = await pickFile\(\); if \(f\) setPendingFile\(f\); \}\}/.test(SRC);
    const attachGuarded = /qrBusy[^\n]{0,80}pickFile\(\)/.test(SRC);
    // محاكاةٌ لدلالة الإغلاق في React: لقطة الحالة يوم بدأت القراءة، ثم أرفق المستخدم ملفه، ثم انتهت القراءة
    const state: { pendingFile: string | null; qrFile: string | null } = { pendingFile: null, qrFile: null };
    const snap = { ...state };
    state.pendingFile = 'عقد-الصيانة-الأصلي.pdf';
    if (!snap.pendingFile || snap.pendingFile === snap.qrFile) { state.pendingFile = 'صورة-الرمز.jpg'; state.qrFile = 'صورة-الرمز.jpg'; }
    log('R10 · الشرط (سطر', lineOf('if (!pendingFile || pendingFile === qrFile)') + ') بعد أول await في القراءة:', cond > firstAwait && firstAwait >= 0,
      '· تحديثٌ وظيفي أو مرجع:', functional, '· زرّ الإرفاق (سطر', lineOf('const f = await pickFile(); if (f) setPendingFile(f);') + ') بلا قيد qrBusy:', attach && !attachGuarded,
      '· المرفق بعد انتهاء القراءة:', state.pendingFile);
    // (بعد الإصلاح: الشرط تحديثٌ وظيفي بمرجع صورة الرمز، فلا يبقى الشرط القديم · وزرّ الإرفاق كما هو)
    expect(cond < 0 || cond > firstAwait).toBe(true);
    expect(attach).toBe(true);
    // المتوقع: ما يرفقه المستخدم أثناء القراءة لا يُستبدل (يُقرأ المرفق الحالي لا لقطته، أو يُعطَّل الإرفاق أثناء القراءة)
    expect(functional || attachGuarded).toBe(true);
  });
});
