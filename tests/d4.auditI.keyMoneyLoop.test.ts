/**
 * مدقق خارجي (I) · الجولة الخامسة · تقبيلٌ مشروع بعمولةٍ في البنك يُلغى بتاريخٍ يختاره المستخدم ويُستعاد (مرةً أو مرتين) من عضو ·
 * يُكرَّر لأن ترتيب التطبيق عند المالك يتبع معرّفاتٍ عشوائية (uid) · بيانات مصطنعة.
 */
import { recordKeyMoneyDeal } from '@/domain/keymoney';
import { entrySourceAction } from '@/domain/accounting/sourceCancel';
import { restoreFromTrash } from '@/domain/trash';
import { addBank, addProperty, addUnit } from './helpers/fixtures';
import { pair, sync, ownerPulls } from './helpers/rederive';
import { snap, newAsMember, bal, rejects, waiting } from './helpers/auditI';

async function once(rounds: number) {
  const s = await pair();
  const A = addBank(s.owner, 'بنك أ مصطنع I', 0);
  const pa = addProperty(s.owner, { name: 'عقار تقبيل I مصطنع' });
  const ua = addUnit(s.owner, pa, { unit_no: 'KI-L' });
  await sync(s.owner, s.r);
  await sync(s.dev, s.r);
  const since = snap(s.r);
  const deal = recordKeyMoneyDeal(s.dev, { unitId: ua, contractId: null, outgoing: 'متنازل I', incoming: 'متنازل له I', amountHalalas: 5000000,
    date: '2026-06-01', commissionHalalas: 230000, method: 'bank', bankId: A, notes: '' });
  const dates = ['2026-08-15', '2026-10-20', '2026-10-25'];
  for (let i = 0; i < rounds; i++) {
    const e = s.dev.get<{ id: string }>(`SELECT journal_entry_id AS id FROM key_money_deals WHERE id = ?`, [deal])!.id;
    (entrySourceAction(s.dev, e) as { kind: 'op'; run: (d: string, r: string) => void }).run(dates[i], 'سبب مصطنع');
    restoreFromTrash(s.dev, 'key_money_deals', deal);
  }
  await sync(s.dev, s.r);
  newAsMember(s.r, since);
  await ownerPulls(s.owner, s.r);
  await ownerPulls(s.owner, s.r);
  const out = { owner: bal(s.owner, [A]), member: bal(s.dev, [A]), rejects: rejects(s.owner), waiting: waiting(s.owner).length,
    entries: s.owner.all<{ id: string; src_type: string; date: string; reversed_by: string | null }>(`SELECT id, src_type, date, reversed_by FROM journal_entries WHERE src_type LIKE 'key_money%'`) };
  s.close();
  return out;
}

test.each([[1], [2]])('مدقق I · (L1x) تقبيلٌ يُلغى ويُستعاد %i مرة، ثلاثون تكراراً بمعرّفاتٍ وأوقاتٍ طبيعية: يقبله المالك كله في كل تكرار', async (rounds) => {
  const bad: unknown[] = [];
  for (let i = 0; i < 30; i++) {
    const out = await once(rounds);
    if (JSON.stringify(out.owner) !== JSON.stringify(out.member) || out.rejects.length) bad.push(out);
  }
  // eslint-disable-next-line no-console
  console.log('L1x', rounds, bad.length, JSON.stringify(bad[0] ?? null));
  expect(bad.length).toBe(0);
});

test('مدقق I · (L7) تقبيلٌ يُلغى ويُستعاد ثم يُلغى ويُستعاد ثانيةً، وربط الأصل بعاكسه الثاني في الملّي ثانية التالية لإنشاء العاكس', async () => {
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
  // reverseEntryById يُدرج العاكس ويرقّيه ثم يحدّث reversed_by في الأصل بعبارةٍ لاحقة: إن عبرت بينهما حدودُ الملّي ثانية صار وقت تغيير
  // الأصل بعد وقت العاكس، فيُرفع العاكس قبله (الطابور بالرتبة ثم وقت التغيير) · نثبّت ذلك هنا بدل انتظار المصادفة
  const r2 = s.dev.get<{ id: string }>(`SELECT reversed_by AS id FROM journal_entries WHERE id = ?`, [e2])!.id;
  const t2 = s.dev.get<{ c: string }>(`SELECT changed_at AS c FROM sync_outbox WHERE tbl = 'journal_entries' AND pk = ?`, [r2])!.c;
  s.dev.run(`UPDATE sync_outbox SET changed_at = strftime('%Y-%m-%dT%H:%M:%fZ', ?, '+0.001 seconds') WHERE tbl = 'journal_entries' AND pk = ?`, [t2, e2]);
  await sync(s.dev, s.r);
  newAsMember(s.r, since);
  await ownerPulls(s.owner, s.r);
  await ownerPulls(s.owner, s.r);
  s.owner.run(`UPDATE sync_inbox SET waiting_since = '2020-01-01T00:00:00.000Z', attempts = 50`);
  await ownerPulls(s.owner, s.r);
  const out = { owner: bal(s.owner, [A]), member: bal(s.dev, [A]), rejects: rejects(s.owner), waiting: waiting(s.owner),
    r2: rejects(s.owner).find((x) => x.pk === r2)?.reason ?? '' };
  // eslint-disable-next-line no-console
  console.log('L7', JSON.stringify(out));
  expect(out.owner).toEqual(out.member);
  expect(out.r2).toBe('');
  s.close();
});
