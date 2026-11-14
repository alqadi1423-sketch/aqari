/**
 * إصلاح المراجع المستقل الخامس على R12-BAK-2 · سبب الإلغاء الذي يكتبه الضمّ (DEPOSIT_RENT_KEPT_REASON) يعيده جهاز المالك حين يوثّق عاكسَه
 * حفظُ عضوٍ لا يرى الدفعات (قسم «التأمينات» وحده) فلا يعيده هو (sync/engine.ts: unkeepDocumentedDepositRent) · وإلا بقيت ورقة الموظف بقسم
 * التحصيل تعدّ دفعة ديسمبر الملغاة بعد أن صارت التسوية أضراراً، وجهاز المالك لا يعدّها · بيانات مصطنعة، والأرقام بالهللة محسوبة باليد.
 *
 * السيناريو كاختبار ورقة الموظف (review12.r5.memberSheetArrears): عقد يوليو إلى ديسمبر ٢٠٢٥ بأقساط ١٠٠٬٠٠٠ وتأمين ١٠٠٬٠٠٠ نقداً، سُدّد
 *   يوليو إلى نوفمبر نقداً · S0 خصم ١٠٠٬٠٠٠ كله ديسمبر (P وقيدها E) · نسخة B0 · S1 ردّ التأمين كله (R يعكس E وP ملغاة به، والردّ F) ·
 *   يستعيد المالك B0 ويعتمدها: P ملغاة بسبب الضمّ عند المالك وعند موظف التحصيل M، وورقة كلٍّ منهما ١٠٠٬٠٠٠ ·
 *   ثم يحفظ موظف التأمينات D (لا يرى الدفعات ولا الأقساط) التسوية خصماً ١٠٠٬٠٠٠ أضراراً بلا أقساطٍ متأخرة.
 * بعد حفظ D: F′ يعكس F (مدين 1100 / دائن 2400) وقيد الخصم (مدين 2400 / دائن 4300 ١٠٠٬٠٠٠) · 1100 = ٥٠٠٬٠٠٠ + ١٠٠٬٠٠٠ − F + F′ = ٦٠٠٬٠٠٠ ·
 *   2400 (دائن موجب) = ١٠٠٬٠٠٠ − E + R − F + F′ − ١٠٠٬٠٠٠ = ٠ · 4200 = ٥٠٠٬٠٠٠ · 4300 = ١٠٠٬٠٠٠ · وديسمبر مستحقٌّ بلا مسدَّد (٠) ·
 *   وسطر حفظه يوثّق R عند المالك، فيعيد سبب P سبب التعديل ويرفعه: الورقة عند المالك وعند M صفر، والفحوص خضراء والمراجعة فارغة.
 *   TZ=Asia/Riyadh npx jest tests/review12.r5.depositsOnlyResave.test.ts
 */
import * as path from 'node:path';
import { tempDir, rmrf, memDb } from './helpers/testDb';
import { MemoryRemote } from './helpers/memoryRemote';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { makeBackupEnv, type TestBackupEnv } from './helpers/backupEnv';
import { confirmContract, saveDepositSettlement, recordRentPayment, depositArrearsPaid } from '@/domain/contracts/service';
import { DEPOSIT_RENT_EDIT_REASON, DEPOSIT_RENT_KEPT_REASON, DEPOSIT_RENT_METHOD } from '@/domain/contracts/installments';
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

const UID = 'OWNER-R12-R5-DOR';
const OWNER_ACCESS: Access = { owner: true, uid: UID, perms: {}, allProps: true, props: [] } as Access;
const dirs: string[] = [];
const newEnv = () => { const d = tempDir('aq-r12-r5-dor-'); dirs.push(d); return makeBackupEnv(d); };
afterAll(() => { for (const d of dirs) rmrf(d); });
async function backup(env: TestBackupEnv): Promise<string> {
  const out = path.join(env.root, 'b-' + Math.random().toString(36).slice(2) + '.aqbk');
  await createBackup(env, out);
  return out;
}
const dev = (db: DB) => getMeta(db, 'device_id')!;
const sync = (db: DB, r: MemoryRemote) => syncOnce(db, r, dev(db));
const insts = (db: DB, c: string) => db.all<{ id: string; due_date: string }>(
  `SELECT id, due_date FROM contract_installments WHERE contract_id = ? ORDER BY due_date`, [c]);
const reasons = (db: DB, c: string) => db.all<{ r: string | null }>(
  `SELECT cancel_reason AS r FROM contract_payments WHERE contract_id = ? AND method_label = ? ORDER BY date, rowid`, [c, DEPOSIT_RENT_METHOD])
  .map((x) => x.r);

