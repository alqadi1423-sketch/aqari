/**
 * المدقق Z1 · الجولة الثالثة عشرة · بصمة السطر برقم تكراره في الكشف وحده (src/domain/bankStatement/dedupe.ts:21-29) مع منع التكرار في
 * saveStatement (src/domain/bankStatement/store.ts:36-38) · بياناتٌ مصطنعة كلها.
 *   TZ=Asia/Riyadh npx jest tests/d4.auditZ1.photoPages.test.ts
 *
 * Z1-2 · عالٍ: البصمة منذ U18 هي البنك والتاريخ والمبلغ ورقم التكرار «في الكشف نفسه» (بلا الرصيد والبيان، خلافاً لـDESIGN §١٣.٢٢ «البنك
 * والتاريخ والمبلغ الموقَّع والرصيد والبيان المطبَّع») · وكشف الصورة صفحةٌ واحدة (services/bankStatement.ts: صورةٌ لكل كشف)، فكشفٌ من
 * صفحتين يُحفظ كشفين · حوالتان بالإيجار نفسه في يومٍ واحد على الصفحة الأولى (ماجد وسالم، #1 و#2) وثالثةٌ بالمبلغ واليوم نفسيهما أول
 * الصفحة الثانية (فهد) يأخذ رقم التكرار #1 في كشفها، فبصمتها بصمة حوالة ماجد: تُتخطّى «محفوظةً من قبل» بصمت · فلا سطر لحوالة فهد ولا
 * اقتراح تحصيلٍ لها، وتقرير أكتوبر بفرقٍ «غير مفسَّر» 2,500 لا يستطيع المستخدم مطابقته بشيء · ومنذ db011e7 (معرّف السطر من بصمته) تُحفظ
 * الصفحتان على جهازين فيصير السطران صفاً واحداً يغلب أحدهما الآخر.
 * لماذا يهم: أول الشهر في عقارٍ مؤجَّر حوالاتٌ كثيرة بالإيجار نفسه في اليوم نفسه، وكشف الصور صفحاتٌ متتالية: إيداعاتٌ حقيقية تسقط.
 * السلوك الصحيح: حركةٌ في الكشف الثاني ليست في الأول لا تُتخطّى (البصمة تميّز الحركتين برصيدهما أو بيانهما حيث طُبعا، أو يُعرف
 * التداخل بالرصيد لا برقم التكرار وحده) · فتُحفظ حوالات ماجد وسالم وفهد والرسوم، ولا فرق غير مفسَّر.
 */
import { memDb } from './helpers/testDb';
import { addBank } from './helpers/fixtures';
import { readStatementPhoto, type OcrLine } from '@/domain/bankStatement/photo';
import { saveStatement, reconciliation } from '@/domain/bankStatement/store';

/** سطرٌ بعرضه من طول نصه (عشر نقاطٍ للحرف) كما في tests/d4.auditV.photo.test.ts */
const ln = (text: string, left: number, top: number): OcrLine => ({ text, left, top, width: text.length * 10, height: 20 });

describe('Z1-2 · [عالٍ] كشفٌ من صفحتين بالصورة: حوالةٌ أول الصفحة الثانية بمبلغ ويوم حوالةٍ في الأولى تُتخطّى «محفوظة» وهي جديدة (dedupe.ts:24 · store.ts:38)', () => {
  test('صفحتا أكتوبر: أربع حركاتٍ محفوظة (ماجد وسالم وفهد والرسوم)، ولا فرق غير مفسَّر', () => {
    const db = memDb();
    const bank = addBank(db, 'بنك مصطنع Z1-2', 0);
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
    const r1 = readStatementPhoto(page1);
    const r2 = readStatementPhoto(page2);
    if (!r1.ok || !r2.ok) throw new Error('لم تُقرأ الصفحتان'); // i18n-exempt: رسالة اختبار
    // القراءة سليمة: كل صفحةٍ بحركاتها وأرصدتها المتسلسلة
    expect([r1.lines.map((l) => l.descr), r2.lines.map((l) => l.descr)]).toEqual([['TRANSFER MAJED', 'TRANSFER SALEM'], ['TRANSFER FAHAD', 'SMS CHARGES']]);
    saveStatement(db, bank, r1, { name: 'oct-p1.jpg', hash: 'z1-2-p1' });
    const second = saveStatement(db, bank, r2, { name: 'oct-p2.jpg', hash: 'z1-2-p2' });

    const saved = db.all<{ d: string }>(`SELECT descr AS d FROM bank_statement_lines WHERE bank_id = ? AND deleted_at IS NULL ORDER BY date, balance_halalas`, [bank]).map((x) => x.d);
    // (الواقع: الصفحة الثانية «حركة جديدة واحدة، وتُخطّيت واحدة محفوظة من قبل»، وحوالة فهد ليست في الكشف، والفرق غير المفسَّر 250,000 هللة)
    expect({ added: second.added, skipped: second.skipped, saved, unexplained: reconciliation(db, bank, '2026-10').unexplained }).toEqual({
      added: 2, skipped: 0, saved: ['TRANSFER MAJED', 'TRANSFER SALEM', 'TRANSFER FAHAD', 'SMS CHARGES'], unexplained: 0,
    });
    db.close();
  });
});
