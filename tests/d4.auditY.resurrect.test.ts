/**
 * المدقق Y · الجولة الثانية عشرة · المعرّفات الحتمية لاعتماد التحصيل من كشف البنك (collect.ts: approveCollection) تُحيي تحصيلاً أُلغي ·
 * بياناتٌ مصطنعة كلها.
 *   TZ=Asia/Riyadh npx jest tests/d4.auditY.resurrect.test.ts
 *
 * السبب المشترك: رقم الاعتماد (attempt) يُحسب من دفتر الجهاز وحده (collect.ts:221)، فجهازٌ لم يصله الإلغاء بعد يعتمد السطر للهدف
 * نفسه بالمعرّفات نفسها التي ألغاها الجهاز الآخر · وصفوف الدفعة والفاتورة «الأحدث يغلب»، فتعود نسخة الاعتماد الثاني فوق الإلغاء،
 * والقيد المرحّل معكوسٌ لا يعود · فيبقى المستند «محصَّلاً» وقيده معكوس وحركة بنكه مقابَلة بسالبة.
 * قبل المعرّفات الحتمية كان الاعتماد الثاني تحصيلاً مستقلاً متسقاً (مكرراً · W1)، والآن صار تحصيلاً نصفه ملغى ونصفه حيّ.
 */
import { addBank, addProperty, addUnit, contractInput } from './helpers/fixtures';
import { pair, sync, ownerPulls, MEMBER } from './helpers/rederive';
import { confirmContract } from '@/domain/contracts/service';
import { cancelPayment } from '@/domain/contracts/cancelPayment';
import { saveInvoice, setInvoiceStatus } from '@/domain/invoices';
import { bankBalance } from '@/domain/accounting/ledger';
import { integrityChecks } from '@/domain/accounting/integrity';
import { readStatementGrid } from '@/domain/bankStatement/read';
import { saveStatement } from '@/domain/bankStatement/store';
import { collectionSuggestions, approveCollection } from '@/domain/bankStatement/collect';
import { getMeta } from '@/repos/settings';
import type { MemoryRemote } from './helpers/memoryRemote';
import type { DB } from '@/db/adapter';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const HEAD = ['التاريخ', 'البيان', 'مدين', 'دائن', 'الرصيد'];
function grid(rows: string[][]) {
  const r = readStatementGrid([['الرصيد الافتتاحي', '0.00'], HEAD, ...rows]);
  if (!r.ok) throw new Error(r.error);
  return r;
}
/** ما كتبه الجهاز الثاني بكاتبه العضو، ثم جولات مزامنة حتى يستقر الجهازان */
async function settle(p: { owner: DB; dev: DB; r: MemoryRemote }) {
  await sync(p.owner, p.r);
  await sync(p.dev, p.r);
  const devId = getMeta(p.dev, 'device_id');
  for (const d of [...p.r.docs.values()]) if (d.dev === devId) p.r.inject({ ...d, by: MEMBER });
  await ownerPulls(p.owner, p.r);
  await sync(p.dev, p.r);
  await ownerPulls(p.owner, p.r);
  await sync(p.dev, p.r);
}
const failing = (db: DB) => integrityChecks(db).filter((x) => !x.ok).map((x) => x.name);

