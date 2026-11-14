/**
 * المدقق G2 · الجولة السابعة عشرة · على 3f2c136 · حفظ كشفٍ يُطبع فيه الرصيد آخر اليوم وحده بعد قراءةٍ أخرى لإحدى حوالتيه: الحفظ يعدّ
 * الحوالة الأخرى مكرَّرةً فلا يُنشئ سطرها أبداً · بياناتٌ مصطنعة كلها.
 *   TZ=Asia/Riyadh npx jest tests/d4.auditG2.freshDayEnd.test.ts
 *
 * G2-1 · عالٍ · src/domain/bankStatement/dedupe.ts:117-136 (freshLines: ذو الرصيد «مكرَّرٌ إن … بقي للقاعدة سطرٌ بلا رصيدٍ لم يُطابَق»
 * والسطر بلا رصيد «#n» مكرَّرٌ ما لم تتجاوز n عدد المحفوظ كله e.all · وما عُدّ مكرَّراً من الملف لا يحجز ما طابقه من المحفوظ، فيُطابَق
 * السطر المحفوظ الواحد بسطرين من الملف) مع src/domain/bankStatement/store.ts:36-41 (saveStatement يحفظ ما عدّه freshLines جديداً وحده):
 * كشف أكتوبر بالشكل الذي يُطبع فيه الرصيد آخر اليوم وحده (E2-1أ: القارئ يقبله سليماً متحقَّقاً): يوم 1 أكتوبر حوالة ماجد «#1» بلا رصيد
 * ثم حوالة سالم «@600000» برصيد اليوم، ورسم رسائل · ويُحفظ بعد قراءةٍ أخرى لإحدى الحوالتين:
 *  أ) تصديرٌ بلا رصيدٍ أُخذ صباح 1 أكتوبر فيه حوالة ماجد وحدها «#1» (كما في E2-1ج) · freshLines يعدّ «#1» من الكشف حوالة ماجد المحفوظة
 *     (صحيح)، ثم يعدّ «@600000» السطرَ بلا رصيدٍ نفسه مرةً ثانية (claimed < noBal) فيتخطّاه: «أُضيف 1، تُخطّي 2»، وحوالة سالم لا سطر
 *     لها، وتقرير أكتوبر بفرقٍ «غير مفسَّر» 2,500 لا يدلّ على سطر.
 *  ب) صورة الصفحة الثانية من كشف PDF (تبدأ في منتصف اليوم بحوالة سالم برصيدها «@600000» · D2-1) · freshLines يعدّ «@600000» من الكشف
 *     المحفوظَ برصيده (صحيح)، ثم «#1» لا يتجاوز عدد المحفوظ (1) فيعدّه إياه أيضاً: حوالة ماجد لا سطر لها.
 * والكشف نفسه يقول إن في القاعدة حركتين («#1» و«@600000» من كشفٍ واحد · E2-1)، وسجل القرارات ٦٥(١): «عدد الإيداعات في اليوم بالمبلغ
 * نفسه أكبرُ عددٍ لها في كشفٍ واحد» · فالحفظ يخالف القاعدة التي تحكم بها المزامنة (keepInOrder بـ statementsNeed)، ولا تصلحه المزامنة:
 * statementCascade يحيي سطراً محذوفاً ولا ينشئ ما لم يُحفظ قط (جُرّب).
 * لماذا يهم: الشكلان مدعومان وشائعان (التصدير اليومي بلا رصيد، والرصيد آخر اليوم، وصورة الصفحة)، وأول الشهر حوالاتٌ كثيرة بالإيجار نفسه:
 * إيداعٌ حقيقي لا يظهر في الكشف على أي جهاز، فلا يُقترح له تحصيل ويبقى المستأجر مطالَباً بما دفع، والتقرير بفرقٍ لا يُعرف سببه · ولا
 * علاج من الشاشة: الملف نفسه يُرفض «قُرئ من قبل» (وجهاز آخر يقرؤه يتخطّاه كذلك).
 * السلوك الصحيح: سطور الكشف الواحد التي تعدّها قاعدةٌ واحدة حركتين لا تُطابَق بسطرٍ محفوظٍ واحد مرتين: بعد حفظ القراءتين الحوالتان حيّتان
 * ورسم الرسائل، وتقرير أكتوبر بلا فرقٍ غير مفسَّر.
 */
import { memDb } from './helpers/testDb';
import { addBank } from './helpers/fixtures';
import { readStatementFile, type StatementResult } from '@/domain/bankStatement/read';
import { readStatementPhoto, type OcrLine } from '@/domain/bankStatement/photo';
import { saveStatement, reconciliation } from '@/domain/bankStatement/store';
import type { DB } from '@/db/adapter';

