/**
 * المدقق الخارجي T · الجولة العاشرة · قاعدة «لا مبلغ سالب» في savePurchase (إصلاح R٢ في 7e3b492) · رسالتها تقول «والضريبة لا تزيد على
 * الإجمالي» ولا تفرضه: فرق تقريبٍ سالب يحمل ضريبةً فوق الإجمالي، وبـ«قابلة للخصم» تدخل الإقرار · كل حالةٍ تفشل على 7e3b492 وتمرّ حين يُصلح.
 *   TZ=Asia/Riyadh npx jest tests/d4.auditT.negative.test.ts
 */
import fs from 'fs';
import path from 'path';
import { decodeZatcaQr, zatcaQrKey, type ZatcaQr } from '@/domain/zatcaQr';
import { purchaseDraftFromQr } from '@/domain/purchaseQr';
import { savePurchase, TS_DEDUCTIBLE } from '@/domain/purchases';
import { saveSupplier } from '@/domain/suppliers';
import { vatReturnData } from '@/domain/vatReturn';
import { RuleViolation } from '@/domain/contracts/service';
import { memDb } from './helpers/testDb';

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'app', 'purchases.tsx'), 'utf8');
const AR = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'i18n', 'locales', 'ar.json'), 'utf8')) as { purchase: { negativeAmounts: string } };
const u8 = (v: string) => Array.from(new TextEncoder().encode(v));
const tlv = (pairs: Array<[number, string]>) =>
  Buffer.from(Uint8Array.from(pairs.flatMap(([t, v]) => { const b = u8(v); return [t, b.length, ...b]; }))).toString('base64');
const ok = (r: ReturnType<typeof decodeZatcaQr>): ZatcaQr => { if (!r.ok) throw new Error('لم يُقرأ'); return r.qr; };
const log = (...a: unknown[]) => { /* eslint-disable-next-line no-console */ console.log(...a); };

describe('T٧ · الضريبة فوق الإجمالي تُحفظ بفرق تقريبٍ سالب، و«قابلة للخصم» تخصم ضريبةً أكبر من الفاتورة كلها', () => {
  test('رمزٌ بوسمَي الإجمالي والضريبة مقلوبين: الصافي ‎-100 يُرفض، فيصحّح المستخدم إشارته ويقبل «الفرق كفرق تقريب» في نافذة عدم التوازن', () => {
    const db = memDb();
    db.run(`UPDATE company SET vat_enabled = 1, vatno = '399999999999993' WHERE id = 1`);
    saveSupplier(db, null, { name: 'مؤسسة القلب المصطنعة', vat: '300000000000003', phone: '', category: '', amountHalalas: null, utility: '' });
    const qr = ok(decodeZatcaQr(tlv([[1, 'مؤسسة القلب المصطنعة'], [2, '300000000000003'], [3, '2026-11-01T09:15:42'], [4, '15.00'], [5, '115.00']])));
    const d = purchaseDraftFromQr(db, qr, () => '2026-11-07');
    // ما تحفظه نافذة عدم التوازن بزرّها الأول (purchases.tsx: «احفظ كما هي · اقبل الفرق … كفرق تقريب» → doSave(bh, xh, gh, diff))
    const acceptDiff = /onPress=\{\(\) => \{ close\(\); doSave\(bh, xh, gh, diff\); \}\}/.test(SRC);
    const bh = -d.subtotalHalalas; // المستخدم يحذف علامة السالب من الصافي
    const xh = d.taxHalalas;
    const gh = d.totalHalalas;
    let err: unknown = null;
    try {
      savePurchase(db, {
        supplier: d.supplier, date: d.date, due: '', category: 'صيانة', incorpItem: '', amortize: false, amortizeMonths: null,
        exempt: false, excludeFromVat: false, taxStatus: TS_DEDUCTIBLE, subtotalHalalas: bh, taxHalalas: xh, totalHalalas: gh,
        roundingDiffHalalas: gh - bh - xh, qrKey: zatcaQrKey(qr),
      });
    } catch (e) { err = e; }
    const sched = vatReturnData(db, 2026, 4).schedules.deductiblePurchases.map((p) => ({ tax: p.tax, total: p.total }));
    log('T7 · زرّ قبول الفرق في المصدر:', acceptDiff, '· المحفوظ: الصافي', bh, 'الضريبة', xh, 'الإجمالي', gh, 'فرق التقريب', gh - bh - xh,
      '· الخطأ:', (err as Error | null)?.message ?? 'لا شيء', '· جدول الخصم في الإقرار:', JSON.stringify(sched), '· نصّ القاعدة:', AR.purchase.negativeAmounts);
    expect(acceptDiff).toBe(true);
    expect(AR.purchase.negativeAmounts).toContain('الضريبة لا تزيد على الإجمالي');
    // المتوقع: ما تقوله القاعدة تفرضه: ضريبةٌ فوق الإجمالي تُرفض قاعدةَ عمل (RuleViolation) أيّاً كان فرق التقريب
    expect(err).toBeInstanceOf(RuleViolation);
  });
});
