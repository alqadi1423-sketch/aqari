/**
 * المراجعة الشاملة 2026-11-13 · R12-DEP-2 على جهاز المالك · بيانات مصطنعة، والأرقام بالهللة محسوبة باليد.
 *
 * السيناريو كاختبار المدقق (review12.money.carriedDepositArrears): (أ) ستة أقساط ١٬٠٠٠ وتأمين ١٬٠٠٠ نقداً، سُدّد منها خمسة وبقي قسط
 * ديسمبر 2025 · جُدّد إلى (ب) بترحيل التأمين وسُدّدت أقساطه الستة · ثم يسوّي عضوٌ بقسم التأمينات تأمين (ب) على جهازه: خصمه كله ١٬٠٠٠
 * «منها مقابل أقساطٍ متأخرة» ١٬٠٠٠ = قسط ديسمبر في (أ)، ويرفع.
 * الصحيح على جهاز المالك: قيد السداد من التأمين (مصدره (ب) صاحب التأمين) ودفعته على قسط (أ) يُقبلان، فيُسدَّد قسط ديسمبر · 2400 صفر،
 * و4300 صفر، والإيراد ١٢٬٠٠٠ (١١٬٠٠٠ نقداً + ١٬٠٠٠ من التأمين)، والفحوص خضراء · ثم تعديل العضو للتسوية (ردّ التأمين كله بدل الخصم)
 * يعكس السداد ويُقبل كذلك فيعود القسط مستحقاً.
 */
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { confirmContract, recordRentPayment, renewContract, saveDepositSettlement } from '@/domain/contracts/service';
import { accountBalance } from '@/domain/accounting/ledger';
import { integrityChecks } from '@/domain/accounting/integrity';
import { pair, sync, ownerPulls, has, reasonOf, MEMBER } from './helpers/rederive';
import { getMeta } from '@/repos/settings';
import type { DB } from '@/db/adapter';

const instOf = (db: DB, id: string) =>
  db.get<{ s: string; p: number }>(`SELECT status AS s, paid_halalas AS p FROM contract_installments WHERE id = ?`, [id]);

test('R12-DEP-2 · جهاز المالك يقبل من العضو سداد قسط العقد السابق من التأمين المرحَّل وتعديله', async () => {
  const s = await pair();
  const u = addUnit(s.owner, addProperty(s.owner, { name: 'عقار سلسلة ترحيلٍ مصطنع' }), { unit_no: 'CM-1' });
  const a = confirmContract(s.owner, contractInput(u, { tenant: 'مستأجر سلسلة ترحيلٍ مصطنع', idNumber: '1000012021', phone: '0500012021',
    start: '2025-07-01', end: '2025-12-31', valueHalalas: 600000, depositHalalas: 100000 }));
  const ia = s.owner.all<{ id: string; due_date: string }>(`SELECT id, due_date FROM contract_installments WHERE contract_id = ? ORDER BY due_date`, [a]);
  for (const i of ia.slice(0, 5)) {
    recordRentPayment(s.owner, a, { installmentId: i.id, period: '', date: i.due_date, lines: [{ method: 'cash', amountHalalas: 100000 }], discountHalalas: 0, notes: '' });
  }
  const b = renewContract(s.owner, a, { start: '2026-01-01', end: '2026-06-30', valueHalalas: 600000, cycle: 'شهرية', carryDeposit: true,
    extraDepositHalalas: 0, services: '', furnished: 'غير مؤثثة', ejarNo: '', note: '' });
  for (const i of s.owner.all<{ id: string; due_date: string }>(`SELECT id, due_date FROM contract_installments WHERE contract_id = ? ORDER BY due_date`, [b])) {
    recordRentPayment(s.owner, b, { installmentId: i.id, period: '', date: i.due_date, lines: [{ method: 'cash', amountHalalas: 100000 }], discountHalalas: 0, notes: '' });
  }
  await sync(s.owner, s.r);
  await sync(s.dev, s.r);
  const devId = getMeta(s.dev, 'device_id');
  const asMember = () => { for (const d of [...s.r.docs.values()]) if (d.dev === devId) s.r.inject({ ...d, by: MEMBER }); };

  // العضو يسوّي (ب): التأمين كله مقابل قسط ديسمبر في (أ)
  saveDepositSettlement(s.dev, b, { date: '2026-07-05', deductionHalalas: 100000, deductionReason: 'إيجار ديسمبر 2025 غير المدفوع',
    refundHalalas: 0, notes: '', arrearsHalalas: 100000 });
  const rent = s.dev.get<{ id: string }>(`SELECT id FROM journal_entries WHERE src_type = 'deposit_rent'`)!.id;
  await sync(s.dev, s.r);
  asMember();
  await ownerPulls(s.owner, s.r);

  expect(reasonOf(s.owner, rent)).toBe('');
  expect(has(s.owner, rent)).toBe(true);
  expect(instOf(s.owner, ia[5].id)).toEqual({ s: 'مدفوعة', p: 100000 });
  // 2400 = ١٠٠٬٠٠٠ − ١٠٠٬٠٠٠ سداد · 4300 صفر · 4200 = ١١٬٠٠٠ نقداً + ١٬٠٠٠ من التأمين · والنقد ١٢٬٠٠٠ (١١٬٠٠٠ إيجار + ١٬٠٠٠ تأمين)
  expect([accountBalance(s.owner, '2400'), accountBalance(s.owner, '4300'), accountBalance(s.owner, '4200'), accountBalance(s.owner, '1100')])
    .toEqual([0, 0, 1200000, 1200000]);
  // والتزام 2400 من (ب) صاحب التأمين، والإيراد على (أ) عقد القسط
  const dimsOf = (acc: string) => s.owner.all<{ c: string }>(`SELECT contract_id AS c FROM journal_lines WHERE entry_id = ? AND account_code = ?`, [rent, acc]).map((x) => x.c);
  expect(dimsOf('2400')).toEqual([b]);
  expect(dimsOf('4200')).toEqual([a]);
  expect(integrityChecks(s.owner).filter((c) => !c.ok).map((c) => c.name)).toEqual([]);

  // العضو يعدّل التسوية: ردّ التأمين كله بدل الخصم · فيُعكس السداد ويعود قسط ديسمبر مستحقاً على جهاز المالك
  await sync(s.dev, s.r);
  saveDepositSettlement(s.dev, b, { date: '2026-07-05', deductionHalalas: 0, deductionReason: '', refundHalalas: 100000, notes: '', arrearsHalalas: 0 });
  await sync(s.dev, s.r);
  asMember();
  await ownerPulls(s.owner, s.r);
  expect(s.owner.all(`SELECT tbl, reason FROM sync_rejects`)).toEqual([]);
  expect(instOf(s.owner, ia[5].id)).toEqual({ s: 'مستحقة', p: 0 });
  // 2400 صفر (رُدّ) · 4200 = ١١٬٠٠٠ نقداً · والنقد ١١٬٠٠٠ (١٢٬٠٠٠ − ١٬٠٠٠ ردّ)
  expect([accountBalance(s.owner, '2400'), accountBalance(s.owner, '4300'), accountBalance(s.owner, '4200'), accountBalance(s.owner, '1100')])
    .toEqual([0, 0, 1100000, 1100000]);
  expect(integrityChecks(s.owner).filter((c) => !c.ok).map((c) => c.name)).toEqual([]);
  s.close();
});
