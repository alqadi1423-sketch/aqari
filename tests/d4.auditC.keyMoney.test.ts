/**
 * مدقق خارجي (ج) · الجولة الثانية · قبول «نسخة الاستعادة» في قيد عمولة التقبيل (deriveSources.ts · key_money · ك١ في 825f162) ·
 * بيانات مصطنعة.
 *  (١) الاستثناء الجديد لا يسأل هل الصفقة في السلة: بعد إلغاء الصفقة (قيدها معكوس وصفّها محذوف)، قيدُ عمولةٍ جديد يكتبه عضوٌ للصفقة
 *      الملغاة يُقبل «نسخةَ استعادة» · فإيرادٌ ونقدٌ لصفقةٍ ملغاة. (قبل 825f162: يُرفض noEntry.)
 *  (٢) الصفّ صار يسمّي النسخة (trash.ts) · فإن سحب المالك الصفقة وإلغاءها واستعادتها معاً، فالقيد الأول المعكوس يُرفض في reversedIssue
 *      (الصف يسمّي غيره) وتتبعه النسخة (تاريخ العكس لا عاكس له هنا) · فالدفتران يختلفان.
 */
import { recordKeyMoneyDeal } from '@/domain/keymoney';
import { entrySourceAction } from '@/domain/accounting/sourceCancel';
import { restoreFromTrash } from '@/domain/trash';
import { confirmContract } from '@/domain/contracts/service';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { pair, sync, ownerPulls, asMember, has, reasonOf, net, srcAsMember, forge, MEMBER } from './helpers/rederive';
import type { DB } from '@/db/adapter';

async function setup() {
  const p = await pair();
  const pa = addProperty(p.owner, { name: 'عقار تقبيل ج مصطنع' });
  const ua = addUnit(p.owner, pa, { unit_no: 'KC-A' });
  const ca = confirmContract(p.owner, contractInput(ua, { tenant: 'مستأجر تقبيل ج مصطنع', idNumber: '1000000029', phone: '0555550029' }));
  await sync(p.owner, p.r);
  await sync(p.dev, p.r);
  return { ...p, pa, ua, ca };
}
const deal = (db: DB, unit: string, n: number, contractId: string | null = null) => recordKeyMoneyDeal(db, {
  unitId: unit, contractId, outgoing: 'متنازل ج ' + n, incoming: 'متنازل له ج ' + n, amountHalalas: 5000000, date: '2026-11-01',
  commissionHalalas: 230000, method: 'cash', bankId: null, notes: '' });
const cancel = (db: DB, entryId: string, date = '2026-11-02') => {
  const a = entrySourceAction(db, entryId);
  if (a?.kind !== 'op') throw new Error('op');
  a.run(date, 'إلغاء مصطنع');
};

describe('مدقق ج · التقبيل', () => {
  test('(١) صفقةٌ ملغاة (في السلة): قيد عمولةٍ جديد من عضوٍ لها لا يُقبل', async () => {
    const s = await setup();
    const id = deal(s.dev, s.ua, 1, s.ca);
    await sync(s.dev, s.r);
    const k = asMember(s.r, 'key_money');
    await ownerPulls(s.owner, s.r);
    expect(has(s.owner, k)).toBe(true);
    cancel(s.dev, k);
    await sync(s.dev, s.r);
    asMember(s.r, 'key_money_rev');
    await ownerPulls(s.owner, s.r);
    expect(s.owner.get<{ d: string | null }>(`SELECT deleted_at AS d FROM key_money_deals WHERE id = ?`, [id])!.d).not.toBeNull();
    expect(net(s.owner, '4300')).toBe(0);
    // العضو يرحّل للصفقة الملغاة قيد عمولةٍ جديداً بسطور الأصل نفسها (بأبعادها) · لا استعادة ولا صفّ محدَّث
    const orig = s.r.docs.get('journal_entries__' + k)!;
    const f = forge(orig, { lines: orig.lines! });
    s.r.inject(f);
    await ownerPulls(s.owner, s.r);
    const out = { forgedAccepted: has(s.owner, f.k), reason: reasonOf(s.owner, f.k), owner4300: net(s.owner, '4300'), owner1100: net(s.owner, '1100'),
      dealInTrash: s.owner.get(`SELECT deleted_at IS NOT NULL AS t, journal_entry_id = ? AS namesOrig FROM key_money_deals WHERE id = ?`, [k, id]) };
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(out));
    expect(has(s.owner, f.k)).toBe(false);
    expect(net(s.owner, '4300')).toBe(0);
    s.close();
  });

  test('(٢) الصفقة وإلغاؤها واستعادتها من جهاز العضو يسحبها المالك معاً: دفتره كدفتر العضو', async () => {
    const s = await setup();
    const id = deal(s.dev, s.ua, 2, s.ca);
    const k = s.dev.get<{ id: string }>(`SELECT journal_entry_id AS id FROM key_money_deals WHERE id = ?`, [id])!.id;
    cancel(s.dev, k);
    restoreFromTrash(s.dev, 'key_money_deals', id);
    await sync(s.dev, s.r);
    const ids = srcAsMember(s.r, /^key_money(_rev)?$/);
    // وصفّ الصفقة يكتبه العضو كذلك
    for (const d of [...s.r.docs.values()].filter((x) => x.t === 'key_money_deals')) s.r.inject({ ...d, by: MEMBER });
    await ownerPulls(s.owner, s.r);
    await ownerPulls(s.owner, s.r);
    const out = { member4300: net(s.dev, '4300'), owner4300: net(s.owner, '4300'),
      entries: ids.map((x) => [s.r.docs.get('journal_entries__' + x)?.d?.src_type, x === k ? 'E0' : 'other', has(s.owner, x), reasonOf(s.owner, x),
        s.owner.get(`SELECT last_error AS e FROM sync_inbox WHERE pk = ?`, [x]) ?? null]) };
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(out));
    expect(net(s.dev, '4300')).toBe(-230000);
    expect(out.owner4300).toBe(out.member4300);
    s.close();
  });
});
