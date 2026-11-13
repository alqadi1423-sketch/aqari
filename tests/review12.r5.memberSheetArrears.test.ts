/**
 * مراجعٌ مستقل خامس على R12-BAK-2 (4913565) · depositArrearsPaid (service.ts) يعدّ دفعة «من التأمين» الملغاة بعاكسٍ معلَّمٍ خارج المطابقة
 * (outOfMatch)، والعلامة سطرٌ في سجل العمليات · وجهاز الموظف بلا قسم «سجل العمليات» لا يصله السجل (readSections.ts: audit_log لقسم
 * audit وحده)، فلا علامة عنده ولا «خارج المطابقة»، فتملأ ورقة التسوية عنده خانة الأقساط المتأخرة صفراً كما كانت عند المالك قبل الإصلاح ·
 * بيانات مصطنعة، والأرقام بالهللة محسوبة باليد.
 *
 * السيناريو: عقد ستة أشهر (يوليو إلى ديسمبر ٢٠٢٥) بأقساط ١٠٠٬٠٠٠ وتأمين ١٠٠٬٠٠٠ نقداً · سُدّد يوليو إلى نوفمبر نقداً · التسوية S0: الخصم
 *   ١٠٠٬٠٠٠ كله مقابل ديسمبر (دفعة «من التأمين» P وقيدها E: مدين 2400 / دائن 4200) · مزامنة · موظفٌ بأقسام العقود والتأمينات والتحصيل ·
 *   نسخة B0 · التعديل S1: ردّ التأمين كله (العاكس R يعكس E، وP ملغاة به، وقيد الردّ F: مدين 2400 / دائن 1100) · مزامنة ·
 *   يستعيد المالك B0 ويعتمدها (R وF في المراجعة، وP ملغاة محمولة مع R، وصفّ التسوية S0) · مزامنة ·
 *   ثم يفتح الموظف ورقة التسوية ويحفظها كما تظهر (الخصم ١٠٠٬٠٠٠ «إيجار ديسمبر»، والأقساط المتأخرة كما تملؤها الورقة).
 * بعد الاستعادة: 1100 = ٥٠٠٬٠٠٠ + ١٠٠٬٠٠٠ − F ١٠٠٬٠٠٠ = ٥٠٠٬٠٠٠ · 2400 (دائن موجب) = ١٠٠٬٠٠٠ − E + R − F = ٠ · 4200 = ٥٠٠٬٠٠٠ + E − R = ٥٠٠٬٠٠٠ ·
 *   والورقة عند المالك: الأقساط المتأخرة ١٠٠٬٠٠٠ (صفّ التسوية S0 منه ديسمبر) · فيجب أن تكون كذلك عند الموظف.
 * الصحيح بعد حفظ الموظف (الأقساط المتأخرة ١٠٠٬٠٠٠، قرار المالك س١): F′ يعكس F (مدين 1100 / دائن 2400) وE2 يسدّد ديسمبر (مدين 2400 / دائن 4200)
 *   ولا قيد أضرار (الخصم − المتأخرة = ٠) · 1100 = ٥٠٠٬٠٠٠ + ١٠٠٬٠٠٠ = ٦٠٠٬٠٠٠ · 2400 = ٠ + ١٠٠٬٠٠٠ − ١٠٠٬٠٠٠ = ٠ · 4200 = ٦٠٠٬٠٠٠ ·
 *   4300 = ٠ · وديسمبر مدفوع ١٠٠٬٠٠٠ · والفحوص خضراء والمراجعة فارغة.
 * اليوم: ورقة الموظف صفر، فحفظها كما تظهر يقيد الخصم أضراراً (مدين 2400 / دائن 4300 ١٠٠٬٠٠٠): 4300 = ١٠٠٬٠٠٠ و4200 = ٥٠٠٬٠٠٠ وديسمبر
 *   مستحقٌّ يطالَب به المستأجر وقد خُصم من تأمينه · والفحوص خضراء فلا ينبّه شيء.
 *   TZ=Asia/Riyadh npx jest tests/review12.r5.memberSheetArrears.test.ts
 */
import * as path from 'node:path';
import { tempDir, rmrf, memDb } from './helpers/testDb';
import { MemoryRemote } from './helpers/memoryRemote';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { makeBackupEnv, type TestBackupEnv } from './helpers/backupEnv';
import { confirmContract, saveDepositSettlement, recordRentPayment, depositArrearsPaid } from '@/domain/contracts/service';
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

