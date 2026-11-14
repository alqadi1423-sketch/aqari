/**
 * المدقق C2 · الجولة الخامسة عشرة · على f5036b1 · عكس تحصيل فاتورةٍ حُصّلت من الكشف يُبقي إيداعها «مطابَقاً» بحركة التحصيل المعكوس · بياناتٌ
 * مصطنعة كلها، وجهازٌ واحد.
 *   TZ=Asia/Riyadh npx jest tests/d4.auditC2.invoiceReversed.test.ts
 *
 * C2-3 · متوسط · src/domain/invoices.ts:259-276 (reverseInvoicePayment يعكس القيد ويكتب الحركة السالبة ولا يمسّ سطر الكشف المطابَق
 * بحركة التحصيل) ومن يستدعيه: setInvoiceStatus (invoices.ts:299 · إعادة الفاتورة «مستحقة» أو «متأخرة» من شاشتها) وpayInvoice
 * (invoices.ts:244-246 · تحصيلٌ جديد يعكس القائم) · وإصلاح B2-7 في src/domain/contracts/cancelPayment.ts:234-239 للدفعة وحدها (ونظيره
 * reverseBankTx في src/domain/accounting/sourceCancel.ts:45 لإلغاء عمليات النقد المسجّلة من «تسجيل» سطرٍ غير مطابَق):
 * المالك يعتمد حوالة نجم (575) تحصيلاً لفاتورته من الكشف · ثم يتبيّن أن الحوالة لعميلٍ آخر فيعيد الفاتورة «مستحقة» من شاشتها (المسار
 * المعتاد لإلغاء تحصيل الفاتورة) · القيد يُعكس والحركة السالبة تُكتب والفاتورة مستحقة ثانيةً، لكن السطر يبقى «مطابَقاً» بحركة التحصيل
 * المعكوس: لا يُقترح تحصيلاً (ولا للفاتورة نفسها إن كانت الحوالة لها فعلاً)، والتقرير يعدّه مطابَقاً ويفسّر الفرق بالحركة السالبة «في
 * الدفاتر وحدها»، و«غير مفسَّر» صفر.
 * وكذلك (ب) سطرٌ غير مطابَق سُجّل من «تسجيل» واردٍ آخر (recordManualBankTx) وطوبق بحركته، ثم أُلغيت العملية من الدفتر («إلغاء العملية» ·
 * sourceCancel.ts:123-134): السطر «مطابَق» بحركة قيدٍ معكوس ولا يعود «في الكشف وحده».
 * لماذا يهم: هو B2-7 لهدفٍ آخر من أهداف التحصيل من الكشف (القسط والمطالبة والفاتورة · DESIGN §١٣.٢٢): مسار «ألغِ ثم اعتمد للهدف
 * الصحيح» لا يصل إليه من ألغى من شاشة الفاتورة، وإيداعٌ حقيقي يختفي من قائمة العمل بمطابقةٍ لتحصيلٍ أُلغي.
 * السلوك الصحيح: عكس تحصيل الفاتورة (وإلغاء أي عمليةٍ طوبق سطرٌ بحركتها) يعيد سطر الكشف مفتوحاً كما يفعل إلغاء الدفعة: السطر مفتوح،
 * ويُقترح للتحصيل ثانيةً، ويظهر «في الكشف وحده».
 */
import { addBank } from './helpers/fixtures';
import { memDb } from './helpers/testDb';
import { saveInvoice, setInvoiceStatus } from '@/domain/invoices';
import { readStatementGrid } from '@/domain/bankStatement/read';
import { saveStatement, reconciliation, matchSuggestions, approveMatch } from '@/domain/bankStatement/store';
import { collectionSuggestions, approveCollection } from '@/domain/bankStatement/collect';
import { recordManualBankTx } from '@/domain/cashOps';
import { entrySourceAction } from '@/domain/accounting/sourceCancel';

