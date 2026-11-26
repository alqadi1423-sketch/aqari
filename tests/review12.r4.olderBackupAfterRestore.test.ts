/**
 * المراجع المعاكس الرابع على R12-BAK-2 (dcab693: «صار له مستند» مشتقٌّ لا سطرٌ يُكتب) · استعادة نسخةٍ أقدم بعد استعادةٍ واعتمادها ·
 * بيانات مصطنعة، والأرقام بالهللة محسوبة باليد.
 *
 * العلامة سطرٌ في سجل العمليات بمعرّف القيد، يُضمّ في كل اعتماد · فعلامة الاستعادة الأولى على العاكس R1 تبقى بعد استعادةٍ ثانية لنسخةٍ
 *   أقدم من أصله E1: هناك E1 وR1 كلاهما بعد النسخة، زوجٌ مضموم أثره صفر لا يُراجَع (keepPosted.ts: paired) · لكن علامة R1 القديمة
 *   تُخرجه وحده من المطابقة ويبقى أصله E1 داخلها، و«صار له مستند» المشتق لا يصح (لا قيد تسويةٍ حيّ غير معلَّم: F3 معلَّم) ·
 *   (في cd9653c كان سطر «صار له مستند» المخزَّن لـ R1 وF2 يُضمّ أيضاً فيلغي علامتيهما · واشتقاقه في dcab693 لا يلغيهما.)
 * السيناريو: (أ) ستة أقساط ١٬٠٠٠ وتأمين ١٬٠٠٠، سُدّد خمسة، والعقد منتهٍ ولم يُسوَّ · مزامنة · نسخة B0 (بلا تسوية) ·
 *   التسوية S1: التأمين كله مقابل ديسمبر (P1 وقيدها E1) · مزامنة · نسخة B1 · التعديل S2: ردّ التأمين كله (R1 يعكس E1، وF2) · مزامنة ·
 *   استعادة B1 واعتمادها (R1 وF2 معلَّمان) · [الحال أ: يحفظ المالك الردّ ثانيةً: F2′ يعكس F2 ويُرحَّل F3] · مزامنة ·
 *   ثم يستعيد المالك B0 (أقدم) ويعتمدها.
 * بعد الاستعادة الثانية: صفّ التسوية غائب (B0) فالتأمين محتجز ١٠٠٬٠٠٠ · وكل قيود التسوية بعد B0:
 *   2400 (دائن موجب) = ١٠٠٬٠٠٠ قبض − E1 + R1 − F2 + F2′ − F3 = ٠ (الحال أ) · أو ١٠٠٬٠٠٠ − E1 + R1 − F2 = ٠ (الحال ب).
 *   الصحيح: الزوجان (E1، R1) و(F2، F2′) أثرهما صفر فلا يُراجَعان، والمعلَّم خارج المطابقة F3 وحده (الحال أ) أو F2 وحده (الحال ب):
 *   المطابقة = ٠ + ١٠٠٬٠٠٠ = ١٠٠٬٠٠٠ = المحتجز ١٠٠٬٠٠٠ · فالفحوص خضراء.
 * اليوم (dcab693): علامتا R1 وF2 القديمتان قائمتان: خارج المطابقة R1 وF2 وF2′ وF3 = −١ + ١ − ١ + ١ = ٠ (أو R1 وF2 = ٠) ·
 *   فالمطابقة ٠ / ١٠٠٬٠٠٠ ويحمرّ فحص التأمينات، وR1 في أداة المراجعة.
 *   (الحال أ في 31bb43e خضراء: سطرا «صار له مستند» لـ R1 وF2 يُضمّان مع العلامات · والحال ب حمراء في الإصدارين: العلّة في العلامة
 *   القديمة على زوجٍ صار كله مضموماً، وكشفها الاشتقاق في الحال أ.)
 *   TZ=Asia/Riyadh npx jest tests/review12.r4.olderBackupAfterRestore.test.ts
 */
import * as path from 'node:path';
import { tempDir, rmrf } from './helpers/testDb';
import { MemoryRemote } from './helpers/memoryRemote';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { makeBackupEnv, type TestBackupEnv } from './helpers/backupEnv';
import { confirmContract, saveDepositSettlement, recordRentPayment } from '@/domain/contracts/service';
import { createBackup } from '@/domain/backup/create';
import { prepareRestore, commitRestore } from '@/domain/backup/restore';
import { integrityChecks } from '@/domain/accounting/integrity';
import { accountBalance } from '@/domain/accounting/ledger';
import { keptForReview } from '@/domain/accounting/orphans';
import { enableSync, syncOnce, readCloud, planFromSnapshot, adoptAsCloudTruth } from '@/sync/engine';
import { getMeta } from '@/repos/settings';
import type { DB } from '@/db/adapter';