const ok = (r: StatementResult) => { if (!r.ok) throw new Error('لم يُقرأ: ' + r.error); return r; }; // i18n-exempt: رسالة اختبار
/** كشف أكتوبر: الرصيد يُطبع آخر كل يوم وحده (سطر ماجد بلا رصيد، وسطر سالم برصيد اليوم) كما في tests/d4.auditE2.dayEndBalance.test.ts */
const dayEnd = () => ok(readStatementFile({ name: 'oct.csv', bytes: new TextEncoder().encode([
  'Date,Description,Debit,Credit,Balance',
  '30/09/2026,Opening Balance,,,1000.00',
  '01/10/2026,TRANSFER MAJED,,2500.00,',
  '01/10/2026,TRANSFER SALEM,,2500.00,6000.00',
  '02/10/2026,SMS CHARGES,5.00,,5995.00',
].join('\n')) }));
const live = (db: DB, bank: string) => db.all<{ d: string }>(
  `SELECT descr AS d FROM bank_statement_lines WHERE bank_id = ? AND deleted_at IS NULL ORDER BY date, descr`, [bank]).map((x) => x.d);

describe('G2-1 · [عالٍ] freshLines يطابق السطر المحفوظ الواحد بسطرين من الكشف (dedupe.ts:117-136)', () => {
  test('أ) تصدير الصباح بلا رصيد (حوالة ماجد) ثم كشف الشهر برصيد آخر اليوم: حوالة سالم تُحفظ، والتقرير بلا فرقٍ غير مفسَّر', () => {
    const db = memDb();
    const bank = addBank(db, 'بنك مصطنع G2-1أ', 100000);
    const morning = ok(readStatementFile({ name: 'today.csv', bytes: new TextEncoder().encode([
      'Date,Description,Debit,Credit', '01/10/2026,TRANSFER MAJED,,2500.00'].join('\n')) }, { opening: 100000, closing: 350000 }));
    expect(morning.lines.map((l) => [l.descr, l.balance])).toEqual([['TRANSFER MAJED', null]]);
    saveStatement(db, bank, morning, { name: 'today-g2-1a.csv', hash: 'g2-1a-today' });

    // الكشف سليمٌ متحقَّق: ماجد بلا رصيد، وسالم برصيد اليوم
    const st = dayEnd();
    expect({ lines: st.lines.map((l) => [l.descr, l.balance]), warnings: st.warnings })
      .toEqual({ lines: [['TRANSFER MAJED', null], ['TRANSFER SALEM', 600000], ['SMS CHARGES', 599500]], warnings: [] });
    const saved = saveStatement(db, bank, st, { name: 'oct-g2-1a.csv', hash: 'g2-1a-oct' });

    // (الواقع: { added: 1, skipped: 2 } والسطور ['TRANSFER MAJED', 'SMS CHARGES'] والفرق غير المفسَّر 250,000 هللة)
    expect({ saved: { added: saved.added, skipped: saved.skipped }, live: live(db, bank), unexplained: reconciliation(db, bank, '2026-10').unexplained })
      .toEqual({ saved: { added: 2, skipped: 1 }, live: ['TRANSFER MAJED', 'TRANSFER SALEM', 'SMS CHARGES'], unexplained: 0 });
    db.close();
  });

  test('ب) صورة الصفحة الثانية (تبدأ بحوالة سالم برصيدها) ثم كشف الشهر برصيد آخر اليوم: حوالة ماجد تُحفظ', () => {
    const db = memDb();
    const bank = addBank(db, 'بنك مصطنع G2-1ب', 100000);
    // صورة الصفحة الثانية بأرصدتها (سطرٌ بعرضه من طول نصه كما في tests/d4.auditC2.mt940Twins.test.ts)
    const ln = (text: string, left: number, top: number): OcrLine => ({ text, left, top, width: text.length * 10, height: 20 });
    const page2 = ok(readStatementPhoto([
      ln('Date Description Debit Credit Balance', 40, 60),
      ln('Opening Balance', 40, 80), ln('3,500.00', 880, 80),
      ln('01/10/2026', 40, 100), ln('TRANSFER SALEM', 200, 100), ln('2,500.00', 720, 100), ln('6,000.00', 880, 100),
      ln('Closing Balance', 40, 140), ln('6,000.00', 880, 140),
      ln('Page 2 of 2', 40, 220),
    ]));
    expect(page2.lines.map((l) => [l.date, l.amount, l.balance])).toEqual([['2026-10-01', 250000, 600000]]);
    saveStatement(db, bank, page2, { name: 'oct-g2-1b-p2.jpg', hash: 'g2-1b-p2' });

    const saved = saveStatement(db, bank, dayEnd(), { name: 'oct-g2-1b.csv', hash: 'g2-1b-oct' });

    // (الواقع: { added: 1, skipped: 2 } والسطور حوالة سالم (من الصورة) ورسم الرسائل وحدهما: حوالة ماجد لم تُحفظ)
    expect({ saved: { added: saved.added, skipped: saved.skipped }, live: live(db, bank).length, majed: live(db, bank).includes('TRANSFER MAJED') })
      .toEqual({ saved: { added: 2, skipped: 1 }, live: 3, majed: true });
    db.close();
  });
});
