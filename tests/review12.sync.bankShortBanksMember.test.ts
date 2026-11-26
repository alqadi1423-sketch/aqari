/**
 * مراجعة إصلاح R12-SYN-3 (المراجع: «ومثله عضوان، أحدهما للبنوك والآخر للتحصيل، يصلان في سحبٍ واحد») · بيانات مصطنعة كلها.
 *
 * العيب: حدّ البنك على جهاز المالك لقيد العضو (memberBankOutCheck) يحسب ما طُبّق من حركات البنك وما ينتظر من الداخل وحده · وحركات
 *   البنك تُطبَّق بعد القيود · فسحبُ عضو البنوك (حركةٌ بلا قيد) وإلغاءُ عضو التحصيل إن وصلا جهاز المالك في سحبٍ واحد قُبل الإلغاء
 *   (يرى البنك قبل السحب) وانتظر السحب ثم رُفض، وجهازٌ للمالك سحب السحب وحده قبل الإلغاء طبّقه ورفض الإلغاء · فيختلف دفترا المالك
 *   على جهازيه بحسب توقيت السحب لا بترتيب ما كُتب.
 * الصحيح: الحكم بترتيب الكتابة في السحابة (وقت الخادم) أياً كان توقيت السحب: ما كتبه العضو قبل هذا القيد يُحسب له، وما كتبه بعده يُحكم
 *   عليه بعده.
 *   ١) سحب عضو البنوك كُتب قبل الإلغاء: الإلغاء مرفوض على الجهازين · بنك أ = ٠ + ١٢٠٬٠٠٠ − ١٠٠٬٠٠٠ = ٢٠٬٠٠٠ هللة.
 *   ٢) ضابط: الإلغاء كُتب قبل سحبٍ كتبه عضو البنوك بلا اتصال: الإلغاء مقبول والسحب ينتظر ثم يُرفض (حدٌّ موثَّق L٦) على الجهازين ·
 *      بنك أ = ٠ + ١٢٠٬٠٠٠ − ١٢٠٬٠٠٠ = ٠ هللة.
 *   TZ=Asia/Riyadh npx jest tests/review12.sync.bankShortBanksMember.test.ts
 */
import { memDb } from './helpers/testDb';
import { MemoryRemote } from './helpers/memoryRemote';
import { addBank, addProperty, addUnit, contractInput } from './helpers/fixtures';
import { enableSync, syncOnce, setSyncState } from '@/sync/engine';
import { annotate, memberTokens } from '@/sync/acl';
import { getMeta } from '@/repos/settings';
import { confirmContract, recordRentPayment } from '@/domain/contracts/service';
import { cancelPayment } from '@/domain/contracts/cancelPayment';
import { withdrawCashFromBank } from '@/domain/cashOps';
import { bankBalance } from '@/domain/accounting/ledger';
import type { Access } from '@/domain/access/access';
import type { DB } from '@/db/adapter';
import type { RemoteDoc, RemoteStore } from '@/sync/types';

const ORG = 'OWNER-R12-BBM';
const OWNER: Access = { owner: true, uid: ORG, perms: {}, allProps: true, props: [] } as Access;
const COLLECT: Access = { owner: false, uid: 'M-R12-BBM-C', perms: { collect: 3 }, allProps: true, props: [] } as Access;
const BANKS: Access = { owner: false, uid: 'M-R12-BBM-B', perms: { banks: 3 }, allProps: true, props: [] } as Access;
const dev = (db: DB) => getMeta(db, 'device_id')!;

/** جهاز عضوٍ يسحب ما تجيزه رموز رؤيته كما يكتبها annotate (كـ review12.r.bankShortSecondOwner) */
function memberDevice(r: MemoryRemote, owner: DB, member: Access) {
  const tokens = new Set(memberTokens(member));
  const seen = (x: RemoteDoc | null) => !!x && (x.g ?? []).some((g) => tokens.has(g));
  const m = memDb();
  enableSync(m, member.uid!);
  m.run(`DELETE FROM sync_outbox`);
  m.run(`INSERT OR REPLACE INTO sync_state (k, v) VALUES ('membership', ?)`, [JSON.stringify({ org: ORG, profile: { name: 'عضو مصطنع' } })]);
  setSyncState(m, 'org', ORG);
  const remote: RemoteStore = {
    pull: async (c, l) => {
      const page = await r.pull(c, l);
      const docs: RemoteDoc[] = [];
      for (const d of page.docs) {
        const a = d.op ? { doc: d, pub: null } : annotate(owner, { ...d } as RemoteDoc, OWNER);
        if (seen(a.doc)) docs.push(a.doc);
        else if (seen(a.pub)) docs.push(a.pub!);
      }
      return { ...page, docs };
    },
    write: (d) => r.write(d), clockSample: () => r.clockSample(),
    reserveBlocks: (q) => r.reserveBlocks(q), takeInvoiceSeq: (f) => r.takeInvoiceSeq(f), memberMode: true,
    annotate: (d, doc) => annotate(d, doc, member).doc,
  };
  return { m, sync: () => syncOnce(m, remote, dev(m)) };
}

