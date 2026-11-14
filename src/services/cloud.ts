/**
 * طبقة الربط على الجهاز · تربط المنطق الخالص (src/cloud و src/sync) بوحدات الجهاز:
 * Google Sign-In الأصلي، المخزن الآمن، شبكة الجهاز، ونقل الملفات من القرص وإليه.
 *
 * التطبيق يعمل كاملاً بلا هذا كله: لا دخول = لا مزامنة ولا Drive، والقاعدة المحلية كما هي.
 * والمزامنة تجري وحدها: عند الإقلاع، وعند عودة الاتصال، وعند العودة إلى التطبيق، وكل دقيقة
 * ما دام التطبيق ظاهراً · ولا تجري بلا اتصال أو بلا دخول، ولا تجريان معاً.
 */
import { AppState } from 'react-native';
import { SCHEMA_VERSION } from '../db/schema';
import * as SecureStore from 'expo-secure-store';
import * as Network from 'expo-network';
import * as LegacyFS from 'expo-file-system/legacy';
import { File, Paths } from 'expo-file-system';
import { GoogleSignin, isSuccessResponse } from '@react-native-google-signin/google-signin';
import type { AppDB } from '../db/expoAdapter';
import { cloudConfig, filesCloudConfig, DRIVE_SCOPE, DRIVE_FILE_SCOPE } from '../cloud/config';
import { type StorageIO } from '../cloud/storage';
import { pumpUploads, ensureLocal, fileState, cacheUsage, clearCache, reconcileOwnerFiles, type FilesRemote } from '../files/cloudFiles';
import { liveBlobs } from '../files/store';
import { appFilesEnv } from './filesEnv';
import { getSetting } from '../repos/settings';
import { signInWithGoogleIdToken, refreshIdToken, deleteFirebaseAccount } from '../cloud/authRest';
import { createSession, type SessionUser, type AccountProof } from '../cloud/session';
import type { AuthProvider } from '../cloud/authProvider';
import { googleAuthProvider } from '../cloud/googleAuth';
import { deleteAccountFlow } from '../cloud/deleteAccountFlow';
import { whilePrompting, deviceLockAvailable, askDevice } from './appLockService';
import { FirestoreRemote, FirestoreHttpError } from '../cloud/firestore';
import { listDriveBackups, uploadBackupToDrive, uploadVisibleCopy, downloadBackupFromDrive, deleteAllAppDataFiles, DriveError, type DriveBackup, type DriveIO } from '../cloud/drive';
import { exportDriveBackups, deleteDriveBackups, driveExitView, emptyExitState, type DriveExitDeps, type DriveExitState, type ExportReport } from '../cloud/driveExit';
import { writeToBackupFolder, backupFolder } from './backupFolder';
import { resetDeviceData } from './deviceReset';
import { profileForAudit } from '../domain/access/profile';
import { cancelAllNotifications } from './notifications';
import { hasUserData } from '../domain/backup/upgrade';
import {
  enableSync, syncOnce, syncStatus, setSyncState, getSyncState, planCloudReplace, adoptAsCloudTruth, readCloud, planFromSnapshot, syncBackoffUntil,
  type SyncStatus, type CloudReplacePlan, type CloudSnapshot, replayRejectsAfterUpgrade, clockSkewMs } from '../sync/engine';
import type { DB } from '../db/adapter';
import { ensureDeviceId } from '../db/seed';
import { expoHasher, expoMd5Base64 } from '../files/expoFs';
import { joinPath } from '../files/fsAdapter';
import { createBackup, ensureFreeSpace } from '../domain/backup/create';
import { prepareRestore, type RestorePlan, type PrepareOptions } from '../domain/backup/restore';
import type { BackupEnv } from '../domain/backup/types';
import { planKeepPosted, applyKeepPosted, keepShortages, type KeepPlan } from '../domain/backup/keepPosted';
import { toLocalISODate } from '../domain/dates';
import { appBackupEnv, shareUnsyncedFile } from './backupService';
import { backupSecretForSealing } from './backupPassword';
import { sealBackupFile } from '../domain/backup/seal';
import { SYNC_TABLES } from '../db/syncTables';
import { memberTokens, fullReadTables } from '../sync/acl';
import { setCapture, outboxCount, seedOutbox, setFilesSync } from '../sync/engine';
import { autoDepreciate } from '../domain/assets/auto';
import { syncLanguageWithAccount } from '../i18n/device';
import { gateFailure } from '../cloud/signInFailure';
import { t } from '../i18n';
import { runChatSync, setSupervisor, supervisorOf, chatSyncRunning, chatUnsentCount, clearChatData, hasChatData, chatRemoveMember, chatEditGroup, chatLeaveOrg, chatSetPin, chatAcknowledge, chatEditMessage, chatEditsOf, chatSetTask, chatSetTaskDone, chatCancelTask, chatVote,
  type GroupChange, type ChatTag, type ChatTask,
  chatReviewCandidates, chatOpenReview, chatCloseReview, chatJoinGroup, chatMe, type ChatSession } from '../chat';
import type { RemoteMessage, RemoteThread } from '../chat/remote';
import { getCloudLang, putCloudLang } from '../cloud/userPrefs';
import { today } from '../domain/dates';
import { wipeAllData } from '../domain/wipe';
import { makeSafetyBackup } from '../domain/backup/create';
import { leaveSafely } from '../domain/leaveOrg';
import { saveUnsyncedWork, unsyncedAuditNote, dropMemberBackups, noteDropPending, retryDropMemberBackups, readExitNotice, writeExitNotice,
  clearExitNotice, unsyncedPath, MEMBER_SINCE_KEY, type UnsyncedSaved, type ExitWhy } from '../domain/memberExit';
import { wipeCloud, deleteAccountCloud, type CloudFiles } from './cloudWipe';
import { logMemberAccess } from '../domain/memberAudit';
import { appDataRoot } from '../files/expoFs';
import { switchTo, parkActive, activeAccount, UNBOUND } from './accountSlots';
import { appSlotEnv } from './slotsApp';
import { readAccess, readMembership, saveMembership, type Membership } from './access';
import {
  moveOwnerToOrg, refreshMembership, checkEpoch, pendingEpoch, chatWipeDue, chatEpochBaseline, resolveEpoch, readEpoch, findInvites, ownOrgExists, localBindAllowed, claimLocalBind, acceptInvite, leaveOrg, listTeam, sendInvite, updateMember, removeMember, revokeInvite, readCompat, raiseCompat, appTooOld,
  updateMemberProfile, publishUnitMoves, checkUnitMoves, type MemberDoc, type MemberSpec, permWipeDue, notePermWipe, PERM_WIPE_KEY } from './org';
import type { MemberProfile } from '../domain/access/profile';
import { logAudit } from '../domain/audit';
import { throwIfCancelled, isCancelled, CancelledError, type CancelSignal, type ProgressFn } from '../domain/progress';
import { saveInvoiceIssued, setInvoiceStatusIssued, issuePendingInvoices, issueCreditNote, type InvoiceNumberSource, type IssueResult } from '../domain/invoiceIssue';
import type { InvoiceInput, CreditNoteInput } from '../domain/invoices';

/* ═══════════ الجلسة ═══════════ */

/**
 * مزوّد الهوية (ق٠-٦ · cloud/authProvider.ts): كل ما يحتاج الحساب هنا يمرّ به ولا يعرف أنه قوقل · اليوم مزوّد قوقل وحده حين يُهيّأ
 * الربط · ومزوّدٌ آخر يُعطى بـsetAuthProvider عند التحويل وحده (بإذن المالك) وفي الاختبارات
 */
let session: AuthProvider | null = null;
let chosen: AuthProvider | null = null;

/** مزوّد الهوية لهذا التشغيل بدل قوقل · null يعيد قوقل · لا يناديه التطبيق قبل التحويل (ق٣ إلى ق٥) */
export function setAuthProvider(p: AuthProvider | null): void {
  chosen = p;
  session = null;
  patch({ configured: !!getSession(), user: null, restored: false });
}

function getSession(): AuthProvider | null {
  if (chosen) return chosen;
  const cfg = cloudConfig();
  if (!cfg) return null;
  if (session) return session;
  // بعد حذف النسخ من Drive وسحب الإذن على هذا الجهاز (ق٠-١) لا يُطلب نطاق Drive في أي دخولٍ بعده
  GoogleSignin.configure(googleConfig(cfg.webClientId));
  const authOpts = { apiKey: cfg.apiKey };
  const google = createSession({
    google: {
      // نافذة قوقل تُخرج التطبيق إلى الخلفية: لا يُحسب ذلك خروجاً فيُقفل عند العودة (services/appLockService.ts)
      signIn: () => whilePrompting(async () => {
        await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
        const res = await GoogleSignin.signIn();
        if (!isSuccessResponse(res) || !res.data.idToken) return null;
        return { idToken: res.data.idToken, email: res.data.user.email };
      }),
      async signInSilently() {
        const res = await GoogleSignin.signInSilently();
        return res.type === 'success';
      },
      async accessToken() {
        return (await GoogleSignin.getTokens()).accessToken;
      },
      async signOut() { await GoogleSignin.signOut(); },
    },
    store: {
      get: (k) => SecureStore.getItemAsync(k),
      set: (k, v) => SecureStore.setItemAsync(k, v),
      del: (k) => SecureStore.deleteItemAsync(k),
    },
    signInWithIdp: (t) => signInWithGoogleIdToken(authOpts, t),
    refresh: (r) => refreshIdToken(authOpts, r),
  });
  session = googleAuthProvider({ session: google, deleteFirebaseAccount: (tok) => deleteFirebaseAccount(authOpts, tok) });
  return session;
}

/* ═══════════ الحالة لشاشة الإعدادات ═══════════ */

export interface CloudState {
  configured: boolean;
  user: SessionUser | null;
  online: boolean;
  syncing: boolean;
  progress: string | null;
  lastError: string | null;
  sync: SyncStatus | null;
  /** انتهت قراءة الجلسة المحفوظة عند الإقلاع · قبلها لا تُعرض شاشة الدخول فلا تومض */
  restored: boolean;
  /** دعوات منشآت لإيميل الداخل على جهاز جديد · تعرضها بوابة الدخول قبل أي مزامنة */
  invites: Array<{ org: string; doc: MemberDoc }> | null;
  /** للحساب منشأةٌ قائمة في السحابة · تُعرض قبل الدعوات (مراجعة التثبيت #52) */
  ownOrg?: boolean;
  /**
   * ما تنتظره بوابة الدخول قبل فتح التطبيق: 'retry' تعذّر التحقق من الدعوات (يلزم اتصال) ·
   * 'unbound' على الجهاز بيانات بلا حساب ينتظر قرار الداخل فيها · 'switching' تُفتح نسخة الحساب
   */
  gate: 'retry' | 'unbound' | 'switching' | null;
  /** سبب تعثّر التحقق من الدعوات بنصه الفعلي وتفاصيله للنسخ (رسالة المالك 2026-10-08) */
  gateError?: { lead: string; full: string } | null;
  /**
   * ما ينتظر قرار المستخدم ولا يُنفَّذ بدونه (قاعدة المالك ٢٠٢٦-١٠-٠٥): 'epoch' مُسحت المنشأة من جهاز آخر
   * وعلى هذا الجهاز بيانات · 'removed' أُزيلت عضويته (أو غادر: left) ففُرّغ الجهاز عند أول اتصال بلا نسخةٍ كاملة، وما يبقى
   * إشعارٌ بذلك وملفُّ ما لم يُرفع من عمله (pending عدد ما فيه) يرسله إلى صاحب المنشأة (المراجعة الشاملة 2026-11-13 · B-4 · س٩ وس١٠).
   * والمزامنة متوقفة حتى يقرر.
   */
  decision: { kind: 'epoch' | 'removed'; pending: number; left?: boolean } | null;
}

