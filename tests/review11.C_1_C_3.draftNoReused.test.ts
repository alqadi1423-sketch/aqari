/**
 * تدقيق مستقل لإصلاح C-1 (المراجعة الشاملة 2026-11-13) · بيانات مصطنعة.
 *
 * السيناريو:
 *  ١) جهازٌ منفرد (بلا حساب) يحفظ مسودة صرف ٥٬٠٠٠٫٠٠ (saveManualDraft) فتأخذ JE-0001، ثم نسخة احتياطية والمسودة فيها.
 *  ٢) جهاز المالك الآخر في الحساب رحّل قبلها قيد رأس مال ١٠٬٠٠٠٫٠٠ برقم JE-0001 ورفعه.
 *  ٣) الجهاز الأول ينضمّ إلى الحساب: تصادمُ الرقم عند الانضمام (renumberJoiningCollision) يعيد ترقيم مسودته المحلية،
 *     ويدخل قيد رأس المال برقمه JE-0001. ثم يرحّل الجهاز المسودة.
 *  ٤) تُستعاد النسخة القديمة على الجهاز نفسه.
 *
 * الخطأ: planKeepPosted يُخرج رقم المسودة (JE-0001) من فحص التصادم takenNos ظنّاً أن المرحّل يحمل رقمها، والمرحّل هنا برقمٍ آخر ·
 * فيُضمّ قيد رأس المال برقمه JE-0001 بلا ترقيم جديد، ويُدرج (تاريخه أسبق) والمسودة ما زالت تحمل JE-0001 في النسخة قبل أن يُستبدل
 * رأسها، فيرفضه قيد التفرّد على journal_entries.no وتفشل الاستعادة كلها في التجهيز. قبل الإصلاح كانت الاستعادة تمرّ (والرقم يُعاد
 * ترقيمه)، فالإصلاح حوّل الحالة إلى استعادةٍ مستحيلة.
 *
 * السلوك الصحيح: الاستعادة تتمّ · القيدان مرحّلان بعدها، والمحفظة ١٠٬٠٠٠٫٠٠ − ٥٬٠٠٠٫٠٠ = ٥٬٠٠٠٫٠٠ (٥٠٠٬٠٠٠ هللة) كما قبلها،
 * ولا رقم مكرر · ويُستثنى من takenNos رقم المسودة حين يحمل المرحّل رقمها نفسه فقط (أو تُرقَّى المسودات قبل إدراج غيرها).
 */
import * as path from 'node:path';
import { tempDir, rmrf, memDb } from './helpers/testDb';
import { makeBackupEnv } from './helpers/backupEnv';
import { MemoryRemote } from './helpers/memoryRemote';
import { saveManualDraft, postDraftEntry, postEntry } from '@/domain/accounting/post';
import { createBackup } from '@/domain/backup/create';
import { prepareRestore, commitRestore } from '@/domain/backup/restore';
import { accountBalance } from '@/domain/accounting/ledger';
import { enableSync, syncOnce } from '@/sync/engine';
import { getMeta } from '@/repos/settings';
import type { DB } from '@/db/adapter';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmrf(d); });

const row = (db: DB, id: string) => db.get<{ no: string; s: string }>(`SELECT no, status AS s FROM journal_entries WHERE id = ?`, [id]);

test('C-1 · مسودةٌ أُعيد ترقيمها عند الانضمام ثم رُحّلت: رقمها القديم في النسخة لا يُخرج من فحص التصادم فلا تفشل الاستعادة', async () => {
  const r = new MemoryRemote();
  // ٢) جهاز المالك الآخر: رأس مال ١٠٬٠٠٠٫٠٠ برقم JE-0001 مرفوع
  const owner = memDb();
  enableSync(owner, 'U');
  const capital = postEntry(owner, { date: '2026-03-01', memo: 'رأس مال مصطنع', lines: [
    { account: '1100', debit: 1_000_000, credit: 0 }, { account: '3100', debit: 0, credit: 1_000_000 }] })!;
  await syncOnce(owner, r, getMeta(owner, 'device_id')!);

  // ١) جهازٌ منفرد: مسودة صرف ٥٬٠٠٠٫٠٠ ثم نسخة
  const d = tempDir('aq-r11c1-renum-');
  dirs.push(d);
  const env = makeBackupEnv(d);
  const draft = saveManualDraft(env.db, { date: '2026-03-05', memo: 'صرف مصطنع', lines: [
    { account: '5100', debit: 500_000, credit: 0 }, { account: '1100', debit: 0, credit: 500_000 }] })!;
  expect(draft.no).toBe(capital.no);
  const archive = path.join(d, 'b.aqbk');
  await createBackup(env, archive);

  // ٣) الانضمام: مسودته تأخذ رقماً جديداً ورأس المال برقمه · ثم ترحيل المسودة
  enableSync(env.db, 'U');
  await syncOnce(env.db, r, getMeta(env.db, 'device_id')!);
  await syncOnce(env.db, r, getMeta(env.db, 'device_id')!);
  expect(row(env.db, capital.id)).toEqual({ no: capital.no, s: 'مرحّل' });
  expect(row(env.db, draft.id)!.no).not.toBe(draft.no);
  postDraftEntry(env.db, draft.id);
  // ١٠٬٠٠٠٫٠٠ − ٥٬٠٠٠٫٠٠ = ٥٬٠٠٠٫٠٠
  expect(accountBalance(env.db, '1100')).toBe(500_000);

  // ٤) استعادة النسخة القديمة
  const err = await prepareRestore(env, archive).then(async (plan) => {
    const db = (await commitRestore(env, plan)).db;
    const nos = db.all<{ no: string }>(`SELECT no FROM journal_entries`).map((x) => x.no);
    return { capital: row(db, capital.id)!.s, draft: row(db, draft.id)!.s, cash: accountBalance(db, '1100'),
      uniqueNos: new Set(nos).size === nos.length };
  }, (e: unknown) => String(e instanceof Error ? e.message : e));
  expect(err).toEqual({ capital: 'مرحّل', draft: 'مرحّل', cash: 500_000, uniqueNos: true });
  env.closeLive();
  owner.close();
});
