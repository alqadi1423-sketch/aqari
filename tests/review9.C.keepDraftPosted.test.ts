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

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmrf(d); });

test.failing('C-1 مسودةٌ في النسخة رُحّلت بعدها: الاستعادة تُبقي القيد مرحّلاً ولا تعيده مسودة', async () => {
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
