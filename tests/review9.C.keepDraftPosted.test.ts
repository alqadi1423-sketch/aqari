/**
 * C-1 · عالٍ · src/domain/backup/keepPosted.ts:90 و:95 و:102
 *
 * السيناريو (بيانات مصطنعة):
 *  ١) قيدٌ يدوي محفوظ «مسودة» (saveManualDraft · كقيد العضو الذي ينتظر ترحيل المالك) بمبلغ ٥٬٠٠٠٫٠٠ صرفاً من المحفظة.
 *  ٢) نسخة احتياطية والمسودة فيها «قيد الإنشاء».
 *  ٣) المالك يرحّل المسودة نفسها (postDraftEntry) فتصير «مرحّل» بالمعرّف نفسه.
 *  ٤) استعادة النسخة.
 * الخطأ: planKeepPosted يتخطى كل قيدٍ معرّفه في النسخة أياً كانت حالته فيها (targetIds تشمل المسودات)، فلا يُضمّ القيد المرحّل،
 * وتعود المسودة مكانه: يختفي أثره من الدفتر (رصيد 1100 يرجع ٥٬٠٠٠٫٠٠)، ولا يظهر في قائمة «قيود مرحّلة تبقى» قبل التأكيد،
 * ويصير قابلاً للتعديل والحذف من جديد.
 *
 * لماذا يهم: قرار المالك 2026-10-03 «القيد المرحّل لا يُحذف أبداً بالاستعادة… ولا تتم الاستعادة إلا بتأكيده» · والحوار يقول
 * إن المرحّل بعد النسخة يبقى، وهو هنا يختفي صامتاً · ومع «اعتماد للسحابة» تحاول المسودة الكتابة فوق مرحّلٍ في السحابة.
 *
 * السلوك الصحيح: القيد المرحّل على الجهاز (أو في السحابة) ومسودةٌ في النسخة يُضمّ مرحّلاً كما هو (سطوره كما رُحّلت)، ويظهر في
 * plan.kept، ويبقى أثره في الدفتر بعد الاستعادة.
 */
import * as path from 'node:path';
import { tempDir, rmrf } from './helpers/testDb';
import { makeBackupEnv } from './helpers/backupEnv';
import { saveManualDraft, postDraftEntry } from '@/domain/accounting/post';
import { createBackup } from '@/domain/backup/create';
import { prepareRestore, commitRestore } from '@/domain/backup/restore';
import { accountBalance } from '@/domain/accounting/ledger';
import { postEntry } from '@/domain/accounting/post';
import { memDb } from './helpers/testDb';
import { MemoryRemote } from './helpers/memoryRemote';
import { enableSync, syncOnce, readCloud, planFromSnapshot, adoptAsCloudTruth } from '@/sync/engine';
import { getMeta } from '@/repos/settings';
import type { DB } from '@/db/adapter';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmrf(d); });

test('C-1 مسودةٌ في النسخة رُحّلت بعدها: الاستعادة تُبقي القيد مرحّلاً ولا تعيده مسودة', async () => {
  const d = tempDir('aq-r9c-draft-');
  dirs.push(d);
  const env = makeBackupEnv(d);
  // نقدٌ في المحفظة يكفي الصرف (رأس مال مصطنع)
  postEntry(env.db, { date: '2026-03-01', memo: 'رأس مال مصطنع', lines: [
    { account: '1100', debit: 1_000_000, credit: 0 }, { account: '3100', debit: 0, credit: 1_000_000 }] });
  // ١) مسودة صرف ٥٬٠٠٠٫٠٠ من المحفظة
  const draft = saveManualDraft(env.db, { date: '2026-03-05', memo: 'صرف مصطنع', lines: [
    { account: '5100', debit: 500_000, credit: 0 }, { account: '1100', debit: 0, credit: 500_000 }] })!;
  expect(env.db.get<{ s: string }>(`SELECT status AS s FROM journal_entries WHERE id = ?`, [draft.id])!.s).toBe('قيد الإنشاء');

  // ٢) النسخة والمسودة فيها
  const archive = path.join(d, 'b.aqbk');
  await createBackup(env, archive);

  // ٣) الترحيل بعد النسخة
  postDraftEntry(env.db, draft.id);
  expect(env.db.get<{ s: string }>(`SELECT status AS s FROM journal_entries WHERE id = ?`, [draft.id])!.s).toBe('مرحّل');
  const cashBefore = accountBalance(env.db, '1100');
  expect(cashBefore).toBe(500_000);

  // ٤) الاستعادة
  const plan = await prepareRestore(env, archive);
  const db = (await commitRestore(env, plan)).db;
  // النتيجة كلها في مقارنة واحدة فيظهر كل ما خالف
  const observed = {
    // الحوار يذكر القيد المرحّل بعد النسخة
    shownAsKept: plan.kept.some((k) => k.id === draft.id),
    statusAfter: db.get<{ s: string }>(`SELECT status AS s FROM journal_entries WHERE id = ?`, [draft.id])!.s,
    cashAfter: accountBalance(db, '1100'),
  };
  expect(observed).toEqual({ shownAsKept: true, statusAfter: 'مرحّل', cashAfter: cashBefore });
  env.closeLive();
});

