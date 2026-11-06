/**
 * المراجعة الشاملة (الالتزام ac76adc) · البندان ٦ و٧: رمز ضريبة السطر ونسبته، وإشعار الفاتورة المختلطة · بيانات مصطنعة.
 */
import { memDb } from './helpers/testDb';
import { saveInvoice, type InvoiceInput } from '@/domain/invoices';
import { vatReturnData } from '@/domain/vatReturn';
import { accountBalance } from '@/domain/accounting/ledger';

const item = (d: ReturnType<typeof vatReturnData>, no: string) => d.items.find((x) => x.no === no)!;
const register = (db: ReturnType<typeof memDb>) => db.run(`UPDATE company SET vat_enabled = 1 WHERE id = 1`);
const inv = (lines: InvoiceInput['lines'], issue = '2026-02-10'): InvoiceInput =>
  ({ customer: 'عميل مصطنع', customerVat: '', issue, due: issue, notes: '', lines });
/** ضريبة المخرجات في الدفتر (دائن 2200) */
const ledgerVat = (db: ReturnType<typeof memDb>) => accountBalance(db, '2200');

test('٦ سطرٌ برمز صفري أو معفى ونسبة ١٥٪ لا يرحّل ضريبة: نسبته صفر، والدفتر يطابق الإقرار', () => {
  for (const code of ['Z', 'E'] as const) {
    const db = memDb();
    register(db);
    const id = saveInvoice(db, inv([
      { descr: 'خاضع مصطنع', qty: 1, priceHalalas: 10000, taxPct: 15, taxCode: 'S' },
      { descr: 'غير خاضع مصطنع', qty: 1, priceHalalas: 20000, taxPct: 15, taxCode: code },
    ]), 'مستحقة');
    const v = db.get<{ tax: number }>(`SELECT tax_halalas AS tax FROM invoices WHERE id = ?`, [id])!;
    expect(Number(v.tax)).toBe(1500);
    const lines = db.all<{ c: string; p: number }>(`SELECT tax_code AS c, tax_pct AS p FROM invoice_lines WHERE invoice_id = ? ORDER BY sort`, [id]);
    expect(lines.map((l) => [l.c, Number(l.p)])).toEqual([['S', 15], [code, 0]]);
    expect(ledgerVat(db)).toBe(item(vatReturnData(db, 2026, 1), '1').taxHalalas);
    db.close();
  }
});

test('٦ والخاضع بنسبة صفر يُرفض', () => {
  const db = memDb();
  register(db);
  expect(() => saveInvoice(db, inv([{ descr: 'خاضع مصطنع', qty: 1, priceHalalas: 10000, taxPct: 0, taxCode: 'S' }]), 'مستحقة')).toThrow();
  expect(Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM invoices`)!.n)).toBe(0);
  db.close();
});
