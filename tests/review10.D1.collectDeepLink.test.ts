/**
 * المراجعة الشاملة 2026-11-13 · D-1 · عالٍ · app/(tabs)/collect.tsx:145-151 و:172-197 · بيانات مصطنعة كلها.
 *
 * السيناريو: يفتح المالك التطبيق (لم يزر «التحصيل» بعد) ← عقد ← «تحصيل» بجانب قسطٍ مستحق (contracts.tsx:693)،
 *   أو من «تفاصيل القسط» (:925)، أو من ورقة الوحدة (unitSheets.tsx:463) ← /collect?pay=<القسط>.
 * النتيجة قبل الإصلاح: قائمة «غير مسدَّدة» بلا نافذة «تسجيل دفعة إيجار».
 *   لأن الأثر كان يبحث عن القسط في `base.all`، و`base` فارغٌ في أول رسم (useDeferredReady)، والأثر يعتمد على
 *   `[params.pay]` وحده فلا يعود حين يجهز · ومن «الوحدات» تُركَّب الشاشة من جديد كل مرة فيفشل دائماً ·
 *   والضغطة الثانية على القسط نفسه لا تغيّر المعامل فلا يجري الأثر.
 * الصحيح: القسط يُقرأ من القاعدة بعينه (collectPayTarget) لا من القائمة المؤجَّلة، ثم يُستهلك المعامل.
 */
import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import { memDb } from './helpers/testDb';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { confirmContract, cancelContract, recordRentPayment } from '@/domain/contracts/service';
import { allInstallments, collectPayTarget } from '@/domain/stats';
import type { DB } from '@/db/adapter';

const T = '2026-11-13';

const instId = (db: DB, cid: string, due: string) =>
  db.get<{ id: string }>(`SELECT id FROM contract_installments WHERE contract_id = ? AND due_date = ?`, [cid, due])!.id;

/** عقد شهري ١٢٬٠٠٠ ريال لسنة من 2026-09-01 · اثنا عشر قسطاً كلٌّ منها ١٬٠٠٠ ريال = ١٠٠٬٠٠٠ هللة */
function lease(db: DB, unitNo: string, tenant: string, idNumber: string): string {
  const u = addUnit(db, addProperty(db, { name: 'عقار تحصيل مصطنع ' + unitNo }), { unit_no: unitNo });
  return confirmContract(db, contractInput(u, { tenant, idNumber, valueHalalas: 1200000, cycle: 'شهرية',
    start: '2026-09-01', end: '2027-08-31', depositHalalas: 0 }));
}

