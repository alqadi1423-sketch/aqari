/**
 * مراجعة إصلاح R12-SYN-3 (01bc668) · بيانات مصطنعة كلها.
 *
 * العيب: الإصلاح يجعل استعادة فاتورة الشراء المسدَّدة عمليةً واحدة على جهاز المالك (نسخة قيد الفاتورة ونسخة قيد سدادها وصفّها تُقبل معاً
 *   أو تُرفض معاً) بأن يبحث مع نسخة قيد الفاتورة عن نسخة السداد في الصندوق الوارد أو في المرفوض (siblingCopies) · فإن وصلت نسخة قيد
 *   الفاتورة في سحبٍ ونسخة السداد في سحبٍ بعده (رفع العضو على دفعات، أو سحب المالك بين دفعتين: holdBack كما في اختبارات B-1) لم تجد
 *   أختها فقُبلت، ثم رُفضت نسخة السداد لأن البنك لا يكفيها، ورُفض صفّ الفاتورة فبقي في السلة · فيبقى في الدفتر قيد فاتورة شراءٍ حيّ
 *   (ذمّة مورد ١٬٠٠٠ ريال) لفاتورةٍ في السلة وبلا سداد، خلاف ما يقوله الإصلاح نفسه.
 * السيناريو كاختبار review12.sync.bankNegativeSiblings (عضو المشتريات يستعيد فاتورةً سدّدها من بنكٍ سحب منه المالك) مع حبس نسخة قيد
 *   السداد وحركتها البنكية حتى يسحب المالك ما قبلهما.
 * الأرقام: 2100 = −١٠٠٬٠٠٠ (الفاتورة) + ١٠٠٬٠٠٠ (السداد) وعكساهما بالحذف = ٠ · ولا نسخة حيّة · والبنك ٠ (افتتاحي ١٠٠٬٠٠٠ − سحب ١٠٠٬٠٠٠).
 *   TZ=Asia/Riyadh npx jest tests/review12.r.purchaseRestoreSplit.test.ts
 */
import { memDb } from './helpers/testDb';
import { MemoryRemote } from './helpers/memoryRemote';
import { addBank } from './helpers/fixtures';
import { holdBack } from './helpers/rederive';
import { enableSync, syncOnce, setSyncState } from '@/sync/engine';
import { annotate, memberTokens } from '@/sync/acl';
import { getMeta } from '@/repos/settings';
import { withdrawCashFromBank } from '@/domain/cashOps';
import { savePurchase, payPurchase, deletePurchase, type PurchaseInput } from '@/domain/purchases';
import { restoreFromTrash } from '@/domain/trash';
import { bankBalance, accountBalance } from '@/domain/accounting/ledger';
import type { Access } from '@/domain/access/access';
import type { DB } from '@/db/adapter';
import type { RemoteDoc, RemoteStore } from '@/sync/types';

const ORG = 'OWNER-R12-RPS';
const OWNER: Access = { owner: true, uid: ORG, perms: {}, allProps: true, props: [] } as Access;
const PURCH: Access = { owner: false, uid: 'M-R12-RPS', perms: { purchases: 3 }, allProps: true, props: [] } as Access;
const dev = (db: DB) => getMeta(db, 'device_id')!;

test('استعادة فاتورة شراءٍ مسدَّدة تصل نسختا قيديها في سحبين: لا يبقى قيد الفاتورة حيّاً وهي في السلة بلا سداد', async () => {
  const r = new MemoryRemote();
  const owner = memDb();
  enableSync(owner, ORG);
  owner.run(`UPDATE company SET vat_enabled = 0 WHERE id = 1`);
  const A = addBank(owner, 'بنك أ مصطنع', 100_000);
  owner.run(`INSERT INTO suppliers (id, name, vat, category, default_category, created_at) VALUES (?,?,?,?,?,?)`,
    ['SUP-R12-RPS', 'مورد مصطنع', '310999999900003', 'صيانة', 'صيانة', new Date().toISOString()]);
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

  // العضو يسجّل فاتورة شراء ١٬٠٠٠ ريال ويسدّدها من بنك أ ثم يحذفها إلى السلة (يعود المبلغ إلى البنك)
  const pid = savePurchase(m, {
    supplier: 'مورد مصطنع', date: '2026-10-02', due: '2026-11-02', category: 'صيانة', incorpItem: '', amortize: false,
    amortizeMonths: null, exempt: false, excludeFromVat: true, unitId: null, propertyId: null, meterId: null, meterReading: null,
    subtotalHalalas: 100_000, taxHalalas: 0, totalHalalas: 100_000,
  } as PurchaseInput);
  payPurchase(m, pid, 'bank', A, '2026-10-03');
  deletePurchase(m, pid);
  await msync();
  await osync();
  expect(bankBalance(owner, A)).toBe(100_000);
  // المالك يسحب ١٬٠٠٠ من بنك أ: يصير صفراً
  withdrawCashFromBank(owner, { bankId: A, amountHalalas: 100_000, date: '2026-10-04' });
  await osync();
  await msync();
  // العضو يستعيدها (جهازه يرى بنك أ ١٬٠٠٠)
  try { restoreFromTrash(m, 'purchases', pid); } catch { /* المنع على جهاز العضو أحد طرفي الصحيح */ }
  await msync();
  // نسخة قيد السداد وحركتها البنكية تصلان المالك في سحبٍ لاحق
  const payCopy = [...r.docs.values()].find((d) => d.t === 'journal_entries' && d.d?.src_type === 'purchase_pay' && d.d?.src_id === pid
    && d.d?.reversed_by == null && !owner.get(`SELECT 1 FROM journal_entries WHERE id = ?`, [d.k]));
  expect(payCopy).toBeTruthy();
  const late = holdBack(r, (d) => d.k === payCopy!.k || (d.t === 'bank_tx' && d.d?.journal_no === payCopy!.d!.no));
  expect(late.count).toBe(2);
  await osync();
  late.release();
  await osync();
  owner.run(`UPDATE sync_inbox SET waiting_since = '2020-01-01T00:00:00.000Z', attempts = 50`);
  await osync();

  const out = {
    bankA: bankBalance(owner, A),
    inTrash: !!owner.get<{ d: string | null }>(`SELECT deleted_at AS d FROM purchases WHERE id = ?`, [pid])!.d,
    // 2100: −١٠٠٬٠٠٠ + ١٠٠٬٠٠٠ وعكساهما بالحذف = ٠
    ap2100: accountBalance(owner, '2100'),
    liveCopies: Number(owner.get<{ n: number }>(`SELECT COUNT(*) AS n FROM journal_entries WHERE src_id = ? AND src_type IN ('purchase', 'purchase_pay') AND reversed_by IS NULL`, [pid])!.n),
  };
  // eslint-disable-next-line no-console
  console.log('استعادة على سحبين ·', JSON.stringify(out));
  expect(out).toEqual({ bankA: 0, inTrash: true, ap2100: 0, liveCopies: 0 });
  owner.close(); m.close();
});
