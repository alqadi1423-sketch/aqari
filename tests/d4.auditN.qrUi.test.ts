/**
 * المدقق الخارجي N · الجولة السابعة · شاشة فواتير الشراء حول قراءة الرمز (app/purchases.tsx) كما هي في 2cf6151 · إثباتٌ من المصدر
 * (وحدات الواجهة لا تعمل على Node) ومعه أثره في منطق المجال حيث يُمكن · كل حالةٍ تفشل على الكود الحالي وتمرّ حين يُصلح · بياناتٌ مصطنعة.
 *   TZ=Asia/Riyadh npx jest tests/auditN.qrUi.test.ts
 */
import fs from 'fs';
import path from 'path';
import ar from '@/i18n/locales/ar.json';
import { decodeZatcaQr, type ZatcaQr } from '@/domain/zatcaQr';
import { purchaseDraftFromQr } from '@/domain/purchaseQr';
import { savePurchase, TS_EXCLUDED } from '@/domain/purchases';
import { saveSupplier } from '@/domain/suppliers';
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
const log = (...a: unknown[]) => { /* eslint-disable-next-line no-console */ console.log(...a); };

describe('N٥ · تعبئة الرمز تغيّر المورد ولا تمسح العدّاد المختار لموردٍ قبله: يُحفظ «قراءة عدّاد» لغير صاحبه بمبلغ فاتورةٍ أخرى', () => {
  test('apply() في fillFromQr لا يمسح meterId، والعدّاد يختفي من النموذج، والحفظ يرسله فتُسجَّل قراءة على عدّاد المورد الأول', () => {
    const applyBody = between('const apply = (name: string) => {', "if (d.supplierId) { apply(d.supplier); return; }");
    // الدليل من المصدر: اختيار المورد يدوياً يمسح العدّاد، والعقار كذلك، وتعبئة الرمز لا
    const manualPick = /setSupplier\(s\.name\);[\s\S]{0,300}?setMeterId\(''\);/.test(SRC);
    const shownOnlyForUtility = SRC.includes('{selectedSupplier?.utility_type ? (');
    const saveSends = SRC.includes('meterId: meterId || null,');
    log('N5 · السطور: apply', lineOf('const apply = (name: string) => {'), '· الاختيار اليدوي يمسح العدّاد:', manualPick,
      '· العدّاد يُعرض لمورد الخدمة وحده:', shownOnlyForUtility, '· والحفظ يرسله:', saveSends, '(سطر', lineOf('meterId: meterId || null,') + ')');

    // الأثر في المجال: النموذج مفتوح بمورد المياه (suppliers[0] بالترتيب) واختار المستخدم عدّاده وقراءته، ثم قرأ رمز فاتورة موردٍ آخر
    const db = memDb();
    db.run(`INSERT INTO properties (id, name, created_at) VALUES ('P-N5', 'عقار مصطنع', '2026-01-01T00:00:00.000Z')`);
    const water = saveSupplier(db, null, { name: 'شركة المياه المصطنعة', vat: '', phone: '', category: '', amountHalalas: null, utility: 'ماء' });
    saveSupplier(db, null, { name: 'مؤسسة العدد المصطنعة', vat: '300000000000003', phone: '', category: '', amountHalalas: null, utility: '' });
    db.run(`INSERT INTO meters (id, owner_type, owner_id, kind, number, supplier_id) VALUES ('M-N5', 'property', 'P-N5', 'ماء', '77001', ?)`, [water]);
    const qr = ok(decodeZatcaQr(tlv([[1, 'مؤسسة العدد المصطنعة'], [2, '300000000000003'], [3, '2026-11-01T10:20:30'], [4, '2300.00'], [5, '300.00']])));
    const d = purchaseDraftFromQr(db, qr, () => '2026-11-07');
    // كما يبني doSaveIn مدخلات الحفظ بعد apply(d.supplier): المورد من الرمز، والعدّاد والقراءة كما بقيا في الحالة
    const id = savePurchase(db, {
      supplier: d.supplier, date: d.date, due: '', category: '', incorpItem: '', amortize: false, amortizeMonths: null,
      exempt: false, excludeFromVat: true, taxStatus: TS_EXCLUDED, subtotalHalalas: d.subtotalHalalas, taxHalalas: d.taxHalalas,
      totalHalalas: d.totalHalalas, meterId: 'M-N5', meterReading: 1234,
    });
    const reading = db.get<{ reading: number; amount_halalas: number; ref: string }>(`SELECT reading, amount_halalas, ref FROM meter_readings WHERE meter_id = 'M-N5'`);
    const linked = db.get<{ supplier_name: string; meter_id: string }>(`SELECT supplier_name, meter_id FROM purchases WHERE id = ?`, [id]);
    log('N5 · قراءة عدّاد المياه بعد حفظ فاتورة العدد:', JSON.stringify(reading), '· الفاتورة:', JSON.stringify(linked));

    // المتوقع: تعبئة الرمز التي تغيّر المورد تمسح العدّاد وقراءته كما يفعل الاختيار اليدوي
    expect(applyBody).toMatch(/setMeterId\(''\)/);
  });
});