describe('Y1 · [عالٍ] دفعةٌ ألغاها المالك تعود حيّةً بقيدٍ معكوس حين يعتمد جهازٌ آخر السطر نفسه بعد الإلغاء (collect.ts:221 · engine.ts:1247)', () => {
  // المالك يعتمد إيداع 2 أكتوبر لقسط ماجد ثم يلغي الدفعة (الإيداع ليس له) · وجهاز العضو بلا اتصال يعتمد الاقتراح نفسه بعد ذلك ·
  // المعرّفات واحدة، فصفّ الدفعة من العضو (الأحدث) يمحو إلغاء المالك، وحارس الدفعة على جهاز المالك يفحص الإلغاء ولا يفحص فكّه ·
  // النتيجة على الجهازين: القسط «مدفوعة» والدفعة حيّة وقيدها معكوس، ورصيد البنك صفر، وفحص «كل دفعة محصَّلة لها قيد» أحمر ·
  // وإلغاء الدفعة ثانيةً لا قيد له يُعكس فيُخرج من البنك حركةً سالبة بلا قيد.
  // لماذا يهم: المستأجر يظهر مسدِّداً لقسطٍ لا مال له في البنك ولا إيراد في الدفتر، بعد قرارٍ صريح من المالك بالإلغاء.
  test('اعتماد → إلغاء الدفعة على جهاز المالك، واعتمادٌ للهدف نفسه بعده على جهاز العضو: بعد المزامنة لا دفعة حيّة بقيدٍ معكوس، والفحوص خضراء', async () => {
    const p = await pair();
    const bank = addBank(p.owner, 'بنك مصطنع Y1', 0);
    const prop = addProperty(p.owner, { name: 'عقار مصطنع Y1' });
    const c = confirmContract(p.owner, contractInput(addUnit(p.owner, prop, { unit_no: 'Y1-1' }), {
      tenant: 'ماجد المصطنع', idNumber: '1000000931', phone: '0500000931', valueHalalas: 1200000, cycle: 'شهرية',
      start: '2026-10-01', end: '2027-09-30', depositHalalas: 0,
    }));
    saveStatement(p.owner, bank, grid([['2026/10/02', 'حوالة واردة ماجد', '', '1,000.00', '1,000.00']]), { name: 'y1-oct.csv', hash: 'y1' });
    await sync(p.owner, p.r);
    await sync(p.dev, p.r);

    const so = collectionSuggestions(p.owner, bank)[0];
    approveCollection(p.owner, so.line.id, so.target);
    const pay = p.owner.get<{ id: string }>(`SELECT id FROM contract_payments WHERE contract_id = ?`, [c])!.id;
    cancelPayment(p.owner, pay, { date: '2026-10-02', reason: 'الإيداع ليس للمستأجر' });
    await wait(5);
    // العضو بلا اتصال لا يعرف الإلغاء: يعتمد الاقتراح نفسه بعده
    const sd = collectionSuggestions(p.dev, bank)[0];
    approveCollection(p.dev, sd.line.id, sd.target);
    await settle(p);

    const liveOnReversed = (db: DB) => Number(db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM contract_payments p JOIN journal_entries e ON e.id = p.journal_entry_id
       WHERE p.contract_id = ? AND p.cancelled_at IS NULL AND e.reversed_by IS NOT NULL`, [c])!.n);
    const firstPaid = (db: DB) => Number(db.get<{ n: number }>(
      `SELECT paid_halalas AS n FROM contract_installments WHERE contract_id = ? ORDER BY due_date, sort LIMIT 1`, [c])!.n);
    // الصحيح: إما يبقى الإلغاء (القسط مستحق والبنك صفر) وإما تحصيلٌ حيٌّ كامل (القسط مدفوع والبنك 1,000) · لا نصفٌ من هذا ونصفٌ من ذاك
    // (الواقع: دفعةٌ حيّة بقيدٍ معكوس على الجهازين، والقسط مسدَّد 1,000 والبنك صفر، وفحص «كل دفعة محصَّلة لها قيد» أحمر)
    expect({
      owner: { failing: failing(p.owner), liveOnReversed: liveOnReversed(p.owner), paidMatchesBank: firstPaid(p.owner) === bankBalance(p.owner, bank) },
      dev: { liveOnReversed: liveOnReversed(p.dev), paidMatchesBank: firstPaid(p.dev) === bankBalance(p.dev, bank) },
    }).toEqual({
      owner: { failing: [], liveOnReversed: 0, paidMatchesBank: true },
      dev: { liveOnReversed: 0, paidMatchesBank: true },
    });
    p.close();
  });
});

describe('Y2 · [عالٍ] فاتورةٌ أُعيدت «مستحقة» تعود «مدفوعة» بقيد تحصيلٍ معكوس حين يعتمد جهازٌ آخر السطر نفسه بعد ذلك (collect.ts:221 · engine.ts:1822)', () => {
  // المالك يعتمد إيداع 12 أكتوبر لتحصيل الفاتورة ثم يعيدها «مستحقة» (يُعكس قيد التحصيل وتقابله حركة بنكٍ سالبة) · وجهاز العضو بلا
  // اتصال يعتمد الاقتراح نفسه بعد ذلك بالمعرّفات نفسها · صفّ الفاتورة الأحدث يغلب بلا حارس: «مدفوعة» وقيد تحصيلها هو القيد المعكوس ·
  // فذمم 1200 بـ575 والفاتورة لا ذمة عليها (فحص ذمم الفواتير أحمر)، والبنك صفر، وهي خارج اقتراحات التحصيل لأنها «مدفوعة».
  // لماذا يهم: فاتورةٌ تظهر محصَّلة للعميل وفي التقارير ولا مال لها، بعد قرارٍ صريح من المالك بإلغاء تحصيلها.
  test('اعتماد → إعادة الفاتورة «مستحقة» على جهاز المالك، واعتمادٌ للهدف نفسه بعده على جهاز العضو: حالة الفاتورة تطابق قيدها وبنكها، والفحوص خضراء', async () => {
    const p = await pair();
    const bank = addBank(p.owner, 'بنك مصطنع Y2', 0);
    const inv = saveInvoice(p.owner, { customer: 'نجم المصطنع', customerVat: '', issue: '2026-10-01', due: '2026-10-15', notes: '',
      lines: [{ descr: 'خدمة مصطنعة', qty: 1, priceHalalas: 50000, taxPct: 15 }] }, 'مستحقة');
    const invNo = p.owner.get<{ no: string }>(`SELECT no FROM invoices WHERE id = ?`, [inv])!.no;
    saveStatement(p.owner, bank, grid([['2026/10/12', 'سداد فاتورة ' + invNo, '', '575.00', '575.00']]), { name: 'y2-oct.csv', hash: 'y2' });
    await sync(p.owner, p.r);
    await sync(p.dev, p.r);

    const so = collectionSuggestions(p.owner, bank)[0];
    expect(so.target).toEqual({ kind: 'invoice', invoiceId: inv });
    approveCollection(p.owner, so.line.id, so.target);
    setInvoiceStatus(p.owner, inv, 'مستحقة');
    await wait(5);
    const sd = collectionSuggestions(p.dev, bank)[0];
    approveCollection(p.dev, sd.line.id, sd.target);
    await settle(p);

    const state = (db: DB) => db.get<{ status: string; rb: string | null }>(
      `SELECT v.status, e.reversed_by AS rb FROM invoices v LEFT JOIN journal_entries e ON e.id = v.payment_journal_entry_id WHERE v.id = ?`, [inv])!;
    const coherent = (db: DB) => {
      const s = state(db);
      return (s.status === 'مدفوعة') === (bankBalance(db, bank) === 57500) && (s.status !== 'مدفوعة' || s.rb === null);
    };
    // (الواقع: «مدفوعة» وقيد تحصيلها معكوس، والبنك صفر، وفحص «ذمم الفواتير = الفواتير المصدرة غير المحصّلة» أحمر 575 / 0)
    expect({ owner: { failing: failing(p.owner), coherent: coherent(p.owner) }, dev: { coherent: coherent(p.dev) } })
      .toEqual({ owner: { failing: [], coherent: true }, dev: { coherent: true } });
    p.close();
  });
});
