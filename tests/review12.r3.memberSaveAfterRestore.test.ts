/**
 * المراجع المعاكس الثالث على تعارض R12-DEP-2 مع R12-BAK-2 · documentKeptSettlement (service.ts) حين يحفظ التسوية عضو · بيانات مصطنعة،
 * والأرقام بالهللة محسوبة باليد.
 *
 * القرار: حفظ التسوية بعد الاستعادة يعكس قيودها الحيّة ويكتب «صار له مستند» لما ضُمّ منها ورُوجع، فيعود داخل المطابقة · لكن العلامة
 *   والتوثيق سطورٌ في سجل العمليات، وسجل العمليات لا يقرؤه العضو (readSections.ts: audit_log لقسم «سجل العمليات» وحده) · فحين يحفظ
 *   التسوية عضوٌ بقسمي التحصيل والتأمينات لا يرى العلامة فلا يوثّق شيئاً، ولا شيء على جهاز المالك يوثّق ما حفظه.
 * السيناريو: (أ) ستة أقساط ١٬٠٠٠ وتأمين ١٬٠٠٠، سُدّد خمسة · التسوية S1: التأمين كله مقابل ديسمبر (P1 وقيدها E1) · مزامنة · نسخة ·
 *   التعديل S2: ردّ التأمين كله (العاكس R1 وقيد الردّ F2) · مزامنة · استعادة النسخة واعتمادها (R1 وF2 في المراجعة، الفحوص خضراء) ·
 *   مزامنة · ثم يحفظ عضوٌ الردّ نفسه من «التصرف بالتأمين» (F2 يُعكس بـ F2′ ويُرحَّل F3) · مزامنة.
 * على جهاز المالك بعدها: الدفتر كما يريده المالك: 2400 = ٠ · 1100 = ٥٠٠٬٠٠٠ + ١٠٠٬٠٠٠ − F2 + F2′ − F3 = ٥٠٠٬٠٠٠ · 4200 = ٥٠٠٬٠٠٠ ·
 *   وديسمبر مستحق · لكن R1 باقٍ معلَّماً خارج المطابقة (F2 معكوسٌ فخرج من المراجعة) وأصله E1 داخلها:
 *   المعلَّم R1 + F2 + F2′ = −١٠٠٬٠٠٠ · فيحمرّ فحص التأمينات بألف، وR1 في أداة المراجعة بلا زرّ (مرآة قيد)، و«تمّت مراجعته» تُبقيه خارجها.
 * الصحيح (كحفظ المالك نفسه · review12.r2.settlementAfterRestore): بعد حفظ تسويةٍ يطابقها الدفتر تخضرّ الفحوص وتفرغ المراجعة.
 *   TZ=Asia/Riyadh npx jest tests/review12.r3.memberSaveAfterRestore.test.ts
 */
import * as path from 'node:path';
import { tempDir, rmrf, memDb } from './helpers/testDb';
import { MemoryRemote } from './helpers/memoryRemote';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { makeBackupEnv, type TestBackupEnv } from './helpers/backupEnv';
import { confirmContract, saveDepositSettlement, recordRentPayment } from '@/domain/contracts/service';
import { createBackup } from '@/domain/backup/create';
import { prepareRestore, commitRestore } from '@/domain/backup/restore';
import { integrityChecks } from '@/domain/accounting/integrity';
import { accountBalance } from '@/domain/accounting/ledger';
import { keptForReview } from '@/domain/accounting/orphans';
import { enableSync, syncOnce, readCloud, planFromSnapshot, adoptAsCloudTruth, setSyncState } from '@/sync/engine';
import { annotate, memberTokens } from '@/sync/acl';
import { getMeta } from '@/repos/settings';
import type { Access } from '@/domain/access/access';
import type { DB } from '@/db/adapter';
import type { RemoteStore, RemoteDoc } from '@/sync/types';

const UID = 'user-r12-r3-msr';
const OWNER_ACCESS: Access = { owner: true, uid: UID, perms: {}, allProps: true, props: [] } as Access;
const dirs: string[] = [];
const newEnv = () => { const d = tempDir('aq-r12-r3-msr-'); dirs.push(d); return makeBackupEnv(d); };
afterAll(() => { for (const d of dirs) rmrf(d); });
async function backup(env: TestBackupEnv): Promise<string> {
  const out = path.join(env.root, 'b-' + Math.random().toString(36).slice(2) + '.aqbk');
  await createBackup(env, out);
  return out;
}
const insts = (db: DB, c: string) => db.all<{ id: string; due_date: string }>(
  `SELECT id, due_date FROM contract_installments WHERE contract_id = ? ORDER BY due_date`, [c]);
const sync = (db: DB, r: RemoteStore) => syncOnce(db, r, getMeta(db, 'device_id')!);
const ARREARS = { deductionHalalas: 100000, deductionReason: 'إيجار ديسمبر غير المدفوع', refundHalalas: 0, notes: '', arrearsHalalas: 100000 };
const REFUND = { deductionHalalas: 0, deductionReason: '', refundHalalas: 100000, notes: '', arrearsHalalas: 0 };
const view = (db: DB, dec: string) => ({
  c1100: accountBalance(db, '1100'), c2400: accountBalance(db, '2400'), c4200: accountBalance(db, '4200'),
  dec: db.get(`SELECT paid_halalas AS p, status AS s FROM contract_installments WHERE id = ?`, [dec]),
  red: integrityChecks(db).filter((c) => !c.ok).map((c) => c.name + ' (' + c.value + ')'),
  review: keptForReview(db).map((k) => db.get<{ t: string }>(`SELECT src_type AS t FROM journal_entries WHERE id = ?`, [k.id])!.t).sort(),
});