const statusOf = (db: DB, id: string) => db.get<{ s: string }>(`SELECT status AS s FROM journal_entries WHERE id = ?`, [id])!.s;
const debitOf = (db: DB, id: string) => Number(db.get<{ d: number }>(`SELECT SUM(debit_halalas) AS d FROM journal_lines WHERE entry_id = ?`, [id])!.d);
const capital = (db: DB) => postEntry(db, { date: '2026-03-01', memo: 'رأس مال مصطنع', lines: [
  { account: '1100', debit: 1_000_000, credit: 0 }, { account: '3100', debit: 0, credit: 1_000_000 }] });

test('C-1 مسودةٌ عُدّلت بعد النسخة ثم رُحّلت: تبقى بسطورها كما رُحّلت لا كما في النسخة', async () => {
  const d = tempDir('aq-r9c-draft-edit-');
  dirs.push(d);
  const env = makeBackupEnv(d);
  capital(env.db);
  const draft = saveManualDraft(env.db, { date: '2026-03-05', memo: 'صرف مصطنع', lines: [
    { account: '5100', debit: 500_000, credit: 0 }, { account: '1100', debit: 0, credit: 500_000 }] })!;
  const archive = path.join(d, 'b.aqbk');
  await createBackup(env, archive);
  // تعديل المسودة بعد النسخة (٥٬٠٠٠٫٠٠ ← ٤٬٠٠٠٫٠٠) ثم ترحيلها
  env.db.run(`UPDATE journal_lines SET debit_halalas = 400000 WHERE entry_id = ? AND debit_halalas > 0`, [draft.id]);
  env.db.run(`UPDATE journal_lines SET credit_halalas = 400000 WHERE entry_id = ? AND credit_halalas > 0`, [draft.id]);
  postDraftEntry(env.db, draft.id);
  // ١٠٬٠٠٠٫٠٠ − ٤٬٠٠٠٫٠٠ = ٦٬٠٠٠٫٠٠
  expect(accountBalance(env.db, '1100')).toBe(600_000);

  const plan = await prepareRestore(env, archive);
  const kept = plan.kept.find((k) => k.id === draft.id);
  expect(kept).toEqual(expect.objectContaining({ no: draft.no, newNo: null, amount: 400_000, from: 'device', wasDraft: true, review: null }));
  const db = (await commitRestore(env, plan)).db;
  expect({ status: statusOf(db, draft.id), debit: debitOf(db, draft.id), cash: accountBalance(db, '1100'),
    no: db.get<{ no: string }>(`SELECT no FROM journal_entries WHERE id = ?`, [draft.id])!.no })
    .toEqual({ status: 'مرحّل', debit: 400_000, cash: 600_000, no: draft.no });
  env.closeLive();
});