let state: CloudState = { configured: !!cloudConfig(), user: null, online: false, syncing: false, progress: null, lastError: null, sync: null, restored: false, invites: null, gate: null, decision: null };
const listeners = new Set<() => void>();
function patch(p: Partial<CloudState>): void {
  state = { ...state, ...p };
  for (const l of listeners) l();
}
export function cloudState(): CloudState { return state; }
export function subscribeCloud(l: () => void): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

/* ═══════════ المزامنة ═══════════ */

let appDb: AppDB | null = null;
let running = false;
let onData: () => void = () => {};

const arabic = (e: unknown) => {
  const m = e instanceof Error ? e.message : String(e);
  return /[؀-ۿ]/.test(m) ? m : 'تعذّر الاتصال بالخادم · ستُعاد المحاولة';
};

/**
 * عميل السحابة لهذا الجهاز (docs/PERMISSIONS.md) · العضو: منشأته برموزه، والمالك: منشأته orgs/{uid}
 * بعد انتقاله، وقبله المسار القديم users/{uid} (legacy=true يفرضه، لقراءة حروف الأجهزة القديمة).
 */
/** قواعد الحد الأدنى للإصدار منشورة (#36) · فتُرفع صفوف المنشأة بإصدارها · يُعرف من قراءة الحد في كل دورة */
let compatLive = false;
const svOf = () => (compatLive ? SCHEMA_VERSION : null);

function remoteOf(db: DB, uid: string, idToken: () => Promise<string>, legacy = false): FirestoreRemote {
  const cfg = cloudConfig()!;
  const m = readMembership(db);
  const tables = SYNC_TABLES.map((t) => t.name);
  if (m && !legacy) {
    return new FirestoreRemote({
      projectId: cfg.projectId, uid, idToken, org: m.org,
      memberTokens: () => memberTokens(readAccess(db)),
      fullReadTables: () => fullReadTables(readAccess(db), tables),
      access: () => readAccess(db), sv: svOf, serverSkewMs: () => clockSkewMs(db),
    });
  }
  if (!legacy && getSyncState(db, 'org') === uid) {
    return new FirestoreRemote({ projectId: cfg.projectId, uid, idToken, org: uid, access: () => readAccess(db), sv: svOf, serverSkewMs: () => clockSkewMs(db) });
  }
  return new FirestoreRemote({ projectId: cfg.projectId, uid, idToken, serverSkewMs: () => clockSkewMs(db) });
}

/** ربط الجهاز بعضويته بعد تفريغه · بلا رفع ما زُرع عليه (ليس للعضو أن يكتبه في منشأة غيره) */
function bindMember(db: DB, m: Membership, email: string, orgName: string | null): void {
  db.transaction(() => {
    saveMembership(db, m);
    setSyncState(db, 'uid', m.uid);
    setSyncState(db, 'email', email);
    setSyncState(db, 'org', m.org);
    setSyncState(db, 'org_name', orgName);
    setSyncState(db, 'cursor', null);
    setSyncState(db, 'joining', '1');
    db.run('DELETE FROM sync_outbox');
    setCapture(db, true);
  });
}

/** إيقاف مؤقت أثناء الاستعادة · لا سحب ولا رفع حتى يُستأنف */
let paused = false;

/** يوقف المزامنة وينتظر انتهاء دورة جارية · فلا تكتب دورةٌ في القاعدة وهي تُستبدل */
/**
 * المحادثة موقوفة أثناء تفريغ الجهاز (تحقق الدمج ف٦): لا تبدأ دورة، وتُنتظر الجارية · فلا يقع سحبٌ في قاعدة فُرّغت للتو
 */
let chatHeld = 0;
async function holdChat<T>(fn: () => Promise<T>): Promise<T> {
  chatHeld++;
  try {
    while (chatSyncRunning()) await new Promise((r) => setTimeout(r, 200));
    return await fn();
  } finally {
    chatHeld--;
  }
}

export async function pauseSync(): Promise<void> {
  paused = true;
  while (running || chatSyncRunning()) await new Promise((r) => setTimeout(r, 200));
}
export function resumeSync(): void {
  paused = false;
}

export async function syncNow(): Promise<void> {
  const s = getSession();
  const db0 = appDb;
  const cfg = cloudConfig();
  if (!s || !db0 || !cfg || running || paused || !state.user || !state.online) return;
  // القاعدة الحية قد تتبدّل بتفريغٍ في أثناء الدورة (wipe.ts: «الاستدعاء يعيد قراءة env.db») · فتُقرأ من جديد بعده
  let db: AppDB = db0;
  // قرارٌ معلّق (دعوة، أو بيانات بلا حساب، أو تحقق لم يتمّ) · لا مزامنة فلا تُنشأ منشأة قبله
  if (state.gate || state.invites?.length || activating) return;
  if (activeAccount(db) !== state.user.uid) return;
  // استعادةٌ جرت خارج الحساب لم تُعتمد بعد · لا تُدمج مع السحابة صامتةً، فتنتظر قرار المستخدم
  if (getSyncState(db, 'restored_unadopted') === '1') {
    patch({ lastError: 'استُعيدت نسخة ولم تُعتمد للسحابة بعد · افتح الإعدادات لاعتمادها' });
    return;
  }
  // بيانات الجهاز لحساب آخر · لا تُرفع إلى الداخل ولا يُنضمّ بها حتى يختار في بوابة الدخول
  const owner = deviceAccount(db);
  if (owner && owner.uid !== state.user.uid) return;
  // خرج من المنشأة (أُزيل أو غادر) وفُرّغ الجهاز: إشعاره وملفُّ ما لم يُرفع من عمله يبقيان حتى يقرأه، والمزامنة متوقفة حتى ذلك
  // (المراجعة الشاملة 2026-11-13 · B-4 · س٩ وس١٠)
  // ونسخ الجهاز التي تعذّر حذفها عند خروجه يُعاد حذفها (R11-B4-2) · لا تُنتظر
  retryExitDrop(db).catch(() => {});
  const exit = readExitNotice(db);
  if (exit) { patch({ decision: { kind: 'removed', pending: exit.count, ...(exit.why === 'left' ? { left: true } : {}) } }); return; }
  // رفضٌ متكرر من الخادم (حصة أو انشغال) · تُؤجَّل الدورات ثم تُستأنف من الطابور نفسه
  if (syncBackoffUntil(db)) return;
  // القاعدة قد تكون استُبدلت باستعادة: بلا حالة مزامنة أو بحساب آخر أو بالتقاط متوقف ·
  // enableSync لا يفعل شيئاً للحساب نفسه سوى تشغيل الالتقاط، ولغيره ينضمّ من جديد
  const uid = state.user.uid;
  const idToken = () => s.accessToken();
  const member = readMembership(db);
  running = true;
  patch({ syncing: true, lastError: null });
  try {
    // لغة المستخدم تتبعه على أجهزته وتُزامَن مع حسابه (قرار المالك ٢٠٢٦-١٠-٠٧) · فشلها لا يعطّل المزامنة
    const prefsAt = { projectId: cfg.projectId, uid, idToken };
    syncLanguageWithAccount(uid, { get: () => getCloudLang(prefsAt), put: (c) => putCloudLang(prefsAt, c) }).catch(() => {});
    // صفوف المرفقات تُزامَن حين يعمل تخزين الملفات وحده (النموذج المختلط) · وأول تشغيل يرفعها كلها
    setFilesSync(db, filesCloudOn());
    if (!member) {
      enableSync(db, uid);
      // المالك ينتقل إلى منشأته مرة (صلاحيات الأقسام) · حروف أجهزته تنتقل كما هي
      await moveOwnerToOrg(db, remoteOf(db, uid, idToken, true), new FirestoreRemote({ projectId: cfg.projectId, uid, idToken, org: uid }), uid);
    }
    // العضوية في الخادم أول الدورة، قبل كل قراءةٍ تشترطها (المراجعة الشاملة 2026-11-13 · B-2): مستند العضو يقرؤه صاحبه دائماً ولو حُذف
    // (firestore.rules · members/{uid})، وعهد المسح والحد الأدنى للإصدار والسحب برموزه المحفوظة يرفضها الخادم (403) لمن أُزيل أو أُنقصت
    // صلاحيته · فكانت الدورة ترمي قبل أن تعرف، ويبقى جواله يعرض ما كان يراه · أُزيلت ← يُفرَّغ الآن · تغيّرت ← تُحفظ ويُسحب بها في
    // هذه الدورة، والتفريغ المنتظر في آخرها · ونُقلت وحدةٌ من عقاراته إلى عقار ليس له ← كتغيّرها · وعلى جهاز المالك لا طلب
    // (سجل النقل يُرفض لمن أُزيل فلا يحجب فحص عضويته بعده، ورفضه هو الدليل الثاني على الإزالة مع غياب مستند العضوية · R11-B2-1)
    const seen = { denied: false };
    const moved = await checkUnitMoves(db, remoteOf(db, uid, idToken)).catch((e: unknown) => deniedAsNone(e, seen));
    // مؤشر النقل تقدّم · فيُسجَّل التفريغ الآن قبل طلب العضوية، فلا يضيع بفشله
    if (moved === 'lost') notePermWipe(db, 'moved');
    const r0 = await refreshMembership(db, remoteOf(db, uid, idToken), seen.denied);
    const r = r0 === 'same' && moved === 'lost' ? 'changed' : r0;
    if (r === 'removed') { db = await exitRemoved(db); return; }
    // والتغيّر يُسجَّل تفريغه المنتظر الآن (حُفظت العضوية الجديدة) فلا يضيع بفشلٍ بعده في الدورة
    if (r === 'changed') notePermWipe(db, moved === 'lost' ? 'moved' : 'changed');
    // عهد المسح: مُسحت المنشأة من جهاز آخر وعلى هذا الجهاز بيانات ← يُسأل المستخدم ولا يُفرَّغ، والمزامنة
    // متوقفة حتى يقرر (قاعدة المالك ٢٠٢٦-١٠-٠٥) · وما ينتظر قراراً يبقى كذلك في الدورات التالية
    const org = member?.org ?? (getSyncState(db, 'org') === uid ? uid : null);
    if (org) {
      const chatBase = chatEpochBaseline(db);
      const act = pendingEpoch(db) !== null ? 'ask' : await checkEpoch(db, remoteOf(db, uid, idToken), org);
      // مسح المالك الشامل يمسح محادثات المنشأة من هذا الجهاز عند أول اتصال، بنسخة أمان وسطر في سجل العمليات
      // (قرار المالك 2026-10-08) · قبل سؤال البيانات وبمعزل عنه
      const remoteEpoch = Number(getSyncState(db, 'remote_epoch') ?? 0);
      if (chatWipeDue(chatBase, remoteEpoch, hasChatData(db))) {
        await holdChat(async () => {
          await makeSafetyBackup(appBackupEnv(db as AppDB), 'pre-wipe');
          const n = clearChatData(db);
          setSyncState(db, 'chat_epoch', String(remoteEpoch));
          logAudit(db, 'المحادثة', 'delete', 'مسح محادثات المنشأة', 'بمسح المالك الشامل · ' + n + ' رسالة'); // i18n-exempt: سطر سجل العمليات المخزَّن
        });
        onData();
      } else if (remoteEpoch > (chatBase ?? 0)) {
        setSyncState(db, 'chat_epoch', String(remoteEpoch));
      }
      if (act === 'ask') { patch({ decision: { kind: 'epoch', pending: outboxCount(db) } }); return; }
    }
    // الحد الأدنى لإصدار التطبيق (#36 · قرار المالك 2026-10-09): العضو بإصدارٍ أقدم من حدّ المنشأة لا يزامن ويُطلب منه التحديث
    if (org) {
      const compat = await readCompat(remoteOf(db, uid, idToken), org);
      compatLive = compat.live;
      // المالك والعضو كلاهما: جهازٌ أقدم من الحد لا يكتب فيُرفض ما يكتبه (التحقق المستقل من f07ad73)
      if (appTooOld(compat.min)) { patch({ lastError: t('compat.updateApp') }); return; }
    }
    patch({ decision: null });
    // ما رُفض لإصدارٍ أقدم يعود بعد الترقية، مرة لكل إصدار (التحقق المستقل من #36 والهجرة ٤٠)
    replayRejectsAfterUpgrade(db, SCHEMA_VERSION);
    // الشاشات تتحدث بما وصل أثناء التطبيق لا بعده كله · أول سحب يظهر تدريجياً (أعطال ٢٠٢٦-١٠-٠٥)
    const rep = await syncOnce(db, remoteOf(db, uid, idToken), ensureDeviceId(db), (msg) => patch({ progress: msg }), { onApplied: () => onData() });
    setSyncState(db, 'last_error', null);
    if (rep.applied || rep.conflicts) onData();
    // الفواتير التي طُلب إصدارها بلا اتصال تصدر الآن برقمها من العدّاد (قرار المالك ٢٠٢٦-١٠-٠٥)
    if (await issuePendingInvoices(db, remoteOf(db, uid, idToken))) onData();
    // الإهلاك الشهري الآلي على جهاز المالك بعد دورةٍ لم يبقَ بعدها ما ينتظر الرفع (موجز الأصول §٣ب)
    if (!member && autoDepreciate(db, today(), { owner: true, afterSync: true })) onData();
    // الملفات الجديدة تُرفع في الخلفية بعد البيانات · ولا تُنتظر
    pumpFilesInBackground(db, rep.applied + rep.pushed > 0).catch(() => {});
    // المالك ينشر نقل الوحدات بعد رفع صفوفها بوسمها الجديد (ملاحظة المالك على ٤.١٢)
    if (!member && org === uid) await publishUnitMoves(db, remoteOf(db, uid, idToken), org);
    if (member && (r === 'changed' || r === 'same')) {
      // تغيّر الصلاحية (عُرف أول الدورة): لا تفريغ وفي الطابور ما لم يُرفع (قاعدة المالك ٢٠٢٦-١٠-٠٥) · التفريغ منتظرٌ محفوظ حتى يُرفع
      // الطابور وما لم يُرسل من المحادثة (في هذه الدورة)، ثم يقع في أول دورة بعدها، ويُعاد السحب من أوله بصلاحيته الجديدة (تحقق الدمج ف٢)
      const queued = outboxCount(db);
      const due = permWipeDue(db, r, moved, queued + chatUnsentCount(db));
      if (due) {
        const next = readMembership(db)!;
        await wipeLocal(db, undefined, undefined, due === 'moved' ? 'نُقلت وحدةٌ من عقاراتك إلى عقار ليس لك' : 'تغيّرت صلاحيتك في المنشأة');
        db = liveAfterWipe(db);
        setSyncState(db, PERM_WIPE_KEY, null);
        bindMember(db, next, state.user.email, getSyncState(db, 'org_name'));
        onData();
      }
    }
  } catch (e0) {
    let e = e0;
    // رفضٌ (403) على جهاز عضو بعد فحص العضوية أول الدورة: أُزيل أو تغيّرت صلاحيته في أثنائها · تُفحص من جديد قبل أن يُعرض «تعذّر
    // الاتصال» (المراجعة الشاملة 2026-11-13 · B-2)
    if (member && e instanceof FirestoreHttpError && e.status === 403) {
      try {
        const again = await refreshMembership(db, remoteOf(db, uid, idToken));
        if (again === 'removed') { db = await exitRemoved(db); return; }
        if (again === 'changed') { notePermWipe(db, 'changed'); e = new Error(t('org.permChanged')); }
      } catch (e2) {
        e = e2;
      }
    }
    const msg = arabic(e);
    try { setSyncState(db, 'last_error', msg); } catch { /* القاعدة مشغولة · يظهر في الحالة وحدها */ }
    patch({ lastError: msg });
  } finally {
    running = false;
    patch({ syncing: false, progress: null, sync: syncStatus(db) });
    // المحادثة بعد كل دورة (src/chat) · وحدة مستقلة: فشلها لا يمسّ المزامنة ولا يظهر خطأً عاماً
    chatSyncNow().catch(() => {});
  }
}

