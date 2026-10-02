/**
 * اختبارات الخلل المزروع — فحصٌ لم يُختبَر بخلل مزروع ليس فحصاً.
 * لكل فحص من الثمانية: نزرع الخلل عمداً ونتأكد أن الفحص يسقط،
 * وقبلها نتأكد أن الثمانية تمر على قاعدة سليمة بدورة عمل كاملة.
 */
import { memDb } from './helpers/testDb';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { integrityChecks } from '@/domain/accounting/integrity';
import { confirmContract, recordRentPayment } from '@/domain/contracts/service';
import { uid } from '@/domain/ids';

const CHECKS = [
  'مجموع المدين = مجموع الدائن',
  'كل قيد متوازن على حدة',
  'تأمينات المستأجرين = التأمينات المحتجزة (غير المُسوَّاة)',
  'ذمم المطالبات = المطالبات المفتوحة',
  'كل حركة بنكية مرتبطة بحساب حيّ',
  'الأصول = الالتزامات + حقوق الملكية + صافي الدخل',
  'لا قيود يتيمة لمصادر محذوفة',
  'كل دفعة محصَّلة لها قيد مرحّل',
];

const check = (db: ReturnType<typeof memDb>, name: string) => {
  const c = integrityChecks(db).find((x) => x.name === name);
  if (!c) throw new Error('فحص مفقود: ' + name);
  return c;
};

/** قاعدة بدورة عمل حقيقية: عقد موثق بتأمين + دفعة محصلة */
function seededDb() {
  const db = memDb();
  const pid = addProperty(db);
  const uidd = addUnit(db, pid);
  const cid = confirmContract(db, contractInput(uidd, {
    tenant: 'مستأجر الفحص', valueHalalas: 1200000, depositHalalas: 100000,
    start: '2026-01-01', end: '2026-12-31',
  }));
  const inst = db.get<{ id: string }>(
    `SELECT id FROM contract_installments WHERE contract_id = ? ORDER BY due_date LIMIT 1`, [cid]
  )!;
  recordRentPayment(db, cid, {
    installmentId: inst.id, date: '2026-01-05', period: 'يناير',
    lines: [{ method: 'cash', amountHalalas: 100000 }], discountHalalas: 0, notes: '',
  });
  return { db, cid };
}

