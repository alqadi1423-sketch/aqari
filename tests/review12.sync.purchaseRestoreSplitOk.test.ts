/**
 * مراجعة إصلاح R12-SYN-3 · ضابطٌ لانتظار نسخة السداد (review12.r.purchaseRestoreSplit) · بيانات مصطنعة كلها.
 *
 * نسخة قيد فاتورة الشراء المستعادة وصفّها ينتظران نسخة قيد سدادها ما دامت في الطريق، فيُحكم على الاستعادة كلها معاً · والبنك يكفيها
 * هنا (المالك لا يسحب)، فتُستعاد كلها حين تصل نسخة السداد · ولا يطول الانتظار: بعد ساعةٍ بوقت الخادم (LATE_LINK_MS) يُحكم على نسخة
 * الفاتورة وصفّها وحدهما كما كان.
 * الأرقام (بنك أ افتتاحيه ١٠٠٬٠٠٠ هللة، والفاتورة ١٠٠٬٠٠٠ بلا ضريبة):
 *   البنك = ١٠٠٬٠٠٠ − ١٠٠٬٠٠٠ (السداد) + ١٠٠٬٠٠٠ (عكسه بالحذف) − ١٠٠٬٠٠٠ (نسخته بالاستعادة) = ٠
 *   2100 = ١٠٠٬٠٠٠ (الفاتورة) − ١٠٠٬٠٠٠ (السداد) − ١٠٠٬٠٠٠ + ١٠٠٬٠٠٠ (عكساهما) + ١٠٠٬٠٠٠ − ١٠٠٬٠٠٠ (نسختاهما) = ٠
 *   وفي الانتظار: البنك ١٠٠٬٠٠٠ (بعد الحذف) و2100 = ٠، والفاتورة في السلة.
 *   TZ=Asia/Riyadh npx jest tests/review12.sync.purchaseRestoreSplitOk.test.ts
 */
import { memDb } from './helpers/testDb';
import { MemoryRemote } from './helpers/memoryRemote';
import { addBank } from './helpers/fixtures';
import { holdBack } from './helpers/rederive';
import { enableSync, syncOnce, setSyncState } from '@/sync/engine';
import { annotate, memberTokens } from '@/sync/acl';
import { getMeta } from '@/repos/settings';
import { savePurchase, payPurchase, deletePurchase, type PurchaseInput } from '@/domain/purchases';
import { restoreFromTrash } from '@/domain/trash';
import { bankBalance, accountBalance } from '@/domain/accounting/ledger';
import type { Access } from '@/domain/access/access';
import type { DB } from '@/db/adapter';
import type { RemoteDoc, RemoteStore } from '@/sync/types';

const ORG = 'OWNER-R12-RPO';
const OWNER: Access = { owner: true, uid: ORG, perms: {}, allProps: true, props: [] } as Access;
const PURCH: Access = { owner: false, uid: 'M-R12-RPO', perms: { purchases: 3 }, allProps: true, props: [] } as Access;
const dev = (db: DB) => getMeta(db, 'device_id')!;