const UID = 'user-r12-r4-older';
const dirs: string[] = [];
const newEnv = () => { const d = tempDir('aq-r12-r4-older-'); dirs.push(d); return makeBackupEnv(d); };
afterAll(() => { for (const d of dirs) rmrf(d); });
async function backup(env: TestBackupEnv): Promise<string> {
  const out = path.join(env.root, 'b-' + Math.random().toString(36).slice(2) + '.aqbk');
  await createBackup(env, out);
  return out;
}
const insts = (db: DB, c: string) => db.all<{ id: string; due_date: string }>(
  `SELECT id, due_date FROM contract_installments WHERE contract_id = ? ORDER BY due_date`, [c]);
const sync = (db: DB, r: MemoryRemote) => syncOnce(db, r, getMeta(db, 'device_id')!);
const ARREARS = { deductionHalalas: 100000, deductionReason: 'إيجار ديسمبر غير المدفوع', refundHalalas: 0, notes: '', arrearsHalalas: 100000 };
const REFUND = { deductionHalalas: 0, deductionReason: '', refundHalalas: 100000, notes: '', arrearsHalalas: 0 };
const view = (db: DB) => ({
  c2400: accountBalance(db, '2400'),
  red: integrityChecks(db).filter((c) => !c.ok).map((c) => c.name + ' (' + c.value + ')'),
  review: keptForReview(db).map((k) => db.get<{ t: string }>(`SELECT src_type AS t FROM journal_entries WHERE id = ?`, [k.id])!.t).sort(),
});
async function restore(env: TestBackupEnv, r: MemoryRemote, archive: string): Promise<DB> {
  const snap = await readCloud(r);
  const db = (await commitRestore(env, await prepareRestore(env, archive, undefined, { cloud: async () => snap.docs }))).db;
  adoptAsCloudTruth(db, UID, planFromSnapshot(db, snap));
  for (let i = 0; i < 2; i++) await sync(db, r);
  return db;
}

test.each([
  { name: 'الحال أ: حفظ المالك الردّ بين الاستعادتين', saveBetween: true, outside: 'deposit_refund' },
  { name: 'الحال ب: بلا حفظٍ بين الاستعادتين', saveBetween: false, outside: 'deposit_refund' },
])('$name · استعادة نسخةٍ أقدم من التسوية بعد استعادةٍ واعتمادها: يبقى فحص التأمينات أخضر', async ({ saveBetween, outside }) => {
  const r = new MemoryRemote();
  const env = newEnv();
  enableSync(env.db, UID);
  const db0 = env.db;
  const n = saveBetween ? 1 : 2;
  const u = addUnit(db0, addProperty(db0, { name: 'عقار النسخة الأقدم المصطنع ' + n }), { unit_no: 'R4O-' + n });
  const a = confirmContract(db0, contractInput(u, { tenant: 'مستأجر النسخة الأقدم المصطنع ' + n, idNumber: '100001410' + n, phone: '050001410' + n,
    start: '2025-07-01', end: '2025-12-31', valueHalalas: 600000, depositHalalas: 100000 }));
  for (const i of insts(db0, a).slice(0, 5)) {
    recordRentPayment(db0, a, { installmentId: i.id, period: '', date: i.due_date, lines: [{ method: 'cash', amountHalalas: 100000 }], discountHalalas: 0, notes: '' });
  }
  const date = '2026-01-05';
  await sync(db0, r);
  const b0 = await backup(env);
  saveDepositSettlement(db0, a, { date, ...ARREARS });
  await sync(db0, r);
  const b1 = await backup(env);
  saveDepositSettlement(db0, a, { date, ...REFUND });
  await sync(db0, r);

  // الاستعادة الأولى (B1): R1 وF2 في المراجعة والفحوص خضراء
  const db1 = await restore(env, r, b1);
  expect(view(db1)).toEqual({ c2400: 0, red: [], review: ['deposit_refund', 'deposit_rent_rev'] });
  if (saveBetween) {
    saveDepositSettlement(db1, a, { date, ...REFUND });
    for (let i = 0; i < 2; i++) await sync(db1, r);
    expect(view(db1)).toEqual({ c2400: 0, red: [], review: [] });
  }

  // الاستعادة الثانية (B0، بلا تسوية): التأمين محتجز ١٠٠٬٠٠٠ · 2400 = ١٠٠٬٠٠٠ − E1 + R1 − F2 (+ F2′ − F3) = ٠ ·
  // خارج المطابقة المعلَّم الذي لا زوج له في المضموم وحده (F3، أو F2) = مدين ١٠٠٬٠٠٠ · فالمطابقة ٠ + ١٠٠٬٠٠٠ = ١٠٠٬٠٠٠ = المحتجز
  // اليوم: «تأمينات المستأجرين = التأمينات المحتجزة (0.00 / 1,000.00)» وR1 في المراجعة
  const db2 = await restore(env, r, b0);
  expect(db2.get(`SELECT COUNT(*) AS n FROM deposit_settlements WHERE contract_id = ?`, [a])).toEqual({ n: 0 });
  expect(view(db2)).toEqual({ c2400: 0, red: [], review: [outside] });
  env.closeLive();
});
