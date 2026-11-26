/**
 * المراجعة الشاملة 2026-11-13 · R12-DEP-3 · تعديل التسوية المشروع من عضو يبقى مقبولاً على جهاز المالك ولو وصل صفّ التسوية في دفعةٍ بعد
 * قيوده · بيانات مصطنعة، والأرقام بالهللة محسوبة باليد.
 *
 * السيناريو كاختبار المدقق (review12.sync.depositRentCancelAlone): عقد ثلاثة أشهر بأقساط ١٬٠٠٠ وتأمين ١٬٥٠٠ نقداً، لم يُدفع شيء ·
 * سوّى المالك التأمين: خصم ١٬٥٠٠ منها ١٬٢٠٠ للأقساط (يناير ١٬٠٠٠ وفبراير ٢٠٠) و٣٠٠ أضرار · ثم يعدّل عضوٌ بقسمي التحصيل والتأمينات
 * التسوية من «التصرف بالتأمين» على إصدارٍ حديث: الخصم ١٬٥٠٠ كله مقابل الأقساط (يناير ١٬٠٠٠ وفبراير ٥٠٠) · وصفّ التسوية يتأخر وصوله
 * (العضو يرفع على دفعاتٍ من ثمانية).
 * الصحيح: قبل وصول الصف ينتظر عكس سداد الأقساط وإلغاء دفعاتهما ولا يُرفضان · وبعد وصوله يُقبل التعديل كله: يناير مدفوع وفبراير ٥٠٠،
 * و2400 صفر، والإيراد ١٬٥٠٠، و4300 صفر، والنقد ١٬٥٠٠.
 */
import { memDb } from './helpers/testDb';
import { MemoryRemote } from './helpers/memoryRemote';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { holdBack } from './helpers/rederive';
import { enableSync, syncOnce, setSyncState } from '@/sync/engine';
import { annotate } from '@/sync/acl';
import { getMeta } from '@/repos/settings';
import { confirmContract, saveDepositSettlement } from '@/domain/contracts/service';
import { accountBalance } from '@/domain/accounting/ledger';
import { integrityChecks } from '@/domain/accounting/integrity';
import type { Access } from '@/domain/access/access';
import type { DB } from '@/db/adapter';
import type { RemoteStore } from '@/sync/types';

const OWNER = 'OWNER-R12-DRE';
const dev = (db: DB) => getMeta(db, 'device_id')!;

async function joinMember(r: MemoryRemote, a: Access) {
  const db = memDb();
  enableSync(db, a.uid!);
  db.run(`DELETE FROM sync_outbox`);
  db.run(`INSERT OR REPLACE INTO sync_state (k, v) VALUES ('membership', ?)`, [JSON.stringify({ org: OWNER, profile: { name: 'عضو مصطنع' } })]);
  setSyncState(db, 'org', OWNER);
  const remote: RemoteStore = {
    pull: (c, l) => r.pull(c, l), write: (d) => r.write(d), clockSample: () => r.clockSample(),
    reserveBlocks: (q) => r.reserveBlocks(q), takeInvoiceSeq: (f) => r.takeInvoiceSeq(f), memberMode: true,
    annotate: (d, doc) => annotate(d, doc, a).doc,
  };
  await syncOnce(db, remote, dev(db));
  return { db, sync: () => syncOnce(db, remote, dev(db)) };
}

const paid = (db: DB, cid: string) => db.all<{ p: number }>(
  `SELECT paid_halalas AS p FROM contract_installments WHERE contract_id = ? ORDER BY due_date`, [cid]).map((x) => Number(x.p));

test('R12-DEP-3 · تعديل العضو للتسوية يُقبل على جهاز المالك ولو تأخر صفّها عن قيودها', async () => {
  const r = new MemoryRemote();
  const owner = memDb();
  enableSync(owner, OWNER);
  const u = addUnit(owner, addProperty(owner, { name: 'عقار مصطنع' }), { unit_no: 'DRE-1' });
  const cid = confirmContract(owner, contractInput(u, { tenant: 'مستأجر مصطنع', idNumber: '1000001341', phone: '0500001341',
    valueHalalas: 300_000, cycle: 'شهرية', start: '2026-01-01', end: '2026-03-31', depositHalalas: 150_000 }));
  saveDepositSettlement(owner, cid, { date: '2026-04-05', deductionHalalas: 150_000, deductionReason: 'إيجار وأضرار مصطنعة',
    refundHalalas: 0, notes: '', arrearsHalalas: 120_000 });
  await syncOnce(owner, r, dev(owner));
  // قُبض ١٬٥٠٠ · ١٬٢٠٠ إيراد إيجار من التأمين و٣٠٠ أضرار
  expect([paid(owner, cid), accountBalance(owner, '2400'), accountBalance(owner, '4200'), accountBalance(owner, '4300')])
    .toEqual([[100_000, 20_000, 0], 0, 120_000, 30_000]);

  const m = await joinMember(r, { owner: false, uid: 'M-R12-DRE', perms: { collect: 3, deposits: 3 }, allProps: true, props: [] } as Access);
  // التعديل من «التصرف بالتأمين»: الخصم كله مقابل الأقساط
  saveDepositSettlement(m.db, cid, { date: '2026-04-05', deductionHalalas: 150_000, deductionReason: 'إيجار مصطنع', refundHalalas: 0, notes: '', arrearsHalalas: 150_000 });
  await m.sync();
  const late = holdBack(r, (d) => d.t === 'deposit_settlements');
  expect(late.count).toBe(1);
  await syncOnce(owner, r, dev(owner));
  await syncOnce(owner, r, dev(owner));
  // ينتظر الصف ولا يُرفض شيء، والتسوية على حالها عند المالك
  expect(owner.all(`SELECT tbl, reason FROM sync_rejects`)).toEqual([]);
  expect(paid(owner, cid)).toEqual([100_000, 20_000, 0]);

  late.release();
  await syncOnce(owner, r, dev(owner));
  await syncOnce(owner, r, dev(owner));
  expect(owner.all(`SELECT tbl, reason FROM sync_rejects`)).toEqual([]);
  // يناير ١٬٠٠٠ وفبراير ٥٠٠ من التأمين · 2400 = ١٬٥٠٠ قبض − ١٬٥٠٠ سداد = صفر · 4200 = ١٬٥٠٠ · 4300 = ٣٠٠ − ٣٠٠ عكسٌ = صفر · والنقد ١٬٥٠٠
  expect([paid(owner, cid), accountBalance(owner, '2400'), accountBalance(owner, '4200'), accountBalance(owner, '4300'), accountBalance(owner, '1100')])
    .toEqual([[100_000, 50_000, 0], 0, 150_000, 0, 150_000]);
  expect(integrityChecks(owner).filter((c) => !c.ok).map((c) => c.name)).toEqual([]);
  owner.close();
  m.db.close();
});
