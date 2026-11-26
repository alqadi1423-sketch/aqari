/**
 * المراجع المعاكس الثاني على قرار تعارض R12-DEP-2 مع R12-BAK-2 (keepPosted.ts وintegrity.ts ٨) · بيانات مصطنعة، والأرقام بالهللة
 * محسوبة باليد.
 *
 * القرار: بعد استعادة نسخةٍ قبل تعديل التسوية تبقى المستندات كما في النسخة (دفعة ديسمبر «من التأمين» P1 حيّة وديسمبر مدفوع) وقيدها E
 *   معكوسٌ بعاكسٍ R مضمومٍ مربوطٍ به ومعلَّمٍ للمراجعة · وفحص الدفعات ٨ صار يقبل «دفعةً حيّة قيدها معكوسٌ بعاكسٍ معلَّم».
 * العيب: هذه الحال نفسها يصلحها محرّك المزامنة (sync/engine.ts · Z١١ وZ٢٢: «دفعةٌ تصل حيّةً وقيدها معكوسٌ هنا ملغاةٌ بعاكسه»، ويرفعها
 *   جهاز المالك) · فأول جهازٍ للمالك يستلم البيانات المعتمدة يلغي P1 بالعاكس R ويرفعها، فيعود الجهاز المستعاد نفسه إلى ديسمبر «مستحقة»
 *   ودفعةٍ ملغاة: أي حال R12-DEP-2 التي رفضها القرار. فما يقرره الضمّ تنقضه المزامنة، والأجهزة تفترق حتى تدور المزامنة.
 * السيناريو: (أ) ستة أقساط ١٬٠٠٠ وتأمين ١٬٠٠٠، سُدّد خمسة · [السلسلة: جُدّد إلى (ب) بترحيل التأمين وسُدّد (ب) كله] · التسوية: التأمين كله
 *   مقابل ديسمبر (أ) · مزامنة · نسخة · التعديل: ردّ التأمين كله · مزامنة · استعادة النسخة وهو داخلٌ إلى حسابه (لقطة السحابة) · اعتمادها ·
 *   ثم جهازٌ جديد للمالك ينضمّ.
 * الصحيح: ما تقرره الاستعادة هو ما يبقى بعد المزامنة على الجهاز المستعاد والجهاز المنضمّ معاً (قرار المالك 2026-10-04: لا تمرّ بيانات في
 *   أحدهما وتُرفض في الآخر) · فإما أن يبقى ديسمبر مدفوعاً بعد المزامنة، وإما أن تُخرجه الاستعادة نفسها مستحقاً · لا الأولى ثم الثانية.
 *   TZ=Asia/Riyadh npx jest tests/review12.r2.restoreSyncDepositRent.test.ts
 */
import * as path from 'node:path';
import { tempDir, rmrf, memDb } from './helpers/testDb';
import { MemoryRemote } from './helpers/memoryRemote';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { makeBackupEnv, type TestBackupEnv } from './helpers/backupEnv';
import { confirmContract, saveDepositSettlement, recordRentPayment, renewContract } from '@/domain/contracts/service';
import { createBackup } from '@/domain/backup/create';
import { prepareRestore, commitRestore } from '@/domain/backup/restore';
import { integrityChecks } from '@/domain/accounting/integrity';
import { accountBalance } from '@/domain/accounting/ledger';
import { DEPOSIT_RENT_METHOD } from '@/domain/contracts/installments';
import { enableSync, syncOnce, readCloud, planFromSnapshot, adoptAsCloudTruth } from '@/sync/engine';
import { getMeta } from '@/repos/settings';
import type { DB } from '@/db/adapter';

const UID = 'user-r12-r2-sync';
const dirs: string[] = [];
const newEnv = () => { const d = tempDir('aq-r12-r2-sync-'); dirs.push(d); return makeBackupEnv(d); };
afterAll(() => { for (const d of dirs) rmrf(d); });
async function backup(env: TestBackupEnv): Promise<string> {
  const out = path.join(env.root, 'b-' + Math.random().toString(36).slice(2) + '.aqbk');
  await createBackup(env, out);
  return out;
}
const insts = (db: DB, c: string) => db.all<{ id: string; due_date: string }>(
  `SELECT id, due_date FROM contract_installments WHERE contract_id = ? ORDER BY due_date`, [c]);
