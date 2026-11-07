/**
 * مدقق خارجي (هـ) · الجولة الثالثة · عمولة التقبيل بعد 1f21568 (deriveSources.ts · key_money: «if (k.deleted_at) return no('deleted')») ·
 * بيانات مصطنعة.
 * العضو يرفع على دفعات بترتيب الجداول (journal_entries قبل key_money_deals)، فنسخة الاستعادة من السلة (E1) قد تصل جهاز المالك قبل صفّ
 * الصفقة المستعاد · والصفّ عند المالك ما زال في السلة (من الإلغاء الذي سحبه قبل) · فيُرفض E1 رفضاً نهائياً «deleted» ولا يُنتظر الصف،
 * ثم يصل الصف حيّاً يسمّي E1 · فدفتر العضو فيه العمولة ودفتر المالك بلا عمولة.
 */
import { recordKeyMoneyDeal } from '@/domain/keymoney';
import { entrySourceAction } from '@/domain/accounting/sourceCancel';
import { restoreFromTrash } from '@/domain/trash';
import { confirmContract } from '@/domain/contracts/service';
import { addProperty, addUnit, addBank, contractInput } from './helpers/fixtures';
import { bankBalance } from '@/domain/accounting/ledger';
import { pair, sync, ownerPulls, has, reasonOf, net, srcAsMember, holdBack, forge, mirrorOf, MEMBER } from './helpers/rederive';
import type { RemoteDoc } from '@/sync/types';
import type { DB } from '@/db/adapter';
import type { MemoryRemote } from './helpers/memoryRemote';

async function setup() {
  const p = await pair();
  const pa = addProperty(p.owner, { name: 'عقار تقبيل هـ مصطنع' });
  const ua = addUnit(p.owner, pa, { unit_no: 'KE-A' });
  const ca = confirmContract(p.owner, contractInput(ua, { tenant: 'مستأجر تقبيل هـ مصطنع', idNumber: '1000000051', phone: '0555550051' }));
  await sync(p.owner, p.r);
  await sync(p.dev, p.r);
  return { ...p, pa, ua, ca };
}
const deal = (db: DB, unit: string, contractId: string | null, bankId: string | null = null) => recordKeyMoneyDeal(db, {
  unitId: unit, contractId, outgoing: 'متنازل هـ', incoming: 'متنازل له هـ', amountHalalas: 5000000, date: '2026-11-01',
  commissionHalalas: 230000, method: bankId ? 'bank' : 'cash', bankId, notes: '' });
const cancel = (db: DB, entryId: string, date = '2026-11-02') => {
  const a = entrySourceAction(db, entryId);
  if (a?.kind !== 'op') throw new Error('op');
  a.run(date, 'إلغاء مصطنع');
};
/** كل ما رفعه العضو من قيود التقبيل وصفوف صفقاته بكاتبه العضو */
const allAsMember = (r: MemoryRemote) => {
  srcAsMember(r, /^key_money(_rev)?$/);
  for (const d of [...r.docs.values()].filter((x) => x.t === 'key_money_deals')) r.inject({ ...d, by: MEMBER });
  for (const d of [...r.docs.values()].filter((x) => x.t === 'bank_tx')) r.inject({ ...d, by: MEMBER, op: 'reservations' });
};