describe('N٦ · قراءةٌ جارية تكتب في نموذج «تعديل» فُتح أثناءها (إصلاح L٦ يُتجاوَز)', () => {
  test('fillFromQr بعد await لا يتحقق أن النموذج ما زال الفاتورة الجديدة نفسها، وapply يكتب المورد والتاريخ والمبالغ والمرفق', () => {
    const body = between('const fillFromQr = async', 'const startQr = () =>');
    const afterAwait = body.slice(body.indexOf('await read'));
    const guard = /editingId|formOpen|readSeq|qrSeq|alive|cancel|token|generation/.test(afterAwait);
    const openEdit = between('const openEdit = useCallback(', '}, [db]);');
    const clearsThenEdits = /setPendingFile\(null\); setQrKey\(''\); setQrFile\(null\);\s*\n\s*setEditingId\(id\);/.test(openEdit);
    const editAttaches = /if \(pendingFile\) \{\s*\n\s*attachPicked\(db, pendingFile, 'purchase', savedId/.test(SRC);
    const sheetCloses = SRC.includes('onClose={() => setFormOpen(false)}');
    log('N6 · السطور: await', lineOf('await readQrFromImage'), '· apply', lineOf('const apply = (name: string) => {'),
      '· openEdit يمسح ثم يفتح التعديل:', clearsThenEdits, '· الحفظ يرفق المعلّق في التعديل أيضاً:', editAttaches,
      '· النافذة تُغلق أثناء القراءة (qrBusy لا يمنعه):', sheetCloses, '· حارسٌ بعد await:', guard);
    // المتوقع: بعد الانتظار تُهمل النتيجة إن تغيّر النموذج (أُغلق أو صار تعديلاً لفاتورةٍ أخرى)
    expect(guard).toBe(true);
  });
});

describe('N٧ · المورد المؤرشف: التنبيه لا يسمّيه، والنموذج يبقى على مورده الأول', () => {
  test('فرع supplierArchived يستدعي apply(\'\') ولا يعرض d.supplier، ونصّ التنبيه بلا اسم', () => {
    const branch = /if \(d\.warnings\.includes\('supplierArchived'\)\) \{([^}]*)\}/.exec(SRC);
    const text = (ar as unknown as { purchaseQr: { warn: Record<string, string> } }).purchaseQr.warn.supplierArchived;
    // الأثر: البطاقة المؤرشفة اسمها غير اسم البائع في الرمز (طوبقت برقمها)، فلا يعرف المستخدم ما يُعيد من الأرشيف
    const db = memDb();
    const old = saveSupplier(db, null, { name: 'مورد قديم مصطنع', vat: '300000000000003', phone: '', category: '', amountHalalas: null, utility: '' });
    db.run(`UPDATE suppliers SET archived = 1 WHERE id = ?`, [old]);
    saveSupplier(db, null, { name: 'أول مورد نشط مصطنع', vat: '', phone: '', category: '', amountHalalas: null, utility: '' });
    const qr = ok(decodeZatcaQr(tlv([[1, 'الاسم التجاري الجديد المصطنع'], [2, '300000000000003'], [3, '2026-11-01T10:20:30'], [4, '115.00'], [5, '15.00']])));
    const d = purchaseDraftFromQr(db, qr, () => '2026-11-07');
    const first = db.get<{ name: string }>(`SELECT name FROM suppliers WHERE archived = 0 AND deleted_at IS NULL ORDER BY name LIMIT 1`)!.name;
    log('N7 · سطر الفرع:', lineOf("if (d.warnings.includes('supplierArchived'))"), '· الفرع:', branch?.[1]?.trim(), '· نصّ التنبيه:', text,
      '· المسودة:', JSON.stringify({ supplier: d.supplier, warnings: d.warnings }), '· المورد الذي يبقى في النموذج (openNew: suppliers[0]):', first);
    const named = /\{\{\w+\}\}/.test(text) || /d\.supplier/.test(branch?.[1] ?? '');
    // المتوقع: يُسمّى المورد المؤرشف الذي يُعاد (d.supplier)، فالنموذج يعرض غيره
    expect(named).toBe(true);
  });
});

describe('N٨ · «رمز QR أولاً» لا يُبلغ بلا موردٍ نشط: الزر داخل نموذجٍ لا يُفتح', () => {
  test('openNew يرفض بلا موردين، وزر الشاشة مخفي، وقراءة الرمز (التي تضيف المورد) داخل النموذج وحده', () => {
    const bails = /const openNew = \(\) => \{\s*\n\s*if \(!suppliers\.length\) \{ toast\('أضف مورداً أولاً'\); return; \}/.test(SRC);
    const headerHidden = SRC.includes('actions={suppliers.length && perm.add ?');
    const uses = (SRC.match(/startQr/g) ?? []).length - 1; // سوى تعريفه
    const onlyInForm = uses === 1 && /\{!editingId \? \(\s*\n\s*<View[^>]*>\s*\n\s*<BtnGhost small icon="invoice"[^\n]*startQr/.test(SRC);
    log('N8 · openNew يرفض بلا موردين (سطر', lineOf('const openNew = () => {') + '):', bails, '· زر «+ تسجيل» مشروطٌ بالموردين (سطر',
      lineOf('actions={suppliers.length && perm.add ?') + '):', headerHidden, '· استعمالات startQr:', uses, '· وكلها في النموذج:', onlyInForm);
    // المتوقع: قراءة الرمز تُبلغ ولو بلا موردٍ نشط (منشأة جديدة، أو أُرشف كل الموردين)، فحوارها نفسه يضيف المورد برقمه
    const reachable = !bails || !onlyInForm;
    expect(reachable).toBe(true);
  });
});
