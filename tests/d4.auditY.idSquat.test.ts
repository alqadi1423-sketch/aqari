/**
 * المدقق Y · الجولة الثانية عشرة · المعرّف الحتمي لقيد اعتماد التحصيل يُحسب من معرّف سطر الكشف والهدف ورقم الاعتماد (collect.ts:219–222)،
 * وكلها يقرؤها العضو صاحب البنوك في السحابة · فيكتب عضوٌ مستنداً بهذا المعرّف قبل أن يرفعه المالك · بياناتٌ مصطنعة كلها.
 *   TZ=Asia/Riyadh npx jest tests/d4.auditY.idSquat.test.ts
 *
 * القيد المرحّل في السحابة لا يُستبدل (قاعدة السحابة وMemoryRemote)، فمن كتب المعرّف أولاً ملكه · وجهاز المالك يحمي دفتره بإعادة
 * اشتقاق قيد العضو، لكن لا يمنعه ذلك أن يحجز المعرّف ولا أن يُملي رقم قيده (noteJournalNoAlias يثق برقمه قبل أي فحص).
 */
import { addBank, addProperty, addUnit, contractInput } from './helpers/fixtures';
import { pair, sync, ownerPulls, MEMBER, UID } from './helpers/rederive';
import { memDb } from './helpers/testDb';
import { enableSync } from '@/sync/engine';
import { confirmContract } from '@/domain/contracts/service';
import { saveInvoice, payInvoice, setInvoiceStatus } from '@/domain/invoices';
import { bankBalance } from '@/domain/accounting/ledger';
import { readStatementGrid } from '@/domain/bankStatement/read';
import { saveStatement } from '@/domain/bankStatement/store';
import { collectionSuggestions, approveCollection, type CollectSuggestion } from '@/domain/bankStatement/collect';
import { deterministicId } from '@/domain/ids';
import type { RemoteDoc } from '@/sync/types';
import type { DB } from '@/db/adapter';

async function setup(tag: string) {
  const p = await pair();
  const bank = addBank(p.owner, 'بنك مصطنع ' + tag, 0);
  const prop = addProperty(p.owner, { name: 'عقار مصطنع ' + tag });
  const c = confirmContract(p.owner, contractInput(addUnit(p.owner, prop, { unit_no: tag + '-1' }), {
    tenant: 'ماجد المصطنع', idNumber: '1000000944', phone: '0500000944', valueHalalas: 1200000, cycle: 'شهرية',
    start: '2026-10-01', end: '2027-09-30', depositHalalas: 0,
  }));
  const r = readStatementGrid([['الرصيد الافتتاحي', '0.00'], ['التاريخ', 'البيان', 'مدين', 'دائن', 'الرصيد'],
    ['2026/10/02', 'حوالة واردة ماجد', '', '1,000.00', '1,000.00']]);
  if (!r.ok) throw new Error(r.error);
  saveStatement(p.owner, bank, r, { name: tag + '-oct.csv', hash: tag });
  return { p, bank, c };
}

/** قيد العضو بالمعرّف الحتمي لأول اعتمادٍ للاقتراح، برقمٍ يختاره، وسطوره على حسابٍ آخر وبلا أبعاد */
function squat(s: CollectSuggestion, no: string): RemoteDoc {
  if (s.target.kind !== 'installments') throw new Error('هدفٌ غير متوقع'); // i18n-exempt: رسالة اختبار
  const k = deterministicId('stmt:' + s.line.id + ':i:' + s.target.contractId + ':' + s.target.installmentIds.join(',') + ':0', 1);
  const now = new Date().toISOString();
  return {
    id: 'journal_entries__' + k, t: 'journal_entries', k, u: now, dev: 'member-phone', del: false, by: MEMBER, op: 'collect',
    d: { id: k, no, date: '2026-10-02', memo: 'قيد عضوٍ مصطنع', status: 'مرحّل', auto: 1, src_type: 'rent', src_id: s.target.installmentIds[0],
      created_at: now, reversed_by: null, deleted_at: null },
    lines: [
      { id: k + '-a', entry_id: k, account_code: '1100', descr: '', debit_halalas: 100000, credit_halalas: 0 },
      { id: k + '-b', entry_id: k, account_code: '4300', descr: '', debit_halalas: 0, credit_halalas: 100000 },
    ],
  };
}