/** اسم المالك في المحادثة · مصدر واحد للشاشة والمزامنة (التحقق ج١) */
export const chatOwnerName = (db: DB): string => orgNameOf(db);

/** دورة مزامنة للمحادثة وحدها · تستدعيها شاشتها أيضاً · بلا جلسة أو اتصال لا تفعل شيئاً */
export async function chatSyncNow(o: { threadId?: string; full?: boolean; force?: boolean } = {}): Promise<void> {
  const s = getSession();
  const db = appDb;
  const cfg = cloudConfig();
  const u = state.user;
  if (!s || !db || !cfg || !u || !state.online) return;
  // ما يوقف المزامنة العامة يوقف المحادثة (مراجعة المحادثة #7)
  if (paused || chatHeld || activating || state.gate || state.invites?.length || state.decision) return;
  if (activeAccount(db) !== u.uid) return;
  if (getSyncState(db, 'restored_unadopted') === '1' || syncBackoffUntil(db)) return;
  const owner = deviceAccount(db);
  if (owner && owner.uid !== u.uid) return;
  await runChatSync(db, { projectId: cfg.projectId, uid: u.uid, email: u.email, idToken: () => s.accessToken() }, orgNameOf(db), o);
}

/**
 * قراءة الجلسة المحفوظة فور الإقلاع لبوابة الدخول · بلا شبكة ولا مزامنة (تبدأ هي متأخرةً في startCloud) ·
 * فلا تنتظر البوابة ثواني ولا تومض شاشة الدخول لمن دخل من قبل
 */
export function primeSession(): void {
  if (state.restored) return;
  const s = getSession();
  if (!s) { patch({ configured: false, restored: true }); return; }
  Network.getNetworkStateAsync()
    .then((n) => patch({ online: !!n.isConnected && n.isInternetReachable !== false }))
    .catch(() => {});
  s.restore().then((u) => patch({ user: u, restored: true })).catch(() => patch({ restored: true }));
}

/** يبدأ مع التطبيق · يعيد دالة الإيقاف */
export function startCloud(db: AppDB, onRemoteData?: () => void): () => void {
  appDb = db;
  onData = onRemoteData ?? (() => {});
  // نسخ الجهاز التي تعذّر حذفها عند خروج العضو تُحذف عند الإقلاع ولو خرج من حسابه بعد المغادرة (R11-B4-2)
  retryExitDrop(db).catch(() => {});
  const s = getSession();
  patch({ configured: !!s, sync: syncStatus(db) });
  if (!s) { patch({ restored: true }); return () => {}; }
  let timer: ReturnType<typeof setInterval> | null = null;
  const subs: Array<{ remove(): void }> = [];

  Network.getNetworkStateAsync()
    .then((n) => patch({ online: !!n.isConnected && n.isInternetReachable !== false }))
    .catch(() => {});
  subs.push(Network.addNetworkStateListener((n) => {
    const online = !!n.isConnected && n.isInternetReachable !== false;
    const back = online && !state.online;
    patch({ online });
    if (back) syncNow(); // عودة الاتصال تُرسل الطابور
  }));
  subs.push(AppState.addEventListener('change', (a) => { if (a === 'active') syncNow(); }));
  timer = setInterval(() => { if (AppState.currentState === 'active') syncNow(); }, 60_000);

  s.restore().then((u) => {
    patch({ user: u, restored: true });
    // كل إقلاع يمرّ بفتح نسخة الحساب: نسخة غيره تُركن، والنسخة الفارغة تُعرض دعواتها قبل أي مزامنة
    if (u) activateAccount(u);
  }).catch(() => patch({ restored: true }));

  return () => {
    if (timer) clearInterval(timer);
    for (const x of subs) { try { x.remove(); } catch { /* أُزيل */ } }
  };
}

export async function cloudSignIn(): Promise<SessionUser | null> {
  const s = getSession();
  if (!s || !appDb) return null;
  const u = await s.signIn();
  if (!u) return null;
  await activateAccount(u);
  return u;
}

// موضع الخطأ في نص التفاصيل المنسوخ لا في الشاشة
const GATE_WHERE = 'الدخول · التحقق من الدعوات'; // i18n-exempt: موضع في تقرير الخطأ

let activating = false;

/**
 * نسخة الحساب الداخل تصير النشطة (توجيه المالك: البيانات ملك الحساب لا الجهاز) · نسخة غيره تُركن
 * مقفلةً بطابورها ولا تُمسح. والنسخة الجديدة لا تُنشئ منشأة قبل التحقق من الدعوات: المدعوّ يرى دعوته
 * وحدها حتى يقرر، وتعذّر التحقق (بلا اتصال) لا يُفترض معه أنه مالك.
 */
export async function activateAccount(u: SessionUser): Promise<void> {
  const db = appDb;
  const s = getSession();
  if (!db || !s || activating) return;
  activating = true;
  // شاشة الانتظار حين تُفتح نسخة غير النشطة وحدها · والنسخة النشطة نفسها لا تومض عند كل إقلاع
  patch(activeAccount(db) === u.uid ? { user: u, invites: null, gateError: null } : { user: u, gate: 'switching', invites: null, gateError: null });
  await pauseSync();
  try {
    const env = appSlotEnv(db);
    const r = switchTo(env, u.uid);
    onData();
    const fresh = activeAccount(db) !== u.uid;
    // نسخة الحساب بلا عضوية ولا بيانات (منشأة فارغة أُنشئت قبل قراره) · تُعرض دعواته كالجديدة،
    // وتعذّر التحقق هنا لا يوقفه لأن له نسخة
    const emptyOwn = !fresh && !readMembership(db) && !hasUserData(db);
    if (emptyOwn && state.online) {
      try {
        const sess = s;
        const inv = await findInvites(new FirestoreRemote({ projectId: cloudConfig()!.projectId, uid: u.uid, idToken: () => sess.accessToken() }), u.email);
        if (inv.length) { patch({ invites: inv, gate: null }); return; }
      } catch { /* يكمل بنسخته */ }
    }
    if (fresh) {
      // نسخة جديدة أو بيانات بلا حساب · الدعوات أولاً
      let inv: Array<{ org: string; doc: MemberDoc }> | null = null;
      if (state.online) {
        try {
          const sess = s;
          inv = await findInvites(new FirestoreRemote({ projectId: cloudConfig()!.projectId, uid: u.uid, idToken: () => sess.accessToken() }), u.email);
        } catch (e) {
          inv = null;
          patch({ gateError: gateFailure(GATE_WHERE, true, e) });
        }
      } else {
        patch({ gateError: gateFailure(GATE_WHERE, false) });
      }
      if (inv === null) { patch({ gate: 'retry' }); return; }
      if (inv.length) {
        // بيانات الجهاز التي بلا حساب لا تُعرض على مدعوّ · تُركن كما هي
        if (r === 'unbound') { parkActive(env, UNBOUND); onData(); }
        // منشأة الحساب القائمة تُعرض قبل دعوات غيره (مراجعة التثبيت #52)
        const sess = s;
        const ownOrg = await ownOrgExists(new FirestoreRemote({ projectId: cloudConfig()!.projectId, uid: u.uid, idToken: () => sess.accessToken() }), u.uid);
        patch({ invites: inv, ownOrg, gate: null });
        return;
      }
      if (r === 'unbound') {
        // للحساب منشأةٌ قائمة: بيانات الجهاز لا تُدمج فيها (تتكرر أرقامها) · يظهر الركن وحده وسببه (ثالثاً أ ١١)
        const sess2 = s;
        // تعذّر الفحص يُظهر الزر · والربط نفسه يفحص صارماً ويحجز
        const ownOrg = !(await localBindAllowed(new FirestoreRemote({ projectId: cloudConfig()!.projectId, uid: u.uid, idToken: () => sess2.accessToken() }), u.uid, ensureDeviceId(db)).catch(() => true));
        patch({ gate: 'unbound', ownOrg });
        return;
      }
      // لا دعوة: صاحب الحساب مالكٌ لمنشأته · نسخته الجديدة تسحب ما في سحابته (الانضمام: السحابة تغلب)
      enableSync(db, u.uid);
    }
    setSyncState(db, 'email', u.email);
    patch({ gate: null, gateError: null, sync: syncStatus(db) });
  } finally {
    activating = false;
    resumeSync();
  }
  syncNow();
}