async function setup() {
  const r = new MemoryRemote();
  const owner = memDb();
  enableSync(owner, ORG);
  const A = addBank(owner, 'بنك أ مصطنع', 0);
  const u = addUnit(owner, addProperty(owner, { name: 'عقار مصطنع' }), { unit_no: 'BBM-1' });
  const cid = confirmContract(owner, contractInput(u, { tenant: 'مستأجر مصطنع', idNumber: '1000001481', phone: '0555551481' }));
  await syncOnce(owner, r, dev(owner));
  const tab = memDb();
  enableSync(tab, ORG);
  const osync = async () => { await syncOnce(owner, r, dev(owner)); await syncOnce(owner, r, dev(owner)); };
  const tsync = async () => { await syncOnce(tab, r, dev(tab)); await syncOnce(tab, r, dev(tab)); };
  await tsync();
  const c = memberDevice(r, owner, COLLECT);
  const b = memberDevice(r, owner, BANKS);
  await c.sync();
  await b.sync();
  // عضو التحصيل يحصّل ١٬٢٠٠ بشيكٍ في بنك أ · يصل الجهازين وعضو البنوك
  const inst = c.m.get<{ id: string }>(`SELECT id FROM contract_installments WHERE contract_id = ? ORDER BY due_date LIMIT 1`, [cid])!.id;
  const pay = recordRentPayment(c.m, cid, { installmentId: inst, period: 'الأول', date: '2026-02-01',
    lines: [{ method: 'cheque', bankId: A, amountHalalas: 120_000 }], discountHalalas: 0, notes: '' });
  await c.sync();
  await osync();
  await tsync();
  await b.sync();
  expect([bankBalance(owner, A), bankBalance(tab, A), bankBalance(b.m, A)]).toEqual([120_000, 120_000, 120_000]);
  /** يمضي شهر على الجهازين: ما ينتظر يُحسم */
  const monthLater = async () => {
    for (const db of [owner, tab]) db.run(`UPDATE sync_inbox SET waiting_since = '2020-01-01T00:00:00.000Z', attempts = 50`);
    await osync();
    await tsync();
    await osync();
    await tsync();
  };
  return { owner, tab, c, b, A, pay, osync, tsync, monthLater };
}

test('سحب عضو البنوك كُتب قبل إلغاء عضو التحصيل: يُرفض الإلغاء على جهاز المالك سحبهما معاً أو كلاً وحده', async () => {
  const s = await setup();
  // عضو البنوك يسحب ١٬٠٠٠ من بنك أ (يرى ١٬٢٠٠) ويرفع · اللوح يسحبه وحده
  withdrawCashFromBank(s.b.m, { bankId: s.A, amountHalalas: 100_000, date: '2026-02-05' });
  await s.b.sync();
  await s.tsync();
  // الشيك يرتجع: عضو التحصيل يلغي (لا يرى حركات البنك فيرى بنك أ ١٬٢٠٠) ويرفع بعد السحب
  try { cancelPayment(s.c.m, s.pay, { date: '2026-02-10', reason: 'شيك مرتجع مصطنع' }); } catch { /* المنع على جهاز العضو أحد طرفي الصحيح */ }
  await s.c.sync();
  // جهاز المالك يسحب السحب والإلغاء معاً، واللوح الإلغاء وحده
  await s.osync();
  await s.tsync();
  await s.monthLater();
  const out = {
    owner: bankBalance(s.owner, s.A), tablet: bankBalance(s.tab, s.A),
    cancelled: [s.owner, s.tab].map((db) => !!db.get<{ c: string | null }>(`SELECT cancelled_at AS c FROM contract_payments WHERE id = ?`, [s.pay])!.c),
  };
  // eslint-disable-next-line no-console
  console.log('عضو البنوك قبل الإلغاء ·', JSON.stringify(out));
  // ٠ + ١٢٠٬٠٠٠ − ١٠٠٬٠٠٠ = ٢٠٬٠٠٠ على الجهازين، والدفعة غير ملغاة
  expect(out).toEqual({ owner: 20_000, tablet: 20_000, cancelled: [false, false] });
  s.owner.close(); s.tab.close(); s.c.m.close(); s.b.m.close();
});

test('ضابط: الإلغاء كُتب قبل سحبٍ كتبه عضو البنوك بلا اتصال: يُقبل الإلغاء وينتظر السحب ثم يُرفض على الجهازين', async () => {
  const s = await setup();
  // عضو التحصيل يلغي ويرفع أولاً · اللوح يسحبه وحده
  cancelPayment(s.c.m, s.pay, { date: '2026-02-10', reason: 'شيك مرتجع مصطنع' });
  await s.c.sync();
  await s.tsync();
  // عضو البنوك سحب ١٬٠٠٠ بلا اتصال قبل أن يصله الإلغاء، ثم زامن فرُفع سحبه بعد الإلغاء
  withdrawCashFromBank(s.b.m, { bankId: s.A, amountHalalas: 100_000, date: '2026-02-05' });
  await s.b.sync();
  // جهاز المالك يسحب الإلغاء والسحب معاً
  await s.osync();
  await s.tsync();
  await s.monthLater();
  const out = {
    owner: bankBalance(s.owner, s.A), tablet: bankBalance(s.tab, s.A),
    cancelled: [s.owner, s.tab].map((db) => !!db.get<{ c: string | null }>(`SELECT cancelled_at AS c FROM contract_payments WHERE id = ?`, [s.pay])!.c),
  };
  // eslint-disable-next-line no-console
  console.log('الإلغاء قبل سحب عضو البنوك ·', JSON.stringify(out));
  // ٠ + ١٢٠٬٠٠٠ − ١٢٠٬٠٠٠ = ٠ على الجهازين (السحب مرفوض)، والدفعة ملغاة
  expect(out).toEqual({ owner: 0, tablet: 0, cancelled: [true, true] });
  s.owner.close(); s.tab.close(); s.c.m.close(); s.b.m.close();
});