describe('مدقق هـ · التقبيل · نسخة الاستعادة قبل صفّها المستعاد', () => {
  test.each([['نقداً', false], ['ببنك', true]])('صفقة (%s) ← يسحبها المالك ← إلغاء ← يسحبه ← استعادة يصل قيدها قبل صفّها: دفتر المالك كدفتر العضو', async (_l, withBank) => {
    const s = await setup();
    const bank = withBank ? addBank(s.owner, 'بنك تقبيل هـ مصطنع') : null;
    if (bank) { await sync(s.owner, s.r); await sync(s.dev, s.r); }
    const id = deal(s.dev, s.ua, s.ca, bank);
    const e0 = s.dev.get<{ id: string }>(`SELECT journal_entry_id AS id FROM key_money_deals WHERE id = ?`, [id])!.id;
    await sync(s.dev, s.r);
    allAsMember(s.r);
    await ownerPulls(s.owner, s.r);
    expect(has(s.owner, e0)).toBe(true);
    cancel(s.dev, e0);
    await sync(s.dev, s.r);
    allAsMember(s.r);
    await ownerPulls(s.owner, s.r);
    expect(s.owner.get<{ d: string | null }>(`SELECT deleted_at AS d FROM key_money_deals WHERE id = ?`, [id])!.d).not.toBeNull();
    expect(net(s.owner, '4300')).toBe(0);
    // الاستعادة: نسخة القيد (E1) ثم الصف الحي يسمّيها · والصف في الدفعة التالية من الرفع
    restoreFromTrash(s.dev, 'key_money_deals', id);
    const e1 = s.dev.get<{ id: string }>(`SELECT journal_entry_id AS id FROM key_money_deals WHERE id = ?`, [id])!.id;
    expect(e1).not.toBe(e0);
    await sync(s.dev, s.r);
    allAsMember(s.r);
    const row = holdBack(s.r, (d) => d.t === 'key_money_deals' && d.k === id);
    expect(row.count).toBe(1);
    await ownerPulls(s.owner, s.r);
    const midway = { e1: has(s.owner, e1), why: reasonOf(s.owner, e1), inbox: !!s.owner.get(`SELECT 1 FROM sync_inbox WHERE pk = ?`, [e1]) };
    row.release();
    await ownerPulls(s.owner, s.r);
    await ownerPulls(s.owner, s.r);
    const out = { midway, e1Applied: has(s.owner, e1), why: reasonOf(s.owner, e1), member4300: net(s.dev, '4300'), owner4300: net(s.owner, '4300'),
      ownerRow: s.owner.get(`SELECT deleted_at IS NULL AS live, journal_entry_id = ? AS namesE1 FROM key_money_deals WHERE id = ?`, [e1, id]),
      bank: bank ? [bankBalance(s.owner, bank), bankBalance(s.dev, bank)] : null };
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(out));
    expect(out.member4300).toBe(-230000);
    expect(out.owner4300).toBe(out.member4300);
    if (out.bank) expect(out.bank[0]).toBe(out.bank[1]);
    s.close();
  });
});

/**
 * (٢) «pendingRev» (ج٥): تاريخ أي عاكسٍ للصفقة في الوارد لم يُطبَّق يصير تاريخاً مقبولاً لقيدها الحي · والعاكس في الوارد لم يُفحص بعد ·
 * فعضوٌ يرحّل قيد عمولة صفقةٍ حيّة بتاريخٍ غير تاريخها (سنةٌ أخرى أو ربعٌ آخر) ومعه «عاكسٌ» بذلك التاريخ لا يطابق (يُرفض حين يأتي
 * دوره) · فيُقبل القيد بتاريخه المزوَّر. (في 381460e: يُرفض «التاريخ».)
 */
describe('مدقق هـ · التقبيل · تاريخ القيد من عاكسٍ معلَّق', () => {
  test('قيد عمولة صفقةٍ حيّة بتاريخ 2027-01-10 (الصفقة 2026-11-01) ومعه عاكسٌ مزوَّر بذلك التاريخ: يُرفض القيد', async () => {
    const s = await setup();
    const id = deal(s.dev, s.ua, s.ca);
    const e0 = s.dev.get<{ id: string }>(`SELECT journal_entry_id AS id FROM key_money_deals WHERE id = ?`, [id])!.id;
    await sync(s.dev, s.r);
    allAsMember(s.r);
    const orig = s.r.docs.get('journal_entries__' + e0)!;
    // القيد بتاريخٍ غير تاريخ الصفقة (العضو يكتب مستند قيده)
    s.r.inject({ ...orig, by: MEMBER, d: { ...orig.d, date: '2027-01-10' } } as RemoteDoc);
    // و«عاكسٌ» بتاريخه لا يطابق (نصف المبالغ) · يُرفض حين يأتي دوره
    const bad = forge(orig, { src_type: 'key_money_rev', lines: mirrorOf(orig.lines!).map((l) => ({ ...l,
      debit_halalas: Number(l.debit_halalas) / 2, credit_halalas: Number(l.credit_halalas) / 2 })) });
    s.r.inject({ ...bad, op: 'ledger', d: { ...bad.d, date: '2027-01-10' } } as RemoteDoc);
    await ownerPulls(s.owner, s.r);
    await ownerPulls(s.owner, s.r);
    const out = { e0: [has(s.owner, e0), reasonOf(s.owner, e0).slice(0, 70)], e0Date: s.owner.get(`SELECT date FROM journal_entries WHERE id = ?`, [e0]),
      bad: [has(s.owner, bad.k), reasonOf(s.owner, bad.k).slice(0, 60)], dealDate: s.owner.get(`SELECT date FROM key_money_deals WHERE id = ?`, [id]),
      rev4300in2027: net(s.owner, '4300', 'e.date >= ?', ['2027-01-01']) };
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(out));
    expect(has(s.owner, e0)).toBe(false);
    expect(out.rev4300in2027).toBe(0);
    s.close();
  });
});
