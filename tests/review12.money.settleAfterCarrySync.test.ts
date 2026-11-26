/**
 * مدقق المرحلة ١ المستقل (2026-11-13) · المال · A1-1 على جهاز المالك في الاتجاه المعاكس · بيانات مصطنعة، والأرقام بالهللة محسوبة باليد.
 *
 * A1-1 (b7aff71) جعل جهاز المالك يرفض من العضو «ترحيل تأمينٍ سُوّي» (deriveSources: carryAfterSettle) · والاتجاه المعاكس بلا حارس على
 * جهاز المالك: «تسوية تأمينٍ رُحِّل» يمنعها التطبيق وحده (saveDepositSettlement: depositCarried)، واشتقاق قيود التسوية على جهاز المالك
 * (deposit_deduct / deposit_refund) لا ينظر في الترحيل.
 *
 * السيناريو:
 *  - عقد (أ) من 2025-07-01 إلى 2025-12-31 بتأمين ١٬٠٠٠٫٠٠ لدى المكتب (يُقبض نقداً)، أنشأه جهاز العضو ووصل جهاز المالك.
 *  - المالك يجدّد (أ) إلى (ب) من 2026-01-01 بترحيل التأمين (قيد deposit_carry) · وجهاز العضو لم يسحب بعد.
 *  - العضو على جهازه (لا يرى التجديد) يسوّي تأمين (أ): ردّه كاملاً نقداً ١٬٠٠٠٫٠٠ في 2026-01-05، ويرفع.
 * الخطأ: جهاز المالك يقبل قيد الردّ وصفّ التسوية · فالتأمين خرج نقداً للمستأجر، وهو في الوقت نفسه محمولٌ في (ب) تأميناً ١٬٠٠٠٫٠٠ تعرض
 * تسويته ردّه ثانية: عيب A1-1 الحرج نفسه بترتيبٍ معاكس · وفحص التأمينات الثالث يحمرّ (الدفتر 0.00 والمحتجز 1,000.00).
 *
 * السلوك الصحيح: جهاز المالك يرفض قيد تسوية تأمينٍ رُحِّل إلى عقدٍ مجدَّد (كما يرفض ترحيل تأمينٍ سُوّي)، فيبقى 2400 = ١٬٠٠٠٫٠٠
 * محمولاً في (ب)، والنقد ١٬٠٠٠٫٠٠ لم يخرج، والفحوص خضراء.
 */
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { confirmContract, renewContract, saveDepositSettlement } from '@/domain/contracts/service';
import { accountBalance } from '@/domain/accounting/ledger';
import { integrityChecks } from '@/domain/accounting/integrity';
import { pair, sync, ownerPulls, has, MEMBER } from './helpers/rederive';
import { getMeta } from '@/repos/settings';

test('A1-1 · جهاز المالك يرفض من العضو تسوية تأمينٍ رُحِّل إلى العقد المجدَّد', async () => {
  const s = await pair();
  const u = addUnit(s.owner, addProperty(s.owner, { name: 'عقار ترحيلٍ ومزامنةٍ مصطنع' }), { unit_no: 'SC-1' });
  await sync(s.owner, s.r);
  await sync(s.dev, s.r);
  // (أ) على جهاز العضو ثم عند المالك
  const a = confirmContract(s.dev, contractInput(u, { tenant: 'مستأجر ترحيلٍ ومزامنةٍ مصطنع', idNumber: '1000012004', phone: '0500012004',
    start: '2025-07-01', end: '2025-12-31', valueHalalas: 600000, depositHalalas: 100000 }));
  await sync(s.dev, s.r);
  const devId = getMeta(s.dev, 'device_id');
  // ما كتبه جهاز العضو وحده بكاتبه العضو
  for (const d of [...s.r.docs.values()]) if (d.dev === devId) s.r.inject({ ...d, by: MEMBER });
  await ownerPulls(s.owner, s.r);
  expect(accountBalance(s.owner, '2400')).toBe(100000);

  // المالك يجدّد بترحيل التأمين · والعضو لم يسحب بعد
  renewContract(s.owner, a, { start: '2026-01-01', end: '2026-06-30', valueHalalas: 600000, cycle: 'شهرية', carryDeposit: true,
    extraDepositHalalas: 0, services: '', furnished: 'غير مؤثثة', ejarNo: '', note: '' });
  await sync(s.owner, s.r);
  expect(accountBalance(s.owner, '2400')).toBe(100000);

  // العضو على جهازه القديم يسوّي تأمين (أ) بردّه كاملاً نقداً ثم يرفع
  saveDepositSettlement(s.dev, a, { date: '2026-01-05', deductionHalalas: 0, deductionReason: '', refundHalalas: 100000, notes: '' });
  const refund = s.dev.get<{ id: string }>(`SELECT id FROM journal_entries WHERE src_type = 'deposit_refund' AND src_id = ?`, [a])!.id;
  await sync(s.dev, s.r);
  for (const d of [...s.r.docs.values()]) {
    if (d.dev === devId) s.r.inject({ ...d, by: MEMBER });
  }
  await ownerPulls(s.owner, s.r);

  // اليوم: قيد الردّ مقبول على جهاز المالك · فالنقد نقص ١٬٠٠٠ و2400 صفر و(ب) يحمل تأميناً ١٬٠٠٠ لم يبقَ، والفحص الثالث أحمر
  expect(has(s.owner, refund)).toBe(false);
  expect([accountBalance(s.owner, '2400'), accountBalance(s.owner, '1100')]).toEqual([100000, 100000]);
  expect(integrityChecks(s.owner).filter((c) => !c.ok).map((c) => c.name)).toEqual([]);
  s.close();
});
