/**
 * المراجعة الشاملة 2026-11-13 · المراجع A1 (دورة الإيجار) · بيانات مصطنعة كلها.
 *
 * A1-1 · حرج · src/domain/contracts/service.ts:551 و584 (renewContract) · app/(tabs)/contracts.tsx:982 (خانة الترحيل مؤشَّرة افتراضياً)
 *   السيناريو: عقد سنوي بتأمين ١٬٠٠٠ لدى المكتب انتهى في 2026-10-31 · سُوّي تأمينه وردّ ١٬٠٠٠ للمستأجر نقداً ·
 *   ثم جُدّد العقد للمستأجر نفسه (التجديد متاح بعد الانتهاء) وخانة «ترحيل التأمين الحالي» مؤشَّرة كما تفتح.
 *   النتيجة اليوم: العقد الجديد يحمل تأميناً ١٬٠٠٠ لم يُقبض، وقيد ترحيل 2400/2400 يجعل التزام العقد القديم سالباً،
 *   وفحص المطابقة الثالث يحمرّ (الدفتر ٠ والمتوقع ١٬٠٠٠)، وعند انتهاء الجديد تعرض شاشة التسوية ردّ ١٬٠٠٠ ثانية فيخرج من النقد.
 *   لماذا يهم: المالك يردّ التأمين مرتين (١٬٠٠٠ ريال من جيبه)، ورصيد 2400 يصير سالباً.
 *   السلوك الصحيح: لا يُرحَّل تأمينٌ سُوّي (يُرفض الترحيل بسببه، أو يُرحَّل صفر)، فيبقى 2400 صفراً والفحص أخضر.
 *
 * A1-3 · متوسط · src/domain/accounting/integrity.ts:54
 *   السيناريو: عقد بتأمين ١٬٠٠٠ جُدّد قبل نهايته بلا ترحيل التأمين (الخانة أُزيلت) · التأمين القديم ما زال في 2400 بحق حتى يُسوّى.
 *   النتيجة اليوم: الفحص الثالث يستثني كل عقدٍ له renewed_to ويفترض أن تأمينه رُحِّل، فيحمرّ «١٬٠٠٠ / ٠» لدفترٍ صحيح.
 *   لماذا يهم: إنذارٌ كاذب في «فحص المطابقة» وفي بيان كل نسخة احتياطية حتى تُسوّى التسوية بعد نهاية العقد القديم.
 *   السلوك الصحيح: يُستثنى العقد المجدَّد حين رُحِّل تأمينه فعلاً (قيد deposit_carry حيّ) لا لمجرد أن له خلفاً.
 */
import { memDb } from './helpers/testDb';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { confirmContract, saveDepositSettlement, renewContract } from '@/domain/contracts/service';
import { ownerCashIn } from '@/domain/cashOps';
import { accountBalance } from '@/domain/accounting/ledger';
import { integrityChecks } from '@/domain/accounting/integrity';

const DEPOSIT_CHECK = 'تأمينات المستأجرين = التأمينات المحتجزة (غير المُسوَّاة)';
const renewInput = (start: string, end: string, carry: boolean) => ({
  start, end, valueHalalas: 1000000, cycle: 'شهرية', carryDeposit: carry, extraDepositHalalas: 0,
  services: '', furnished: 'غير مؤثثة', ejarNo: '', note: '',
});

test('A1-1 التجديد بعد تسوية التأمين لا يرحّل تأميناً رُدّ للمستأجر', () => {
  const db = memDb();
  ownerCashIn(db, { amountHalalas: 500000, date: '2026-01-01' });
  const u = addUnit(db, addProperty(db, { name: 'عقار تجديد مصطنع' }), { unit_no: 'R-1' });
  const a = confirmContract(db, contractInput(u, { tenant: 'مستأجر تجديد مصطنع', idNumber: '1000000901',
    valueHalalas: 1000000, start: '2026-01-01', end: '2026-10-31', depositHalalas: 100000 }));
  // انتهى العقد فسُوّي تأمينه: ردّ ١٬٠٠٠ كاملاً نقداً
  saveDepositSettlement(db, a, { date: '2026-11-01', deductionHalalas: 0, deductionReason: '', refundHalalas: 100000, notes: '' });
  expect(accountBalance(db, '2400')).toBe(0);
  expect(accountBalance(db, '1100')).toBe(500000); // ٥٬٠٠٠ إيداع + ١٬٠٠٠ تأمين − ١٬٠٠٠ ردّ

  // التجديد بالخانة كما تفتح (ترحيل التأمين مؤشَّر)
  let refused = false;
  let b = '';
  try { b = renewContract(db, a, renewInput('2026-11-01', '2027-10-31', true)); } catch { refused = true; }
  if (!refused) {
    // إن قُبل التجديد فلا تأمين في العقد الجديد: لم يُقبض شيء
    expect(Number(db.get<{ d: number }>(`SELECT deposit_halalas AS d FROM contracts WHERE id = ?`, [b])!.d)).toBe(0);
  }
  // اليوم: العقد الجديد بتأمين ١٬٠٠٠ والدفتر ٠، فالفحص أحمر وشاشة التسوية تعرض ردّ ١٬٠٠٠ ثانية
  expect(accountBalance(db, '2400')).toBe(0);
  expect(integrityChecks(db).find((x) => x.name === DEPOSIT_CHECK)!.ok).toBe(true);
  db.close();
});

test('A1-3 التجديد بلا ترحيل التأمين: الفحص الثالث لا يحمرّ لدفترٍ صحيح', () => {
  const db = memDb();
  const u = addUnit(db, addProperty(db, { name: 'عقار تجديد مصطنع' }), { unit_no: 'R-2' });
  const a = confirmContract(db, contractInput(u, { tenant: 'مستأجر تجديد مصطنع', idNumber: '1000000919',
    valueHalalas: 1200000, start: '2026-01-01', end: '2026-12-31', depositHalalas: 100000 }));
  renewContract(db, a, renewInput('2027-01-01', '2027-12-31', false));
  // التأمين القديم محتجز بحق حتى يُسوّى بعد نهاية العقد القديم: ١٬٠٠٠ في الدفتر و١٬٠٠٠ متوقعة
  expect(accountBalance(db, '2400')).toBe(100000);
  const chk = integrityChecks(db).find((x) => x.name === DEPOSIT_CHECK)!;
  expect(chk.value).toBe('1,000.00 / 1,000.00');
  expect(chk.ok).toBe(true);
  db.close();
});
