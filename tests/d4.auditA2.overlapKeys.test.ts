/**
 * المدقق A2 · الجولة الرابعة عشرة · على 52f19cb · لاحقة الرصيد في بصمة السطر (إصلاح Z1-2) مع رقم التكرار «في الكشف نفسه» تُكرّر حركةً بين
 * كشفين متداخلين · بياناتٌ مصطنعة كلها.
 *   TZ=Asia/Riyadh npx jest tests/d4.auditA2.overlapKeys.test.ts
 *
 * A2-5 · عالٍ · src/domain/bankStatement/dedupe.ts:24-29 (البصمة fnv(البنك|اليوم|المبلغ#رقم التكرار في الملف)@الرصيد) وdedupe.ts:36-41
 * (sameLineKey وSAME_KEY_SQL: القاعدة نفسها وحدها) مع src/domain/bankStatement/store.ts:37-42 (منع التكرار عند الحفظ): ثلاث حوالاتٍ
 * بالإيجار نفسه (2,500) يوم 1 أكتوبر — ماجد وسالم وفهد — أرصدتها 2,500 و5,000 و7,500 · في كشف الشهر الكامل رقم تكرار فهد #3، وفي صورة
 * الصفحة الثانية (تبدأ بفهد) #1 · فبصمتاه «#3@7500» و«#1@7500» قاعدتاهما مختلفتان فلا تُعدّان السطر نفسه، ولا يُنظر إلى أن الرصيد واحد ·
 * وقبل 52f19cb كانت الصفحة بعد الكشف الكامل تُتخطّى كلها («لا جديد»):
 *  أ) كشف الشهر (CSV بأرصدته) ثم صورة الصفحة الثانية: تُحفظ حوالة فهد مرةً ثانية.
 *  ب) صورتا الصفحتين ثم كشف الشهر MT940 (بلا أرصدة): «#3» لا قاعدة له محفوظة فتُحفظ حوالة فهد مرةً ثانية.
 * فيصير في الكشف 7,500 وارداً في يومٍ فيه 5,000 + 2,500 فقط، وتقرير أكتوبر بفرقٍ «غير مفسَّر» −2,500، والسطر المكرر مفتوحٌ يُقترح تحصيلاً
 * لقسطٍ آخر.
 * لماذا يهم: صفحات الصور وكشف الشهر وMT940 للفترة نفسها مسارٌ عادي (DESIGN §١٣.٢٢: «الكشفان المتداخلان لا يضيفان السطر نفسه»)، وأول
 * الشهر حوالاتٌ كثيرة بالإيجار نفسه في اليوم نفسه: إيداعٌ وهميٌّ يُعتمد تحصيلاً لمستأجرٍ لم يدفع.
 * السلوك الصحيح: السطر نفسه (البنك واليوم والمبلغ والرصيد المطبوع، أو بلا رصيدٍ بموضعه) لا يُحفظ مرتين أياً كان رقم تكراره في ملفه:
 * أربع حركاتٍ محفوظة (ماجد وسالم وفهد والرسوم) ولا فرق غير مفسَّر.
 */
import { memDb } from './helpers/testDb';
import { addBank } from './helpers/fixtures';
import { readStatementPhoto, type OcrLine } from '@/domain/bankStatement/photo';
import { readStatementGrid, readStatementFile, type StatementResult } from '@/domain/bankStatement/read';
import { saveStatement, reconciliation, StatementDuplicate } from '@/domain/bankStatement/store';
import type { DB } from '@/db/adapter';

/** سطرٌ بعرضه من طول نصه (عشر نقاطٍ للحرف) كما في tests/d4.auditZ1.photoPages.test.ts */
const ln = (text: string, left: number, top: number): OcrLine => ({ text, left, top, width: text.length * 10, height: 20 });
const page1: OcrLine[] = [
  ln('Date Description Debit Credit Balance', 40, 60),
  ln('Opening Balance', 40, 80), ln('0.00', 880, 80),
  ln('01/10/2026', 40, 100), ln('TRANSFER MAJED', 200, 100), ln('2,500.00', 720, 100), ln('2,500.00', 880, 100),
  ln('01/10/2026', 40, 140), ln('TRANSFER SALEM', 200, 140), ln('2,500.00', 720, 140), ln('5,000.00', 880, 140),
  ln('Balance Carried Forward', 40, 180), ln('5,000.00', 880, 180),
  ln('Page 1 of 2', 40, 260),
];
const page2: OcrLine[] = [
  ln('Date Description Debit Credit Balance', 40, 60),
  ln('Balance Brought Forward', 40, 80), ln('5,000.00', 880, 80),
  ln('01/10/2026', 40, 100), ln('TRANSFER FAHAD', 200, 100), ln('2,500.00', 720, 100), ln('7,500.00', 880, 100),
  ln('02/10/2026', 40, 140), ln('SMS CHARGES', 200, 140), ln('5.00', 560, 140), ln('7,495.00', 880, 140),
  ln('Closing Balance', 40, 180), ln('7,495.00', 880, 180),
  ln('Page 2 of 2', 40, 260),
];
const ok = (r: StatementResult) => { if (!r.ok) throw new Error('لم يُقرأ: ' + r.error); return r; }; // i18n-exempt: رسالة اختبار
/** كشف الشهر بأرصدته (CSV) */
const monthCsv = () => ok(readStatementGrid([['الرصيد الافتتاحي', '0.00'], ['التاريخ', 'البيان', 'مدين', 'دائن', 'الرصيد'],
  ['2026/10/01', 'TRANSFER MAJED', '', '2,500.00', '2,500.00'],
  ['2026/10/01', 'TRANSFER SALEM', '', '2,500.00', '5,000.00'],
  ['2026/10/01', 'TRANSFER FAHAD', '', '2,500.00', '7,500.00'],
  ['2026/10/02', 'SMS CHARGES', '5.00', '', '7,495.00']]));
