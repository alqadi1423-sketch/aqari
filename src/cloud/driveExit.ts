/**
 * «نسخك على Google Drive» (ق٠-١ · F-الاستقلال-عن-قوقل ٧.٤): الخروج من Drive بخطوتين يضغطهما المستخدم.
 *  ١) الإخراج: تُنزَّل النسخ واحدةً واحدة بالمسار القائم (downloadBackupFromDrive، بمطابقة البصمة) ثم تُكتب في المجلد الذي اختاره
 *     وتُطابق هناك · والتالفة (بصمتها لا تطابق) تُذكر باسمها ولا يُحفظ منها شيء · وما خرج يُسجَّل فلا يُعاد.
 *  ٢) الحذف: deleteAllAppDataFiles القائم (المجلد المخفي والمجلد الظاهر) ثم سحب إذن التطبيق من حساب قوقل (revokeAccess).
 *
 * قرار القاعدة ٩٩ (ق٠-١): الحذف بعد إخراج كل ما على Drive الآن، أو بتأكيدٍ زائد يسمّي عدد ما لم يُخرج ويطابق العدد ساعة الحذف ·
 * وزرّه لا يظهر قبل محاولة إخراج (لا يعمل) · وسحب الإذن بعد الحذف لا قبله، وتعذّره يُقال ويُعاد بالزرّ نفسه بلا شيءٍ يُحذف ·
 * و«انتهى» (retiredAt) لا يُكتب إلا بعد السحب، وبعده تختفي الشاشة ولا يُطلب Drive.
 * منطق خالص · Drive والمجلد والسجل والسحب تُحقن (cloud.ts على الجهاز، ونسخٌ وهمية في الاختبارات).
 */
import { listDriveBackups, downloadBackupFromDrive, deleteAllAppDataFiles, DriveError, type DriveBackup, type DriveIO } from './drive';
import { throwIfCancelled, isCancelled, type CancelSignal, type ProgressFn } from '../domain/progress';
import { t } from '../i18n';

export interface DriveExitState {
  /** ما خرج إلى المجلد وطابق: معرّف النسخة على Drive ← بصمتها واسمها في المجلد ووقتها */
  exported: Record<string, { sha256: string; name: string; at: string }>;
  /** حُذفت النسخ وسُحب الإذن · بعده لا شاشة ولا Drive */
  retiredAt?: string;
}

export const emptyExitState = (): DriveExitState => ({ exported: {} });

export interface DriveExitDeps {
  io: DriveIO;
  token: () => Promise<string>;
  /** ملفٌ مؤقت في مجلد التطبيق لنسخةٍ تُنزَّل */
  tmpPath: (b: DriveBackup) => string;
  removeTmp: (path: string) => void;
  /** يكتب الملف المنزَّل في المجلد المختار ويطابقه ببصمة Drive · يعيد اسمه هناك · FolderAccessError إن ضاع الإذن */
  save: (path: string, b: DriveBackup) => Promise<string>;
  load: () => DriveExitState;
  store: (s: DriveExitState) => void;
  /** سحب إذن التطبيق من حساب قوقل */
  revoke: () => Promise<void>;
}

export interface ExportReport {
  saved: string[];
  /** خرجت من قبل فلم تُنزَّل ثانية */
  already: number;
  failed: Array<{ name: string; why: string }>;
}

const done = (s: DriveExitState, b: DriveBackup) => !!b.sha256 && s.exported[b.id]?.sha256 === b.sha256;

/** ما يظهر في الشاشة · العدد وما خرج، وأيّ زرّ يعمل الآن (الزرّ الذي لا يعمل لا يظهر) */
export function driveExitView(list: DriveBackup[], s: DriveExitState, o: { folder: boolean; triedExport?: boolean }) {
  const exported = list.filter((b) => done(s, b)).length;
  const unexported = list.length - exported;
  return {
    count: list.length,
    exported,
    canExport: o.folder && unexported > 0 && !s.retiredAt,
    // كلها خارجة (أو لا شيء على Drive وبقي سحب الإذن) · أو حاول الإخراج فتعذّر بعضها: بتأكيدٍ يسمّي العدد
    canDelete: !s.retiredAt && (unexported === 0 || (!!o.triedExport && exported + unexported > 0 && o.folder)),
    unexported,
  };
}

/** الشاشة للمالك أو المدير (بطاقة النسخ لهما وحدهما، فالعضو لم يرفع إلى Drive)، داخلاً متصلاً، ولم يُنهِ الخروج على هذا الجهاز */
export function driveExitVisible(o: { admin: boolean; signedIn: boolean; online: boolean; retired: boolean }): boolean {
  return o.admin && o.signedIn && o.online && !o.retired;
}

/** تنزيل ما لم يخرج بعد إلى المجلد · الأقدم أولاً · التالفة تُذكر وتُتخطّى · وضياع إذن المجلد أو الإلغاء يوقف الكل */
export async function exportDriveBackups(deps: DriveExitDeps, o: { onProgress?: ProgressFn; signal?: CancelSignal } = {}): Promise<ExportReport> {
  const token = await deps.token();
  const list = (await listDriveBackups(deps.io, token)).slice().reverse();
  const report: ExportReport = { saved: [], already: 0, failed: [] };
  let state = deps.load();
  const todo = list.filter((b) => { if (done(state, b)) { report.already++; return false; } return true; });
  for (let i = 0; i < todo.length; i++) {
    const b = todo[i];
    throwIfCancelled(o.signal);
    o.onProgress?.(t('driveExit.exporting', { i: i + 1, n: todo.length }), { done: i, total: todo.length, unit: 'items' });
    const tmp = deps.tmpPath(b);
    try {
      try {
        await downloadBackupFromDrive(deps.io, token, b, tmp, { signal: o.signal });
      } catch (e) {
        // نسخةٌ تالفة أو تعذّر تنزيلها: تُذكر باسمها ولا يُحفظ منها شيء، ويكمل الباقي
        if (isCancelled(e) || !(e instanceof DriveError)) throw e;
        report.failed.push({ name: b.name, why: e.message.replace(/^Google Drive:\s*/, '') });
        continue;
      }
      const name = await deps.save(tmp, b);
      state = { ...state, exported: { ...state.exported, [b.id]: { sha256: b.sha256, name, at: new Date().toISOString() } } };
      deps.store(state);
      report.saved.push(name);
    } finally {
      deps.removeTmp(tmp);
    }
  }
  return report;
}

/**
 * «احذف نسخ عقاري من Drive»: كل ما على Drive الآن خرج، أو أكّد المستخدم حذف ما لم يخرج بعدده نفسه · ثم الحذف ثم سحب الإذن.
 * يعيد عدد ما حُذف (المخفية والظاهرة).
 */
export async function deleteDriveBackups(
  deps: DriveExitDeps, o: { unexportedConfirmed?: number; onProgress?: ProgressFn } = {},
): Promise<{ deleted: number }> {
  const token = await deps.token();
  const list = await listDriveBackups(deps.io, token);
  const state = deps.load();
  const unexported = list.filter((b) => !done(state, b)).length;
  if (unexported > 0 && o.unexportedConfirmed !== unexported) throw new Error(t('driveExit.notExported', { count: unexported }));
  o.onProgress?.(t('driveExit.deleting'));
  const deleted = await deleteAllAppDataFiles(deps.io, token);
  o.onProgress?.(t('driveExit.revoking'));
  try {
    await deps.revoke();
  } catch {
    throw new Error(t('driveExit.revokeFailed'));
  }
  deps.store({ ...deps.load(), retiredAt: new Date().toISOString() });
  return { deleted };
}
