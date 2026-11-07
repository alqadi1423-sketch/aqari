/** مدقق K · تكرار L7 لالتقاط الفشل المتقطع · بيانات مصطنعة */
import { recordKeyMoneyDeal } from '@/domain/keymoney';
import { entrySourceAction } from '@/domain/accounting/sourceCancel';
import { restoreFromTrash } from '@/domain/trash';
import { addBank, addProperty, addUnit } from './helpers/fixtures';
import { pair, sync, ownerPulls } from './helpers/rederive';
import { snap, newAsMember, bal, rejects, waiting } from './helpers/auditI';

async function l7() {
  const s = await pair();
  const A = addBank(s.owner, 'بنك أ مصطنع I', 0);
  const pa = addProperty(s.owner, { name: 'عقار تقبيل I مصطنع' });
  const ua = addUnit(s.owner, pa, { unit_no: 'KI-L7' });
  await sync(s.owner, s.r);
  await sync(s.dev, s.r);
  const since = snap(s.r);
  const deal = recordKeyMoneyDeal(s.dev, { unitId: ua, contractId: null, outgoing: 'متنازل I', incoming: 'متنازل له I', amountHalalas: 5000000,
    date: '2026-06-01', commissionHalalas: 230000, method: 'bank', bankId: A, notes: '' });
  const e1 = s.dev.get<{ id: string }>(`SELECT journal_entry_id AS id FROM key_money_deals WHERE id = ?`, [deal])!.id;
  (entrySourceAction(s.dev, e1) as { kind: 'op'; run: (d: string, r: string) => void }).run('2026-08-15', 'سبب مصطنع');
  restoreFromTrash(s.dev, 'key_money_deals', deal);
  const e2 = s.dev.get<{ id: string }>(`SELECT journal_entry_id AS id FROM key_money_deals WHERE id = ?`, [deal])!.id;
  (entrySourceAction(s.dev, e2) as { kind: 'op'; run: (d: string, r: string) => void }).run('2026-10-20', 'سبب مصطنع ٢');
  restoreFromTrash(s.dev, 'key_money_deals', deal);
  const r2 = s.dev.get<{ id: string }>(`SELECT reversed_by AS id FROM journal_entries WHERE id = ?`, [e2])!.id;
  const t2 = s.dev.get<{ c: string }>(`SELECT changed_at AS c FROM sync_outbox WHERE tbl = 'journal_entries' AND pk = ?`, [r2])!.c;
  s.dev.run(`UPDATE sync_outbox SET changed_at = strftime('%Y-%m-%dT%H:%M:%fZ', ?, '+0.001 seconds') WHERE tbl = 'journal_entries' AND pk = ?`, [t2, e2]);
  const outbox = s.dev.all(`SELECT tbl, pk, changed_at FROM sync_outbox ORDER BY rowid`);
  await sync(s.dev, s.r);
  newAsMember(s.r, since);
  await ownerPulls(s.owner, s.r);
  await ownerPulls(s.owner, s.r);
  const mid = { rejects: rejects(s.owner), waiting: waiting(s.owner) };
  s.owner.run(`UPDATE sync_inbox SET waiting_since = '2020-01-01T00:00:00.000Z', attempts = 50`);
  await ownerPulls(s.owner, s.r);
  const out = { owner: bal(s.owner, [A]), member: bal(s.dev, [A]), rejects: rejects(s.owner), waiting: waiting(s.owner), mid, outbox,
    devEntries: s.dev.all(`SELECT id, src_type, date, reversed_by, created_at FROM journal_entries ORDER BY created_at`),
    ownerEntries: s.owner.all(`SELECT id, src_type, date, reversed_by FROM journal_entries`),
    e1, e2, r2 };
  s.close();
  return out;
}

test('L7 loop', async () => {
  const N = Number(process.env.K_N ?? 60);
  const bad: unknown[] = [];
  for (let i = 0; i < N; i++) {
    const out = await l7();
    if (JSON.stringify(out.owner) !== JSON.stringify(out.member) || out.rejects.length) bad.push(out);
  }
  // eslint-disable-next-line no-console
  console.log('L7loop', N, bad.length, JSON.stringify(bad[0] ?? null, null, 1));
  expect(bad.length).toBe(0);
}, 600000);