/** كشف الشهر MT940 (بلا رصيدٍ لكل حركة) */
const monthMt940 = () => ok(readStatementFile({ name: 'oct.sta', bytes: new TextEncoder().encode([':20:SYNA25', ':60F:C260930SAR0,00',
  ':61:2610011001C2500,00NTRF//MAJED', ':86:TRANSFER MAJED',
  ':61:2610011001C2500,00NTRF//SALEM', ':86:TRANSFER SALEM',
  ':61:2610011001C2500,00NTRF//FAHAD', ':86:TRANSFER FAHAD',
  ':61:2610021002D5,00NCHG//SMS', ':86:SMS CHARGES',
  ':62F:C261002SAR7495,00'].join('\n')) }));
const photo = (p: OcrLine[]) => ok(readStatementPhoto(p));
/** يحفظ ما لم يُحفظ («لا جديد» ليس خطأً هنا) */
function save(db: DB, bank: string, r: ReturnType<typeof ok>, name: string) {
  try { saveStatement(db, bank, r, { name, hash: name }); } catch (e) { if (!(e instanceof StatementDuplicate)) throw e; }
}
const state = (db: DB, bank: string) => ({
  saved: db.all<{ d: string }>(`SELECT descr AS d FROM bank_statement_lines WHERE bank_id = ? AND deleted_at IS NULL ORDER BY date, descr`, [bank]).map((x) => x.d),
  unexplained: reconciliation(db, bank, '2026-10').unexplained,
});
const want = { saved: ['TRANSFER FAHAD', 'TRANSFER MAJED', 'TRANSFER SALEM', 'SMS CHARGES'], unexplained: 0 };

describe('A2-5 · [عالٍ] كشفان متداخلان يحفظان حوالة فهد مرتين: رقم التكرار في الملف يختلف والرصيد واحد (dedupe.ts:29 · store.ts:42)', () => {
  test('أ) كشف أكتوبر بأرصدته ثم صورة صفحته الثانية: أربع حركاتٍ محفوظة ولا فرق غير مفسَّر', () => {
    const db = memDb();
    const bank = addBank(db, 'بنك مصطنع A2-5أ', 0);
    // القراءة سليمة: الكشف بأربع حركات، والصفحة الثانية بحركتين من الأربع نفسها
    expect([monthCsv().lines.length, photo(page2).lines.map((l) => l.descr)]).toEqual([4, ['TRANSFER FAHAD', 'SMS CHARGES']]);
    save(db, bank, monthCsv(), 'a25-oct.csv');
    save(db, bank, photo(page2), 'a25-oct-p2.jpg');
    // (الواقع: حوالة فهد مرتان، والفرق غير المفسَّر −250,000 هللة)
    expect(state(db, bank)).toEqual(want);
    db.close();
  });

  test('ب) صورتا صفحتي أكتوبر ثم كشف الشهر MT940 بلا أرصدة: أربع حركاتٍ محفوظة ولا فرق غير مفسَّر', () => {
    const db = memDb();
    const bank = addBank(db, 'بنك مصطنع A2-5ب', 0);
    expect(monthMt940().lines.map((l) => [l.date, l.amount, l.balance])).toEqual([
      ['2026-10-01', 250000, null], ['2026-10-01', 250000, null], ['2026-10-01', 250000, null], ['2026-10-02', -500, null]]);
    save(db, bank, photo(page1), 'a25-oct-p1.jpg');
    save(db, bank, photo(page2), 'a25-oct-p2.jpg');
    save(db, bank, monthMt940(), 'a25-oct.sta');
    // (الواقع: حوالة فهد مرتان، والفرق غير المفسَّر −250,000 هللة)
    expect(state(db, bank)).toEqual(want);
    db.close();
  });
});