const payCash = (db: DB, c: string, n: number) => {
  for (const i of insts(db, c).slice(0, n)) {
    recordRentPayment(db, c, { installmentId: i.id, period: '', date: i.due_date, lines: [{ method: 'cash', amountHalalas: 100000 }], discountHalalas: 0, notes: '' });
  }
};
const sync = (db: DB, r: MemoryRemote) => syncOnce(db, r, getMeta(db, 'device_id')!);
/** ما يراه المالك على جهاز: الدفتر وقسط ديسمبر ودفعته «من التأمين» والفحوص الحمراء */
const view = (db: DB, dec: string) => ({
  c1100: accountBalance(db, '1100'),
  c4200: accountBalance(db, '4200'),
  dec: db.get(`SELECT paid_halalas AS p, status AS s FROM contract_installments WHERE id = ?`, [dec]),
  depositRentLive: Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM contract_payments WHERE installment_id = ? AND method_label = ?
    AND cancelled_at IS NULL`, [dec, DEPOSIT_RENT_METHOD])!.n),
  red: integrityChecks(db).filter((c) => !c.ok).map((c) => c.name + ' (' + c.value + ')'),
});

test.each([
  // العقد الواحد: 1100 = ٥ أقساط نقداً ٥٠٠٬٠٠٠ + تأمين ١٠٠٬٠٠٠ − ردّه ١٠٠٬٠٠٠ = ٥٠٠٬٠٠٠ · 4200 = ٥٠٠٬٠٠٠ + سداد ديسمبر ١٠٠٬٠٠٠ − عكسه ١٠٠٬٠٠٠
  { chain: false, cash: 500000, rent: 500000 },
  // السلسلة: 1100 = ١١ قسطاً نقداً ١٬١٠٠٬٠٠٠ + تأمين ١٠٠٬٠٠٠ − ردّه ١٠٠٬٠٠٠ · 4200 = ١٬١٠٠٬٠٠٠ + ١٠٠٬٠٠٠ − ١٠٠٬٠٠٠
  { chain: true, cash: 1100000, rent: 1100000 },
])('الاستعادة ثم المزامنة (السلسلة: $chain): ما قررته الاستعادة لدفعة ديسمبر «من التأمين» يبقى على الجهاز المستعاد والجهاز المنضمّ', async ({ chain, cash, rent }) => {
  const r = new MemoryRemote();
  const env = newEnv();
  enableSync(env.db, UID);
  const db0 = env.db;
  const u = addUnit(db0, addProperty(db0, { name: 'عقار مزامنةٍ واستعادةٍ مصطنع' }), { unit_no: 'R2S-' + (chain ? 'C' : 'S') });
  const a = confirmContract(db0, contractInput(u, { tenant: 'مستأجر مزامنةٍ واستعادةٍ مصطنع', idNumber: chain ? '1000012071' : '1000012072',
    phone: chain ? '0500012071' : '0500012072', start: '2025-07-01', end: '2025-12-31', valueHalalas: 600000, depositHalalas: 100000 }));
  payCash(db0, a, 5);
  let holder = a;
  let date = '2026-01-05';
  if (chain) {
    holder = renewContract(db0, a, { start: '2026-01-01', end: '2026-06-30', valueHalalas: 600000, cycle: 'شهرية', carryDeposit: true,
      extraDepositHalalas: 0, services: '', furnished: 'غير مؤثثة', ejarNo: '', note: '' });
    payCash(db0, holder, 6);
    date = '2026-07-05';
  }
  const dec = insts(db0, a)[5].id;
  saveDepositSettlement(db0, holder, { date, deductionHalalas: 100000, deductionReason: 'إيجار ديسمبر غير المدفوع', refundHalalas: 0,
    notes: '', arrearsHalalas: 100000 });
  await sync(db0, r);
  const archive = await backup(env);
  saveDepositSettlement(db0, holder, { date, deductionHalalas: 0, deductionReason: '', refundHalalas: 100000, notes: '', arrearsHalalas: 0 });
  await sync(db0, r);

  // الاستعادة وهو داخلٌ إلى حسابه: لقطة السحابة مصدرٌ مع الجهاز · ثم الاعتماد
  const snap = await readCloud(r);
  const db = (await commitRestore(env, await prepareRestore(env, archive, undefined, { cloud: async () => snap.docs }))).db;
  const restored = view(db, dec);
  // ما قررته الاستعادة (قرار المُصلح على هذه المراجعة: الطريق الثاني في «الصحيح» أعلاه، وكان المتوقع { p: 100000, s: 'مدفوعة' } ودفعةً حيّة):
  // p = ٠ لأن دفعة ديسمبر P1 ملغاةٌ بعاكس قيدها R المحمول معها ولا دفعة غيرها على ديسمبر · ولا دفعة «من التأمين» حيّة · وكل الفحوص خضراء
  expect(restored).toEqual({ c1100: cash, c4200: rent, dec: { p: 0, s: 'مستحقة' }, depositRentLive: 0, red: [] });
  adoptAsCloudTruth(db, UID, planFromSnapshot(db, snap));
  await sync(db, r);

  // جهازٌ جديد للمالك ينضمّ، ثم تدور المزامنة بين الجهازين
  const joined = memDb();
  enableSync(joined, UID);
  for (let i = 0; i < 2; i++) await sync(joined, r);
  for (let i = 0; i < 2; i++) { await sync(db, r); await sync(joined, r); }
  // اليوم: الجهاز المنضمّ يلغي P1 بالعاكس R ويرفعها، فيصير ديسمبر على الجهازين { p: 0, s: 'مستحقة' } ولا دفعة حيّة
  expect({ restored: view(db, dec), joined: view(joined, dec) }).toEqual({ restored, joined: restored });
  env.closeLive();
  joined.close();
});
