/**
 * مدقق خارجي K · الجولة السادسة · جذر تقطّع d4.auditI.keyMoneyLoop: L1x نفسه (بلا تلاعبٍ بالطابور) وكل عبارةٍ على جهاز العضو في جزءٍ
 * من الألف تالٍ (بطءٌ كالحمل الموازي): وقت التغيير في الطابور من ساعة SQLite لكل عبارة · بيانات مصطنعة.
 */
import { recordKeyMoneyDeal } from '@/domain/keymoney';
import { entrySourceAction } from '@/domain/accounting/sourceCancel';
import { restoreFromTrash } from '@/domain/trash';
import { addBank, addProperty, addUnit } from './helpers/fixtures';
import { pair, sync, ownerPulls } from './helpers/rederive';
import { snap, newAsMember, bal, rejects } from './helpers/auditI';
import type { DB } from '@/db/adapter';

/** كل عبارة كتابةٍ تنتهي ثم تمضي ميلي ثانيتان قبل التالية */
function slow(db: DB) {
  const run = db.run.bind(db);
  (db as { run: DB['run'] }).run = ((sql: string, params?: unknown[]) => {
    const r = run(sql, params as never);
    const until = Date.now() + 2;
    while (Date.now() < until) { /* بطءٌ مصطنع */ }
    return r;
  }) as DB['run'];
}

test.each([[1], [2]])('مدقق K · (K1ج) L1x بـ%i إلغاءٍ واستعادة وجهاز العضو بطيء: يقبله المالك كله', async (rounds) => {
  const s = await pair();
  const A = addBank(s.owner, 'بنك أ مصطنع K', 0);
  const pa = addProperty(s.owner, { name: 'عقار تقبيل K مصطنع' });
  const ua = addUnit(s.owner, pa, { unit_no: 'KK-3' });
  await sync(s.owner, s.r);
  await sync(s.dev, s.r);
  const since = snap(s.r);
  slow(s.dev);
  const deal = recordKeyMoneyDeal(s.dev, { unitId: ua, contractId: null, outgoing: 'متنازل K', incoming: 'متنازل له K', amountHalalas: 5000000,
    date: '2026-06-01', commissionHalalas: 230000, method: 'bank', bankId: A, notes: '' });
  const dates = ['2026-08-15', '2026-10-20'];
  const names: Record<string, string> = {};
  for (let i = 0; i < rounds; i++) {
    const e = s.dev.get<{ id: string }>(`SELECT journal_entry_id AS id FROM key_money_deals WHERE id = ?`, [deal])!.id;
    names[e] = 'e' + (i + 1);
    (entrySourceAction(s.dev, e) as { kind: 'op'; run: (d: string, r: string) => void }).run(dates[i], 'سبب مصطنع');
    names[s.dev.get<{ r: string }>(`SELECT reversed_by AS r FROM journal_entries WHERE id = ?`, [e])!.r] = 'r' + (i + 1);
    restoreFromTrash(s.dev, 'key_money_deals', deal);
  }
  names[s.dev.get<{ id: string }>(`SELECT journal_entry_id AS id FROM key_money_deals WHERE id = ?`, [deal])!.id] = 'e' + (rounds + 1);
  const push = s.dev.all<{ pk: string }>(`SELECT pk FROM sync_outbox WHERE tbl = 'journal_entries' ORDER BY changed_at, tbl, pk`).map((x) => names[x.pk]).join(',');
  await sync(s.dev, s.r);
  newAsMember(s.r, since);
  await ownerPulls(s.owner, s.r);
  await ownerPulls(s.owner, s.r);
  const out = { push, owner: bal(s.owner, [A]), member: bal(s.dev, [A]), rejects: rejects(s.owner).map((r) => (names[r.pk] ?? r.tbl) + ': ' + r.reason) };
  // eslint-disable-next-line no-console
  console.log('K1c', rounds, JSON.stringify(out));
  expect(out.rejects).toEqual([]);
  expect(out.owner).toEqual(out.member);
  s.close();
});