describe('فحوص المطابقة الثمانية · خلل مزروع لكل فحص', () => {
  test('القاعدة السليمة: الفحوص الثمانية كلها تمر', () => {
    const { db } = seededDb();
    const results = integrityChecks(db);
    expect(results.length).toBe(8);
    for (const r of results) expect({ name: r.name, ok: r.ok }).toEqual({ name: r.name, ok: true });
    for (const n of CHECKS) expect(results.some((r) => r.name === n)).toBe(true);
    db.close();
  });

  /**
   * محفّزات القاعدة نفسها تمنع التلاعب بالقيود المرحّلة — وهذا خط الدفاع الأول.
   * لزرع الخلل نعطّلها داخل الاختبار فقط، محاكين بياناتٍ فاسدة وصلت من خارج
   * التطبيق (نسخة مستعادة معطوبة مثلاً) — وفحص المطابقة هو خط الدفاع الثاني.
   */
  const dropGuards = (db: ReturnType<typeof memDb>) => {
    for (const t of db.all<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type='trigger'`
    )) db.exec(`DROP TRIGGER IF EXISTS "${t.name}"`);
  };

  test('١ · زرع سطر مدين بلا دائن ← يسقط فحص التوازن الكلي', () => {
    const { db } = seededDb();
    dropGuards(db);
    const e = db.get<{ id: string }>(`SELECT id FROM journal_entries WHERE status='مرحّل' LIMIT 1`)!;
    db.run(`INSERT INTO journal_lines (id, entry_id, account_code, descr, debit_halalas, credit_halalas)
            VALUES (?,?,?,?,?,?)`, [uid(), e.id, '1100', 'خلل مزروع', 555, 0]);
    expect(check(db, CHECKS[0]).ok).toBe(false);
    expect(check(db, CHECKS[1]).ok).toBe(false); // والقيد نفسه اختل
    db.close();
  });

  test('٣ · تعديل تأمين العقد في الجدول دون قيد ← يسقط فحص التأمينات', () => {
    const { db, cid } = seededDb();
    db.run(`UPDATE contracts SET deposit_halalas = deposit_halalas + 50000 WHERE id = ?`, [cid]);
    expect(check(db, CHECKS[2]).ok).toBe(false);
    db.close();
  });

  test('٤ · مطالبة مفتوحة بلا قيد ← يسقط فحص المطالبات', () => {
    const { db, cid } = seededDb();
    db.run(`INSERT INTO claims (id, contract_id, reason, amount_halalas, status, date, created_at)
            VALUES (?,?,?,?,?,?,?)`,
      [uid(), cid, 'خلل مزروع', 30000, 'مفتوحة', '2026-02-01', new Date().toISOString()]);
    expect(check(db, CHECKS[3]).ok).toBe(false);
    db.close();
  });

  test('٥ · حركة بنكية على حساب محذوف ← يسقط فحص الحركات اليتيمة', () => {
    const { db } = seededDb();
    // بنك ثم حركة عليه ثم حذف صف البنك نهائياً بلا قيود مرجعية — محاكاة استعادة معطوبة
    const bid = uid();
    db.run(`INSERT INTO banks (id, name, opening_halalas, created_at) VALUES (?,?,0,?)`,
      [bid, 'بنك مؤقت', new Date().toISOString()]);
    db.run(`INSERT INTO bank_tx (id, bank_id, date, descr, amount_halalas, matched, source, created_at)
            VALUES (?,?,?,?,?,0,'',?)`,
      [uid(), bid, '2026-01-01', 'خلل مزروع', 1000, new Date().toISOString()]);
    db.exec(`PRAGMA foreign_keys = OFF`);
    db.run(`DELETE FROM banks WHERE id = ?`, [bid]);
    db.exec(`PRAGMA foreign_keys = ON`);
    expect(check(db, CHECKS[4]).ok).toBe(false);
    db.close();
  });

  test('٦ · حقن رصيد في حساب أصل دون مقابل ← تسقط معادلة الميزانية', () => {
    const { db } = seededDb();
    dropGuards(db);
    const eid = uid();
    db.run(`INSERT INTO journal_entries (id, no, date, memo, status, auto, created_at)
            VALUES (?,?,?,?,'مرحّل',1,?)`, [eid, 'JE-FAULT', '2026-01-01', 'خلل مزروع', new Date().toISOString()]);
    db.run(`INSERT INTO journal_lines (id, entry_id, account_code, descr, debit_halalas, credit_halalas)
            VALUES (?,?,?,?,?,?)`, [uid(), eid, '1100', 'خلل', 777, 0]);
    expect(check(db, CHECKS[5]).ok).toBe(false);
    db.close();
  });

  test('٧ · حذف دفعة من الجدول وقيدها باقٍ ← يسقط فحص القيود اليتيمة', () => {
    const { db } = seededDb();
    db.run(`DELETE FROM contract_payments`);
    expect(check(db, CHECKS[6]).ok).toBe(false);
    db.close();
  });

  test('٨ · دفعة محقونة بلا قيد ← يسقط فحص ربط التحصيل بالدفتر', () => {
    const { db, cid } = seededDb();
    db.run(`INSERT INTO contract_payments (id, contract_id, period, date, gross_halalas, discount_halalas,
              net_halalas, method_label, notes, created_at)
            VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [uid(), cid, 'خلل', '2026-03-01', 50000, 0, 50000, 'نقداً', '', new Date().toISOString()]);
    expect(check(db, CHECKS[7]).ok).toBe(false);
    db.close();
  });
});