/** عضوٌ يسحب ما تقرؤه رموز عضويته وحدها (كقواعد Firestore) · رموز المستند كما يكتبها annotate على جهاز المالك */
async function joinMember(r: MemoryRemote, a: Access, owner: () => DB) {
  const db = memDb();
  enableSync(db, a.uid!);
  db.run(`DELETE FROM sync_outbox`);
  db.run(`INSERT OR REPLACE INTO sync_state (k, v) VALUES ('membership', ?)`, [JSON.stringify({ org: UID, profile: { name: 'عضو مصطنع' } })]);
  setSyncState(db, 'org', UID);
  const tokens = new Set(memberTokens(a));
  const seen = (x: RemoteDoc | null | undefined) => !!x && (x.g ?? []).some((g) => tokens.has(g));
  const remote: RemoteStore = {
    pull: async (c, l) => {
      const page = await r.pull(c, l);
      const docs: RemoteDoc[] = [];
      for (const d of page.docs) {
        const { doc, pub } = annotate(owner(), { ...d } as RemoteDoc, OWNER_ACCESS);
        if (seen(doc)) docs.push(d);
        else if (seen(pub)) docs.push(pub!);
      }
      return { ...page, docs };
    },
    write: (d) => r.write(d), clockSample: () => r.clockSample(),
    reserveBlocks: (q) => r.reserveBlocks(q), takeInvoiceSeq: (f) => r.takeInvoiceSeq(f), memberMode: true,
    annotate: (d, doc) => annotate(d, doc, a).doc,
  };
  await sync(db, remote);
  return { db, sync: () => sync(db, remote) };
}

test('عضوٌ يحفظ التسوية بعد استعادةٍ ضمّت تعديلها: يخضرّ فحص التأمينات وتفرغ المراجعة على جهاز المالك كحفظ المالك نفسه', async () => {
  const r = new MemoryRemote();
  const env = newEnv();
  enableSync(env.db, UID);
  const db0 = env.db;
  const u = addUnit(db0, addProperty(db0, { name: 'عقار حفظ العضو المصطنع' }), { unit_no: 'R3M-1' });
  const a = confirmContract(db0, contractInput(u, { tenant: 'مستأجر حفظ العضو المصطنع', idNumber: '1000013201', phone: '0500013201',
    start: '2025-07-01', end: '2025-12-31', valueHalalas: 600000, depositHalalas: 100000 }));
  for (const i of insts(db0, a).slice(0, 5)) {
    recordRentPayment(db0, a, { installmentId: i.id, period: '', date: i.due_date, lines: [{ method: 'cash', amountHalalas: 100000 }], discountHalalas: 0, notes: '' });
  }
  const dec = insts(db0, a)[5].id;
  const date = '2026-01-05';
  saveDepositSettlement(db0, a, { date, ...ARREARS });
  await sync(db0, r);
  const archive = await backup(env);
  saveDepositSettlement(db0, a, { date, ...REFUND });
  await sync(db0, r);

  const snap = await readCloud(r);
  const db = (await commitRestore(env, await prepareRestore(env, archive, undefined, { cloud: async () => snap.docs }))).db;
  adoptAsCloudTruth(db, UID, planFromSnapshot(db, snap));
  for (let i = 0; i < 2; i++) await sync(db, r);
  // بعد الاستعادة: 1100 = ٥٠٠٬٠٠٠ + ١٠٠٬٠٠٠ − F2 ١٠٠٬٠٠٠ = ٥٠٠٬٠٠٠ · 4200 = ٥٠٠٬٠٠٠ + E1 − R1 = ٥٠٠٬٠٠٠ · R1 وF2 في المراجعة
  expect(view(db, dec)).toEqual({ c1100: 500000, c2400: 0, c4200: 500000, dec: { p: 0, s: 'مستحقة' }, red: [],
    review: ['deposit_refund', 'deposit_rent_rev'] });

  const m = await joinMember(r, { owner: false, uid: 'M-R12-R3-MSR', perms: { collect: 3, deposits: 3 }, allProps: true, props: [] } as Access, () => db);
  saveDepositSettlement(m.db, a, { date, ...REFUND });
  for (let i = 0; i < 3; i++) { await m.sync(); await sync(db, r); }
  expect(db.all(`SELECT tbl, reason FROM sync_rejects`)).toEqual([]);
  // 1100 = ٥٠٠٬٠٠٠ قبل الحفظ (F2 فيه) + F2′ ١٠٠٬٠٠٠ − F3 ١٠٠٬٠٠٠ = ٥٠٠٬٠٠٠ · 2400 = ٠ · 4200 = ٥٠٠٬٠٠٠ · ديسمبر مستحق
  // اليوم: فحص التأمينات أحمر (-1,000.00 / 0.00 · خارجها قيود بلا مستند 1,000.00) وR1 باقٍ في المراجعة
  expect(view(db, dec)).toEqual({ c1100: 500000, c2400: 0, c4200: 500000, dec: { p: 0, s: 'مستحقة' }, red: [], review: [] });
  env.closeLive();
  m.db.close();
});