/** بيانات بلا حساب على الجهاز: يربطها الداخل بحسابه بقراره */
/**
 * قفل التطبيق (#51): يؤكَّد الحساب المسجّل على الجهاز نفسه بقوقل دون مسّ الجلسة · بخروجٍ من قوقل ثم دخولٍ جديد يُفحص رمز هويته
 * (cloud/session.ts · المراجعة الشاملة · البند ٥)
 */
export async function confirmSameAccount(): Promise<AccountProof> {
  const s = getSession();
  if (!s || !state.user) return { ok: false, why: 'none' };
  return s.freshProof('lockReset');
}

/** على الجهاز حسابٌ يؤكَّد به قفل التطبيق (وإلا لا يُعرض «نسيت الرمز» ولا «تأكيد حسابي»: لا ينجحان) · يتغيّر بـsubscribeCloud */
export function accountConfirmable(): boolean {
  return !!getSession() && !!state.user;
}

/** مزوّد الحساب الذي يُؤكَّد به (لنصّ الزر والسجل والتنبيه) · null بلا ربط */
export function accountProvider(): AuthProvider['id'] | null {
  return getSession()?.id ?? null;
}

export async function bindUnboundToAccount(db: AppDB): Promise<void> {
  if (!state.user) return;
  const s = getSession(); const cfg = cloudConfig();
  if (!s || !cfg) throw new Error(t('bind.needConnection'));
  // منشأةٌ قائمة للحساب: لا دمج (تتكرر أرقام الجهاز المحلية فيها) · المراجعات الخارجية «ثالثاً أ ١١» · فحصٌ صارم ثم حجزٌ ذرّي
  // لهذا الجهاز (المتحقق المستقل: خطأ الشبكة كان يفتح الربط، وجهازان معاً كانا يربطان)
  const remote = new FirestoreRemote({ projectId: cfg.projectId, uid: state.user.uid, idToken: () => s.accessToken() });
  const dev = ensureDeviceId(db);
  let allowed: boolean;
  try { allowed = (await localBindAllowed(remote, state.user.uid, dev)) && (await claimLocalBind(remote, state.user.uid, dev)); }
  catch { throw new Error(t('bind.needConnection')); }
  if (!allowed) throw new Error(t('bind.orgHasData'));
  enableSync(db, state.user.uid);
  setSyncState(db, 'email', state.user.email);
  patch({ gate: null, sync: syncStatus(db) });
  syncNow();
}

/** أو يتركها على الجهاز بلا حساب (تُركن ولا تُمسح) ويبدأ بنسخة حسابه من السحابة */
export async function keepUnboundAside(db: AppDB): Promise<void> {
  if (!state.user) return;
  await pauseSync();
  try { parkActive(appSlotEnv(db), UNBOUND); onData(); }
  finally { resumeSync(); }
  await activateAccount(state.user);
}

/** استعادة تمّت ولم تُعتمد للسحابة بعد (جرت والمستخدم خارج حسابه) */
export function restoreAwaitingAdoption(db: AppDB): boolean {
  return getSyncState(db, 'restored_unadopted') === '1';
}

/** بعد استعادة لم يُستبدل بها ما في السحابة · تبقى المزامنة منتظرة قرار المستخدم */
export function markRestoredUnadopted(db: AppDB): void {
  setSyncState(db, 'restored_unadopted', '1');
}

/** منشأة هذا الحساب: منشأة العضوية، أو منشأته هو مالكاً */
function orgOfAccount(db: DB): string {
  return readMembership(db)?.org ?? state.user!.uid;
}

function remoteFor(): FirestoreRemote {
  const s = getSession();
  const cfg = cloudConfig();
  if (!s || !cfg || !state.user) throw new Error('سجّل الدخول بحساب قوقل أولاً');
  if (!state.online) throw new Error('لا اتصال بالإنترنت · اعتماد النسخة للسحابة يحتاج اتصالاً لقراءة ما فيها');
  const sess = s;
  if (!appDb) throw new Error('القاعدة غير جاهزة');
  return remoteOf(appDb, state.user.uid, () => sess.accessToken());
}

/** لقطة ما في السحابة · تُقرأ مرة والمزامنة متوقفة، فتخدم ضمّ القيود المرحّلة وخطة الاستبدال معاً */
export async function readCloudSnapshot(onProgress?: (m: string) => void): Promise<CloudSnapshot> {
  return readCloud(remoteFor(), onProgress, await readEpoch(remoteFor(), orgOfAccount(appDb!)));
}

export function planReplaceFromSnapshot(db: DB, snap: CloudSnapshot): CloudReplacePlan {
  return planFromSnapshot(db, snap);
}

/**
 * اعتماد القاعدة الحالية (المستعادة) حقيقةً لهذا الحساب · ثم يرفعها استئناف المزامنة.
 * الخطة المقروءة على قاعدة التجهيز قبل الاستعادة تصلح هنا (الاستعادة تنقل الملف نفسه، والتصحيح
 * يضيف صفوفاً ولا يحذف) · وبلا خطة تُقرأ من جديد على القاعدة الحالية.
 */
export async function adoptForCloud(
  db: AppDB, ready?: CloudReplacePlan, onProgress?: (m: string) => void
): Promise<{ queued: number; plan: CloudReplacePlan }> {
  const plan = ready ?? await planCloudReplace(db, remoteFor(), onProgress, await readEpoch(remoteFor(), orgOfAccount(db)));
  // عهد المسح الحالي يُقرأ قبل الاعتماد ويُسجَّل معه في معاملة واحدة (قاعدة المالك ٢٠٢٦-١٠-٠٥)
  const epoch = await readEpoch(remoteFor(), orgOfAccount(db));
  const res = adoptAsCloudTruth(db, state.user!.uid, plan, epoch);
  patch({ sync: syncStatus(db), lastError: null });
  return { ...res, plan };
}

/**
 * نسخةٌ استُعيدت خارج الحساب ثم دخل: القيود المرحّلة في السحابة وليست على الجهاز تُضمّ قبل الاعتماد
 * (القيد المرحّل لا يُحذف) · قراءة فقط هنا، والضمّ بعد التأكيد
 */
export async function planAdoptPending(
  db: AppDB, onProgress?: (m: string) => void
): Promise<{ snap: CloudSnapshot; keep: KeepPlan; plan: CloudReplacePlan }> {
  const snap = await readCloud(remoteFor(), onProgress, await readEpoch(remoteFor(), orgOfAccount(db)));
  const keep = planKeepPosted(db, { cloud: snap.docs });
  // ولا يُنزل الضمّ بنكاً ولا المحفظة تحت الصفر (القرار ٥٥ · R12-BAK-3) · يُسمّى قبل أي كتابة · والنسخة هنا مستعادةٌ تنتظر الاعتماد،
  // فالرسالة تقول إنها لم تُعتمد لا إنها لم تُستعد (مراجعة R12-BAK-3)
  const short = keepShortages(db, keep, 'adopt');
  if (short.length) throw new Error(short.join(' · '));
  return { snap, keep, plan: planFromSnapshot(db, snap) };
}

export async function adoptPendingWithKeep(
  db: AppDB, ready: { snap: CloudSnapshot; keep: KeepPlan }
): Promise<{ queued: number; kept: number; moves: number }> {
  // وحركات نقل النقد في السحابة بعد النسخة تُحمل ولو لم يُضمّ قيد (قرار المالك 2026-11-14 · R12-BAK-3): applyKeepPosted لا يكتب شيئاً
  // حين لا قيد ولا حركة
  const kept = applyKeepPosted(db, ready.keep).entries.length;
  const { queued } = await adoptForCloud(db, planFromSnapshot(db, ready.snap));
  return { queued, kept, moves: ready.keep.cashMoves };
}

/** حساب البيانات على هذا الجهاز (uid وإيميل) · آخر من دخل وارتبطت به المزامنة */
export function deviceAccount(db: DB): { uid: string; email: string } | null {
  const uid = getSyncState(db, 'uid');
  return uid ? { uid, email: getSyncState(db, 'email') ?? '' } : null;
}

/**
 * «حذف حسابي» (الدراسة أ، معتمدة · ق٠-٦: عبر مزوّد الهوية، cloud/deleteAccountFlow.ts): إثباتٌ حديث لغرض الحذف (قوقل: خروجٌ ثم دخولٌ
 * جديد للحساب نفسه كما كان · الجهاز: قفل الجهاز ثم إثبات الخادم) ثم بالترتيب · بيانات السحابة كلها (firestore.rules تأذن ساعةً بطلبٍ
 * بوقت الخادم) · نسخ التطبيق على Drive (لقوقل وحده) · الحساب عند مزوّده · ثم الجهاز (resetDeviceData) · ثم الخروج. فشل خطوةٍ يوقف ما
 * بعدها ويُبلَّغ.
 */
export async function deleteMyAccount(db: AppDB, onProgress?: (m: string) => void): Promise<void> {
  const s = getSession();
  const cfg = cloudConfig();
  const user = state.user;
  const uid = user?.uid ?? '';
  // المنشأة (وأعضاؤها ودعواتها) ثم المسار القديم · كلٌّ بنافذة حذفه
  // المحادثة (قرار المالك 2026-10-07: #2): العضو يصير «عضواً سابقاً» في رسائله · والمالك تُحذف محادثات منشأته كلها
  // عضويته في منشأة غيره إن كانت (اسمه وجواله وهويته · محاولة: عضوٌ أُزيل لا مستند له) ثم منشأته هو كاملة: الملفات والمحادثات
  // والمنشأة والمسار القديم بخطواتٍ يختبرها المحاكي كما تجري (cloudWipe.ts · ثالثاً أ ٨ · والمراجعة الخارجية ٧ · النتيجة ١٥)
  const wipeFirestore = s && cfg && user ? async () => {
    const chatS = { projectId: cfg.projectId, uid, email: user.email, idToken: () => s.accessToken() };
    const mem = readMembership(db);
    const remotes = [
      new FirestoreRemote({ projectId: cfg.projectId, uid, idToken: () => s.accessToken(), org: uid }),
      new FirestoreRemote({ projectId: cfg.projectId, uid, idToken: () => s.accessToken() }),
    ];
    const member = mem
      ? { org: mem.org, uid: mem.uid, remote: new FirestoreRemote({ projectId: cfg.projectId, uid, idToken: () => s.accessToken(), org: mem.org }) }
      : null;
    await deleteAccountCloud({ remotes, chat: chatS, org: uid, files: orgFilesTarget(uid), member }, onProgress);
  } : undefined;
  await deleteAccountFlow({
    auth: s,
    signedIn: !!user,
    online: state.online,
    t: (k) => t(k),
    progress: onProgress,
    // مزوّد الجهاز: صاحب الجهاز يفتح قفله قبل إثبات الخادم (لا نافذة دخولٍ تشهد به) · وقوقل كما كان بنافذته
    confirmHolder: async () => !(await deviceLockAvailable()) || (await askDevice()),
    pause: pauseSync,
    resume: resumeSync,
    wipeAccountCloud: wipeFirestore,
    // وبعد الخروج من Drive على هذا الجهاز (حُذفت النسخ وسُحب الإذن · ق٠-١) لا يُطلب Drive ثانيةً فيعود إذنه
    wipeDrive: async (token) => { await deleteAllAppDataFiles(driveIO, token); },
    driveRetired: driveRetired(),
    resetDevice: () => resetDeviceData(db),
    done: () => patch({ user: null, sync: syncStatus(db), lastError: null }),
  });
}