test('D-1 رابط «تحصيل» يجد القسط من القاعدة بلا قائمة الشاشة · بالمتبقي والتأخر نفسيهما', () => {
  const db = memDb();
  const cid = lease(db, 'D1-1', 'مستأجر تحصيل مصطنع', '1000000961');
  const sep = instId(db, cid, '2026-09-01');
  const oct = instId(db, cid, '2026-10-01');
  const nov = instId(db, cid, '2026-11-01');
  // سبتمبر مسدَّد كاملاً · وأكتوبر ٤٠٠ ريال منه
  recordRentPayment(db, cid, { installmentId: sep, period: '', date: '2026-09-01',
    lines: [{ method: 'cash', amountHalalas: 100000 }], discountHalalas: 0, notes: '' });
  recordRentPayment(db, cid, { installmentId: oct, period: '', date: '2026-10-05',
    lines: [{ method: 'cash', amountHalalas: 40000 }], discountHalalas: 0, notes: '' });

  // أكتوبر: ١٠٠٬٠٠٠ − ٤٠٬٠٠٠ = ٦٠٬٠٠٠ هللة · ومتأخرٌ من 2026-10-01 إلى 2026-11-13 = ٣٠ + ١٣ = ٤٣ يوماً
  const xo = collectPayTarget(db, oct, true, T)!;
  expect(xo).not.toBeNull();
  expect(xo.installmentId).toBe(oct);
  expect(xo.contractId).toBe(cid);
  expect(xo.remaining).toBe(60000);
  expect(xo.paid).toBe(40000);
  expect(xo.daysLate).toBe(43);
  // نوفمبر: لم يُدفع منه شيء · ١٠٠٬٠٠٠ ومتأخرٌ ١٢ يوماً
  const xn = collectPayTarget(db, nov, true, T)!;
  expect(xn.remaining).toBe(100000);
  expect(xn.daysLate).toBe(12);

  // العرض نفسه الذي تبنيه بطاقة القائمة (فنافذة السداد تُملأ بالأرقام ذاتها)
  const all = allInstallments(db, T);
  expect(xo).toEqual(all.find((r) => r.installmentId === oct));
  expect(xn).toEqual(all.find((r) => r.installmentId === nov));

  // الضغطة الثانية على القسط نفسه تجده ثانيةً (القراءة بلا حالة · والشاشة تستهلك المعامل)
  expect(collectPayTarget(db, oct, true, T)).toEqual(xo);
  // معامل المسار قد يصل مصفوفة
  expect(collectPayTarget(db, [nov], true, T)).toEqual(xn);

  // لا نافذة: قسطٌ مسدَّد · بلا صلاحية الإضافة · معرّفٌ مجهول أو غائب
  expect(collectPayTarget(db, sep, true, T)).toBeNull();
  expect(collectPayTarget(db, oct, false, T)).toBeNull();
  expect(collectPayTarget(db, 'no-such-installment', true, T)).toBeNull();
  expect(collectPayTarget(db, undefined, true, T)).toBeNull();
  expect(collectPayTarget(db, '', true, T)).toBeNull();
  db.close();
});

test('D-1 العقد الملغى: متأخراته تُفتح للتحصيل، وقسطه الملغى لا (قاعدة البطاقة وجدول العقد)', () => {
  const db = memDb();
  const cid = lease(db, 'D1-2', 'مستأجر إلغاء مصطنع', '1000000962');
  cancelContract(db, cid, { date: '2026-11-10', reason: 'إنهاء مصطنع', installmentsFate: 'cancel', settle: false,
    deductionHalalas: 0, refundHalalas: 0, deductionReason: '' });
  const nov = instId(db, cid, '2026-11-01');
  const dec = instId(db, cid, '2026-12-01');
  // نوفمبر استُحق قبل الإلغاء فبقي ديناً يُحصَّل كاملاً
  const xn = collectPayTarget(db, nov, true, T)!;
  expect(xn).not.toBeNull();
  expect(xn.remaining).toBe(100000);
  // ديسمبر بعد الإلغاء صار «ملغية»
  expect(db.get<{ s: string }>(`SELECT status AS s FROM contract_installments WHERE id = ?`, [dec])!.s).toBe('ملغية');
  expect(collectPayTarget(db, dec, true, T)).toBeNull();
  db.close();
});

/** الأثر الذي يقرأ معامل pay في شاشة التحصيل */
function payEffectBody(): string {
  const file = path.resolve(__dirname, '..', 'app', '(tabs)', 'collect.tsx');
  const src = fs.readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && n.expression.getText(sf) === 'useEffect' && n.arguments.length === 2) {
      const deps = n.arguments[1];
      if (ts.isArrayLiteralExpression(deps) && deps.elements.some((e) => e.getText(sf) === 'params.pay')) {
        found.push(n.arguments[0].getText(sf));
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  expect(found).toHaveLength(1);
  return found[0];
}

test('D-1 شاشة التحصيل: الأثر لا ينتظر «base» المؤجَّل، ويستهلك المعامل بعد قراءته', () => {
  const body = payEffectBody();
  // قبل الإصلاح: base.all.find(...) · فارغٌ في أول رسم ولا يعود الأثر حين يجهز
  expect(body).not.toMatch(/\bbase\b/);
  expect(body).toMatch(/collectPayTarget\(/);
  // يُستهلك المعامل فتعمل الضغطة الثانية على القسط نفسه
  expect(body).toMatch(/setParams\(\s*\{\s*pay:\s*undefined\s*\}/);
});
