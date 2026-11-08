/**
 * المدقق F2 · الجولة السادسة عشرة · على 50556c3 · خط زمن تقرير المطابقة بعد إصلاح D2-1 يضع افتتاحي كشفٍ بلا أرصدةٍ مطبوعة (MT940، أو
 * CSV بلا عمود رصيد) بعد سطور يومه الأول إن جاء بعد فجوة، فيُمحى أثر تلك السطور من ختامي الشهر · بياناتٌ مصطنعة كلها.
 *   TZ=Asia/Riyadh npx jest tests/d4.auditF2.mt940Gap.test.ts
 *
 * F2-1 · عالٍ · src/domain/bankStatement/store.ts:262-274 (في اليوم الواحد: الافتتاحي يؤخذ إن ساوى الجاري، أو إن تسلسل منه سطرٌ برصيده،
 * وإلا يؤخذ قبله سطرٌ بلا رصيد «ls.findIndex(l.balance == null)»، والافتتاحي آخر اليوم «!ls.length») ثم store.ts:286-290 (الافتتاحي يعيد
 * الجاري إلى قيمته): كشف MT940 فترته من تاريخ أول سطرٍ فيه (read.ts:535)، فافتتاحيه وأول سطوره في يومٍ واحد دائماً، وسطوره بلا رصيد ·
 * كشف أغسطس (افتتاحي 0 وإيداع 1,000 يوم 5) ثم كشف أكتوبر (افتتاحي 1,500 وإيداع 200 يوم 1 أكتوبر) وكشف سبتمبر لم يُقرأ (فجوة):
 * الجاري يوم 1 أكتوبر 1,000 لا يساوي 1,500، ولا سطر برصيدٍ يتسلسل منه، فيؤخذ إيداع 1 أكتوبر قبل افتتاحي كشفه (1,200) ثم الافتتاحي
 * (1,500) فيمحو الإيداع · فتقرير أكتوبر: افتتاحي الكشف 1,000 (ختامي أغسطس) وختاميه 1,500 بدل 1,700، و«غير مفسَّر» 300 والدفاتر توافق
 * البنك تماماً، والفجوة «بعد 1 أكتوبر بختامي 1,200» بدل «بعد 5 أغسطس بختامي 1,000» · وقبل إصلاح D2-1 (f5036b1) كان الافتتاحي قبل سطور
 * يومه فيصح هذا التقرير: هو تراجعٌ جاء به إصلاح الجولة الخامسة عشرة.
 * لماذا يهم: MT940 صيغة المنشآت (DESIGN §١٣.٢٢)، والكشف الناقص شهراً هو ما يُراد للتقرير كشفه؛ فيقول التقرير إن في أكتوبر فرقاً «غير
 * مفسَّر» ولا فرق، ويخطئ في الختامي وفي موضع الفجوة وقدرها · وكذلك كل كشفٍ بلا عمود رصيد يبدأ سطره الأول في أول يوم فترته بعد فجوة.
 * السلوك الصحيح: افتتاحي الكشف قبل سطوره هو (U15 · DESIGN «افتتاحي الشهر افتتاحي أول كشفٍ يبدأ فيه … ولو بعد فجوة»): تقرير أكتوبر افتتاحيه
 * 1,500 وختاميه 1,700، وغير المفسَّر صفر، والفجوة واحدة بعد 5 أغسطس (1,000 ← 1,500) · كما يعطيه الكشفان نفساهما بعمود رصيد (الضابط).
 */
import { memDb } from './helpers/testDb';
import { addBank } from './helpers/fixtures';
import { depositCashToBank, ownerCashIn } from '@/domain/cashOps';
import { readStatementFile, readStatementGrid, type StatementResult } from '@/domain/bankStatement/read';
import { saveStatement, matchSuggestions, approveMatch, reconciliation } from '@/domain/bankStatement/store';

const bytes = (s: string) => new Uint8Array(Buffer.from(s, 'utf8'));
const ok = (r: StatementResult) => { if (!r.ok) throw new Error('لم يُقرأ: ' + r.error); return r; }; // i18n-exempt: رسالة اختبار

