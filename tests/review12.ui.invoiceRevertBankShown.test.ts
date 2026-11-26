/**
 * المدقق المستقل للمرحلة ١ · الواجهة (ui) · A2.2 (بلا مدققٍ خاص) · app/invoices.tsx:441-466 مع src/domain/invoices.ts:268
 *
 * السيناريو (أرقام ذهبية · بيانات مصطنعة): بنك «أ» افتتاحيه صفر. فاتورة مبيعات ١٬٠٠٠٫٠٠ + ضريبة ١٥٪ = ١٬١٥٠٫٠٠ (١١٥٬٠٠٠ هللة)
 * تُحصَّل تحويلاً إلى «أ»، ثم يُحوَّل ١٬١٥٠٫٠٠ من «أ» إلى «ب» فيصير «أ» صفراً. يفتح المالك «تغيير حالة الفاتورة».
 *  - الورقة تُخفي خيارات الرجوع عن «مدفوعة» حين لا يكفي **النقد** وحده (cashShortfall(collectionCashOut) · وهو صفرٌ للتحصيل البنكي)،
 *    فيظهر «مستحقة · يعكس قيد التحصيل» و«متأخرة · يعكس قيد التحصيل».
 *  - يضغطه فيرفضه A2.2 بعد الضغط (requireBanksCover): «تعذّر تغيير الحالة · رصيد بنك أ … لا يكفي».
 * وقاعدة المالك في الواجهة (سجل القرارات 2026-09-09): الزر الذي لا يصح لا يظهر وسببه ظاهر · وهو ما تفعله الورقة نفسها للنقد
 * (CashShortNote وإخفاء الخيار)، ولوحتا إلغاء الدفعة وإلغاء التقبيل للبنك (مانعٌ ظاهر بلا زر) · فالفاتورة وحدها تَعرض ثم ترفض.
 *
 * السلوك الصحيح: ما يرفضه A2.2 لا يُعرض في ورقة الحالة: يُفحص البنك كما يُفحص النقد، ويظهر السبب مكان الخيار.
 */
import fs from 'fs';
import path from 'path';
import { memDb } from './helpers/testDb';
import { addBank } from './helpers/fixtures';
import { saveInvoice, payInvoice, setInvoiceStatus, collectionCashOut } from '@/domain/invoices';
import { bankBalance } from '@/domain/accounting/ledger';
import { transferBetweenBanks } from '@/domain/cashOps';
import { cashShortfall } from '@/domain/cashGuard';

test('A2.2 ورقة «تغيير حالة الفاتورة» تعرض الرجوع عن تحصيلٍ بنكي لا يكفيه البنك ثم يُرفض', () => {
  const db = memDb();
  const a = addBank(db, 'بنك مصطنع أ ui-12', 0);
  const b = addBank(db, 'بنك مصطنع ب ui-12', 0);
  const id = saveInvoice(db, {
    customer: 'عميل مصطنع ui-12', customerVat: '', issue: '2026-10-01', due: '2026-10-30', notes: '',
    lines: [{ descr: 'خدمة مصطنعة', qty: 1, priceHalalas: 100000, taxPct: 15 }],
  }, 'مستحقة');
  payInvoice(db, id, { method: 'bank', bankId: a, date: '2026-10-05' });
  expect(bankBalance(db, a)).toBe(115000);
  transferBetweenBanks(db, { fromBankId: a, toBankId: b, amountHalalas: 115000, date: '2026-10-06' });
  expect(bankBalance(db, a)).toBe(0);

  // بوابة الورقة اليوم: النقد وحده · صفرٌ يُعكس من المحفظة فلا نقص، فيُعرض الخيار
  expect(cashShortfall(db, collectionCashOut(db, id))).toBe(0);
  // والضغط عليه يُرفض بعده (A2.2)
  expect(() => setInvoiceStatus(db, id, 'مستحقة')).toThrow();
  expect(bankBalance(db, a)).toBe(0);

  // ورقة الحالة لا تفحص البنك قبل عرض الخيار
  const src = fs.readFileSync(path.resolve(__dirname, '..', 'app', 'invoices.tsx'), 'utf8');
  const i = src.indexOf('title="تغيير حالة الفاتورة"');
  expect(i).toBeGreaterThan(0);
  const sheet = src.slice(i, src.indexOf('</Sheet>', i));
  expect(sheet).toMatch(/bank\w*Short|Short\w*Bank|bankShortages|requireBanksCover|revert\w*Block|status\w*Block/i);
  db.close();
});