async function setup() {
  const r = new MemoryRemote();
  const owner = memDb();
  enableSync(owner, ORG);
  owner.run(`UPDATE company SET vat_enabled = 0 WHERE id = 1`);
  const A = addBank(owner, 'بنك أ مصطنع', 100_000);
  owner.run(`INSERT INTO suppliers (id, name, vat, category, default_category, created_at) VALUES (?,?,?,?,?,?)`,
    ['SUP-R12-RPO', 'مورد مصطنع', '310999999900003', 'صيانة', 'صيانة', new Date().toISOString()]);
  await syncOnce(owner, r, dev(owner));
  const tokens = new Set(memberTokens(PURCH));
  const seen = (x: RemoteDoc | null) => !!x && (x.g ?? []).some((g) => tokens.has(g));
  const m = memDb();
  enableSync(m, PURCH.uid!);
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
    annotate: (d, doc) => annotate(d, doc, PURCH).doc,
  };
  const msync = () => syncOnce(m, remote, dev(m));
  const osync = async () => { await syncOnce(owner, r, dev(owner)); await syncOnce(owner, r, dev(owner)); };
  await msync();
  // العضو يسجّل فاتورة شراء ١٬٠٠٠ ريال ويسدّدها من بنك أ ثم يحذفها إلى السلة، ثم يستعيدها
  const pid = savePurchase(m, {
    supplier: 'مورد مصطنع', date: '2026-10-02', due: '2026-11-02', category: 'صيانة', incorpItem: '', amortize: false,
    amortizeMonths: null, exempt: false, excludeFromVat: true, unitId: null, propertyId: null, meterId: null, meterReading: null,
    subtotalHalalas: 100_000, taxHalalas: 0, totalHalalas: 100_000,
  } as PurchaseInput);
  payPurchase(m, pid, 'bank', A, '2026-10-03');
  deletePurchase(m, pid);
  await msync();
  await osync();
  await msync();
  restoreFromTrash(m, 'purchases', pid);
  await msync();
  // نسخة قيد السداد وحركتها البنكية تتأخران عن نسخة قيد الفاتورة وصفّها
  const payCopy = [...r.docs.values()].find((d) => d.t === 'journal_entries' && d.d?.src_type === 'purchase_pay' && d.d?.src_id === pid
    && d.d?.reversed_by == null && !owner.get(`SELECT 1 FROM journal_entries WHERE id = ?`, [d.k]));
  const late = holdBack(r, (d) => d.k === payCopy!.k || (d.t === 'bank_tx' && d.d?.journal_no === payCopy!.d!.no));
  expect(late.count).toBe(2);
  const state = () => ({
    bankA: bankBalance(owner, A),
    inTrash: !!owner.get<{ d: string | null }>(`SELECT deleted_at AS d FROM purchases WHERE id = ?`, [pid])!.d,
    ap2100: accountBalance(owner, '2100'),
    liveCopies: Number(owner.get<{ n: number }>(`SELECT COUNT(*) AS n FROM journal_entries WHERE src_id = ? AND src_type IN ('purchase', 'purchase_pay') AND reversed_by IS NULL`, [pid])!.n),
  });
  return { owner, m, pid, late, osync, state };
}

test('ضابط: البنك يكفي · نسخة الفاتورة وصفّها ينتظران نسخة السداد ثم تُستعاد كلها معاً', async () => {
  const s = await setup();
  await s.osync();
  // في الانتظار: الفاتورة في السلة ولا نسخة حيّة، والبنك ١٠٠٬٠٠٠ و2100 = ٠
  const waiting = s.state();
  s.late.release();
  await s.osync();
  const done = s.state();
  // eslint-disable-next-line no-console
  console.log('استعادة يكفيها البنك ·', JSON.stringify({ waiting, done }));
  expect({ waiting, done }).toEqual({
    waiting: { bankA: 100_000, inTrash: true, ap2100: 0, liveCopies: 0 },
    // ١٠٠٬٠٠٠ − ١٠٠٬٠٠٠ = ٠ في البنك، و2100 = ٠، ونسختان حيّتان
    done: { bankA: 0, inTrash: false, ap2100: 0, liveCopies: 2 },
  });
  s.owner.close(); s.m.close();
});

test('ضابط: نسخة السداد لم تصل بعد ساعةٍ بوقت الخادم · يُحكم على نسخة الفاتورة وصفّها وحدهما ولا ينتظران أبداً', async () => {
  const s = await setup();
  await s.osync();
  expect(s.state().inTrash).toBe(true);
  // تمضي ساعتان (ساعة الجهاز والخادم معاً · المؤقّتات كما هي)
  jest.useFakeTimers({ now: Date.now() + 2 * 3600 * 1000, doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'setInterval',
    'clearTimeout', 'clearInterval', 'clearImmediate', 'queueMicrotask', 'hrtime', 'performance'] });
  try { await s.osync(); } finally { jest.useRealTimers(); }
  const alone = s.state();
  s.late.release();
  await s.osync();
  const done = s.state();
  // eslint-disable-next-line no-console
  console.log('نسخة السداد بعد الساعة ·', JSON.stringify({ alone, done }));
  expect({ alone, done }).toEqual({
    // نسخة الفاتورة وحدها: ذمّة المورد ١٠٠٬٠٠٠ والبنك ١٠٠٬٠٠٠
    alone: { bankA: 100_000, inTrash: false, ap2100: 100_000, liveCopies: 1 },
    done: { bankA: 0, inTrash: false, ap2100: 0, liveCopies: 2 },
  });
  s.owner.close(); s.m.close();
});