const AUG_940 = [':20:F2-1-AUG', ':25:SYNTH-F2-1', ':28C:8', ':60F:C260801SAR0,00',
  ':61:2608050805C1000,00NTRF//F2A1', ':86:ايداع اغسطس مصطنع', ':62F:C260831SAR1000,00'].join('\n');
const OCT_940 = [':20:F2-1-OCT', ':25:SYNTH-F2-1', ':28C:10', ':60F:C261001SAR1500,00',
  ':61:2610011001C200,00NTRF//F2O1', ':86:ايداع اكتوبر مصطنع', ':62F:C261031SAR1700,00'].join('\n');

const HEAD = ['التاريخ', 'البيان', 'مدين', 'دائن', 'الرصيد'];
const AUG_CSV = [['الفترة من 05/08/2026 إلى 31/08/2026'], ['الرصيد الافتتاحي', '0.00'], HEAD, ['2026/08/05', 'ايداع اغسطس مصطنع', '', '1,000.00', '1,000.00']];
const OCT_CSV = [['الفترة من 01/10/2026 إلى 31/10/2026'], ['الرصيد الافتتاحي', '1,500.00'], HEAD, ['2026/10/01', 'ايداع اكتوبر مصطنع', '', '200.00', '1,700.00']];

function octoberReport(kind: 'mt940' | 'balances') {
  const db = memDb();
  const bank = addBank(db, 'بنك مصطنع F2-1', 0);
  ownerCashIn(db, { amountHalalas: 5000000, date: '2026-07-01' });
  // الدفاتر توافق البنك تماماً: أغسطس 1,000 وسبتمبر 500 (لا كشف له) وأكتوبر 200
  depositCashToBank(db, { bankId: bank, amountHalalas: 100000, date: '2026-08-05', notes: 'ايداع اغسطس مصطنع' });
  depositCashToBank(db, { bankId: bank, amountHalalas: 50000, date: '2026-09-10', notes: 'ايداع سبتمبر مصطنع' });
  depositCashToBank(db, { bankId: bank, amountHalalas: 20000, date: '2026-10-01', notes: 'ايداع اكتوبر مصطنع' });
  if (kind === 'mt940') {
    saveStatement(db, bank, ok(readStatementFile({ name: 'aug.sta', bytes: bytes(AUG_940) })), { name: 'aug.sta', hash: 'f2-1-aug' });
    saveStatement(db, bank, ok(readStatementFile({ name: 'oct.sta', bytes: bytes(OCT_940) })), { name: 'oct.sta', hash: 'f2-1-oct' });
  } else {
    saveStatement(db, bank, ok(readStatementGrid(AUG_CSV)), { name: 'aug.csv', hash: 'f2-1-aug-csv' });
    saveStatement(db, bank, ok(readStatementGrid(OCT_CSV)), { name: 'oct.csv', hash: 'f2-1-oct-csv' });
  }
  for (const s of matchSuggestions(db, bank)) approveMatch(db, s.line.id, s.tx.id);
  const rep = reconciliation(db, bank, '2026-10');
  db.close();
  return { opening: rep.statementOpening, closing: rep.statementClosing, gaps: rep.gaps, unexplained: rep.unexplained, matched: rep.matched };
}

const want = {
  opening: 150000, closing: 170000, gaps: [{ after: '2026-08-05', closing: 100000, nextOpening: 150000 }], unexplained: 0, matched: 1,
};

describe('F2-1 · [عالٍ] افتتاحي كشفٍ بلا أرصدة بعد فجوة يوضع بعد سطور يومه فيمحوها: ختامي خاطئ و«غير مفسَّر» كاذب (store.ts:262-274)', () => {
  test('الضابط: الكشفان نفساهما بعمود رصيد يعطيان التقرير الصحيح', () => {
    expect(octoberReport('balances')).toEqual(want);
  });

  test('الكشفان MT940: افتتاحي أكتوبر 1,500 وختاميه 1,700، والفجوة بعد 5 أغسطس، ولا فرق غير مفسَّر', () => {
    // (الواقع: { opening: 100000, closing: 150000, gaps: [{ after: '2026-10-01', closing: 120000, nextOpening: 150000 }], unexplained: 30000, matched: 1 })
    expect(octoberReport('mt940')).toEqual(want);
  });
});