test('C-1 فرع السحابة: المسودة في النسخة والمرحّل في لقطة السحابة وحدها · يبقى مرحّلاً ويتطابق الجهازان بلا رفض', async () => {
  const r = new MemoryRemote();
  const d = tempDir('aq-r9c-draft-cloud-');
  dirs.push(d);
  const env = makeBackupEnv(d);
  enableSync(env.db, 'U');
  capital(env.db);
  const draft = saveManualDraft(env.db, { date: '2026-03-05', memo: 'صرف مصطنع', lines: [
    { account: '5100', debit: 500_000, credit: 0 }, { account: '1100', debit: 0, credit: 500_000 }] })!;
  await syncOnce(env.db, r, getMeta(env.db, 'device_id')!);
  const archive = path.join(d, 'b.aqbk');
  await createBackup(env, archive);

  // جهازٌ آخر للحساب نفسه يرحّل المسودة ويرفعها · وهذا الجهاز لم يزامن بعدها فالمسودة عنده مسودة
  const other = memDb();
  enableSync(other, 'U');
  await syncOnce(other, r, getMeta(other, 'device_id')!);
  postDraftEntry(other, draft.id);
  await syncOnce(other, r, getMeta(other, 'device_id')!);
  expect(statusOf(env.db, draft.id)).toBe('قيد الإنشاء');

  const snap = await readCloud(r);
  const plan = await prepareRestore(env, archive, undefined, { cloud: async () => snap.docs });
  expect(plan.kept.find((k) => k.id === draft.id)).toEqual(expect.objectContaining({ from: 'cloud', wasDraft: true, newNo: null }));
  const db = (await commitRestore(env, plan)).db;
  // ١٠٬٠٠٠٫٠٠ − ٥٬٠٠٠٫٠٠ = ٥٬٠٠٠٫٠٠
  expect({ status: statusOf(db, draft.id), cash: accountBalance(db, '1100') }).toEqual({ status: 'مرحّل', cash: 500_000 });

  // الاعتماد للسحابة لا يرفع المسودة فوق المرحّل
  const cloudPlan = planFromSnapshot(db, snap);
  expect(cloudPlan.immutable.entries).toBe(0);
  adoptAsCloudTruth(db, 'U', cloudPlan);
  for (let i = 0; i < 2; i++) {
    await syncOnce(db, r, getMeta(db, 'device_id')!);
    await syncOnce(other, r, getMeta(other, 'device_id')!);
  }
  for (const x of [db, other]) {
    expect({ status: statusOf(x, draft.id), cash: accountBalance(x, '1100'),
      rejects: Number(x.get<{ n: number }>(`SELECT COUNT(*) AS n FROM sync_rejects`)!.n) })
      .toEqual({ status: 'مرحّل', cash: 500_000, rejects: 0 });
  }
  env.closeLive();
  other.close();
});

test('C-1 مسودةٌ أُعيد ترقيمها عند الانضمام بلا كتل أرقام ثم رُحّلت: تُستبدل قبل غيرها فيبقى لكلٍّ رقمه ولا تفشل الاستعادة', async () => {
  // بلا كتل أرقام (عضوٌ في منشأةٍ بلا عدّاد · numbering.ts) يُرقَّم بالترقيم القديم: أكبر رقمٍ هنا + ١ ·
  // فلو رُقّم قيد رأس المال عند الاستعادة لأخذ رقم المسودة الجديد وهي لم تُدرج بعد · فالمسودات تُستبدل أولاً فيخلو رقمها القديم
  const r = new MemoryRemote();
  (r as unknown as { reserveBlocks?: unknown }).reserveBlocks = undefined;
  const owner = memDb();
  enableSync(owner, 'U');
  const cap = capital(owner)!;
  await syncOnce(owner, r, getMeta(owner, 'device_id')!);

  const d = tempDir('aq-r9c-draft-renum-');
  dirs.push(d);
  const env = makeBackupEnv(d);
  const draft = saveManualDraft(env.db, { date: '2026-03-05', memo: 'صرف مصطنع', lines: [
    { account: '5100', debit: 500_000, credit: 0 }, { account: '1100', debit: 0, credit: 500_000 }] })!;
  expect(draft.no).toBe(cap.no);
  const archive = path.join(d, 'b.aqbk');
  await createBackup(env, archive);

  enableSync(env.db, 'U');
  await syncOnce(env.db, r, getMeta(env.db, 'device_id')!);
  await syncOnce(env.db, r, getMeta(env.db, 'device_id')!);
  const postedNo = env.db.get<{ no: string }>(`SELECT no FROM journal_entries WHERE id = ?`, [draft.id])!.no;
  expect(postedNo).not.toBe(draft.no);
  postDraftEntry(env.db, draft.id);

  const plan = await prepareRestore(env, archive);
  expect(plan.kept.map((k) => ({ id: k.id, newNo: k.newNo, wasDraft: k.wasDraft }))).toEqual([
    { id: cap.id, newNo: null, wasDraft: false }, { id: draft.id, newNo: null, wasDraft: true }]);
  const db = (await commitRestore(env, plan)).db;
  const noOf = (id: string) => db.get<{ no: string }>(`SELECT no FROM journal_entries WHERE id = ?`, [id])!.no;
  // ١٠٬٠٠٠٫٠٠ − ٥٬٠٠٠٫٠٠ = ٥٬٠٠٠٫٠٠ · ورأس المال برقمه في السحابة والمسودة برقمها بعد الانضمام
  expect({ cap: statusOf(db, cap.id), draft: statusOf(db, draft.id), cash: accountBalance(db, '1100'),
    capNo: noOf(cap.id), draftNo: noOf(draft.id) })
    .toEqual({ cap: 'مرحّل', draft: 'مرحّل', cash: 500_000, capNo: cap.no, draftNo: postedNo });
  env.closeLive();
  owner.close();
});
