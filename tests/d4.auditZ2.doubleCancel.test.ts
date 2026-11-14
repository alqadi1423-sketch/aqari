/**
 * المدقق Z2 · الجولة الثالثة عشرة · على db011e7 · الدفعة التي التقت من اعتمادَي عضوين يلغيها كلٌّ منهما بلا اتصال · بياناتٌ مصطنعة كلها.
 *   TZ=Asia/Riyadh npx jest tests/d4.auditZ2.doubleCancel.test.ts
 *
 * Z2-2 · عالٍ · src/sync/engine.ts:1295-1308 (collectionRowCheck: إلغاء الدفعة بعاكسها المسمّى في cancel_entry_id وحده) مع
 * src/sync/engine.ts:539-549 (memberReversalCheck: العاكس الثاني لأصلٍ معكوس ينتظر ثم يُرفض) وsrc/domain/contracts/cancelPayment.ts:205-226:
 * عضوان يعتمدان الإيداع نفسه للقسط نفسه فيلتقي الاعتمادان دفعةً واحدة بمعرّفاتها الحتمية (W1)، فيراها كلٌّ منهما دفعته · ثم يتبيّن أن
 * الإيداع ليس للمستأجر فيلغيها كلٌّ منهما بلا اتصال بعاكسٍ وحركة بنكٍ سالبة من عنده · السحابة تحمل صفّ الدفعة الأحدث (إلغاء الثاني
 * بعاكسه R2)، وجهاز المالك لم يرَ إلغاء الأول قط: يقبل R1 (أول العاكسين) فيُعكس قيد الدفعة وتُطبَّق حركته السالبة، ويحبس R2 «عاكساً
 * زائداً» حتى يُرفض، وإلغاء الدفعة المسمّي R2 ينتظره ثم يُرفض · فتبقى الدفعة على جهاز المالك حيّةً أبداً وقيدها معكوس: القسط «مسدَّد»
 * 1,000 والبنك صفر، وفحص «كل دفعة محصَّلة لها قيد مرحّل» أحمر · وإلغاؤها ثانيةً من جهاز المالك لا قيد له يُعكس فيُخرج من البنك حركةً
 * سالبة أخرى بلا قيد.
 * لماذا يهم: الدمج الحتمي جعل الدفعة الواحدة «دفعة» كل عضوٍ اعتمدها، فإلغاؤها من كليهما مسارٌ طبيعي · والمستأجر يظهر مسدِّداً لقسطٍ
 * لا مال له في البنك ولا إيراد، بعد قرارين صريحين بالإلغاء.
 * السلوك الصحيح: الدفعة ملغاةٌ على جهاز المالك بعاكسٍ واحدٍ مقبول (الإلغاءان إلغاءٌ واحد): القسط غير مسدَّد، والبنك صفر، والفحوص خضراء.
 */
