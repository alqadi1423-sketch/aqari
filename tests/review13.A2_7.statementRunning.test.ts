/**
 * A2.7 · متوسط · app/accounts.tsx (stmtCarry والجاري) · app/reports.tsx (كشف الحساب من الميزان)
 *
 * السيناريو (بيانات مصطنعة): افتتاحي 1100 = ١٠٬٠٠٠٫٠٠ وقبضٌ ٢٬٠٠٠٫٠٠: الصف في دليل الحسابات «الختامي ١٢٬٠٠٠٫٠٠» وآخر «الجاري»
 * في كشفه كان ٢٬٠٠٠٫٠٠ (يبدأ من صفر ويهمل الافتتاحي) · وحساب خصوم (2400) قُبض فيه تأمين ٢٬٠٠٠٫٠٠: الختامي ٢٬٠٠٠٫٠٠ والجاري كان
 * −٢٬٠٠٠٫٠٠ (مدين ناقص دائن لكل الأنواع) · وبفترة «هذا الشهر» كان «الافتتاحي» المزروع لا رصيد أول الشهر، و«الختامي» رصيد كل الزمن.
 * السلوك الصحيح (قرار 2026-08-22: الافتتاحي · المدين · الدائن · الختامي · وكشف حركته): سطرٌ أول «رصيد منقول» = الافتتاحي + حركة ما
 * قبل بداية الفترة، والجمع باتجاه طبيعة الحساب، و«الختامي» رصيد نهاية الفترة · فآخر «جاري» يساوي «الختامي» في الصف نفسه.
 */
import { memDb } from './helpers/testDb';
import { saveAccount } from '@/domain/accounting/chart';
import { ownerCashIn } from '@/domain/cashOps';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { confirmContract } from '@/domain/contracts/service';
import { accountStatement, accountPeriodBalances } from '@/domain/accounting/ledger';
import { integrityChecks } from '@/domain/accounting/integrity';

const last = <T,>(a: T[]) => a[a.length - 1];

test('A2.7 الجاري يبدأ من الافتتاحي ويجمع بطبيعة الحساب · وآخره يساوي الختامي', () => {
  const db = memDb();
  saveAccount(db, { code: '1100', name: 'النقدية والبنوك', type: 'أصل', openingHalalas: 1000000 }, '1100');
  saveAccount(db, { code: '3100', name: 'رأس المال', type: 'حقوق ملكية', openingHalalas: 1000000 }, '3100');
  ownerCashIn(db, { amountHalalas: 200000, date: '2026-06-10' });
  // تأمين مقبوض ٢٬٠٠٠٫٠٠ على 2400 (خصوم) بعقدٍ مصطنع
  const u = addUnit(db, addProperty(db, { name: 'عقار كشف مصطنع' }), { unit_no: 'K-1' });
  confirmContract(db, contractInput(u, { tenant: 'مستأجر كشف مصطنع', idNumber: '1000000271', phone: '0500000271',
    valueHalalas: 1200000, cycle: 'سنوية', start: '2026-06-12', end: '2027-06-11', depositHalalas: 200000 }));
  const deposit = db.get<{ d: string }>(`SELECT e.date AS d FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id WHERE l.account_code = '2400'`)!.d;

  const s1100 = accountStatement(db, '1100', null, null);
  expect(s1100.carried).toBe(1000000);
  expect(s1100.lines.map((l) => [l.date, l.running])).toEqual([['2026-06-10', 1200000], [deposit, 1400000]]);
  const all = accountPeriodBalances(db, null, null);
  expect(all.get('1100')).toEqual({ opening: 1000000, debit: 400000, credit: 0, closing: 1400000 });
  expect(last(s1100.lines).running).toBe(all.get('1100')!.closing);

  const s2400 = accountStatement(db, '2400', null, null);
  expect(s2400.lines.map((l) => l.running)).toEqual([200000]);
  expect(all.get('2400')!.closing).toBe(200000);
  expect(s2400.closing).toBe(200000);
  expect(integrityChecks(db).filter((c) => !c.ok).map((c) => c.name)).toEqual([]);
  db.close();
});

test('A2.7 فترة «هذا الشهر»: المنقول رصيد أول الشهر والختامي رصيد آخره · وما بعده لا يدخل · والصفحة الثانية تبدأ مما قبلها', () => {
  const db = memDb();
  saveAccount(db, { code: '1100', name: 'النقدية والبنوك', type: 'أصل', openingHalalas: 1000000 }, '1100');
  ownerCashIn(db, { amountHalalas: 50000, date: '2026-05-20' });   // قبل الفترة
  ownerCashIn(db, { amountHalalas: 200000, date: '2026-06-03' });  // في الفترة
  ownerCashIn(db, { amountHalalas: 30000, date: '2026-06-25' });   // في الفترة
  ownerCashIn(db, { amountHalalas: 10000, date: '2026-07-02' });   // بعدها
  const from = '2026-06-01', to = '2026-06-30';
  const s = accountStatement(db, '1100', from, to);
  // المنقول = ١٠٬٠٠٠٫٠٠ + ٥٠٠٫٠٠ = ١٬٠٥٠٬٠٠٠ هللة · الختامي = + ٢٬٠٠٠٫٠٠ + ٣٠٠٫٠٠ = ١٬٢٨٠٬٠٠٠
  expect([s.opening, s.carried, s.closing, s.total]).toEqual([1050000, 1050000, 1280000, 2]);
  expect(s.lines.map((l) => l.running)).toEqual([1250000, 1280000]);
  expect(accountPeriodBalances(db, from, to).get('1100')).toEqual({ opening: 1050000, debit: 230000, credit: 0, closing: 1280000 });
  // حقوق الملكية دائنة بطبيعتها: 3100 يزيد بالإيداع
  expect(accountStatement(db, '3100', from, to).lines.map((l) => l.running)).toEqual([250000, 280000]);
  // الصفحة الثانية (سطرٌ واحد بعد الأول): منقولها ما قبلها
  const p2 = accountStatement(db, '1100', from, to, { limit: 1, offset: 1 });
  expect([p2.carried, p2.lines.length, p2.lines[0].running]).toEqual([1250000, 1, 1280000]);
  db.close();
});