/** الموظف يسحب ما تقرؤه رموز عضويته وحدها (كقواعد Firestore) · والمالك يوسم المستند بقاعدته الحية (تتبدّل بالاستعادة) */
async function joinMember(r: MemoryRemote, a: Access, owner: () => DB) {
  const tokens = new Set(memberTokens(a));
  const seen = (x: RemoteDoc | null | undefined) => !!x && (x.g ?? []).some((g) => tokens.has(g));
  const pull: RemoteStore['pull'] = async (c, l) => {
    const page = await r.pull(c, l);
    const docs: RemoteDoc[] = [];
    for (const d of page.docs) {
      const { doc, pub } = annotate(owner(), { ...d } as RemoteDoc, OWNER_ACCESS);
      if (seen(doc)) docs.push(d);
      else if (seen(pub)) docs.push(pub!);
    }
    return { ...page, docs };
  };
  const db = memDb();
  enableSync(db, a.uid!);
  db.run(`DELETE FROM sync_outbox`);
  db.run(`INSERT OR REPLACE INTO sync_state (k, v) VALUES ('membership', ?)`, [JSON.stringify({ org: UID, profile: { name: 'موظف مصطنع' } })]);
  setSyncState(db, 'org', UID);
  const remote: RemoteStore = {
    pull, write: (d) => r.write(d), clockSample: () => r.clockSample(),
    reserveBlocks: (q) => r.reserveBlocks(q), takeInvoiceSeq: (f) => r.takeInvoiceSeq(f), memberMode: true,
    annotate: (d, doc) => annotate(d, doc, a).doc,
  };
  await syncOnce(db, remote, dev(db));
  return { db, sync: () => syncOnce(db, remote, dev(db)) };
}

test('موظف التأمينات وحده يحفظ بعد الاستعادة تسويةً أضراراً: جهاز المالك يعيد سبب الإلغاء فلا تعدّ ورقة موظف التحصيل ديسمبر', async () => {
  const r = new MemoryRemote();
  const env = newEnv();
  enableSync(env.db, UID);
  const A = env.db;
  const k = confirmContract(A, contractInput(addUnit(A, addProperty(A, { name: 'عقار موظف التأمينات المصطنع' }), { unit_no: 'R5D-1' }), {
    tenant: 'مستأجر موظف التأمينات المصطنع', idNumber: '1000015002', phone: '0500015002',
    start: '2025-07-01', end: '2025-12-31', valueHalalas: 600000, depositHalalas: 100000 }));
  for (const i of insts(A, k).slice(0, 5)) {
    recordRentPayment(A, k, { installmentId: i.id, period: '', date: i.due_date, lines: [{ method: 'cash', amountHalalas: 100000 }], discountHalalas: 0, notes: '' });
  }
  saveDepositSettlement(A, k, { date: '2026-01-05', deductionHalalas: 100000, deductionReason: 'إيجار ديسمبر غير المدفوع', refundHalalas: 0, notes: '', arrearsHalalas: 100000 });
  await sync(A, r);
  let owner = env.db;
  const m = await joinMember(r, { owner: false, uid: 'M-R12-R5-DOR', perms: { contracts: 3, deposits: 3, collect: 3 }, allProps: true, props: [] } as Access,
    () => owner);
  const d = await joinMember(r, { owner: false, uid: 'D-R12-R5-DOR', perms: { deposits: 3 }, allProps: true, props: [] } as Access, () => owner);
  const b0 = await backup(env);
  saveDepositSettlement(A, k, { date: '2026-01-05', deductionHalalas: 0, deductionReason: '', refundHalalas: 100000, notes: '', arrearsHalalas: 0 });
  await sync(A, r);
  await m.sync();
  await d.sync();

  const snap = await readCloud(r);
  const db = (await commitRestore(env, await prepareRestore(env, b0, undefined, { cloud: async () => snap.docs }))).db;
  owner = db;
  adoptAsCloudTruth(db, UID, planFromSnapshot(db, snap));
  for (let i = 0; i < 3; i++) { await sync(db, r); await m.sync(); await d.sync(); }
  // بعد الاستعادة: P ملغاة بسبب الضمّ عند المالك وعند M، والورقة عند كليهما ١٠٠٬٠٠٠ · وD لا يرى الدفعات
  expect({ owner: reasons(db, k), m: reasons(m.db, k), d: reasons(d.db, k), sheet: [depositArrearsPaid(db, k), depositArrearsPaid(m.db, k)] })
    .toEqual({ owner: [DEPOSIT_RENT_KEPT_REASON], m: [DEPOSIT_RENT_KEPT_REASON], d: [], sheet: [100000, 100000] });

  // D يحفظ التسوية أضراراً (لا يرى الأقساط فلا أقساط متأخرة منه)
  saveDepositSettlement(d.db, k, { date: '2026-01-05', deductionHalalas: 100000, deductionReason: 'أضرار مصطنعة', refundHalalas: 0, notes: '', arrearsHalalas: 0 });
  for (let i = 0; i < 3; i++) { await d.sync(); await sync(db, r); await m.sync(); }
  const dec = insts(db, k)[5].id;
  expect({
    reasons: { owner: reasons(db, k), m: reasons(m.db, k) },
    sheet: { owner: depositArrearsPaid(db, k), m: depositArrearsPaid(m.db, k) },
    c1100: accountBalance(db, '1100'), c2400: accountBalance(db, '2400'), c4200: accountBalance(db, '4200'), c4300: accountBalance(db, '4300'),
    dec: db.get(`SELECT paid_halalas AS p, status AS s FROM contract_installments WHERE id = ?`, [dec]),
    red: integrityChecks(db).filter((c) => !c.ok).map((c) => c.name + ' (' + c.value + ')'),
    review: keptForReview(db).length,
  }).toEqual({
    reasons: { owner: [DEPOSIT_RENT_EDIT_REASON], m: [DEPOSIT_RENT_EDIT_REASON] },
    sheet: { owner: 0, m: 0 },
    c1100: 600000, c2400: 0, c4200: 500000, c4300: 100000,
    dec: { p: 0, s: 'مستحقة' },
    red: [], review: 0,
  });
  env.closeLive();
  m.db.close();
  d.db.close();
});
