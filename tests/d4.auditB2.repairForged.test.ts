/**
 * المدقق B2 · الجولة الرابعة عشرة · على 52f19cb · «دفعةٌ تصل حيّةً وقيدها معكوسٌ هنا ملغاةٌ بعاكسه» تُلغي دفعةً بعاكسٍ مزوَّر · بياناتٌ
 * مصطنعة كلها.
 *   TZ=Asia/Riyadh npx jest tests/d4.auditB2.repairForged.test.ts
 *
 * B2-5 · عالٍ · src/sync/engine.ts:1791-1798 (الإصلاح: أي عاكسٍ لقيد الدفعة يجعلها ملغاةً بتاريخه، ويرفعها جهاز المالك · engine.ts:2030)
 * مع engine.ts:495-552 (memberReversalCheck يقبل من العضو مرآةً لقيد تحصيلٍ دفعتُه حيّة) · وcancelPayment.ts:205-235 (الإلغاء الحقيقي
 * يعكس حركة البنك ويعيد الرصيد): عضوٌ أمين يعتمد إيداع ماجد لقسط أكتوبر من الكشف فيقبله جهاز المالك · ثم يرفع عضوٌ آخر عاكساً وحده
 * لقيد التحصيل (مرآته، بلا إلغاء الدفعة ولا حركة البنك السالبة) فيقبله جهاز المالك ويربطه، ثم يعيد كتابة صفّ الدفعة كما هو · فيجعلها
 * جهاز المالك «ملغاة» بالعاكس المزوَّر ويرفعها إلى كل الأجهزة: القسط غير مسدَّد والمستأجر يُطالَب ثانيةً، وحركة الإيداع حيّةٌ مطابَقة
 * بالكشف فرصيد البنك 1,000، والنقد 1100 صفر فالمحفظة −1,000 · وفحوص السلامة كلها خضراء (كان «كل دفعة محصَّلة لها قيد مرحّل» أحمر
 * قبل الإصلاح فصار الإصلاح يُخفي الخلل).
 * لماذا يهم: الإصلاح بُني لإلغاءٍ حقيقي (Z1-1) فصار طريقاً لإلغاء أي تحصيلٍ بلا عكس ماله، وبلا أثرٍ في الفحوص، على كل الأجهزة.
 * السلوك الصحيح: لا تُلغى دفعةٌ ويبقى إيداعها في البنك: إما يُرفض العاكس الوحيد (الدفعة حيّة) وإما يكتمل الإلغاء بعكس حركتها ·
 * فالمحفظة صفر، ورصيد البنك يطابق حال الدفعة.
 */
import { addBank, addProperty, addUnit, contractInput } from './helpers/fixtures';
import { sync, ownerPulls, MEMBER, UID } from './helpers/rederive';
import { memDb } from './helpers/testDb';
import { MemoryRemote } from './helpers/memoryRemote';
import { enableSync } from '@/sync/engine';
import { confirmContract } from '@/domain/contracts/service';
import { bankBalance, walletCashBalance } from '@/domain/accounting/ledger';
import { reverseEntryById } from '@/domain/accounting/post';
import { integrityChecks } from '@/domain/accounting/integrity';
import { readStatementGrid } from '@/domain/bankStatement/read';
import { saveStatement } from '@/domain/bankStatement/store';
import { collectionSuggestions, approveCollection } from '@/domain/bankStatement/collect';
import { getMeta } from '@/repos/settings';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('B2-5 · [عالٍ] عاكسٌ وحيد مزوَّر لقيد تحصيلٍ من الكشف ثم صفّ الدفعة كما هو: لا تُلغى الدفعة وإيداعها باقٍ، والمحفظة صفر', async () => {
  const r = new MemoryRemote();
  const owner = memDb(); const m1 = memDb(); const m2 = memDb();
  for (const d of [owner, m1, m2]) enableSync(d, UID);
  const bank = addBank(owner, 'بنك مصطنع B25', 0);
  const prop = addProperty(owner, { name: 'عقار مصطنع B25' });
  confirmContract(owner, contractInput(addUnit(owner, prop, { unit_no: 'B25-1' }), {
    tenant: 'ماجد المصطنع', idNumber: '1000003501', phone: '0500003501', valueHalalas: 1200000, cycle: 'شهرية',
    start: '2026-10-01', end: '2027-09-30', depositHalalas: 0,
  }));
  const g = readStatementGrid([['الرصيد الافتتاحي', '0.00'], ['التاريخ', 'البيان', 'مدين', 'دائن', 'الرصيد'],
    ['2026/10/02', 'حوالة واردة ماجد', '', '1,000.00', '1,000.00']]);
  if (!g.ok) throw new Error(g.error);
  saveStatement(owner, bank, g, { name: 'b25.csv', hash: 'b25' });
  const ids = [getMeta(m1, 'device_id'), getMeta(m2, 'device_id')];
  const mark = () => { for (const d of [...r.docs.values()]) if (ids.includes(d.dev) && d.by !== MEMBER) r.inject({ ...d, by: MEMBER }); };
  const settle = async () => { for (let i = 0; i < 2; i++) { await sync(owner, r); await sync(m1, r); await sync(m2, r); mark(); await ownerPulls(owner, r); } };
  await settle();

  // العضو الأمين يعتمد الإيداع لقسط أكتوبر
  const s = collectionSuggestions(m2, bank)[0];
  approveCollection(m2, s.line.id, s.target);
  await settle();
  const pay = owner.get<{ id: string; je: string }>(`SELECT id, journal_entry_id AS je FROM contract_payments`)!;
  expect([bankBalance(owner, bank), walletCashBalance(owner)]).toEqual([100000, 0]);

  // المزوِّر: عاكسٌ وحده لقيد التحصيل (مرآته، ويُربط به)، بلا إلغاء الدفعة ولا حركة بنكٍ سالبة
  await wait(5);
  reverseEntryById(m1, pay.je, 'عكس مصطنع', '2026-10-02');
  await sync(m1, r); mark(); await ownerPulls(owner, r);
  // ثم يعيد كتابة صفّ الدفعة كما هو
  const pd = [...r.docs.values()].find((d) => d.t === 'contract_payments' && d.k === pay.id)!;
  r.inject({ ...pd, by: MEMBER });
  await ownerPulls(owner, r);
  await settle();

  const cancelled = owner.get<{ c: string | null }>(`SELECT cancelled_at AS c FROM contract_payments WHERE id = ?`, [pay.id])!.c != null;
  const view = {
    wallet: walletCashBalance(owner),
    // الدفعة الملغاة لا يبقى إيداعها في البنك، والحيّة يبقى
    bankMatchesPayment: bankBalance(owner, bank) === (cancelled ? 0 : 100000),
  };
  // (الواقع: الدفعة «ملغاة» بالعاكس المزوَّر على كل الأجهزة، والبنك 1,000، والمحفظة −1,000، والفحوص خضراء)
  expect({ ...view, failing: integrityChecks(owner).filter((x) => !x.ok).map((x) => x.name) })
    .toEqual({ wallet: 0, bankMatchesPayment: true, failing: [] });
  owner.close(); m1.close(); m2.close();
});
