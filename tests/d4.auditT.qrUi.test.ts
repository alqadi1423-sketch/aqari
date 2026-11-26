/**
 * المدقق الخارجي T · الجولة العاشرة · شاشة فواتير الشراء حول قراءة الرمز (app/purchases.tsx) كما هي في 7e3b492 · إثباتٌ من المصدر (وحدات
 * الواجهة لا تعمل على Node) ومعه أثره في منطق المجال · كل حالةٍ تفشل على 7e3b492 وتمرّ حين يُصلح · بياناتٌ مصطنعة.
 *   TZ=Asia/Riyadh npx jest tests/d4.auditT.qrUi.test.ts
 */
import fs from 'fs';
import path from 'path';
import { decodeZatcaQr, zatcaQrKey, type ZatcaQr } from '@/domain/zatcaQr';
import { purchaseDraftFromQr } from '@/domain/purchaseQr';
import { savePurchase, TS_DEDUCTIBLE } from '@/domain/purchases';
import { saveSupplier } from '@/domain/suppliers';
import { vatReturnData } from '@/domain/vatReturn';
import { memDb } from './helpers/testDb';

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'app', 'purchases.tsx'), 'utf8');
const AR = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'i18n', 'locales', 'ar.json'), 'utf8')) as { purchaseQr: { review: string } };
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

describe('T٨ · تأكيد «الفاتورة باسم المنشأة وبرقمها» يبقى من فاتورةٍ سابقة في النموذج: رمزٌ ثانٍ يُقرأ فيُحفظ «قابلة للخصم» بتأكيدٍ لم يُعطَ له', () => {
  test('apply يبدّل المورد والتاريخ والمبالغ والمفتاح والمرفق ولا يمسّ الوضع الضريبي ولا تأكيده، والمراجعة تقول «الوضع الضريبي اختره أنت»', () => {
    const openNew = between('const openNew = () => {', 'setFormOpen(true);');
    const apply = between('const apply = (name: string) => {', 'const choose = () => {');
    const resetsOnNew = openNew.includes('setConfirmOurs(false)') && openNew.includes('setTaxStatus(TS_EXCLUDED)');
    const fill = between('const fillFromQr = async', 'const startQr = () =>');
    const applyTouchesConfirm = /setConfirmOurs\(|setTaxStatus\(/.test(fill);
    const saveGate = /if \(!confirmOurs\) \{/.test(SRC);
    // الأثر: فاتورة أ (فاتورة ضريبية باسم المنشأة) اختار لها «قابلة للخصم» وأكّد، ثم قرأ رمز فاتورة ب (فاتورةٌ مبسّطة من سوبرماركت، ليست باسم
    // المنشأة) في النموذج نفسه بدل أ: الحفظ يمرّ بالتأكيد الباقي، وضريبة ب تُخصم في الإقرار
    const db = memDb();
    db.run(`UPDATE company SET vat_enabled = 1, vatno = '399999999999993' WHERE id = 1`);
    saveSupplier(db, null, sup('أسواق الحيّ المصطنعة', '311111111111113'));
    const b = ok(decodeZatcaQr(tlv([[1, 'أسواق الحيّ المصطنعة'], [2, '311111111111113'], [3, '2026-11-02T20:11:05+03:00'], [4, '3450.00'], [5, '450.00']])));
    const d = purchaseDraftFromQr(db, b, () => '2026-11-07');
    savePurchase(db, {
      supplier: d.supplier, date: d.date, due: '', category: 'مستلزمات', incorpItem: '', amortize: false, amortizeMonths: null, exempt: false,
      excludeFromVat: false, taxStatus: TS_DEDUCTIBLE, subtotalHalalas: d.subtotalHalalas, taxHalalas: d.taxHalalas, totalHalalas: d.totalHalalas,
      qrKey: zatcaQrKey(b),
    });
    const sched = vatReturnData(db, 2026, 4).schedules.deductiblePurchases.map((p) => ({ supplier: p.supplier, tax: p.tax }));
    log('T8 · openNew يصفّر الوضع وتأكيده (سطر', lineOf('setConfirmOurs(false);'), '):', resetsOnNew, '· apply (سطر', lineOf('const apply = (name: string) => {'),
      ') يمسّهما:', applyTouchesConfirm, '· الحفظ يشترط confirmOurs وحده (سطر', lineOf('if (!confirmOurs) {'), '):', saveGate,
      '\n· نصّ المراجعة:', AR.purchaseQr.review, '\n· جدول الخصم في الإقرار بعد حفظ ب:', JSON.stringify(sched));
    expect(resetsOnNew && saveGate).toBe(true);
    expect(AR.purchaseQr.review).toContain('الوضع الضريبي اختره أنت');
    // المتوقع: فاتورةٌ جديدة تُعبَّأ من رمزها تطلب تأكيداً لها هي (يُصفَّر confirmOurs في التعبئة كما في openNew)، لا تأكيداً أُعطي لما قبلها
    expect(apply.length).toBeGreaterThan(0);
    expect(applyTouchesConfirm).toBe(true);
  });
});
