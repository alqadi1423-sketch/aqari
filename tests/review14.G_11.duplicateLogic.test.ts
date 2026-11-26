/**
 * المراجعة الشاملة 2026-11-13 · G-11 · منخفض · منطقٌ مكرر.
 * السيناريو ١: فاتورةٌ بسطرٍ خاضع 3.33 وسطرٍ معفى 6.67 ← ورقة الإشعار الدائن بـ0.10 تعرض ضريبة 0.01 (creditTaxFor بالنسبة
 * المتوسطة)، والخدمة تحفظ 0.00 (creditNoteAmounts بالرموز): الرقم المعروض يخالف المحفوظ بهللة.
 * السيناريو ٢: payPurchase نسخةٌ ثانية من منطق النقد والبنك والقيد لا يناديها التطبيق، والاختبارات تحرسها.
 * السيناريو ٣: تحويل الأرقام العربية مكتوبٌ في سبعة مواضع، وبعضها لا يحوّل الفارسية.
 * الصحيح: creditNotePreview في الدومين بالحساب نفسه تناديه الورقة، وpayPurchase غلافٌ على payPurchaseSplit، وtoLatinDigits واحدة.
 * بيانات مصطنعة.
 */
import fs from 'fs';
import path from 'path';
import { memDb } from './helpers/testDb';
import { saveInvoice, saveCreditNote, creditNotePreview, type InvoiceInput } from '@/domain/invoices';

const ROOT = path.resolve(__dirname, '..');
const read = (...p: string[]) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

const mixed = (): InvoiceInput => ({
  customer: 'عميل مصطنع', customerVat: '', issue: '2026-02-10', due: '2026-03-10', notes: '',
  lines: [
    { descr: 'خدمة خاضعة مصطنعة', qty: 1, priceHalalas: 333, taxPct: 15, taxCode: 'S' },
    { descr: 'إيجار سكني مصطنع', qty: 1, priceHalalas: 667, taxPct: 0, taxCode: 'E' },
  ],
});

test('G-11 معاينة ضريبة الإشعار تساوي المحفوظ في مسحٍ للمبالغ', () => {
  const diffs: string[] = [];
  for (const sub of [1, 2, 3, 7, 10, 33, 50, 99, 100, 250, 333, 500, 667, 999, 1000]) {
    const db = memDb();
    const id = saveInvoice(db, mixed(), 'مستحقة');
    const p = creditNotePreview(db, id, sub);
    expect(p).not.toBeNull();
    const cn = saveCreditNote(db, id, { date: '2026-02-20', reason: 'تصحيح مصطنع', subtotalHalalas: sub });
    const saved = Math.abs(Number(db.get<{ t: number }>(`SELECT tax_halalas AS t FROM invoices WHERE id = ?`, [cn])!.t));
    if (p!.tax !== saved) diffs.push(`${sub}: المعروض ${p!.tax} والمحفوظ ${saved}`);
    db.close();
  }
  expect(diffs).toEqual([]);
});

test('G-11 الورقة تعرض المعاينة من الدومين لا حساباً خاصاً بها', () => {
  const src = read('app', 'invoices.tsx');
  expect(src).not.toMatch(/creditTaxFor\(/);
  expect(src).toMatch(/creditNotePreview\(db, invoiceId, sub\)/);
});

test('G-11 payPurchase غلافٌ على payPurchaseSplit', () => {
  const src = read('src', 'domain', 'purchases.ts');
  const start = src.indexOf('export function payPurchase(');
  const body = src.slice(start, src.indexOf('\n}\n', start));
  expect(body).toMatch(/return payPurchaseSplit\(/);
  expect(body).not.toMatch(/db\.run\(|INSERT INTO/);
});

test('G-11 محوّل الأرقام واحد: لا تحويلٌ مكتوبٌ بيده خارج money.ts', () => {
  const files = ['src/chat/store.ts', 'src/domain/access/profile.ts', 'src/domain/zatcaQr.ts', 'src/domain/phone.ts',
    'src/domain/backup/recoveryKey.ts', 'src/domain/pdf/ejarExtras.ts'];
  for (const f of files) {
    const src = read(...f.split('/'));
    // التحويل نفسه: طرح بداية مدى الأرقام من رمز المحرف، أو قناعه، أو جدول الأرقام · لا مدى الحروف في التحقق من الاسم
    expect([f, /charCodeAt\(0\)\s*(?:-\s*0x0?6[6fF]0\b|&\s*0xf)|'٠١٢٣٤٥٦٧٨٩'/.test(src)]).toEqual([f, false]);
  }
});
