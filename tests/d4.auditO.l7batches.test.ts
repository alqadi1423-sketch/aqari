/**
 * مدقق خارجي O · الجولة الثامنة · L7 (تقبيلٌ يُلغى ويُستعاد مرتين) على دفعتين بكل تقسيمٍ للقيود الخمسة، والمالك يطبّق بينهما · على e5e16f5
 * · بيانات مصطنعة · مسحٌ لما غيّرته الجولة السابعة في memberReversalCheck وfreeOriginals (exists).
 */
import { recordKeyMoneyDeal } from '@/domain/keymoney';
import { entrySourceAction } from '@/domain/accounting/sourceCancel';
import { restoreFromTrash } from '@/domain/trash';
import { addBank, addProperty, addUnit } from './helpers/fixtures';
import { pair, sync, ownerPulls, holdBack } from './helpers/rederive';
import { snap, newAsMember, bal, rejects, waiting } from './helpers/auditI';

const NAMES = ['e1', 'r1', 'e2', 'r2', 'e3'];

async function run(later: string[], othersLater: boolean) {
  const s = await pair();
  const A = addBank(s.owner, 'بنك أ مصطنع O', 0);
  const pa = addProperty(s.owner, { name: 'عقار تقبيل O مصطنع' });
  const ua = addUnit(s.owner, pa, { unit_no: 'OO-1' });
  await sync(s.owner, s.r);
  await sync(s.dev, s.r);
  const since = snap(s.r);
  const deal = recordKeyMoneyDeal(s.dev, { unitId: ua, contractId: null, outgoing: 'متنازل O', incoming: 'متنازل له O', amountHalalas: 5000000,
    date: '2026-06-01', commissionHalalas: 230000, method: 'bank', bankId: A, notes: '' });
  const cur = () => s.dev.get<{ id: string }>(`SELECT journal_entry_id AS id FROM key_money_deals WHERE id = ?`, [deal])!.id;
  const e1 = cur();
  (entrySourceAction(s.dev, e1) as { kind: 'op'; run: (d: string, r: string) => void }).run('2026-08-15', 'سبب مصطنع');
  restoreFromTrash(s.dev, 'key_money_deals', deal);
  const e2 = cur();
  (entrySourceAction(s.dev, e2) as { kind: 'op'; run: (d: string, r: string) => void }).run('2026-10-20', 'سبب مصطنع ٢');
  restoreFromTrash(s.dev, 'key_money_deals', deal);
  const e3 = cur();
  const rev = (e: string) => s.dev.get<{ id: string }>(`SELECT reversed_by AS id FROM journal_entries WHERE id = ?`, [e])!.id;
  const ids: Record<string, string> = { e1, r1: rev(e1), e2, r2: rev(e2), e3 };
  await sync(s.dev, s.r);
  newAsMember(s.r, since);
  const lateIds = new Set(later.map((n) => ids[n]));
  const held = holdBack(s.r, (d) => (d.t === 'journal_entries' ? lateIds.has(d.k) : othersLater && since.get(d.id) === undefined && d.t !== 'journal_entries'));
  await ownerPulls(s.owner, s.r);
  held.release();
  await ownerPulls(s.owner, s.r);
  await ownerPulls(s.owner, s.r);
  const name = (pk: string) => Object.entries(ids).find(([, v]) => v === pk)?.[0];
  const out = { later: later.join(',') + (othersLater ? '+rows' : ''), owner: bal(s.owner, [A]), member: bal(s.dev, [A]),
    rejects: rejects(s.owner).map((x) => (name(x.pk) ?? x.tbl) + ': ' + x.reason), waiting: waiting(s.owner).map((w) => name(w.pk) ?? w.tbl) };
  s.close();
  return out;
}

// صفّ الصفقة وحركات البنك آخر ما يتغير (الاستعادة تكتب قيدها ثم تسمّيه في الصف)، فيُرفعان في آخر دفعة · وتقسيمٌ يقدّمهما على قيدٍ أقدم
// منهما لا يقع في رفعٍ بترتيب وقت التغيير (جُرّب: يُرفض فيه قيد العمولة على e5e16f5 وعلى 1da04b5 سواءً)
test('(صمد · O6 مسح) L7 على دفعتين بكل تقسيمٍ للقيود الخمسة، وصفّ الصفقة وحركات البنك في الثانية: يقبلها المالك كلها وأرصدته كأرصدة العضو', async () => {
  const bad: Array<Awaited<ReturnType<typeof run>>> = [];
  for (let m = 1; m < 32; m++) {
    const later = NAMES.filter((_, i) => m & (1 << i));
    for (const othersLater of [true]) {
      const out = await run(later, othersLater);
      if (JSON.stringify(out.owner) !== JSON.stringify(out.member) || out.rejects.length || out.waiting.length) bad.push(out);
    }
  }
  // eslint-disable-next-line no-console
  console.log('O6scan', bad.length, '\n' + bad.map((b) => b.later + ' => owner ' + JSON.stringify(b.owner) + ' member ' + JSON.stringify(b.member)
    + ' rejects ' + b.rejects.join(' + ') + ' waiting ' + b.waiting.join(',')).join('\n'));
  expect(bad).toEqual([]);
}, 900000);
