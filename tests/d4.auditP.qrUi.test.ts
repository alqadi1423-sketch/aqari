/**
 * المدقق الخارجي P · الجولة الثامنة · شاشة فواتير الشراء حول قراءة الرمز (app/purchases.tsx) كما هي في e5e16f5 · إثباتٌ من المصدر (وحدات
 * الواجهة لا تعمل على Node) ومعه أثره في منطق المجال حيث يُمكن · كل حالةٍ تفشل على الكود الحالي وتمرّ حين يُصلح · بياناتٌ مصطنعة.
 *   TZ=Asia/Riyadh npx jest tests/auditP.qrUi.test.ts
 */
import fs from 'fs';
import path from 'path';
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

describe('P٦ · إصلاح N٦ ناقص: رقم القراءة qrSeq لا يتقدّم عند إغلاق النموذج، والتعليق يقول «أو إغلاق»', () => {
  test('قراءةٌ تنتهي بعد إغلاق النموذج تعبّئ نموذجاً مغلقاً وتعرض حواريه، و«إضافة المورد» فيها تكتب مورداً لفاتورةٍ تُركت', () => {
    const fill = between('const fillFromQr = async', 'const startQr = () =>');
    const claim = fill.includes('تعديل فاتورةٍ أخرى أو إغلاق');
    // كل مواضع تقدّم الرقم: القراءة نفسها وopenNew وopenEdit — لا الإغلاق
    const bumps = [...SRC.matchAll(/qrSeq\.current\+\+|\+\+qrSeq\.current/g)].map((m) => SRC.slice(0, m.index).split('\n').length);
    const closeExpr = /<Sheet visible=\{formOpen\} onClose=\{([^\n]*?)\}\n/.exec(SRC)?.[1] ?? '';
    const checksOpen = /formOpen/.test(fill);
    // زرّ «إضافة المورد» يكتب المورد قبل apply، وفحص الرقم في apply وحده
    const addPress = between("{ label: t('purchaseQr.addSupplier')", "{ label: t('purchaseQr.keepSupplier')");
    const writesFirst = addPress.indexOf('saveSupplier(') >= 0 && addPress.indexOf('saveSupplier(') < addPress.indexOf('apply(d.supplier)');
    log('P6 · التعليق «أو إغلاق» (سطر', lineOf('تعديل فاتورةٍ أخرى أو إغلاق') + '):', claim, '· مواضع تقدّم qrSeq (أسطر):', bumps,
      '\n· إغلاق النموذج (سطر', lineOf('<Sheet visible={formOpen} onClose='), '):', closeExpr, '· fillFromQr يفحص formOpen:', checksOpen,
      '\n· «إضافة المورد» يكتب المورد قبل apply (سطر', lineOf("saveSupplier(db, null, { name: d.supplier"), '):', writesFirst);
    expect(claim).toBe(true);
    expect(writesFirst).toBe(true);
    // المتوقع: الإغلاق يُبطل القراءة الجارية كما يُبطلها openNew وopenEdit
    expect(closeExpr.includes('qrSeq') || checksOpen).toBe(true);
  });
});

describe('P٧ · تعبئة الرمز تختار المورد ولا تضع فئته الافتراضية كما يضعها اختياره يدوياً، فيُرحَّل المصروف على حسابٍ آخر', () => {
  test('موردٌ فئته الافتراضية «تكلفة مبيعات» (5100): الاختيار اليدوي يضعها، وتعبئة الرمز تتركها فارغة فيُرحَّل على 5300', () => {
    const manual = between('onPick={(id) => {\n            const s = suppliers.find((x) => x.id === id);', 'setMeterId(\'\');\n          }} />');
    const applyBody = between('const apply = (name: string) => {', "if (d.supplierId) { apply(d.supplier); return; }");
    const manualSets = manual.includes('if (s.default_category && !category) setCategory(s.default_category);');
    const applySets = /default_category|setCategory\(/.test(applyBody);

    // الأثر: المسودة تعرف المورد برقمه، والفئة تبقى كما فتحها openNew ('')، فالحفظ يرحّل على 5300 لا 5100
    const db = memDb();
    saveSupplier(db, null, { name: 'مورد البضاعة المصطنع', vat: '300000000000003', phone: '', category: 'تكلفة مبيعات', amountHalalas: null, utility: '' });
    const d = purchaseDraftFromQr(db, ok(decodeZatcaQr(tlv([[1, 'مورد البضاعة المصطنع'], [2, '300000000000003'], [3, '2026-11-01T09:15:42'], [4, '1150.00'], [5, '150.00']]))), () => '2026-11-07');
    const acct = (category: string) => {
      const id = savePurchase(db, {
        supplier: d.supplier, date: d.date, due: '', category, incorpItem: '', amortize: false, amortizeMonths: null, exempt: false,
        excludeFromVat: true, taxStatus: TS_EXCLUDED, subtotalHalalas: d.subtotalHalalas, taxHalalas: d.taxHalalas, totalHalalas: d.totalHalalas,
      });
      return db.all<{ a: string }>(`SELECT l.account_code AS a FROM journal_lines l JOIN purchases p ON p.journal_entry_id = l.entry_id
        WHERE p.id = ? AND l.debit_halalas > 0 ORDER BY l.debit_halalas DESC`, [id]).map((r) => r.a);
    };
    const viaQr = acct('');
    const viaPick = acct('تكلفة مبيعات');
    log('P7 · الاختيار اليدوي يضع الفئة (سطر', lineOf('if (s.default_category && !category)') + '):', manualSets, '· apply يضعها (سطر', lineOf('const apply = (name: string) => {') + '):', applySets,
      '\n· المسودة:', JSON.stringify({ supplier: d.supplier, known: !!d.supplierId }), '· مدين القيد بالرمز:', viaQr, '· وباختياره يدوياً:', viaPick);
    expect(manualSets).toBe(true);
    expect(viaQr[0]).not.toBe(viaPick[0]);
    // المتوقع: «تُعرض معبأة» — اختيار المورد بالرمز كاختياره يدوياً
    expect(applySets).toBe(true);
  });
});

describe('P٨ · «فاتورة جديدة» من المحادثة لا تفتح النموذج بلا موردين، صامتةً، وقد صار النموذج يُفتح بلا موردين (N٨)', () => {
  test('أثر ?newNote= يعود بلا رسالة حين لا موردين، وopenNew نفسه يقبلها', () => {
    const openNew = between('const openNew = () => {', 'setFormOpen(true);');
    const acceptsNone = openNew.includes("setSupplier(suppliers[0]?.name ?? '')");
    const chatGuard = /if \(!perm\.add \|\| !suppliers\.length\) return;/.test(SRC);
    log('P8 · openNew يقبل «بلا موردين» (سطر', lineOf('const openNew = () => {') + '):', acceptsNone, '· أثر المحادثة يشترطهم صامتاً (سطر',
      lineOf('if (!perm.add || !suppliers.length) return;') + '):', chatGuard);
    expect(acceptsNone).toBe(true);
    expect(chatGuard).toBe(false);
  });
});
