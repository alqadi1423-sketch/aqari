/**
 * المراجعة الشاملة 2026-11-13 · R12-DEP-1 (فقرة ALSO من المشكك) · بيانات مصطنعة، والأرقام بالهللة محسوبة باليد.
 *
 * السيناريو:
 *  - عقد (أ) من 2025-07-01 إلى 2025-12-31 بتأمين ١٬٠٠٠٫٠٠ لدى المكتب على جهاز المالك، ووصل جهاز العضو.
 *  - المالك يسوّي تأمين (أ) في 2026-01-02 بردّه كاملاً نقداً · وجهاز العضو لم يسحب بعد.
 *  - العضو على جهازه القديم يجدّد (أ) إلى (ب) بترحيل التأمين وزيادةٍ ٥٠٠٫٠٠ قبضها نقداً فعلاً، ويرفع.
 * الخطأ: جهاز المالك يرفض قيد الترحيل (carryAfterSettle) · وقيد الزيادة (contract_deposit) ينتظر ترحيلاً لن يصل، فلا تدخل دفاتر المالك
 *  الـ٥٠٠ المقبوضة، و(ب) يحمل في صفّه ١٬٥٠٠ تعرض تسويته ردّها.
 * الصحيح: تأمين (ب) في صفّه ما قُبض له فعلاً (٥٠٠)، وقيد الزيادة يُرحَّل · فالنقد والتأمينات ٥٠٠ والفحص الثالث أخضر، وتسوية (ب) لا
 *  تردّ أكثر من ٥٠٠.
 */
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { confirmContract, renewContract, saveDepositSettlement } from '@/domain/contracts/service';
import { accountBalance } from '@/domain/accounting/ledger';
import { integrityChecks } from '@/domain/accounting/integrity';
import { pair, sync, ownerPulls, has, reasonOf, holdBack, MEMBER } from './helpers/rederive';

const DEPOSIT_CHECK = 'تأمينات المستأجرين = التأمينات المحتجزة (غير المُسوَّاة)';

test('R12-DEP-1 · ترحيلٌ رفضه جهاز المالك مع زيادةٍ قُبضت: الزيادة تدخل الدفتر وتأمين المجدَّد بقدرها', async () => {
  const s = await pair();
  const u = addUnit(s.owner, addProperty(s.owner, { name: 'عقار زيادة تأمينٍ مصطنع' }), { unit_no: 'CX-1' });
  await sync(s.owner, s.r);
  await sync(s.dev, s.r);
  const a = confirmContract(s.owner, contractInput(u, { tenant: 'مستأجر زيادة تأمينٍ مصطنع', idNumber: '1000012011', phone: '0500012011',
    start: '2025-07-01', end: '2025-12-31', valueHalalas: 600000, depositHalalas: 100000 }));
  await sync(s.owner, s.r);
  await sync(s.dev, s.r);

  // المالك يردّ التأمين · والعضو لم يسحب
  saveDepositSettlement(s.owner, a, { date: '2026-01-02', deductionHalalas: 0, deductionReason: '', refundHalalas: 100000, notes: '' });
  await sync(s.owner, s.r);
  // ١٠٠٬٠٠٠ قُبضت ثم رُدّت: النقد والتأمينات صفر
  expect([accountBalance(s.owner, '2400'), accountBalance(s.owner, '1100')]).toEqual([0, 0]);

  // العضو يجدّد بترحيل التأمين وزيادة ٥٠٠٫٠٠ نقداً على جهازه القديم ويرفع
  const b = renewContract(s.dev, a, { start: '2026-01-01', end: '2026-06-30', valueHalalas: 600000, cycle: 'شهرية', carryDeposit: true,
    extraDepositHalalas: 50000, services: '', furnished: 'غير مؤثثة', ejarNo: '', note: '' });
  const carry = s.dev.get<{ id: string }>(`SELECT id FROM journal_entries WHERE src_type = 'deposit_carry'`)!.id;
  const extra = s.dev.get<{ id: string }>(`SELECT id FROM journal_entries WHERE src_type = 'contract_deposit' AND src_id = ?`, [b])!.id;
  await sync(s.dev, s.r);
  for (const d of [...s.r.docs.values()]) {
    const his = (d.t === 'journal_entries' && (d.k === carry || d.k === extra)) || (d.t === 'contracts' && d.k === b)
      || (d.t === 'contract_installments' && d.d?.contract_id === b);
    if (his) s.r.inject({ ...d, by: MEMBER });
  }
  await ownerPulls(s.owner, s.r);

  // الترحيل مرفوض (تأمين (أ) سُوّي) · والزيادة المقبوضة مرحّلة
  expect(has(s.owner, carry)).toBe(false);
  expect(reasonOf(s.owner, carry)).not.toBe('');
  expect(has(s.owner, extra)).toBe(true);
  // النقد = ١٠٠٬٠٠٠ قبض (أ) − ١٠٠٬٠٠٠ ردّه + ٥٠٬٠٠٠ زيادة (ب) = ٥٠٬٠٠٠ · والتأمينات كذلك
  expect([accountBalance(s.owner, '2400'), accountBalance(s.owner, '1100')]).toEqual([50000, 50000]);
  // تأمين (ب) في صفّه = ١٥٠٬٠٠٠ كتبها العضو − ١٠٠٬٠٠٠ ترحيلٌ مرفوض = ٥٠٬٠٠٠
  expect(Number(s.owner.get<{ d: number }>(`SELECT deposit_halalas AS d FROM contracts WHERE id = ?`, [b])!.d)).toBe(50000);
  expect(integrityChecks(s.owner).find((c) => c.name === DEPOSIT_CHECK)?.ok).toBe(true);

  // وبعد انتهاء (ب): ردّ ١٬٥٠٠ مرفوض، وردّ الـ٥٠٠ يُقبل فيصير النقد والتأمينات صفراً
  expect(() => saveDepositSettlement(s.owner, b, { date: '2026-07-05', deductionHalalas: 0, deductionReason: '', refundHalalas: 150000, notes: '' })).toThrow();
  saveDepositSettlement(s.owner, b, { date: '2026-07-05', deductionHalalas: 0, deductionReason: '', refundHalalas: 50000, notes: '' });
  expect([accountBalance(s.owner, '2400'), accountBalance(s.owner, '1100')]).toEqual([0, 0]);

  // والمصحَّح يعود إلى السحابة فيأخذه جهاز العضو (لا يُطرح المرحَّل منه ثانيةً حين يعود)
  await sync(s.owner, s.r);
  await ownerPulls(s.owner, s.r);
  expect(Number(s.owner.get<{ d: number }>(`SELECT deposit_halalas AS d FROM contracts WHERE id = ?`, [b])!.d)).toBe(50000);
  await sync(s.dev, s.r);
  expect(Number(s.dev.get<{ d: number }>(`SELECT deposit_halalas AS d FROM contracts WHERE id = ?`, [b])!.d)).toBe(50000);
  s.close();
});