/** الخروج: الرموز وحدها تُمسح · بياناتك على الجهاز كما هي والتقاط التغييرات مستمر لحين العودة */
/**
 * الخروج: نسخة الحساب تُركن على الجهاز مقفلةً فلا يراها حساب آخر أبداً · ولا خروج ما دام شيء لم يُرفع
 * (طابور أو نسخة مستعادة لم تُعتمد)، فلا يبقى تغيير على الجهاز وحده.
 */
export async function cloudSignOut(): Promise<void> {
  const s = getSession();
  if (!s) return;
  const db = appDb;
  if (db) {
    const waiting = outboxCount(db);
    if (waiting > 0) throw new Error('لم تُرفع ' + waiting + ' تغييرات بعد · اتصل بالإنترنت ودع المزامنة تكمل ثم اخرج');
    if (getSyncState(db, 'restored_unadopted') === '1') throw new Error('على الجهاز نسخة مستعادة لم تُعتمد للسحابة · اعتمدها أولاً ثم اخرج');
  }
  await pauseSync();
  try {
    const uid = db ? activeAccount(db) : null;
    if (db && uid) { parkActive(appSlotEnv(db), uid); onData(); }
    // تذكيرات الحساب الخارج لا تبقى للحساب التالي (المراجعة الخارجية ٧ · النتيجة ٣٠)
    await cancelAllNotifications();
    await s.signOut();
    patch({ user: null, invites: null, gate: null, sync: db ? syncStatus(db) : null });
  } finally {
    resumeSync();
  }
}

/** بعد استعادة نسخة والحساب داخل · النسخة المستعادة تُنسب لحسابه فوراً فلا تبقى بلا حساب */
export function bindRestoredToCurrentAccount(db: AppDB): void {
  if (!state.user) return;
  setSyncState(db, 'uid', state.user.uid);
  setSyncState(db, 'email', state.user.email);
}

/** القاعدة الحية بعد التفريغ (wipe.ts: «الاستدعاء يعيد قراءة env.db») · على الجهاز هي نفسها مفتوحةً من جديد، فلا يُكتب في قاعدةٍ أُغلقت */
function liveAfterWipe(db: AppDB): AppDB {
  const live = appBackupEnv(db).db as AppDB;
  if (appDb === db) appDb = live;
  return live;
}

/**
 * رفض سجل النقل (403) لا يحجب فحص العضوية بعده: من أُزيل لا يقرؤه، ومستند عضويته يقرؤه (B-2) · ويُحفظ الرفض: هو مع غياب مستند العضوية
 * دليلا الإزالة (المراجعة الشاملة 2026-11-13 · R11-B2-1 · refreshMembership)
 */
function deniedAsNone(e: unknown, seen: { denied: boolean }): 'none' {
  if (e instanceof FirestoreHttpError && e.status === 403) { seen.denied = true; return 'none'; }
  throw e;
}

/** ما لم يُرفع من عمل العضو في ملفٍ صغير قبل تفريغ جهازه (B-4) · null إن لم يبقَ له شيء · وتعذّر الكتابة يرمي فلا يقع التفريغ ولا يضيع عمله */
function saveUnsynced(db: AppDB, why: ExitWhy): UnsyncedSaved | null {
  const m = readMembership(db);
  return saveUnsyncedWork(appBackupEnv(db), db, {
    reason: why, org: m?.org ?? getSyncState(db, 'org') ?? '', orgName: getSyncState(db, 'org_name'),
    uid: m?.uid ?? state.user?.uid ?? '', email: state.user?.email ?? getSyncState(db, 'email'), name: m?.profile?.name ?? '',
    deviceId: ensureDeviceId(db),
  });
}

/**
 * خروج العضو من المنشأة، أُزيل أو غادر (المراجعة الشاملة 2026-11-13 · B-4 · قرارا المالك س٩ وس١٠ تطبيقاً لقرار 2026-11-07 (٢ أ)):
 * تُحذف أولاً نسخ الجهاز التي صُنعت وهو عضو، تُعرف بما فيها لا بساعته، قبل التفريغ ومحو العضوية ووقت انضمامه (R11-B4-2) · ثم تفريغٌ بلا
 * نسخة أمان كاملة (كانت تبقى على جواله غير مشفّرة ويستعيدها من «البيانات والمساحة» بعد أن يصير جهازه «مالكاً» لحسابه)، وسببه وما حُفظ مما
 * لم يُرفع في سجل العمليات · ثم تُمحى العضوية وما يخص المنشأة فيعود الجهاز لحساب صاحبه بلا منشأة غيره، وما تعذّر حذفه من النسخ يُسجَّل
 * فيُعاد حذفه في كل دورة وإقلاع حتى يتمّ · يعيد القاعدة الحية بعده
 */
async function wipeForRemoval(db: AppDB, saved: UnsyncedSaved | null, reason: string): Promise<AppDB> {
  const since = getSyncState(db, MEMBER_SINCE_KEY);
  const org = readMembership(db)?.org ?? getSyncState(db, 'org');
  const dropped = await dropMemberBackups(appBackupEnv(db), org, since);
  await wipeLocal(db, undefined, null, reason + unsyncedAuditNote(saved));
  const live = liveAfterWipe(db);
  live.transaction(() => {
    saveMembership(live, null);
    for (const k of ['org', 'org_name', 'wipe_epoch', 'epoch_pending', 'removal_pending', 'cursor', 'moves_seen', MEMBER_SINCE_KEY, PERM_WIPE_KEY]) setSyncState(live, k, null);
    if (dropped.failed.length) noteDropPending(live, org, since);
  });
  return live;
}

/** نسخٌ تعذّر حذفها عند خروج العضو يُعاد حذفها (R11-B4-2) · دورةٌ واحدة في المرة، وفشلها لا يمسّ المزامنة */
let droppingBackups = false;
async function retryExitDrop(db: AppDB): Promise<void> {
  if (droppingBackups) return;
  droppingBackups = true;
  try { await retryDropMemberBackups(appBackupEnv(db), db); } catch { /* يُعاد في الدورة التالية */ } finally { droppingBackups = false; }
}

/**
 * أُزيلت العضوية (B-2 وB-4 · س٩): «يُفرَّغ جواله عند أول اتصال بعد حفظ ذلك التعديل وحده في ملفٍ صغير يُرسل لك، بلا خيار «أبقِ بياناتي»» ·
 * ما في طابوره ورفضته السحابة من عمله يُحفظ في الملف أولاً (وفشلُه يوقف التفريغ فيُعاد في الدورة التالية) · ثم يبقى إشعارٌ بذلك حتى يقرأه
 */
async function exitRemoved(db: AppDB): Promise<AppDB> {
  const saved = saveUnsynced(db, 'removed');
  const live = await wipeForRemoval(db, saved, t('org.removedReason', { lng: 'ar' }));
  writeExitNotice(live, { why: 'removed', count: saved?.count ?? 0, file: saved?.name ?? null, at: new Date().toISOString() });
  patch({ decision: { kind: 'removed', pending: saved?.count ?? 0 }, lastError: null });
  onData();
  return live;
}

/** إرسال ملفّ ما لم يُرفع إلى صاحب المنشأة من نافذة المشاركة (B-4) · وبلا ملفٍ لا شيء */
export async function shareUnsyncedNow(): Promise<void> {
  const db = appDb;
  const n = db ? readExitNotice(db) : null;
  if (!db || !n?.file) return;
  await shareUnsyncedFile(unsyncedPath(appBackupEnv(db), n.file), t('org.exit.shareTitle'));
}

/**
 * قرار المستخدم فيما ينتظره (state.decision) · في عهد المسح: 'keep' يُبقي بياناته وتُرفع كلها إلى المنشأة من جديد (للمالك وحده)،
 * و'wipe' تفريغٌ بأمره بنسخة أمان وسجل بسببه · وفي الإزالة والمغادرة لا قرار: فُرّغ الجهاز عند أول اتصال بلا «أبقِ بياناتي» (B-4 · س٩)،
 * و'done' أنه قرأ الإشعار فيُمحى ويُحذف ملفُّ ما لم يُرفع من الجهاز بأمره، وتُستأنف المزامنة.
 */
export async function resolveDecision(choice: 'keep' | 'wipe' | 'done', onProgress?: (m: string) => void): Promise<void> {
  if (!appDb || !state.decision) return;
  const db = appDb;
  if (state.decision.kind === 'epoch') {
    if (choice === 'done') return;
    await resolveEpoch(db, choice, () => wipeLocal(db, onProgress, undefined, 'مُسحت بيانات المنشأة من جهاز آخر · بأمر المستخدم').then(() => db));
  } else if (choice === 'done') {
    clearExitNotice(appBackupEnv(db), db);
  } else {
    return; // لا «أبقِ بياناتي» ولا تفريغ ينتظر بعد الإزالة · فُرّغ الجهاز عند أول اتصال
  }
  patch({ decision: null, sync: syncStatus(db) });
  onData();
  syncNow().catch(() => {});
}

/* ═══════════ مسح كل البيانات ═══════════ */

/**
 * تفريغ الجهاز: القاعدة والمرفقات والمصغّرات ولقطة الودجت · بنسخة أمان، ويبقى الحساب وهوية الجهاز · وsafety = null لخروج العضو من
 * المنشأة: بلا نسخة أمان (B-4 · wipeForRemoval)
 */
async function wipeLocal(db: AppDB, onProgress?: (m: string) => void, safety?: string | null, reason?: string): Promise<string> {
  return holdChat(async () => {
    const env = appBackupEnv(db);
    const path = await wipeAllData(env, onProgress, safety, reason);
    // ومعه التذكيرات المجدولة عند النظام (المراجعة الخارجية ٧ · النتيجة ٣٠) · وهو مسار الإزالة أيضاً
    await cancelAllNotifications();
    for (const d of ['thumbs', 'widget.json']) {
      try { env.fs.remove(joinPath(appDataRoot(), d)); } catch { /* غير موجود */ }
    }
    return path;
  });
}

/**
 * «امسح كل البيانات» للمالك (توجيه ٢٠٢٦-١٠-٠٤): بعده التطبيق كأنه مثبَّت جديداً على هذا الجهاز
 * وعلى كل جهاز آخر وبعد إعادة التثبيت. نسخة الأمان أولاً، ثم السحابة (عهد المسح وحذف الصفوف)، ثم الجهاز.
 * يحتاج اتصالاً ومزامنةً سابقة إلى المنشأة · وبلا إعداد سحابي (بيئة التطوير) يُمسح الجهاز وحده.
 */