describe('Y4 · [متوسط] عضوٌ يحجز المعرّف الحتمي فلا يصل قيد المالك الحقيقي إلى السحابة أبداً، ويفقد جهاز المالك الآخر التحصيل (collect.ts:221 · engine.ts:2441)', () => {
  // العضو يكتب في السحابة قيداً مزوَّراً بمعرّف أول اعتمادٍ لإيداع 2 أكتوبر · جهاز المالك يسحبه فينتظر في الوارد (لا دفعة له) · ثم يعتمد
  // المالك الإيداع: رقم الاعتماد يُحسب من دفتره وحده فيكون 0، فقيده بالمعرّف المحجوز · ورفعه يُرفض «نهائي في السحابة» · فالسحابة فيها
  // المزوَّر ودفعة المالك وحركة بنكه · جهازٌ آخر للمالك (هاتفٌ بديل أو استعادةٌ من السحابة) يرفض المزوَّر بإعادة الاشتقاق، فتنتظر الدفعة
  // قيدها أبداً، وتُطبَّق حركة البنك برقم القيد المزوَّر: بنكٌ بـ1,000 بلا قيدٍ ولا دفعة، والقسط غير مسدَّد.
  // لماذا يهم: عضوٌ واحد يمنع المالك من رفع أي تحصيلٍ يعتمده من الكشف، ويفرّق دفاتر أجهزة المالك نفسه.
  // السلوك الصحيح: المعرّف الذي عرفه الجهاز في الوارد أو المرفوض محجوز، فيأخذ الاعتماد الرقم التالي (أو يُعاد ترقيمه عند الرفض النهائي)،
  // ويحمل جهاز المالك الآخر التحصيل نفسه.
  test('المزوَّر بمعرّف الاعتماد الأول قبل اعتماد المالك: جهاز المالك الثاني يحمل الدفعة وقيدها كالأول', async () => {
    const { p, bank, c } = await setup('Y4');
    await sync(p.owner, p.r);
    const s = collectionSuggestions(p.owner, bank)[0];
    p.r.inject(squat(s, 'JE-9001'));
    await ownerPulls(p.owner, p.r);
    approveCollection(p.owner, s.line.id, s.target);
    await ownerPulls(p.owner, p.r);

    const owner2 = memDb();
    enableSync(owner2, UID);
    await sync(owner2, p.r);
    await sync(owner2, p.r);
    const books = (db: DB) => ({
      paymentsWithEntry: Number(db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM contract_payments p JOIN journal_entries e ON e.id = p.journal_entry_id
         WHERE p.contract_id = ? AND p.cancelled_at IS NULL AND e.status = 'مرحّل' AND e.reversed_by IS NULL`, [c])!.n),
      bank: bankBalance(db, bank),
      txWithEntry: Number(db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM bank_tx t WHERE t.bank_id = ? AND t.deleted_at IS NULL
         AND EXISTS (SELECT 1 FROM journal_entries e WHERE e.no = t.journal_no AND e.status = 'مرحّل')`, [bank])!.n),
    });
    expect(books(p.owner)).toEqual({ paymentsWithEntry: 1, bank: 100000, txWithEntry: 1 });
    // (الواقع على الجهاز الثاني: لا دفعة ولا قيد، والبنك 1,000 بحركةٍ رقم قيدها JE-9001 لا قيد له)
    expect(books(owner2)).toEqual(books(p.owner));
    owner2.close();
    p.close();
  });
});

describe('Y6 · [عالٍ] رقم القيد في مستند العضو يُعتمد اسماً قبل أي فحص فيعيد ربط حركات بنكٍ لقيدٍ آخر لا علاقة له (engine.ts:1659 · engine.ts:661)', () => {
  // المالك حصّل فاتورة نجم ببنكٍ (قيد تحصيلها رقمه X وحركة بنكها برقم X)، ثم يعتمد بلا اتصال إيداع 2 أكتوبر لقسط ماجد · والعضو يكتب في
  // السحابة قبله مستنداً بالمعرّف الحتمي لذلك الاعتماد ورقمه X · عند مزامنة المالك يجد قيده بالمعرّف نفسه برقمٍ آخر فيسجّل X اسماً لرقم
  // قيد ماجد هنا، ويحوّل كل حركة بنكٍ برقم X إليه (UPDATE bank_tx SET journal_no) · فحركة الفاتورة صارت حركة قيد ماجد هنا، وتُرفع
  // حركتا الاثنين إلى السحابة برقم X · وإعادة الفاتورة «مستحقة» بعدها تُرفض «النقد في المحفظة لا يكفي» (تحصيلها صار بلا حركة بنك) ·
  // ولو أُودع نقدٌ لتمرّ لعُكس قيدها وبقيت حركة بنكها.
  // لماذا يهم: عضوٌ يعيد كتابة روابط البنك بالدفتر في دفاتر المالك لأي قيدٍ يعرف رقمه، متخطّياً إعادة الاشتقاق كلها.
  // السلوك الصحيح: لا يُسجَّل اسمٌ لرقم قيدٍ من مستندٍ لم يُقبل (أو لرقمٍ هو رقم قيدٍ آخر هنا)، وحركة الفاتورة تبقى برقمها.
  test('المالك يعتمد بلا اتصال، والعضو يحجز المعرّف برقم قيد تحصيل الفاتورة: حركة الفاتورة تبقى برقمها، وإعادتها «مستحقة» تعكسها', async () => {
    const { p, bank } = await setup('Y6');
    const inv = saveInvoice(p.owner, { customer: 'نجم المصطنع', customerVat: '', issue: '2026-10-01', due: '2026-10-15', notes: '',
      lines: [{ descr: 'خدمة مصطنعة', qty: 1, priceHalalas: 50000, taxPct: 15 }] }, 'مستحقة');
    payInvoice(p.owner, inv, { method: 'bank', bankId: bank, date: '2026-10-05' });
    const xNo = p.owner.get<{ no: string }>(`SELECT e.no FROM invoices v JOIN journal_entries e ON e.id = v.payment_journal_entry_id WHERE v.id = ?`, [inv])!.no;
    await sync(p.owner, p.r);
    // المالك بلا اتصال يعتمد الإيداع، والعضو يحجز المعرّف في السحابة برقم قيد تحصيل الفاتورة
    const s = collectionSuggestions(p.owner, bank)[0];
    approveCollection(p.owner, s.line.id, s.target);
    p.r.inject(squat(s, xNo));
    await ownerPulls(p.owner, p.r);

    const invTxNo = p.owner.get<{ n: string }>(`SELECT journal_no AS n FROM bank_tx WHERE amount_halalas = 57500 AND deleted_at IS NULL`)!.n;
    let unpay = 'ok';
    try { setInvoiceStatus(p.owner, inv, 'مستحقة'); } catch (e) { unpay = (e as Error).message; }
    // (الواقع: حركة الفاتورة برقم قيد ماجد، وإعادتها «مستحقة» تُرفض بنقصٍ في المحفظة، والبنك 1,575)
    expect({ invTxNo, unpay, bank: bankBalance(p.owner, bank) }).toEqual({ invTxNo: xNo, unpay: 'ok', bank: 100000 });
    p.close();
  });
});
