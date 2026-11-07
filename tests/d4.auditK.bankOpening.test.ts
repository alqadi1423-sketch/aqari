/**
 * مدقق خارجي K · الجولة السادسة · «الرصيد الافتتاحي للبنك يضعه المالك وحده» (engine.ts · applyOne) وأجهزة المالك نفسه · بيانات مصطنعة.
 * المالك يرفع بكاتب الصف المعروف (acl.ts · annotate: «by» = row_by) بلا «op»، فتعديله لبنكٍ أنشأه عضوٌ يحمل by = العضو.
 */
import { annotate } from '@/sync/acl';
import { OWNER_ACCESS } from '@/domain/access/access';
import { enableSync } from '@/sync/engine';
import { memDb } from './helpers/testDb';
import { withdrawCashFromBank } from '@/domain/cashOps';
import { walletCashBalance } from '@/domain/accounting/ledger';
import { addBank } from './helpers/fixtures';
import { pair, sync, MEMBER, UID } from './helpers/rederive';
import type { RemoteDoc } from '@/sync/types';
import type { DB } from '@/db/adapter';
import { recordManualBankTx } from '@/domain/cashOps';
import { snap, newAsMember, rejects as allRejects, waiting as inboxWaiting } from './helpers/auditI';
import { ownerPulls } from './helpers/rederive';

const opening = (db: DB, id: string) => db.get<{ o: number }>(`SELECT opening_halalas AS o FROM banks WHERE id = ?`, [id])?.o ?? null;
const bankRejects = (db: DB) => db.all<{ reason: string }>(`SELECT reason FROM sync_rejects WHERE tbl = 'banks'`).map((r) => r.reason);

async function memberBankThenOwnerOpening() {
  const s = await pair();
  // المنشأة: المالك يرفع بحقول الرؤية وكاتب الصف كما في firestore.ts (o.org)
  (s.r as unknown as { annotate: (db: DB, d: RemoteDoc) => RemoteDoc }).annotate = (db, d) => annotate(db, d, { ...OWNER_ACCESS, uid: UID }).doc;
  const tmpl = addBank(s.owner, 'بنك قالب مصطنع K', 0);
  await sync(s.owner, s.r);
  await sync(s.dev, s.r);
  // عضوٌ (مدير البنوك) ينشئ بنكاً بافتتاحيٍّ صفر كما يحفظه نموذجه المقفل
  const t = s.r.docs.get('banks__' + tmpl)!;
  const Z = 'bank-member-k4';
  s.r.inject({ ...t, id: 'banks__' + Z, k: Z, by: MEMBER, op: 'banks', d: { ...t.d, id: Z, name: 'بنك العضو مصطنع K4', opening_halalas: 0 } } as RemoteDoc);
  await sync(s.owner, s.r);
  await sync(s.dev, s.r);
  // المالك على جهازه يضع الافتتاحي لاحقاً (app/banks.tsx · save)
  s.owner.run(`UPDATE banks SET opening_halalas = ? WHERE id = ?`, [500000, Z]);
  await sync(s.owner, s.r);
  return { s, Z };
}

test('(K4أ) جهازٌ ثانٍ للمالك نفسه يرفض افتتاحيّ المالك لبنكٍ أنشأه عضو، ويعيد نسخته فيمحوه من السحابة', async () => {
  const { s, Z } = await memberBankThenOwnerOpening();
  const cloud0 = s.r.docs.get('banks__' + Z)!;
  const seq: number[] = [];
  const cloud = () => Number(s.r.docs.get('banks__' + Z)!.d!.opening_halalas);
  for (let i = 0; i < 3; i++) { await sync(s.dev, s.r); seq.push(cloud()); await sync(s.owner, s.r); seq.push(cloud()); }
  const out = { cloudBy: cloud0.by, cloudOp: cloud0.op ?? null, cloudSeq: seq, owner1: opening(s.owner, Z), owner2: opening(s.dev, Z),
    cloud: Number(s.r.docs.get('banks__' + Z)!.d!.opening_halalas), rejects1: bankRejects(s.owner).length, rejects2: bankRejects(s.dev).length };
  // eslint-disable-next-line no-console
  console.log('K4a', JSON.stringify(out));
  expect(out.owner2).toBe(500000);
  expect(out.cloudSeq).toEqual([500000, 500000, 500000, 500000, 500000, 500000]);
  expect(out.rejects1 + out.rejects2).toBe(0);
  s.close();
});

