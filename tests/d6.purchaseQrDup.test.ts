/**
 * التوجيه الرابع ٦ · ١ · «والمكررة تُرفض»: فاتورة الشراء المقروءة من QR تحمل مفتاح رمزها (الرقم الضريبي للبائع ووقت الإصدار
 * بالثانية والإجمالي والضريبة)، فلا تُسجَّل الفاتورة نفسها مرتين · ولا تعود من السلة فوق نسختها الحيّة · والتعديل يُبقي مفتاحها ·
 * والمُدخلة يدوياً بلا مفتاح لا تُفحص (فاتورتان متطابقتان في يومٍ واحد ممكنتان) · بيانات مصطنعة.
 */
import { memDb } from './helpers/testDb';
import { savePurchase, deletePurchase, restorePurchase, purchaseByQrKey, type PurchaseInput } from '@/domain/purchases';
import { decodeZatcaQr, zatcaQrKey } from '@/domain/zatcaQr';
import { zatcaTlvBase64 } from '@/domain/printDocs';

const base = (over: Partial<PurchaseInput> = {}): PurchaseInput => ({
  supplier: 'مورد مصطنع', date: '2026-11-01', due: '', category: 'صيانة', incorpItem: '', amortize: false, amortizeMonths: null,
  exempt: false, excludeFromVat: true, subtotalHalalas: 100000, taxHalalas: 15000, totalHalalas: 115000, ...over,
});
const qrOf = (issued: string) => {
  const r = decodeZatcaQr(zatcaTlvBase64('مورد مصطنع', '300000000000003', issued, 115000, 15000));
  if (!r.ok) throw new Error(r.error);
  return r.qr;
};

describe('مفتاح الرمز', () => {
  test('الرقم الضريبي ووقت الإصدار بالثانية والمبلغان · وفاتورتان في اليوم نفسه بوقتين مختلفين مفتاحان', () => {
    const a = zatcaQrKey(qrOf('2026-11-01T09:00:00Z'));
    expect(a).toBe('300000000000003|2026-11-01T09:00:00Z|115000|15000');
    expect(zatcaQrKey(qrOf('2026-11-01T09:00:01Z'))).not.toBe(a);
  });
});

describe('الفاتورة المكررة تُرفض', () => {
  const key = '300000000000003|2026-11-01T09:00:00Z|115000|15000';
  test('الثانية بالمفتاح نفسه تُرفض برقم الأولى وتاريخها، ولا تُكتب', () => {
    const db = memDb();
    const id = savePurchase(db, base({ qrKey: key }));
    const no = db.get<{ no: string }>(`SELECT no FROM purchases WHERE id = ?`, [id])!.no;
    expect(purchaseByQrKey(db, key)).toEqual({ id, no, date: '2026-11-01', exact: true });
    expect(() => savePurchase(db, base({ qrKey: key }))).toThrow(no);
    expect(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM purchases`)!.n).toBe(1);
  });
  test('التعديل يُبقي المفتاح ولا يصطدم بنفسه', () => {
    const db = memDb();
    const id = savePurchase(db, base({ qrKey: key }));
    savePurchase(db, base({ category: 'نظافة' }), id);
    expect(db.get<{ k: string }>(`SELECT qr_key AS k FROM purchases WHERE id = ?`, [id])!.k).toBe(key);
    expect(() => savePurchase(db, base({ qrKey: key }))).toThrow();
  });
  test('ما في السلة لا يمنع تسجيلها من جديد · ولا يعود من السلة فوق نسختها الحيّة', () => {
    const db = memDb();
    const first = savePurchase(db, base({ qrKey: key }));
    deletePurchase(db, first);
    const second = savePurchase(db, base({ qrKey: key }));
    expect(purchaseByQrKey(db, key)?.id).toBe(second);
    const no2 = db.get<{ no: string }>(`SELECT no FROM purchases WHERE id = ?`, [second])!.no;
    expect(() => restorePurchase(db, first)).toThrow(no2);
    expect(db.get<{ d: string | null }>(`SELECT deleted_at AS d FROM purchases WHERE id = ?`, [first])!.d).not.toBeNull();
  });
  test('المُدخلة يدوياً بلا مفتاح لا تُفحص', () => {
    const db = memDb();
    savePurchase(db, base());
    expect(() => savePurchase(db, base())).not.toThrow();
  });
});

describe('الهجرة ٥٤', () => {
  test('عمود المفتاح فارغاً للقديمة، وفهرسه لما فيه مفتاح', () => {
    const db = memDb();
    const col = db.all<{ name: string; dflt_value: string }>(`PRAGMA table_info(purchases)`).find((c) => c.name === 'qr_key');
    expect(col?.dflt_value).toBe("''");
    expect(db.get(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'ix_purchases_qr_key'`)).toBeTruthy();
  });
});