const UID = 'OWNER-R12-R5-MSA';
const OWNER_ACCESS: Access = { owner: true, uid: UID, perms: {}, allProps: true, props: [] } as Access;
const dirs: string[] = [];
const newEnv = () => { const d = tempDir('aq-r12-r5-msa-'); dirs.push(d); return makeBackupEnv(d); };
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

const ARREARS = { date: '2026-01-05', deductionHalalas: 100000, deductionReason: 'إيجار ديسمبر غير المدفوع', refundHalalas: 0, notes: '' };

test('موظفٌ بلا قسم سجل العمليات يحفظ بعد الاستعادة تسويةً سدّدت ديسمبر: ورقته تملأ المتأخرة كورقة المالك ولا يصير ديسمبر أضراراً', async () => {
  const r = new MemoryRemote();
  const env = newEnv();
  enableSync(env.db, UID);
  const A = env.db;
  const k = confirmContract(A, contractInput(addUnit(A, addProperty(A, { name: 'عقار ورقة الموظف المصطنع' }), { unit_no: 'R5M-1' }), {
    tenant: 'مستأجر ورقة الموظف المصطنع', idNumber: '1000015001', phone: '0500015001',
    start: '2025-07-01', end: '2025-12-31', valueHalalas: 600000, depositHalalas: 100000 }));
  for (const i of insts(A, k).slice(0, 5)) {
    recordRentPayment(A, k, { installmentId: i.id, period: '', date: i.due_date, lines: [{ method: 'cash', amountHalalas: 100000 }], discountHalalas: 0, notes: '' });
  }
  saveDepositSettlement(A, k, { ...ARREARS, arrearsHalalas: 100000 });
  await sync(A, r);
  const m = await joinMember(r, { owner: false, uid: 'M-R12-R5-MSA', perms: { contracts: 3, deposits: 3, collect: 3 }, allProps: true, props: [] } as Access,
    () => env.db);
  const b0 = await backup(env);
  saveDepositSettlement(A, k, { date: '2026-01-05', deductionHalalas: 0, deductionReason: '', refundHalalas: 100000, notes: '', arrearsHalalas: 0 });
  await sync(A, r);
  await m.sync();

  const snap = await readCloud(r);
  const db = (await commitRestore(env, await prepareRestore(env, b0, undefined, { cloud: async () => snap.docs }))).db;
  adoptAsCloudTruth(db, UID, planFromSnapshot(db, snap));
  for (let i = 0; i < 3; i++) { await sync(db, r); await m.sync(); }
  // بعد الاستعادة على جهاز المالك: 1100 = ٥٠٠٬٠٠٠ · 2400 = ٠ · 4200 = ٥٠٠٬٠٠٠ · وفي المراجعة R وF
  expect({ c1100: accountBalance(db, '1100'), c2400: accountBalance(db, '2400'), c4200: accountBalance(db, '4200'),
    review: keptForReview(db).length, red: integrityChecks(db).filter((c) => !c.ok).map((c) => c.name) })
    .toEqual({ c1100: 500000, c2400: 0, c4200: 500000, review: 2, red: [] });

  // الورقة عند المالك وعند الموظف (app/(tabs)/contracts.tsx: خانة «منها مقابل أقساطٍ متأخرة» من depositArrearsPaid)
  const sheet = { owner: depositArrearsPaid(db, k), member: depositArrearsPaid(m.db, k) };
  // الموظف يحفظ الورقة كما تظهر
  saveDepositSettlement(m.db, k, { ...ARREARS, arrearsHalalas: sheet.member });
  for (let i = 0; i < 3; i++) { await m.sync(); await sync(db, r); }
  const dec = insts(db, k)[5].id;
  expect({
    sheet,
    c1100: accountBalance(db, '1100'), c2400: accountBalance(db, '2400'), c4200: accountBalance(db, '4200'), c4300: accountBalance(db, '4300'),
    dec: db.get(`SELECT paid_halalas AS p, status AS s FROM contract_installments WHERE id = ?`, [dec]),
    red: integrityChecks(db).filter((c) => !c.ok).map((c) => c.name + ' (' + c.value + ')'),
    review: keptForReview(db).length,
  }).toEqual({
    sheet: { owner: 100000, member: 100000 },
    c1100: 600000, c2400: 0, c4200: 600000, c4300: 0,
    dec: { p: 100000, s: 'مدفوعة' },
    red: [], review: 0,
  });
  env.closeLive();
  m.db.close();
});
