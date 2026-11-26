/**
 * R12-UI-2 (المراجعة ١٢ · الواجهة) · سبب إخفاء الرجوع عن «مدفوعة» حين لا يكفي البنك
 *
 * ورقة «تغيير حالة الفاتورة» تُخفي «مستحقة · يعكس قيد التحصيل» و«متأخرة · …» متى كان عكس التحصيل يُنزل بنكاً تحت الصفر (قرار ٥٥)،
 * وتعرض مكانها السبب باسم البنك ورصيده والمبلغ (قاعدة المالك 2026-08-24: الزر الذي لا يصح لا يظهر وسببه ظاهر). مصدر الورقة
 * `collectionBankShortages` · وهذا الاختبار يثبت أنه يطابق ما يرفضه `setInvoiceStatus` بعد الضغط: سطرٌ برصيد البنك ما دام لا يكفي،
 * ولا شيء متى كفى فيصح العكس.
 *
 * أرقام ذهبية · بيانات مصطنعة: فاتورة ١٬٠٠٠٫٠٠ + ضريبة ١٥٪ = ١٬١٥٠٫٠٠ (١١٥٬٠٠٠ هللة).
 */
import fs from 'fs';
import path from 'path';
import { memDb } from './helpers/testDb';
import { addBank } from './helpers/fixtures';
import { saveInvoice, payInvoice, setInvoiceStatus, collectionBankShortages } from '@/domain/invoices';
import { bankBalance } from '@/domain/accounting/ledger';
import { transferBetweenBanks } from '@/domain/cashOps';
import { fmt } from '@/domain/money';
import { t } from '@/i18n';

const invoice = (db: ReturnType<typeof memDb>, customer: string) => saveInvoice(db, {
  customer, customerVat: '', issue: '2026-10-01', due: '2026-10-30', notes: '',
  lines: [{ descr: 'خدمة مصطنعة', qty: 1, priceHalalas: 100000, taxPct: 15 }],
}, 'مستحقة');

test('R12-UI-2 سبب الإخفاء يطابق رفض A2.2: يُسمّى البنك ورصيده والمبلغ ما دام لا يكفي، ولا سبب متى كفى', () => {
  const db = memDb();
  const a = addBank(db, 'بنك مصطنع أ ui-12ج', 0);
  const b = addBank(db, 'بنك مصطنع ب ui-12ج', 0);
  const id = invoice(db, 'عميل مصطنع ui-12ج');
  // لم تُحصَّل بعد: لا عكس فلا مانع
  expect(collectionBankShortages(db, id)).toEqual([]);

  payInvoice(db, id, { method: 'bank', bankId: a, date: '2026-10-05' });
  expect(bankBalance(db, a)).toBe(115000); // 0 + 115000
  // البنك يكفي ما يُخرجه العكس (١١٥٬٠٠٠ من ١١٥٬٠٠٠)
  expect(collectionBankShortages(db, id)).toEqual([]);

  transferBetweenBanks(db, { fromBankId: a, toBankId: b, amountHalalas: 115000, date: '2026-10-06' });
  expect(bankBalance(db, a)).toBe(0); // 115000 − 115000
  const short = collectionBankShortages(db, id);
  expect(short).toEqual([t('bankTx.bankShort', { bank: 'بنك مصطنع أ ui-12ج', balance: fmt(0), amount: fmt(115000) })]);
  expect(short[0]).toContain('1,150.00');
  // وهو ما يرفضه الضغط بعينه
  expect(() => setInvoiceStatus(db, id, 'مستحقة')).toThrow(short[0]);

  // يعود بعضه: ١٠٠٬٠٠٠ < ١١٥٬٠٠٠ فما زال لا يكفي، والرصيد في السبب ١٬٠٠٠٫٠٠
  transferBetweenBanks(db, { fromBankId: b, toBankId: a, amountHalalas: 100000, date: '2026-10-07' });
  expect(collectionBankShortages(db, id)).toEqual([t('bankTx.bankShort', { bank: 'بنك مصطنع أ ui-12ج', balance: fmt(100000), amount: fmt(115000) })]);
  // ويعود الباقي ١٥٬٠٠٠: ١١٥٬٠٠٠ يكفي فلا سبب، ويصح العكس فيصير البنك صفراً
  transferBetweenBanks(db, { fromBankId: b, toBankId: a, amountHalalas: 15000, date: '2026-10-08' });
  expect(collectionBankShortages(db, id)).toEqual([]);
  setInvoiceStatus(db, id, 'مستحقة');
  expect(bankBalance(db, a)).toBe(0); // 115000 − 115000
  db.close();
});

test('R12-UI-2 التحصيل النقدي لا مانع بنكي له', () => {
  const db = memDb();
  const id = invoice(db, 'عميل مصطنع نقداً ui-12ج');
  payInvoice(db, id, { method: 'cash', bankId: null, date: '2026-10-05' });
  expect(collectionBankShortages(db, id)).toEqual([]);
  db.close();
});

test('R12-UI-2 ورقة الحالة تُخفي خيارات الرجوع وتعرض السبب حين لا يكفي البنك', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '..', 'app', 'invoices.tsx'), 'utf8');
  const i = src.indexOf('title="تغيير حالة الفاتورة"');
  const sheet = src.slice(i, src.indexOf('</Sheet>', i));
  // السبب ظاهر بنصه
  expect(sheet).toContain("t('invoice.revertBankShort'");
  // ومرشّح الخيارات يفحص البنك مع النقد
  expect(sheet).toMatch(/\.filter\([^\n]*revertBankShort\.length/);
});