export async function wipeEverything(db: AppDB, onProgress?: (m: string) => void): Promise<string> {
  const s = getSession();
  const cfg = cloudConfig();
  const user = state.user;
  const cloud = !!(s && cfg && user);
  if (cloud) {
    if (!state.online) throw new Error('المسح يحتاج اتصالاً ليصل إلى السحابة وكل الأجهزة');
    if (getSyncState(db, 'org') !== user!.uid) throw new Error('أكمل مزامنة واحدة أولاً ثم امسح');
  }
  await pauseSync();
  try {
    const env = appBackupEnv(db);
    await ensureFreeSpace(env);
    const safety = await makeSafetyBackup(env, 'pre-wipe', onProgress);
    let epoch: number | null = null;
    if (cloud) {
      const sess = s!;
      const remote = new FirestoreRemote({ projectId: cfg!.projectId, uid: user!.uid, idToken: () => sess.accessToken(), org: user!.uid });
      // الصفوف والمحادثات وملفات التخزين بخطواتٍ يختبرها المحاكي كما تجري (cloudWipe.ts · ثالثاً أ ٨ · قرار المالك #28)
      epoch = await wipeCloud({ remote, chat: { projectId: cfg!.projectId, uid: user!.uid, email: user!.email, idToken: () => sess.accessToken() },
        org: user!.uid, files: orgFilesTarget(user!.uid) }, onProgress);
    }
    await wipeLocal(db, onProgress, safety);
    if (epoch !== null) {
      setSyncState(db, 'wipe_epoch', String(epoch));
      // ما زُرع في القاعدة الجديدة (الدليل والقوالب) يُرفع إلى السحابة الفارغة
      seedOutbox(db);
    }
    patch({ sync: syncStatus(db), lastError: null });
    onData();
    return safety;
  } finally {
    resumeSync();
  }
}

/* ═══════════ المنشأة والأعضاء ═══════════ */

/** قبول دعوة: الجهاز يُفرَّغ ثم يُربط بالمنشأة عضواً ويسحب ما تجيزه صلاحيته */
export async function acceptInviteNow(db: AppDB, org: string, doc: MemberDoc): Promise<void> {
  const s = getSession();
  if (!s || !state.user) throw new Error('سجّل الدخول أولاً');
  const sess = s;
  const user = state.user;
  await pauseSync();
  try {
    // نسخة الحساب الجديدة فارغة (activateAccount) · وإن لم تكن فلا يُمسح شيء ويُرفض القبول
    // نسخته فارغة (جديدة، أو منشأة فارغة له قبل قراره) · وما فيه بيانات لا يُستبدل بعضوية
    if (hasUserData(db) || (activeAccount(db) && activeAccount(db) !== user.uid)) throw new Error('على الجهاز نسخة فيها بيانات لهذا الحساب · لا تُستبدل بعضوية');
    const remote = new FirestoreRemote({ projectId: cloudConfig()!.projectId, uid: user.uid, idToken: () => sess.accessToken() });
    const m = await acceptInvite(db, remote, org, user.uid, doc);
    bindMember(db, m, user.email, doc.orgName || null);
    patch({ invites: null, sync: syncStatus(db) });
  } finally {
    resumeSync();
  }
  syncNow();
}

/** رفض الدعوات · يكمل صاحب الحساب مالكاً لمنشأته */
export function declineInvites(db: AppDB): void {
  if (!state.user) return;
  enableSync(db, state.user.uid);
  setSyncState(db, 'email', state.user.email);
  setSyncState(db, 'email', state.user.email);
  patch({ invites: null, sync: syncStatus(db) });
  syncNow();
}

/**
 * مغادرة العضو المنشأة · تُحذف عضويته ويُفرَّغ الجهاز ويخرج · ولا مغادرة قبل رفع تغييراته · وكالإزالة (س١٠ · 2026-11-13 · B-4): لا نسخة
 * أمان كاملة، وما لم يُرفع من عمله (ما رفضته السحابة) وحده في ملفٍ صغير تُفتح نافذة إرساله إلى صاحب المنشأة، ويبقى إشعاره حتى يقرأه
 */
export async function leaveOrgNow(db: AppDB): Promise<void> {
  const m = readMembership(db);
  const s = getSession();
  if (!m || !s || !state.user) return;
  const waiting = outboxCount(db);
  if (waiting > 0) throw new Error('لم تُرفع ' + waiting + ' تغييرات بعد · اتصل بالإنترنت ودع المزامنة تكمل ثم غادر');
  const sess = s;
  await pauseSync();
  try {
    const user = state.user;
    const out: { saved: UnsyncedSaved | null; live: AppDB } = { saved: null, live: db };
    // ما لم يُرفع أولاً (وفشله يوقف كل شيء)، ثم الخروج، ثم التفريغ بلا نسخة أمان وبسببه في سجل العمليات كالإزالة (#65 · B-4)
    await leaveSafely({
      backup: async () => { out.saved = saveUnsynced(db, 'left'); return out.saved?.name ?? null; },
      leaveCloud: async () => {
        // يخرج من مجموعات المحادثة ومن دليلها قبل عضويته (قرار المالك #19)
        const cfgL = cloudConfig();
        if (cfgL) await chatLeaveOrg({ projectId: cfgL.projectId, uid: user.uid, email: user.email, idToken: () => sess.accessToken() }, m.org).catch(() => {});
        await leaveOrg(remoteOf(db, user.uid, () => sess.accessToken()), m.org, m.uid);
      },
      wipe: async (_saved, why) => { out.live = await wipeForRemoval(db, out.saved, why); },
    }, t('org.leftReason', { lng: 'ar' }));
    const saved = out.saved;
    if (saved) {
      writeExitNotice(out.live, { why: 'left', count: saved.count, file: saved.name, at: new Date().toISOString() });
      // نافذة الإرسال الآن، وتعذّرها لا يُفشل المغادرة وقد تمّت: الإشعار والملف باقيان حتى يقرأه عند دخوله التالي
      await shareUnsyncedFile(unsyncedPath(appBackupEnv(out.live), saved.name), t('org.exit.shareTitle')).catch(() => {});
    }
    await sess.signOut();
    patch({ user: null, sync: syncStatus(out.live) });
  } finally {
    resumeSync();
  }
}

function teamRemote(): { remote: FirestoreRemote; org: string } {
  const s = getSession();
  const cfg = cloudConfig();
  if (!s || !cfg || !state.user) throw new Error('سجّل الدخول أولاً');
  if (!state.online) throw new Error('إدارة الأعضاء تحتاج اتصالاً بالإنترنت');
  const sess = s;
  return { remote: new FirestoreRemote({ projectId: cfg.projectId, uid: state.user.uid, idToken: () => sess.accessToken(), org: state.user.uid }), org: state.user.uid };
}
const orgNameOf = (db: DB) => db.get<{ name: string }>('SELECT name FROM company WHERE id = 1')?.name || 'منشأة عقاري';

export async function listTeamNow() { const t = teamRemote(); return listTeam(t.remote, t.org); }
/**
 * حدّ إصدار الأعضاء (#36 · قرار المالك 2026-10-15 «٤»: «زر عندي «اشترط إصداري على الأعضاء»، بلا رفع تلقائي») · يقرؤه المالك ويرفعه
 * بزرّه وحده إلى إصداره، ولا يُخفض
 */
export async function readCompatNow(): Promise<{ live: boolean; min: number; mine: number }> {
  const t = teamRemote();
  return { ...(await readCompat(t.remote, t.org)), mine: SCHEMA_VERSION };
}
export async function raiseCompatNow(db: DB): Promise<boolean> {
  const t = teamRemote();
  const raised = await raiseCompat(t.remote, t.org);
  if (raised) logAudit(db, 'الأعضاء', 'update', 'حدّ إصدار الأعضاء', String(SCHEMA_VERSION)); // i18n-exempt: سطر سجل العمليات المخزَّن
  return raised;
}
export async function inviteMemberNow(db: DB, spec: MemberSpec) {
  const t = teamRemote();
  const doc = await sendInvite(t.remote, t.org, spec, orgNameOf(db), state.user!.email);
  logMemberAccess(db, 'invite', doc.email, null, doc);
  if (spec.profile && (spec.profile.name || spec.profile.phone)) logProfileEdit(db, doc.email, null, spec.profile);
  return doc;
}

/**
 * تعديل بيانات عضو في سجل العمليات بمنفّذه · الهوية لا تُكتب فيه (يقرؤه غير المالك والعضو) بل يُذكر
 * أنها أُدخلت أو تغيّرت أو حُذفت.
 */
function logProfileEdit(db: DB, label: string, before: MemberProfile | null, after: MemberProfile): void {
  logAudit(db, 'الأعضاء', before ? 'update' : 'create', 'بيانات عضو', label, profileForAudit(before, after), profileForAudit(after, null));
}

/** المالك يعدّل بيانات عضو */
export async function updateMemberProfileNow(db: DB, uid: string, label: string, profile: MemberProfile) {
  const t = teamRemote();
  const r = await updateMemberProfile(t.remote, t.org, uid, profile);
  logProfileEdit(db, profile.name || label, r.before, r.after);
}

/** العضو يكمل بياناته أو يعدّلها · القواعد لا تجيز له غير مفاتيحها في مستند عضويته */
export async function updateMyProfileNow(db: DB, profile: MemberProfile) {
  const m = readMembership(db);
  const s = getSession();
  const cfg = cloudConfig();
  if (!m || !s || !cfg || !state.user) throw new Error('سجّل الدخول أولاً');
  if (!state.online) throw new Error('حفظ بياناتك يحتاج اتصالاً بالإنترنت');
  const sess = s;
  const remote = new FirestoreRemote({ projectId: cfg.projectId, uid: state.user.uid, idToken: () => sess.accessToken(), org: m.org });
  const r = await updateMemberProfile(remote, m.org, m.uid, profile);
  db.transaction(() => {
    saveMembership(db, { ...m, profile });
    logProfileEdit(db, profile.name, r.before, r.after);
  });
}
export async function updateMemberNow(db: DB, uid: string, spec: MemberSpec) {
  const t = teamRemote();
  const r = await updateMember(t.remote, t.org, uid, spec, orgNameOf(db));
  logMemberAccess(db, 'grant', r.after.email, r.before, r.after);
}
/** إشراف عضو في المحادثة بإيميله (src/chat) · للمالك وحده */
export async function chatSupervisorNow(email: string): Promise<string[]> {
  const s = getSession(); const cfg = cloudConfig();
  if (!s || !cfg || !state.user || !email) return [];
  if (!state.online) throw new Error('offline');
  return supervisorOf({ projectId: cfg.projectId, uid: state.user.uid, email: state.user.email, idToken: () => s.accessToken() }, state.user.uid, email);
}
export async function setChatSupervisorNow(email: string, sections: string[]): Promise<void> {
  const s = getSession(); const cfg = cloudConfig();
  if (!s || !cfg || !state.user) { teamRemote(); return; }
  await setSupervisor({ projectId: cfg.projectId, uid: state.user.uid, email: state.user.email, idToken: () => s.accessToken() }, state.user.uid, email, sections);
}
export async function removeMemberNow(db: DB, uid: string, email = '', before: MemberDoc | null = null) {
  const t = teamRemote();
  await removeMember(t.remote, t.org, uid, email);
  logMemberAccess(db, 'remove', email, before, null);
  // يخرج من مجموعات المحادثة ودليلها وإشرافها (قرار المالك 2026-10-07: #19)
  const s = getSession(); const cfg = cloudConfig();
  // وفشله لا يُظهر الإزالة فاشلةً وقد تمّت (تحقق الدمج ف٥) · والقواعد تمنع المُزال من المحادثة بعضويته أصلاً
  if (s && cfg && state.user) {
    await chatRemoveMember({ projectId: cfg.projectId, uid: state.user.uid, email: state.user.email, idToken: () => s.accessToken() }, t.org, uid, email)
      .catch(() => {});
  }
}

