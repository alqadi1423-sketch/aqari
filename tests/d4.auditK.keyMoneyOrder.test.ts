/**
 * مدقق خارجي K · الجولة السادسة · ترتيب وصول قيود التقبيل الملغى والمستعاد مرتين (L7 بلا تلاعبٍ بوقت التغيير) · بيانات مصطنعة.
 */
import { recordKeyMoneyDeal } from '@/domain/keymoney';
import { entrySourceAction } from '@/domain/accounting/sourceCancel';
import { restoreFromTrash } from '@/domain/trash';
import { addBank, addProperty, addUnit } from './helpers/fixtures';
import { pair, sync, ownerPulls } from './helpers/rederive';
import { snap, newAsMember, bal, rejects } from './helpers/auditI';
import { holdBack } from './helpers/rederive';
import { waiting } from './helpers/auditI';

/** order: أسماء القيود الخمسة بالترتيب الذي تصل به إلى المالك (e1 r1 e2 r2 e3) */
async function run(order: string[]) {
  const s = await pair();
  const A = addBank(s.owner, 'بنك أ مصطنع K', 0);
  const pa = addProperty(s.owner, { name: 'عقار تقبيل K مصطنع' });
  const ua = addUnit(s.owner, pa, { unit_no: 'KK-1' });
  await sync(s.owner, s.r);
  await sync(s.dev, s.r);
  const since = snap(s.r);
  const deal = recordKeyMoneyDeal(s.dev, { unitId: ua, contractId: null, outgoing: 'متنازل K', incoming: 'متنازل له K', amountHalalas: 5000000,
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
  // تصل القيود بالترتيب المطلوب (وقت الخادم يتزايد بالحقن) · وما عداها بترتيبه
  for (const n of order) s.r.inject(s.r.docs.get('journal_entries__' + ids[n])!);
  await ownerPulls(s.owner, s.r);
  await ownerPulls(s.owner, s.r);
  const out = { order: order.join(','), owner: bal(s.owner, [A]), member: bal(s.dev, [A]),
    rejects: rejects(s.owner).map((x) => Object.entries(ids).find(([, v]) => v === x.pk)?.[0] ?? x.tbl + ':' + x.reason) };
  s.close();
  return out;
}

const perms = (a: string[]): string[][] => (a.length <= 1 ? [a] : a.flatMap((x, i) => perms([...a.slice(0, i), ...a.slice(i + 1)]).map((p) => [x, ...p])));

test('مدقق K · (K1) الترتيب [r1 e1 e3 r2 e2]: نسخة الاستعادة الثانية قبل العاكس الثاني وأصله بعده · يُرفض الأصل وتسقط عمولة البنك عند المالك', async () => {
  const out = await run(['r1', 'e1', 'e3', 'r2', 'e2']);
  // eslint-disable-next-line no-console
  console.log('K1', JSON.stringify(out));
  expect(out.rejects).toEqual([]);
  expect(out.owner).toEqual(out.member);
});

test('مدقق K · (K1 مسح) كل ترتيبات القيود الخمسة: يقبلها المالك كلها وأرصدته كأرصدة العضو', async () => {
  const bad: unknown[] = [];
  for (const p of perms(['e1', 'r1', 'e2', 'r2', 'e3'])) {
    const out = await run(p);
    if (JSON.stringify(out.owner) !== JSON.stringify(out.member) || out.rejects.length) bad.push(out);
  }
  // eslint-disable-next-line no-console
  console.log("K1scan", bad.length, (bad as Array<{ order: string; rejects: string[] }>).map((b) => b.order + " => " + b.rejects.filter((x) => !x.startsWith("bank_tx")).join("+")).join("\n"));
  expect(bad).toEqual([]);
}, 600000);

test('مدقق K · (K1ب) L7 على دفعتين: العاكس الثاني في دفعة رفعٍ والأصل المسمّي له في التالية، والمالك يطبّق بينهما · يُرفض العاكس نهائياً', async () => {
  const s = await pair();
  const A = addBank(s.owner, 'بنك أ مصطنع K', 0);
  const pa = addProperty(s.owner, { name: 'عقار تقبيل K مصطنع' });
  const ua = addUnit(s.owner, pa, { unit_no: 'KK-2' });
  await sync(s.owner, s.r);
  await sync(s.dev, s.r);
  const since = snap(s.r);
  const deal = recordKeyMoneyDeal(s.dev, { unitId: ua, contractId: null, outgoing: 'متنازل K', incoming: 'متنازل له K', amountHalalas: 5000000,
    date: '2026-06-01', commissionHalalas: 230000, method: 'bank', bankId: A, notes: '' });
  const cur = () => s.dev.get<{ id: string }>(`SELECT journal_entry_id AS id FROM key_money_deals WHERE id = ?`, [deal])!.id;
  const e1 = cur();
  (entrySourceAction(s.dev, e1) as { kind: 'op'; run: (d: string, r: string) => void }).run('2026-08-15', 'سبب مصطنع');
  restoreFromTrash(s.dev, 'key_money_deals', deal);
  const e2 = cur();
  (entrySourceAction(s.dev, e2) as { kind: 'op'; run: (d: string, r: string) => void }).run('2026-10-20', 'سبب مصطنع ٢');
  restoreFromTrash(s.dev, 'key_money_deals', deal);
  const e3 = cur();
  const r2 = s.dev.get<{ id: string }>(`SELECT reversed_by AS id FROM journal_entries WHERE id = ?`, [e2])!.id;
  // فرضية L7 نفسها (DESIGN §١٣.١٨ هـ): تحديث الأصل بعد إدراج العاكس بجزءٍ من الثانية فيُرفع العاكس قبله · ونسخة الاستعادة بعدهما
  const t2 = s.dev.get<{ c: string }>(`SELECT changed_at AS c FROM sync_outbox WHERE tbl = 'journal_entries' AND pk = ?`, [r2])!.c;
  s.dev.run(`UPDATE sync_outbox SET changed_at = strftime('%Y-%m-%dT%H:%M:%fZ', ?, '+0.001 seconds') WHERE tbl = 'journal_entries' AND pk = ?`, [t2, e2]);
  s.dev.run(`UPDATE sync_outbox SET changed_at = strftime('%Y-%m-%dT%H:%M:%fZ', ?, '+0.002 seconds') WHERE tbl = 'journal_entries' AND pk = ?`, [t2, e3]);
  await sync(s.dev, s.r);
  newAsMember(s.r, since);
  // دفعة رفع العضو (ثمانية مستندات) تنتهي بعد العاكس، والمالك يسحب ويطبّق قبل وصول التالية: الأصل الثاني ونسخة الاستعادة وما بعدهما
  const later = holdBack(s.r, (d) => (d.t === 'journal_entries' && (d.k === e2 || d.k === e3)) || d.t === 'key_money_deals' || d.t === 'bank_tx' || d.t === 'audit_log');
  await ownerPulls(s.owner, s.r);
  later.release();
  await ownerPulls(s.owner, s.r);
  await ownerPulls(s.owner, s.r);
  const ids: Record<string, string> = { [e1]: 'e1', [e2]: 'e2', [r2]: 'r2', [e3]: 'e3' };
  const out = { owner: bal(s.owner, [A]), member: bal(s.dev, [A]),
    rejects: rejects(s.owner).map((x) => (ids[x.pk] ?? x.tbl) + ': ' + x.reason), waiting: waiting(s.owner).map((w) => ids[w.pk] ?? w.tbl) };
  // eslint-disable-next-line no-console
  console.log('K1b', JSON.stringify(out));
  expect(out.rejects).toEqual([]);
  expect(out.owner).toEqual(out.member);
  s.close();
});