describe('C2-3 · [متوسط] عكس تحصيلٍ أو عمليةٍ طوبق سطر الكشف بحركتها يُبقي السطر «مطابَقاً» (invoices.ts:259 · sourceCancel.ts:45)', () => {
  test('أ) الفاتورة تُعاد «مستحقة» بعد تحصيلها من الكشف: السطر يعود مفتوحاً ويُقترح للتحصيل ثانيةً ويظهر «في الكشف وحده»', () => {
    const db = memDb();
    const bank = addBank(db, 'بنك مصطنع C2-3', 0);
    const inv = saveInvoice(db, { customer: 'نجم المصطنع', customerVat: '', issue: '2026-10-01', due: '2026-10-15', notes: '',
      lines: [{ descr: 'خدمة مصطنعة', qty: 1, priceHalalas: 50000, taxPct: 15 }] }, 'مستحقة');
    const invNo = db.get<{ no: string }>(`SELECT no FROM invoices WHERE id = ?`, [inv])!.no;
    const g = readStatementGrid([['الرصيد الافتتاحي', '0.00'], ['التاريخ', 'البيان', 'مدين', 'دائن', 'الرصيد'],
      ['2026/10/12', 'حوالة واردة نجم سداد فاتورة ' + invNo, '', '575.00', '575.00']]);
    if (!g.ok) throw new Error(g.error);
    saveStatement(db, bank, g, { name: 'c2-3-oct.csv', hash: 'c2-3' });
    const s = collectionSuggestions(db, bank)[0];
    expect([s.target, s.level]).toEqual([{ kind: 'invoice', invoiceId: inv }, 'ready']);
    approveCollection(db, s.line.id, s.target);

    // الحوالة لعميلٍ آخر: الفاتورة تعود «مستحقة» من شاشتها (يُعكس تحصيلها وحركة بنكه)
    setInvoiceStatus(db, inv, 'مستحقة');
    expect(db.get<{ s: string; p: string | null }>(`SELECT status AS s, payment_journal_entry_id AS p FROM invoices WHERE id = ?`, [inv]))
      .toEqual({ s: 'مستحقة', p: null });

    const rec = reconciliation(db, bank, '2026-10');
    const view = {
      line: db.get<{ status: string }>(`SELECT status FROM bank_statement_lines WHERE id = ?`, [s.line.id])!.status,
      collectAgain: collectionSuggestions(db, bank).filter((x) => x.line.id === s.line.id).length,
      onlyInStatement: rec.onlyInStatement.map((x) => x.amount),
    };
    // (الواقع: السطر «مطابَق» بحركة التحصيل المعكوس، ولا اقتراح تحصيلٍ له، و«في الكشف وحده» فارغ والحركة السالبة «في الدفاتر وحدها»)
    expect(view).toEqual({ line: 'open', collectAgain: 1, onlyInStatement: [57500] });
    db.close();
  });

  test('ب) واردٌ آخر سُجّل من سطرٍ غير مطابَق وطوبق، ثم أُلغيت العملية من الدفتر: السطر يعود مفتوحاً ويظهر «في الكشف وحده»', () => {
    const db = memDb();
    const bank = addBank(db, 'بنك مصطنع C2-3ب', 0);
    const g = readStatementGrid([['الرصيد الافتتاحي', '0.00'], ['التاريخ', 'البيان', 'مدين', 'دائن', 'الرصيد'],
      ['2026/10/20', 'عائد وديعة مصطنع', '', '300.00', '300.00']]);
    if (!g.ok) throw new Error(g.error);
    saveStatement(db, bank, g, { name: 'c2-3b-oct.csv', hash: 'c2-3b' });
    const line = db.get<{ id: string }>(`SELECT id FROM bank_statement_lines WHERE bank_id = ?`, [bank])!.id;
    // «تسجيل» من السطر: واردٌ آخر بمبلغه وتاريخه، ثم مطابقته بحركته
    recordManualBankTx(db, { kind: 'income', bankId: bank, amountHalalas: 30000, date: '2026-10-20', descr: 'عائد وديعة مصطنع' });
    const sug = matchSuggestions(db, bank);
    expect(sug.map((x) => x.line.id)).toEqual([line]);
    approveMatch(db, line, sug[0].tx.id);
    // ثم يتبيّن أن الوارد سُجّل خطأً: «إلغاء العملية» من الدفتر
    const entry = db.get<{ id: string }>(`SELECT id FROM journal_entries WHERE no = ?`, [sug[0].tx.no])!.id;
    const action = entrySourceAction(db, entry);
    if (!action || action.kind !== 'op') throw new Error('لا إلغاء من المصدر'); // i18n-exempt: رسالة اختبار
    action.run('2026-10-21', 'سُجّل خطأً (مصطنع)');
    expect(db.get(`SELECT 1 FROM journal_entries WHERE id = ? AND reversed_by IS NOT NULL`, [entry])).toBeTruthy();

    const view = {
      line: db.get<{ status: string }>(`SELECT status FROM bank_statement_lines WHERE id = ?`, [line])!.status,
      onlyInStatement: reconciliation(db, bank, '2026-10').onlyInStatement.map((x) => x.amount),
    };
    // (الواقع: السطر «مطابَق» بحركة القيد المعكوس، و«في الكشف وحده» فارغ)
    expect(view).toEqual({ line: 'open', onlyInStatement: [30000] });
    db.close();
  });
});