test('R12-DEP-1 · صفّ المجدَّد طُبِّق قبل رفض ترحيله: يُصحَّح تأمينه بعد الرفض ويُرفع', async () => {
  const s = await pair();
  const u = addUnit(s.owner, addProperty(s.owner, { name: 'عقار ترحيلٍ متأخرٍ مصطنع' }), { unit_no: 'CX-2' });
  await sync(s.owner, s.r);
  await sync(s.dev, s.r);
  const a = confirmContract(s.owner, contractInput(u, { tenant: 'مستأجر ترحيلٍ متأخرٍ مصطنع', idNumber: '1000012012', phone: '0500012012',
    start: '2025-07-01', end: '2025-12-31', valueHalalas: 600000, depositHalalas: 100000 }));
  await sync(s.owner, s.r);
  await sync(s.dev, s.r);

  // العضو يجدّد بترحيل التأمين بلا زيادة ويرفع · وصفّ (أ) المجدَّد يتأخر وصوله فينتظره قيد الترحيل
  const b = renewContract(s.dev, a, { start: '2026-01-01', end: '2026-06-30', valueHalalas: 600000, cycle: 'شهرية', carryDeposit: true,
    extraDepositHalalas: 0, services: '', furnished: 'غير مؤثثة', ejarNo: '', note: '' });
  const carry = s.dev.get<{ id: string }>(`SELECT id FROM journal_entries WHERE src_type = 'deposit_carry'`)!.id;
  await sync(s.dev, s.r);
  for (const d of [...s.r.docs.values()]) {
    const his = (d.t === 'journal_entries' && d.k === carry) || (d.t === 'contracts' && (d.k === b || d.k === a))
      || (d.t === 'contract_installments' && d.d?.contract_id === b);
    if (his) s.r.inject({ ...d, by: MEMBER });
  }
  const late = holdBack(s.r, (d) => d.t === 'contracts' && d.k === a);
  await ownerPulls(s.owner, s.r);
  // (ب) طُبِّق بتأمينه ١٠٠٬٠٠٠ والترحيل ينتظر
  expect(has(s.owner, carry)).toBe(false);
  expect(Number(s.owner.get<{ d: number }>(`SELECT deposit_halalas AS d FROM contracts WHERE id = ?`, [b])!.d)).toBe(100000);

  // المالك يسوّي (أ) بردّه نقداً قبل أن يصله التجديد كاملاً، ثم يصل صفّ (أ)
  saveDepositSettlement(s.owner, a, { date: '2026-01-02', deductionHalalas: 0, deductionReason: '', refundHalalas: 100000, notes: '' });
  late.release();
  await ownerPulls(s.owner, s.r);
  expect(has(s.owner, carry)).toBe(false);
  expect(reasonOf(s.owner, carry)).not.toBe('');
  // تأمين (ب) = ١٠٠٬٠٠٠ − ١٠٠٬٠٠٠ ترحيلٌ مرفوض = صفر · والدفتر صفر (قبض ١٠٠٬٠٠٠ وردّها)
  expect(Number(s.owner.get<{ d: number }>(`SELECT deposit_halalas AS d FROM contracts WHERE id = ?`, [b])!.d)).toBe(0);
  expect([accountBalance(s.owner, '2400'), accountBalance(s.owner, '1100')]).toEqual([0, 0]);
  expect(integrityChecks(s.owner).find((c) => c.name === DEPOSIT_CHECK)?.ok).toBe(true);
  // ويُرفع المصحَّح فيأخذه جهاز العضو
  await sync(s.owner, s.r);
  await sync(s.dev, s.r);
  expect(Number(s.dev.get<{ d: number }>(`SELECT deposit_halalas AS d FROM contracts WHERE id = ?`, [b])!.d)).toBe(0);
  s.close();
});