import { addBank, addProperty, addUnit, contractInput } from './helpers/fixtures';
import { sync, ownerPulls, MEMBER, UID } from './helpers/rederive';
import { memDb } from './helpers/testDb';
import { MemoryRemote } from './helpers/memoryRemote';
import { enableSync } from '@/sync/engine';
import { confirmContract } from '@/domain/contracts/service';
import { cancelPayment } from '@/domain/contracts/cancelPayment';
import { bankBalance } from '@/domain/accounting/ledger';
import { integrityChecks } from '@/domain/accounting/integrity';
import { readStatementGrid } from '@/domain/bankStatement/read';
import { saveStatement } from '@/domain/bankStatement/store';
import { collectionSuggestions, approveCollection } from '@/domain/bankStatement/collect';
import { getMeta } from '@/repos/settings';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('Z2-2 · [عالٍ] عضوان اعتمدا الإيداع نفسه (دفعةٌ واحدة) ثم ألغاها كلٌّ منهما بلا اتصال: على جهاز المالك الدفعة ملغاة والقسط غير مسدَّد والفحوص خضراء', async () => {
  const r = new MemoryRemote();
  const owner = memDb(); const m1 = memDb(); const m2 = memDb();
  for (const d of [owner, m1, m2]) enableSync(d, UID);
  const ids = [getMeta(m1, 'device_id'), getMeta(m2, 'device_id')];
  const settle = async () => {
    for (let i = 0; i < 3; i++) {
      await sync(owner, r); await sync(m1, r); await sync(m2, r);
      for (const d of [...r.docs.values()]) if (ids.includes(d.dev) && d.by !== MEMBER) r.inject({ ...d, by: MEMBER });
      await ownerPulls(owner, r);
    }
  };
  const bank = addBank(owner, 'بنك مصطنع Z2-2', 0);
  const prop = addProperty(owner, { name: 'عقار مصطنع Z2-2' });
  const c = confirmContract(owner, contractInput(addUnit(owner, prop, { unit_no: 'Z22-1' }), {
    tenant: 'ماجد المصطنع', idNumber: '1000002201', phone: '0500002201', valueHalalas: 1200000, cycle: 'شهرية',
    start: '2026-10-01', end: '2027-09-30', depositHalalas: 0,
  }));
  const g = readStatementGrid([['الرصيد الافتتاحي', '0.00'], ['التاريخ', 'البيان', 'مدين', 'دائن', 'الرصيد'],
    ['2026/10/02', 'حوالة واردة ماجد', '', '1,000.00', '1,000.00']]);
  if (!g.ok) throw new Error(g.error);
  saveStatement(owner, bank, g, { name: 'z22-oct.csv', hash: 'z22' });
  await settle();

  // العضوان يعتمدان الاقتراح نفسه بلا اتصال · فيلتقي الاعتمادان دفعةً واحدة (W1 سليم)
  for (const d of [m1, m2]) { const s = collectionSuggestions(d, bank)[0]; approveCollection(d, s.line.id, s.target); }
  await settle();
  const pays = owner.all<{ id: string }>(`SELECT id FROM contract_payments WHERE contract_id = ?`, [c]);
  expect([pays.length, bankBalance(owner, bank)]).toEqual([1, 100000]);

  // ثم يلغيها كلٌّ منهما بلا اتصال (الإيداع ليس للمستأجر)
  cancelPayment(m1, pays[0].id, { date: '2026-10-03', reason: 'الإيداع ليس للمستأجر (العضو الأول)' });
  await wait(5);
  cancelPayment(m2, pays[0].id, { date: '2026-10-03', reason: 'الإيداع ليس للمستأجر (العضو الثاني)' });
  await settle();
  // وما انتظر في الوارد بلغ حدّ الانتظار (ثلاثون يوماً) فيُحسم كما يُحسم على الجهاز الحقيقي
  owner.run(`UPDATE sync_inbox SET waiting_since = '2026-01-01T00:00:00.000Z', attempts = 50`);
  await ownerPulls(owner, r);

  const state = {
    livePayments: Number(owner.get<{ n: number }>(`SELECT COUNT(*) AS n FROM contract_payments WHERE contract_id = ? AND cancelled_at IS NULL`, [c])!.n),
    paid: Number(owner.get<{ n: number }>(`SELECT paid_halalas AS n FROM contract_installments WHERE contract_id = ? ORDER BY due_date, sort LIMIT 1`, [c])!.n),
    bank: bankBalance(owner, bank),
    failing: integrityChecks(owner).filter((x) => !x.ok).map((x) => x.name),
  };
  // (الواقع: الدفعة حيّةٌ وقيدها معكوس، والقسط مسدَّد 1,000، والبنك صفر، و«كل دفعة محصَّلة لها قيد مرحّل» أحمر)
  expect(state).toEqual({ livePayments: 0, paid: 0, bank: 0, failing: [] });
  owner.close(); m1.close(); m2.close();
});