test('(K4ب) جهازٌ جديد للمالك (هاتفٌ بديل) ينضم: يرفض البنك الذي أنشأه عضوٌ ووضع المالك افتتاحيّه، فلا يصل البنك أصلاً', async () => {
  const { s, Z } = await memberBankThenOwnerOpening();
  // والمالك يسحب من البنك نفسه نقداً على جهازه
  withdrawCashFromBank(s.owner, { bankId: Z, amountHalalas: 100000, date: '2026-11-01' });
  await sync(s.owner, s.r);
  const fresh = memDb();
  enableSync(fresh, UID);
  await sync(fresh, s.r);
  await sync(fresh, s.r);
  const out = { bank: opening(fresh, Z), rejects: bankRejects(fresh), waiting: fresh.all<{ tbl: string }>(`SELECT tbl FROM sync_inbox`).map((w) => w.tbl),
    wallet: { owner1: walletCashBalance(s.owner), fresh: walletCashBalance(fresh) } };
  // eslint-disable-next-line no-console
  console.log('K4b', JSON.stringify(out));
  expect(out.bank).toBe(500000);
  expect(out.rejects).toEqual([]);
  expect(out.wallet.fresh).toBe(out.wallet.owner1);
  fresh.close();
  s.close();
});

test('(K5) بنكٌ أنشأه عضو بافتتاحيٍّ غير صفر (نموذج ما قبل e8d6c19، والحقل مفتوحٌ له) ثم وارد بنكي بقيدٍ فيه: يُرفض البنك كله عند المالك وتعلق حركاته أبداً', async () => {
  const s = await pair();
  await sync(s.owner, s.r);
  await sync(s.dev, s.r);
  const since = snap(s.r);
  // كما كان يحفظه نموذج البنك للعضو قبل الجولة الخامسة (app/banks.tsx · save) · ثم إيرادٌ بنكي بقيد
  const Z = 'bank-member-k5';
  s.dev.run(`INSERT INTO banks (id, name, iban, opening_halalas, opening_date, created_at) VALUES (?,?,?,?,?,?)`,
    [Z, 'بنك العضو مصطنع K5', '', 300000, '2026-01-01', new Date().toISOString()]);
  recordManualBankTx(s.dev, { kind: 'income', bankId: Z, amountHalalas: 50000, date: '2026-10-10', descr: 'وارد بنكي مصطنع K5' });
  await sync(s.dev, s.r);
  newAsMember(s.r, since);
  await ownerPulls(s.owner, s.r);
  s.owner.run(`UPDATE sync_inbox SET waiting_since = '2020-01-01T00:00:00.000Z', attempts = 50`);
  await ownerPulls(s.owner, s.r);
  await ownerPulls(s.owner, s.r);
  const out = { bankHere: opening(s.owner, Z), wallet: { owner: walletCashBalance(s.owner), member: walletCashBalance(s.dev) },
    rejects: allRejects(s.owner).map((r) => r.tbl + ': ' + r.reason), waiting: inboxWaiting(s.owner).map((w) => w.tbl) };
  // eslint-disable-next-line no-console
  console.log('K5', JSON.stringify(out));
  // المتوقع بنص التصميم (§١٣.١٨ هـ «وبنك العضو الجديد بافتتاحيٍّ صفر»): البنك يصل بافتتاحيٍّ صفر وحركته معه، أو ينتظر؛ لا أن يُرفض كله
  expect(out.bankHere).not.toBeNull();
  expect(out.wallet.owner).toBe(out.wallet.member);
  s.close();
});
