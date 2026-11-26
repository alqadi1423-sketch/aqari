/**
 * المراجعة ١٢ · مراجعة إصلاح R12-BAK-4 (المراجع المستقل) · بيانات مصطنعة.
 *
 * finishInterruptedRestore (restore.ts) يُكمل عند الإقلاع استعادةً قُتل التطبيق بعد تبديلها (data.db.pre-restore بجانب data.db، ومجلد
 * تجهيزٍ خرجت منه المجهَّزة) · لكنه يُكمل نقل المرفقات وحده، وما بعد التبديل في commitRestore وفي الشاشة خطوتان أخريان لا يعيدهما:
 *
 *  ١) reconcileCache لا يجري إلا إن نُقل ملفٌ عند الإقلاع (moved > 0) · واستعادة نسخة هذا الجهاز نفسه (أكثر الاستعادات) ملفاتها في مجلد
 *     المرفقات قبلها فلا يُنقل منها شيء، فيبقى file_cache كما في النسخة: «رُفع» (uploaded = 1) لملفٍ لم يطابقه الخادم بعد الاستعادة ·
 *     وتعليق commitRestore نفسه يقول إن تخطّيها «يُبقي رُفع من النسخة فيُفرَّغ ملفٌ قد لا يكون في الخادم» (evictCache وclearCache).
 *  ٢) الشاشة بعد commitRestore تعتمد النسخة للسحابة (adoptForCloud) أو تعلّمها «لم تُعتمد» (markRestoredUnadopted) · والقتل بعد التبديل
 *     يترك القاعدة المستعادة بربط النسخة بالحساب (sync_state.uid ومؤشرها القديم) ولا علامة restored_unadopted، فبوابة syncNow
 *     (cloud.ts: «استعادةٌ جرت … لا تُدمج مع السحابة صامتةً») لا تمنع، وتُدمج النسخة مع السحابة صامتةً في أول دورة · حالةٌ ثالثة
 *     يمنعها قرار المالك 2026-08-20.
 *
 * والاختبار يأخذ لقطة القرص كله لحظة صارت المجهَّزة data.db (كما في review12.backup.swapResume) ويقلع عليها.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tempDir, rmrf } from './helpers/testDb';
import { makeBackupEnv } from './helpers/backupEnv';
import { addProperty } from './helpers/fixtures';
import { createBackup } from '@/domain/backup/create';
import { prepareRestore, commitRestore, finishInterruptedRestore } from '@/domain/backup/restore';
import { putAttachment } from '@/files/store';
import { enableSync, getSyncState } from '@/sync/engine';
import { nodeFs } from '@/files/nodeFs';
import type { FS } from '@/files/fsAdapter';
import type { RestorePlan } from '@/domain/backup/restore';
import type { TestBackupEnv } from './helpers/backupEnv';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmrf(d); });
const dir = (p: string) => { const d = tempDir(p); dirs.push(d); return d; };

/** يُنفّذ الاستعادة ويأخذ لقطة القرص كله لحظة صارت المجهَّزة data.db · ثم يقلع على اللقطة */
async function crashAtSwap(env: TestBackupEnv, plan: RestorePlan): Promise<TestBackupEnv> {
  const crashDir = dir('aq-r12r-boot-crash-');
  const watched: FS = {
    ...nodeFs,
    rename: (from, to) => {
      nodeFs.rename(from, to);
      if (from === plan.stagedDbPath && to === env.dbPath) fs.cpSync(env.root, crashDir, { recursive: true });
    },
  };
  await commitRestore({ ...env, fs: watched }, plan);
  env.closeLive();
  expect(fs.existsSync(path.join(crashDir, 'data.db.pre-restore'))).toBe(true);
  const booted = makeBackupEnv(crashDir);
  finishInterruptedRestore(booted);
  return booted;
}

test('١) استعادة نسخة هذا الجهاز انقطعت بعد التبديل: الإقلاع يطابق حال الملفات من القرص كما تفعل الاستعادة التامة', async () => {
  const env = makeBackupEnv(dir('aq-r12r-boot-cache-'));
  const a = await putAttachment(env.filesEnv, new Uint8Array([4, 4, 4, 1, 2, 3]), { entityType: 'library', kind: 'other', originalName: 'ملف مصطنع.bin' });
  env.db.run(`UPDATE file_cache SET uploaded = 1 WHERE sha256 = ?`, [a.sha256]); // رُفع إلى خادم ذلك الوقت
  const archive = path.join(env.root, 'own.aqbk');
  await createBackup(env, archive);

  const booted = await crashAtSwap(env, await prepareRestore(env, archive));
  // الاستعادة التامة تنتهي بـ reconcileCache: الملف هنا «لم يُرفع» (uploaded = 0) حتى يطابقه الخادم
  expect(booted.db.get<{ u: number }>(`SELECT uploaded AS u FROM file_cache WHERE sha256 = ?`, [a.sha256])?.u).toBe(0);
  booted.closeLive();
});

test('٢) استعادةٌ على جهازٍ مربوط بحساب انقطعت بعد التبديل: لا تُدمج مع السحابة صامتةً عند الإقلاع التالي', async () => {
  const env = makeBackupEnv(dir('aq-r12r-boot-adopt-'));
  enableSync(env.db, 'user-r12r-boot');
  addProperty(env.db, { name: 'عقار مصطنع في النسخة' });
  const archive = path.join(env.root, 'bound.aqbk');
  await createBackup(env, archive);

  const booted = await crashAtSwap(env, await prepareRestore(env, archive));
  // القاعدة المستعادة مربوطة بالحساب من النسخة، فبوابة syncNow تمرّ ما لم تُعلَّم «لم تُعتمد» كما تفعل الشاشة بعد الاستعادة
  expect(getSyncState(booted.db, 'uid')).toBe('user-r12r-boot');
  expect(getSyncState(booted.db, 'restored_unadopted')).toBe('1');
  booted.closeLive();
});
