/**
 * مدقق المرحلة ١ المستقل (2026-11-13) · المال · حارس A1-1 على جهاز المالك (deriveSources: carryAfterSettle) نصفُ حارس · بيانات مصطنعة،
 * والأرقام بالهللة محسوبة باليد.
 *
 * السيناريو:
 *  - عقد (أ) من 2025-07-01 إلى 2025-12-31 بتأمين ١٬٠٠٠٫٠٠ لدى المكتب على جهاز المالك، ووصل جهاز العضو.
 *  - المالك يسوّي تأمين (أ) في 2026-01-02 بردّه كاملاً نقداً ١٬٠٠٠٫٠٠ · وجهاز العضو لم يسحب بعد.
 *  - العضو على جهازه (لا يرى التسوية) يجدّد (أ) إلى (ب) من 2026-01-01 بترحيل التأمين ويرفع.
 *  - جهاز المالك يرفض قيد الترحيل «ترحيل تأمينٍ سُوّي قبل التجديد» كما أراد A1-1 · لكنه يقبل صفّ (ب) وفيه deposit_halalas = ١٬٠٠٠٫٠٠:
 *    تأمينٌ لم يُقبض ولم يُرحَّل · فحص التأمينات الثالث أحمر (0.00 / 1,000.00).
 *  - انتهى (ب) فسوّى المالك تأمينه بردّه ١٬٠٠٠٫٠٠ كما تعرضه الشاشة (القيمة من deposit_halalas) · فيُقبل ويخرج النقد ثانية.
 * الخطأ: التأمين يُردّ مرتين (عيب A1-1 الحرج) رغم رفض قيد الترحيل · وخطة A1-1 «والأدق أن يُرحَّل المتبقي الحيّ في 2400 بدل
 * deposit_halalas» لم تُنفَّذ، فالتسوية تثق بعمود العقد لا بما في الدفتر له.
 *
 * السلوك الصحيح: لا يخرج نقدٌ ثانٍ: إمّا يُصحَّح تأمين (ب) إلى ما قُبض له فعلاً (صفر) حين يُرفض ترحيله، وإمّا ترفض التسوية ردّاً يتجاوز
 * التزام العقد الحيّ في 2400 · فبعد محاولة الردّ يبقى 2400 = صفراً والنقد ١٬٠٠٠٫٠٠ (إيداع المالك) كما هو.
 */
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { confirmContract, renewContract, saveDepositSettlement } from '@/domain/contracts/service';
import { accountBalance } from '@/domain/accounting/ledger';
import { ownerCashIn } from '@/domain/cashOps';
import { pair, sync, ownerPulls, has, reasonOf, MEMBER } from './helpers/rederive';

test('A1-1 · ترحيلٌ رفضه جهاز المالك لا يترك في العقد المجدَّد تأميناً يُردّ ثانية', async () => {
  const s = await pair();
  const u = addUnit(s.owner, addProperty(s.owner, { name: 'عقار ترحيلٍ مرفوضٍ مصطنع' }), { unit_no: 'RC-1' });
  await sync(s.owner, s.r);
  await sync(s.dev, s.r);
  const a = confirmContract(s.owner, contractInput(u, { tenant: 'مستأجر ترحيلٍ مرفوضٍ مصطنع', idNumber: '1000012005', phone: '0500012005',
    start: '2025-07-01', end: '2025-12-31', valueHalalas: 600000, depositHalalas: 100000 }));
  await sync(s.owner, s.r);
  await sync(s.dev, s.r);

  // المالك يردّ التأمين · والعضو لم يسحب
  saveDepositSettlement(s.owner, a, { date: '2026-01-02', deductionHalalas: 0, deductionReason: '', refundHalalas: 100000, notes: '' });
  await sync(s.owner, s.r);

  // العضو يجدّد بترحيل التأمين على جهازه القديم ويرفع
  const b = renewContract(s.dev, a, { start: '2026-01-01', end: '2026-06-30', valueHalalas: 600000, cycle: 'شهرية', carryDeposit: true,
    extraDepositHalalas: 0, services: '', furnished: 'غير مؤثثة', ejarNo: '', note: '' });
  const carry = s.dev.get<{ id: string }>(`SELECT id FROM journal_entries WHERE src_type = 'deposit_carry'`)!.id;
  await sync(s.dev, s.r);
  for (const d of [...s.r.docs.values()]) {
    const his = (d.t === 'journal_entries' && d.d?.src_type === 'deposit_carry') || (d.t === 'contracts' && d.k === b)
      || (d.t === 'contract_installments' && d.d?.contract_id === b);
    if (his) s.r.inject({ ...d, by: MEMBER });
  }
  await ownerPulls(s.owner, s.r);
  // حارس A1-1 يرفض قيد الترحيل (هذا يعمل)
  expect(has(s.owner, carry)).toBe(false);
  expect(reasonOf(s.owner, carry)).not.toBe('');

  // نقدٌ آخر للمالك يكفي أي ردّ، ثم تسوية (ب) بعد انتهائه بالردّ الذي تعرضه الشاشة
  ownerCashIn(s.owner, { amountHalalas: 100000, date: '2026-07-01' });
  expect([accountBalance(s.owner, '2400'), accountBalance(s.owner, '1100')]).toEqual([0, 100000]);
  try {
    saveDepositSettlement(s.owner, b, { date: '2026-07-05', deductionHalalas: 0, deductionReason: '', refundHalalas: 100000, notes: '' });
  } catch { /* الرفض هو السلوك الصحيح */ }
  // اليوم: الردّ يُقبل · 2400 = −١٬٠٠٠ والنقد صفر: التأمين رُدّ مرتين
  expect([accountBalance(s.owner, '2400'), accountBalance(s.owner, '1100')]).toEqual([0, 100000]);
  s.close();
});