/** جلسة المحادثة ومنشأتها لما يحتاج اتصالاً (الدفعات ٢ و٣) */
function chatOnline(): { db: DB; s: ChatSession; org: string } {
  const sess = getSession(); const cfg = cloudConfig(); const db = appDb;
  if (!sess || !cfg || !state.user || !db) throw new Error(t('chat.needAccount'));
  if (!state.online) throw new Error(t('chat.needOnline'));
  return { db, s: { projectId: cfg.projectId, uid: state.user.uid, email: state.user.email, idToken: () => sess.accessToken() }, org: readMembership(db)?.org ?? state.user.uid };
}
export async function chatAckNow(threadId: string, msgId: string): Promise<void> {
  const c = chatOnline(); await chatAcknowledge(c.db, c.s, c.org, threadId, msgId);
}
export async function chatEditMessageNow(threadId: string, msgId: string, body: string, tag: ChatTag | null): Promise<void> {
  const c = chatOnline(); await chatEditMessage(c.db, c.s, c.org, threadId, msgId, body, tag);
}
export async function chatTaskNow(threadId: string, msgId: string, task: ChatTask): Promise<void> {
  const c = chatOnline(); await chatSetTask(c.db, c.s, c.org, threadId, msgId, task);
}
export async function chatTaskDoneNow(threadId: string, msgId: string, done: boolean): Promise<void> {
  const c = chatOnline(); await chatSetTaskDone(c.db, c.s, c.org, threadId, msgId, done);
}
export async function chatCancelTaskNow(threadId: string, msgId: string): Promise<void> {
  const c = chatOnline(); await chatCancelTask(c.db, c.s, c.org, threadId, msgId);
}
export async function chatVoteNow(threadId: string, msgId: string, options: number[]): Promise<void> {
  const c = chatOnline(); await chatVote(c.db, c.s, c.org, threadId, msgId, options);
}
export async function chatEditsNow(threadId: string, msgId: string) {
  const c = chatOnline(); return chatEditsOf(c.s, c.org, threadId, msgId);
}

/** تثبيت رسالة · يحتاج اتصالاً (الدفعة ٢) */
export async function chatPinNow(threadId: string, msgId: string, on: boolean): Promise<void> {
  const s = getSession(); const cfg = cloudConfig(); const db = appDb;
  if (!s || !cfg || !state.user || !db) throw new Error(t('chat.needAccount'));
  if (!state.online) throw new Error(t('chat.pinOffline'));
  const org = readMembership(db)?.org ?? state.user.uid;
  await chatSetPin(db, { projectId: cfg.projectId, uid: state.user.uid, email: state.user.email, idToken: () => s.accessToken() }, org, threadId, msgId, on);
}
/** تعديل المجموعة: الاسم والإعدادات والأعضاء والمسؤولون (#19 و2026-10-08T05:31Z) · كلٌّ بصلاحيته */
export async function chatEditGroupNow(threadId: string, change: GroupChange): Promise<void> {
  const s = getSession(); const cfg = cloudConfig(); const db = appDb;
  if (!s || !cfg || !state.user || !db) { teamRemote(); return; }
  if (!state.online) teamRemote();
  const org = readMembership(db)?.org ?? state.user.uid;
  await chatEditGroup(db, { projectId: cfg.projectId, uid: state.user.uid, email: state.user.email, idToken: () => s.accessToken() }, org, threadId, change);
}
/* ─── مراجعة المالك محادثةً بسبب، وانضمامه إلى مجموعة (قرارا المالك 2026-10-08T04:11Z) · للمالك وحده، وتحتاج اتصالاً ─── */

function ownerChatSession(): { s: ChatSession; db: DB } {
  const t = teamRemote(); // يشترط الدخول والاتصال
  const sess = getSession()!;
  const cfg = cloudConfig()!;
  const db = appDb;
  if (!db || readMembership(db)) throw new Error('chat: owner only');
  return { s: { projectId: cfg.projectId, uid: t.org, email: state.user!.email, idToken: () => sess.accessToken() }, db };
}
export async function chatReviewCandidatesNow(): Promise<RemoteThread[]> {
  const { s } = ownerChatSession();
  return chatReviewCandidates(s, s.uid);
}
export async function chatOpenReviewNow(chatId: string, reason: string, title: string): Promise<RemoteMessage[]> {
  const { s, db } = ownerChatSession();
  return chatOpenReview(db, s, s.uid, chatId, reason, title);
}
export async function chatCloseReviewNow(chatId: string): Promise<void> {
  const { s } = ownerChatSession();
  await chatCloseReview(s, s.uid, chatId);
}
export async function chatJoinGroupNow(t: RemoteThread): Promise<void> {
  const { s, db } = ownerChatSession();
  await chatJoinGroup(db, s, s.uid, t, chatMe(db, s, orgNameOf(db)).name);
}
export async function revokeInviteNow(db: DB, email: string, before: MemberDoc | null = null) {
  const t = teamRemote();
  await revokeInvite(t.remote, t.org, email);
  logMemberAccess(db, 'revoke', email, before, null);
}

/* ═══════════ Google Drive ═══════════ */

const driveIO: DriveIO = {
  fetch: (...a) => fetch(...a),
  // مهام النقل الأصلية بتقدّمها وإلغائها (توجيه المالك ٢٠٢٦-١٠-٠٧: النسبة والحجم وزر الإلغاء)
  async putFile(url, path, headers, onBytes, signal) {
    throwIfCancelled(signal);
    const task = LegacyFS.createUploadTask(url, new File(path).uri, {
      httpMethod: 'PUT', uploadType: LegacyFS.FileSystemUploadType.BINARY_CONTENT, headers,
    }, (p) => onBytes?.(p.totalBytesSent, p.totalBytesExpectedToSend));
    const off = signal?.onCancel(() => { task.cancelAsync().catch(() => {}); });
    try {
      const r = await task.uploadAsync();
      throwIfCancelled(signal);
      if (!r) throw new CancelledError();
      return { status: r.status, body: r.body };
    } finally { off?.(); }
  },
  async downloadFile(url, path, headers, onBytes, signal) {
    throwIfCancelled(signal);
    const task = LegacyFS.createDownloadResumable(url, new File(path).uri, { headers },
      (p) => onBytes?.(p.totalBytesWritten, p.totalBytesExpectedToWrite));
    const off = signal?.onCancel(() => { task.cancelAsync().catch(() => {}); });
    try {
      const r = await task.downloadAsync();
      throwIfCancelled(signal);
      if (!r) throw new CancelledError();
      return { status: r.status };
    } finally { off?.(); }
  },
  async sha256OfFile(path) { return expoHasher(new File(path).bytesSync()); },
  sizeOf(path) { return new File(path).size ?? 0; },
};

async function driveToken(): Promise<string> {
  const s = getSession();
  if (!s || !state.user || !s.driveToken) throw new Error('سجّل الدخول بحساب قوقل أولاً');
  return s.driveToken();
}

/*
 * النسخ الجديدة لا تُرفع إلى Drive (ق٠-١ · قرار المالك «مابي التطبيق يرتبط بقوقل»): أُزيل زرّ «نسخ إلى Google Drive» فلا يناديه شيء،
 * وتُحفظ النسخ في المجلد الذي يختاره المستخدم (backupFolder.ts) · ويبقى الرفع أدناه بلا نداءٍ مع اختباراته حتى خطوة إزالة شاشة Drive،
 * بعد أن يُخرج المالك نسخه ويحذفها (driveExit.ts).
 */
/** نسخة جديدة تجتاز كل تحققات الإنشاء ثم تُرفع وتُطابق بصمتها على Drive */
export async function backupToDrive(db: AppDB, onProgress?: ProgressFn, signal?: CancelSignal): Promise<DriveBackup> {
  const env = appBackupEnv(db);
  const name = `عقاري · نسخة · ${toLocalISODate(new Date())}.aqbk`;
  const out = joinPath(env.tmpDir, 'drive-' + Date.now() + '.aqbk');
  // الملفات في الخادم: نسخة Drive للبيانات وقائمة الملفات وبصماتها، ومعها ما لم يُرفع بعد · فتصير صغيرة وسريعة
  const manifest = await createBackup(env, out, onProgress, { signal, dataOnly: filesCloudOn() });
  try {
    // نسخة Drive مشفّرة دائماً بمفتاح الاسترداد (التوجيه الرابع ٤ · ٣) · وبلا مفتاحٍ أو تعذّرت قراءته: لا رفع
    // سرّ الحساب الداخل لا سرّ الجهاز (المدقق الخارجي D١)
    const secret = await backupSecretForSealing(getSyncState(db, 'uid'));
    await sealBackupFile(env, out, secret, onProgress);
    throwIfCancelled(signal);
    const token = await driveToken();
    const meta = { encrypted: true, notes: !!manifest.notes?.length, onProgress, signal };
    const b = await uploadBackupToDrive(driveIO, token, out, name, meta);
    // ونسخةٌ في المجلد الظاهر (التوجيه الرابع ٤ · ٣) · حسابٌ دخل قبل نطاقه يُسأل عنه مرةً ثم يُعاد الرفع · وتعذّرها بعد أن رُفعت المخفية
    // وطابقت لا يُعلن فشل النسخ كله (المدقق الخارجي D٤: كان يقال «تعذّر النسخ» والنسخة في Drive، ومن رفض النطاق لا تنجح له نسخةٌ أبداً)،
    // بل يُذكر للمستخدم مع النجاح
    try {
      throwIfCancelled(signal);
      try {
        await uploadVisibleCopy(driveIO, token, out, name, meta);
      } catch (e) {
        if (!(e instanceof DriveError) || e.status !== 403) throw e;
        await whilePrompting(() => GoogleSignin.addScopes({ scopes: [DRIVE_FILE_SCOPE] }));
        await uploadVisibleCopy(driveIO, await driveToken(), out, name, meta);
      }
    } catch (e) {
      const m = e instanceof Error ? e.message : '';
      return { ...b, visibleFailed: isCancelled(e) ? t('drive.visibleCancelled') : (/[؀-ۿ]/.test(m) ? m : t('drive.visibleFailed')) };
    }
    return b;
  } finally {
    try { env.fs.remove(out); } catch { /* يكنسه الإقلاع */ }
  }
}

export async function listBackupsOnDrive(): Promise<DriveBackup[]> {
  return listDriveBackups(driveIO, await driveToken());
}

/**
 * تنزيل نسخة ومطابقة بصمتها ثم تجهيز الاستعادة بالمسار المحلي نفسه (prepareRestore):
 * الفك والبصمات والفحص الدلالي والملخص · والتنفيذ بعدها هو تنفيذ الاستعادة المحلية حرفاً بحرف.
 */
export async function prepareRestoreFromDrive(
  db: AppDB, b: DriveBackup, onProgress?: ProgressFn, opts?: PrepareOptions
): Promise<{ env: BackupEnv; plan: RestorePlan; archiveTmp: string }> {
  const env = appBackupEnv(db);
  // القرص يسع العملية قبل أن يبدأ التنزيل · كما في الاستعادة من ملف
  await ensureFreeSpace(env);
  env.fs.mkdirp(env.tmpDir);
  const archiveTmp = joinPath(env.tmpDir, 'restore-input.aqbk');
  try {
    await downloadBackupFromDrive(driveIO, await driveToken(), b, archiveTmp, { onProgress, signal: opts?.signal });
    const plan = await prepareRestore(env, archiveTmp, onProgress, opts);
    return { env, plan, archiveTmp };
  } catch (e) {
    // تنزيلٌ أُلغي أو انقطع أو لم تطابق بصمته: لا يبقى منه شيء
    try { env.fs.remove(archiveTmp); } catch { /* يكنسه الإقلاع */ }
    throw e;
  }
}

/* ═══════════ الخروج من Drive (ق٠-١ · F-الاستقلال-عن-قوقل ٧.٤) ═══════════ */

/** سجل الخروج على هذا الجهاز: ما خرج من نسخ Drive إلى المجلد، ووقت انتهاء الخروج (حُذفت وسُحب الإذن) */
const exitFile = () => new File(Paths.document, 'drive-exit.json');
function loadExit(): DriveExitState {
  try {
    const f = exitFile();
    if (!f.exists) return emptyExitState();
    const j = JSON.parse(f.textSync()) as Partial<DriveExitState>;
    return { exported: j.exported && typeof j.exported === 'object' ? j.exported : {}, ...(j.retiredAt ? { retiredAt: j.retiredAt } : {}) };
  } catch { return emptyExitState(); }
}
function storeExit(st: DriveExitState): void {
  const f = exitFile();
  if (!f.exists) f.create();
  f.write(JSON.stringify(st));
}

/** انتهى الخروج من Drive على هذا الجهاز: لا شاشة، ولا نطاق Drive في الدخول، و«حذف حسابي» لا يطلب Drive */
export function driveRetired(): boolean { return !!loadExit().retiredAt; }

function googleConfig(webClientId: string) {
  const withDrive = { webClientId, scopes: [DRIVE_SCOPE, DRIVE_FILE_SCOPE], offlineAccess: false };
  return driveRetired() ? { ...withDrive, scopes: [] } : withDrive;
}

function exitDeps(db: AppDB): DriveExitDeps {
  const env = appBackupEnv(db);
  return {
    io: driveIO,
    token: driveToken,
    tmpPath: (b) => { env.fs.mkdirp(env.tmpDir); return joinPath(env.tmpDir, 'drive-exit-' + b.id.replace(/[^A-Za-z0-9_-]/g, '') + '.aqbk'); },
    removeTmp: (p) => { try { env.fs.remove(p); } catch { /* يكنسه الإقلاع */ } },
    // مطابقةٌ في المجلد ببصمة Drive نفسها (التي طابقها التنزيل)
    save: async (p, b) => (await writeToBackupFolder(p, b.name, { size: driveIO.sizeOf(p), sha256: b.sha256, hasher: expoHasher })).name,
    load: loadExit,
    store: storeExit,
    revoke: async () => {
      await GoogleSignin.revokeAccess();
      const cfg = cloudConfig();
      if (cfg) GoogleSignin.configure({ webClientId: cfg.webClientId, scopes: [], offlineAccess: false });
    },
  };
}

/** شاشة «نسخك على Google Drive»: النسخ وما يظهر من أزرارها */
export async function driveExitStatus(triedExport = false) {
  const list = await listDriveBackups(driveIO, await driveToken());
  return { list, view: driveExitView(list, loadExit(), { folder: !!backupFolder(), triedExport }) };
}

/** «نزّل النسخ إلى المجلد» */
export async function exportDriveBackupsNow(db: AppDB, onProgress?: ProgressFn, signal?: CancelSignal): Promise<ExportReport> {
  return exportDriveBackups(exitDeps(db), { onProgress, signal });
}

/** «احذف نسخ عقاري من Drive» ثم سحب الإذن · unexportedConfirmed: عدد ما لم يخرج كما أكّده المستخدم */
export async function deleteDriveBackupsNow(db: AppDB, unexportedConfirmed?: number, onProgress?: ProgressFn): Promise<{ deleted: number }> {
  return deleteDriveBackups(exitDeps(db), { unexportedConfirmed, onProgress });
}

/**
 * مصدر رقم الفاتورة الضريبية (invoiceIssue.ts) · جهازٌ يزامن يأخذه من عدّاد السحابة، وبلا اتصال أو جلسة
 * يُرفض الطلب فتبقى الفاتورة مسودةً بانتظار الإصدار · وجهازٌ لا يزامن: null فيُرقِّم من تسلسله.
 */
function invoiceSource(db: DB): InvoiceNumberSource | null {
  if (!getSyncState(db, 'uid')) return null;
  const s = getSession();
  if (!state.online || !s || !state.user || !cloudConfig()) {
    return { takeInvoiceSeq: () => Promise.reject(new Error('لا اتصال')) };
  }
  const sess = s;
  return remoteOf(db, state.user.uid, () => sess.accessToken());
}

/** حفظ فاتورة من الشاشة · الإصدار برقم العدّاد، وبلا اتصال مسودةٌ تصدر عند عودته */
export function saveInvoiceNow(db: DB, input: InvoiceInput, status: 'مسودة' | 'مستحقة', existingId?: string): Promise<IssueResult> {
  return saveInvoiceIssued(db, invoiceSource(db), input, status, existingId);
}

/** إشعار دائن على فاتورة من الشاشة · برقم العدّاد (#30) */
export function issueCreditNoteNow(db: DB, invoiceId: string, input: CreditNoteInput): Promise<string> {
  return issueCreditNote(db, invoiceSource(db), invoiceId, input);
}

/** تغيير حالة فاتورة من الشاشة · الخروج من المسودة يأخذ رقم العدّاد */
export function setInvoiceStatusNow(db: DB, id: string, status: 'مسودة' | 'مستحقة' | 'متأخرة'): Promise<IssueResult> {
  return setInvoiceStatusIssued(db, invoiceSource(db), id, status);
}

/* ═══════════ الملفات في الخادم · النموذج المختلط (قرار المالك ٢٠٢٦-١٠-٠٧) ═══════════ */

/** نقل ملفات Storage على الجهاز · مهام النقل الأصلية بتقدّمها وإلغائها */
const storageIO: StorageIO = {
  fetch: (...a) => fetch(...a),
  async sendFile(url, path, method, headers, onBytes, signal) {
    throwIfCancelled(signal);
    const task = LegacyFS.createUploadTask(url, new File(path).uri, {
      httpMethod: method, uploadType: LegacyFS.FileSystemUploadType.BINARY_CONTENT, headers,
    }, (p) => onBytes?.(p.totalBytesSent, p.totalBytesExpectedToSend));
    const off = signal?.onCancel(() => { task.cancelAsync().catch(() => {}); });
    try {
      const r = await task.uploadAsync();
      throwIfCancelled(signal);
      if (!r) throw new CancelledError();
      return { status: r.status, body: r.body };
    } finally { off?.(); }
  },
  async downloadFile(url, path, headers, onBytes, signal) {
    throwIfCancelled(signal);
    const task = LegacyFS.createDownloadResumable(url, new File(path).uri, { headers },
      (p) => onBytes?.(p.totalBytesWritten, p.totalBytesExpectedToWrite));
    const off = signal?.onCancel(() => { task.cancelAsync().catch(() => {}); });
    try {
      const r = await task.downloadAsync();
      throwIfCancelled(signal);
      if (!r) throw new CancelledError();
      return { status: r.status };
    } finally { off?.(); }
  },
  async md5OfFile(path) { return expoMd5Base64(new File(path).bytesSync()); },
  sizeOf(path) { return new File(path).size ?? 0; },
};

/** هل تعمل الملفات في الخادم على هذا الإصدار · مطفأة حتى تُنشأ الحاوية (config.ts) */
export const filesCloudOn = (): boolean => !!filesCloudConfig();

/** الاتصال بملفات المنشأة · null بلا تخزين أو بلا دخول أو قبل الانتقال إلى المنشأة */
function filesRemote(db: DB): FilesRemote | null {
  const fc = filesCloudConfig();
  const s = getSession();
  if (!fc || !s || !state.user) return null;
  const org = readMembership(db)?.org ?? (getSyncState(db, 'org') === state.user.uid ? state.user.uid : null);
  if (!org) return null;
  const sess = s;
  return { io: storageIO, target: { base: fc.base, bucket: fc.bucket, org, idToken: () => sess.accessToken() }, access: readAccess(db) };
}

const cacheLimitOf = (db: DB) => Number(getSetting(db, 'fileCacheMb') || 500) * 1024 * 1024;

/** رفع الملفات المنتظرة في الخلفية بعد كل مزامنة · طابورها مستقل فلا يحبس البيانات، والفشل يُعاد لاحقاً */
let pumping = false;
async function pumpFilesInBackground(db: DB, dataChanged = false): Promise<void> {
  const remote = filesRemote(db);
  if (!remote || pumping || !state.online) return;
  pumping = true;
  try {
    const env = appFilesEnv(db);
    // صورٌ قائمة قبل المصغّرات الخفيفة: تُولَّد مصغّرتها قبل رفعها فيراها الجهاز الآخر قبل التنزيل
    for (const r of db.all<{ sha256: string; ext: string; mime: string }>(
      `SELECT DISTINCT a.sha256, b.ext, a.mime FROM attachments a JOIN blobs b ON b.sha256 = a.sha256
       JOIN file_cache f ON f.sha256 = a.sha256 WHERE f.uploaded = 0 AND a.thumb IS NULL AND a.deleted_at IS NULL`)) {
      const t = await env.thumbnailer?.(joinPath(env.attachmentsDir, r.sha256 + '.' + r.ext), r.ext, r.mime ?? '');
      if (t) db.run(`UPDATE attachments SET thumb = ? WHERE sha256 = ? AND thumb IS NULL`, [t, r.sha256]);
    }
    await pumpUploads(env, remote);
    // جهاز المالك بعد دورةٍ سحبت كل ما في الحساب: حذف ما لا صفّ له وإعادة كتابة الرموز (المراجعة الخارجية ٧ · النتيجة ١٣)
    if (remote.access.owner) await reconcileOwnerFiles(db, remote, { dataChanged });
  } catch { /* يُعاد في الدورة التالية */ } finally { pumping = false; }
}

/**
 * مسار ملفٍ للفتح · يُنزَّل من الخادم إن لم يكن على الجهاز ثم يُطابَق ببصمته ويبقى في الذاكرة المؤقتة ·
 * وبلا اتصال أو بلا تخزين يُرمى بسببٍ يُعرض.
 */
export async function openFileNow(db: DB, sha256: string, ext: string, onProgress?: ProgressFn, signal?: CancelSignal): Promise<string> {
  return ensureLocal(appFilesEnv(db), filesRemote(db), sha256, ext,
    { onProgress, signal, online: state.online, cacheLimit: cacheLimitOf(db) });
}

/** النسخة الكاملة بالملفات: كل ملفٍ في الخادم وحده يُنزَّل أولاً · ويعيد عدد ما نُزّل */
export async function downloadAllFiles(db: DB, onProgress?: ProgressFn, signal?: CancelSignal): Promise<number> {
  const env = appFilesEnv(db);
  const missing = liveBlobs(db).filter((b) => fileState(env, b.sha256, b.ext) === 'remote');
  if (!missing.length) return 0;
  const remote = filesRemote(db);
  if (!remote || !state.online) throw new Error(missing.length + ' ملفاً في الخادم لم يُنزَّل على هذا الجهاز · النسخة الكاملة تحتاج اتصالاً لتنزيلها');
  const total = missing.reduce((n, b) => n + Number(b.size_bytes), 0);
  let done = 0;
  for (const b of missing) {
    await ensureLocal(env, remote, b.sha256, b.ext, {
      signal, online: true,
      onProgress: (_m, i) => onProgress?.('جاري تنزيل الملفات للنسخة الكاملة', { done: done + (i && i.unit === 'bytes' ? i.done : 0), total, unit: 'bytes' }),
    });
    done += Number(b.size_bytes);
  }
  return missing.length;
}

/** حال الذاكرة المؤقتة للإعدادات */
export const fileCacheUsage = (db: DB) => cacheUsage(db);
/** «تفريغ الذاكرة المؤقتة» · ما لم يُرفع يبقى */
export const clearFileCacheNow = (db: DB) => clearCache(appFilesEnv(db));

/** المسح الشامل وحذف الحساب: ملفات المنشأة في الخادم تُحذف مع صفوفها · المالك وحده */
/** هدف ملفات المنشأة في التخزين · null بلا تخزين ملفات أو بلا جلسة */
function orgFilesTarget(org: string): CloudFiles | null {
  const fc = filesCloudConfig();
  const s = getSession();
  if (!fc || !s) return null;
  const sess = s;
  return { io: storageIO, t: { base: fc.base, bucket: fc.bucket, org, idToken: () => sess.accessToken() } };
}
