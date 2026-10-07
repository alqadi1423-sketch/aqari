/**
 * طبقة الربط على الجهاز · تربط المنطق الخالص (src/cloud و src/sync) بوحدات الجهاز:
 * Google Sign-In الأصلي، المخزن الآمن، شبكة الجهاز، ونقل الملفات من القرص وإليه.
 *
 * التطبيق يعمل كاملاً بلا هذا كله: لا دخول = لا مزامنة ولا Drive، والقاعدة المحلية كما هي.
 * والمزامنة تجري وحدها: عند الإقلاع، وعند عودة الاتصال، وعند العودة إلى التطبيق، وكل دقيقة
 * ما دام التطبيق ظاهراً · ولا تجري بلا اتصال أو بلا دخول، ولا تجريان معاً.
 */
import { AppState } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import * as Network from 'expo-network';
import * as LegacyFS from 'expo-file-system/legacy';
import { File } from 'expo-file-system';
import { GoogleSignin, isSuccessResponse } from '@react-native-google-signin/google-signin';
import type { AppDB } from '../db/expoAdapter';
import { cloudConfig, filesCloudConfig, DRIVE_SCOPE } from '../cloud/config';
import { listObjects, deleteObject, filesPrefix, type StorageIO } from '../cloud/storage';
import { pumpUploads, ensureLocal, fileState, cacheUsage, clearCache, type FilesRemote } from '../files/cloudFiles';
import { liveBlobs } from '../files/store';
import { appFilesEnv } from './filesEnv';
import { getSetting } from '../repos/settings';
import { signInWithGoogleIdToken, refreshIdToken, deleteFirebaseAccount } from '../cloud/authRest';
import { createSession, type Session, type SessionUser } from '../cloud/session';
import { FirestoreRemote } from '../cloud/firestore';
import { listDriveBackups, uploadBackupToDrive, downloadBackupFromDrive, deleteAllAppDataFiles, type DriveBackup, type DriveIO } from '../cloud/drive';
import { resetDeviceData } from './deviceReset';
import { hasUserData } from '../domain/backup/upgrade';
import {
  enableSync, syncOnce, syncStatus, setSyncState, getSyncState, planCloudReplace, adoptAsCloudTruth, readCloud, planFromSnapshot, syncBackoffUntil,
  type SyncStatus, type CloudReplacePlan, type CloudSnapshot,
} from '../sync/engine';
import type { DB } from '../db/adapter';
import { ensureDeviceId } from '../db/seed';
import { expoHasher, expoMd5Base64 } from '../files/expoFs';
import { joinPath } from '../files/fsAdapter';
import { createBackup, ensureFreeSpace } from '../domain/backup/create';
import { prepareRestore, type RestorePlan, type PrepareOptions } from '../domain/backup/restore';
import type { BackupEnv } from '../domain/backup/types';
import { planKeepPosted, applyKeepPosted, type KeepPlan } from '../domain/backup/keepPosted';
import { toLocalISODate } from '../domain/dates';
import { appBackupEnv } from './backupService';
import { getBackupPassword } from './backupPassword';
import { sealBackupFile } from '../domain/backup/seal';
import { SYNC_TABLES } from '../db/syncTables';
import { memberTokens, fullReadTables } from '../sync/acl';
import { setCapture, outboxCount, seedOutbox, setFilesSync } from '../sync/engine';
import { autoDepreciate } from '../domain/assets/auto';
import { syncLanguageWithAccount } from '../i18n/device';
import { runChatSync, setSupervisor, supervisorOf } from '../chat';
import { getCloudLang, putCloudLang } from '../cloud/userPrefs';
import { today } from '../domain/dates';
import { wipeAllData } from '../domain/wipe';
import { makeSafetyBackup } from '../domain/backup/create';
import { appDataRoot } from '../files/expoFs';
import { switchTo, parkActive, activeAccount, UNBOUND } from './accountSlots';
import { appSlotEnv } from './slotsApp';
import { readAccess, readMembership, saveMembership, type Membership } from './access';
import {
  moveOwnerToOrg, refreshMembership, wipeOrgCloud, checkEpoch, pendingEpoch, resolveEpoch, readEpoch, findInvites, acceptInvite, leaveOrg, listTeam, sendInvite, updateMember, removeMember, revokeInvite,
  updateMemberProfile, publishUnitMoves, checkUnitMoves, type MemberDoc, type MemberSpec,
} from './org';
import type { MemberProfile } from '../domain/access/profile';
import { logAudit } from '../domain/audit';
import { throwIfCancelled, CancelledError, type CancelSignal, type ProgressFn } from '../domain/progress';
import { saveInvoiceIssued, setInvoiceStatusIssued, issuePendingInvoices, type InvoiceNumberSource, type IssueResult } from '../domain/invoiceIssue';
import type { InvoiceInput } from '../domain/invoices';

/* ═══════════ الجلسة ═══════════ */

let session: Session | null = null;

function getSession(): Session | null {
  const cfg = cloudConfig();
  if (!cfg) return null;
  if (session) return session;
  GoogleSignin.configure({ webClientId: cfg.webClientId, scopes: [DRIVE_SCOPE], offlineAccess: false });
  const authOpts = { apiKey: cfg.apiKey };
  session = createSession({
    google: {
      async signIn() {
        await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
        const res = await GoogleSignin.signIn();
        if (!isSuccessResponse(res) || !res.data.idToken) return null;
        return { idToken: res.data.idToken, email: res.data.user.email };
      },
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
  /**
   * ما تنتظره بوابة الدخول قبل فتح التطبيق: 'retry' تعذّر التحقق من الدعوات (يلزم اتصال) ·
   * 'unbound' على الجهاز بيانات بلا حساب ينتظر قرار الداخل فيها · 'switching' تُفتح نسخة الحساب
   */
  gate: 'retry' | 'unbound' | 'switching' | null;
  /**
   * ما ينتظر قرار المستخدم ولا يُنفَّذ بدونه (قاعدة المالك ٢٠٢٦-١٠-٠٥): 'epoch' مُسحت المنشأة من جهاز آخر
   * وعلى هذا الجهاز بيانات · 'removed' أُزيلت عضويته وفي طابوره ما لم يُرفع. والمزامنة متوقفة حتى يقرر.
   */
  decision: { kind: 'epoch' | 'removed'; pending: number } | null;
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
function remoteOf(db: DB, uid: string, idToken: () => Promise<string>, legacy = false): FirestoreRemote {
  const cfg = cloudConfig()!;
  const m = readMembership(db);
  const tables = SYNC_TABLES.map((t) => t.name);
  if (m && !legacy) {
    return new FirestoreRemote({
      projectId: cfg.projectId, uid, idToken, org: m.org,
      memberTokens: () => memberTokens(readAccess(db)),
      fullReadTables: () => fullReadTables(readAccess(db), tables),
      access: () => readAccess(db),
    });
  }
  if (!legacy && getSyncState(db, 'org') === uid) {
    return new FirestoreRemote({ projectId: cfg.projectId, uid, idToken, org: uid, access: () => readAccess(db) });
  }
  return new FirestoreRemote({ projectId: cfg.projectId, uid, idToken });
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
export async function pauseSync(): Promise<void> {
  paused = true;
  while (running) await new Promise((r) => setTimeout(r, 200));
}
export function resumeSync(): void {
  paused = false;
}

export async function syncNow(): Promise<void> {
  const s = getSession();
  const db = appDb;
  const cfg = cloudConfig();
  if (!s || !db || !cfg || running || paused || !state.user || !state.online) return;
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
  // رفضٌ متكرر من الخادم (حصة أو انشغال) · تُؤجَّل الدورات ثم تُستأنف من الطابور نفسه
  if (syncBackoffUntil(db)) return;
  running = true;
  patch({ syncing: true, lastError: null });
  try {
    // القاعدة قد تكون استُبدلت باستعادة: بلا حالة مزامنة أو بحساب آخر أو بالتقاط متوقف ·
    // enableSync لا يفعل شيئاً للحساب نفسه سوى تشغيل الالتقاط، ولغيره ينضمّ من جديد
    const uid = state.user.uid;
    const idToken = () => s.idToken();
    // لغة المستخدم تتبعه على أجهزته وتُزامَن مع حسابه (قرار المالك ٢٠٢٦-١٠-٠٧) · فشلها لا يعطّل المزامنة
    const prefsAt = { projectId: cfg.projectId, uid, idToken };
    syncLanguageWithAccount(uid, { get: () => getCloudLang(prefsAt), put: (c) => putCloudLang(prefsAt, c) }).catch(() => {});
    // صفوف المرفقات تُزامَن حين يعمل تخزين الملفات وحده (النموذج المختلط) · وأول تشغيل يرفعها كلها
    setFilesSync(db, filesCloudOn());
    const member = readMembership(db);
    if (!member) {
      enableSync(db, uid);
      // المالك ينتقل إلى منشأته مرة (صلاحيات الأقسام) · حروف أجهزته تنتقل كما هي
      await moveOwnerToOrg(db, remoteOf(db, uid, idToken, true), new FirestoreRemote({ projectId: cfg.projectId, uid, idToken, org: uid }), uid);
    }
    // عهد المسح: مُسحت المنشأة من جهاز آخر وعلى هذا الجهاز بيانات ← يُسأل المستخدم ولا يُفرَّغ، والمزامنة
    // متوقفة حتى يقرر (قاعدة المالك ٢٠٢٦-١٠-٠٥) · وما ينتظر قراراً يبقى كذلك في الدورات التالية
    const org = member?.org ?? (getSyncState(db, 'org') === uid ? uid : null);
    if (getSyncState(db, 'removal_pending') === '1') { patch({ decision: { kind: 'removed', pending: outboxCount(db) } }); return; }
    if (org) {
      const act = pendingEpoch(db) !== null ? 'ask' : await checkEpoch(db, remoteOf(db, uid, idToken), org);
      if (act === 'ask') { patch({ decision: { kind: 'epoch', pending: outboxCount(db) } }); return; }
    }
    patch({ decision: null });
    // الشاشات تتحدث بما وصل أثناء التطبيق لا بعده كله · أول سحب يظهر تدريجياً (أعطال ٢٠٢٦-١٠-٠٥)
    const rep = await syncOnce(db, remoteOf(db, uid, idToken), ensureDeviceId(db), (msg) => patch({ progress: msg }), { onApplied: () => onData() });
    setSyncState(db, 'last_error', null);
    if (rep.applied || rep.conflicts) onData();
    // الفواتير التي طُلب إصدارها بلا اتصال تصدر الآن برقمها من العدّاد (قرار المالك ٢٠٢٦-١٠-٠٥)
    if (await issuePendingInvoices(db, remoteOf(db, uid, idToken))) onData();
    // الإهلاك الشهري الآلي على جهاز المالك بعد دورةٍ لم يبقَ بعدها ما ينتظر الرفع (موجز الأصول §٣ب)
    if (!member && autoDepreciate(db, today(), { owner: true, afterSync: true })) onData();
    // الملفات الجديدة تُرفع في الخلفية بعد البيانات · ولا تُنتظر
    pumpFilesInBackground(db).catch(() => {});
    // المالك ينشر نقل الوحدات بعد رفع صفوفها بوسمها الجديد (ملاحظة المالك على ٤.١٢)
    if (!member && org === uid) await publishUnitMoves(db, remoteOf(db, uid, idToken), org);
    if (member) {
      // العضوية في الخادم: أُزيلت فيُفرَّغ الجهاز · تغيّرت فيُعاد السحب من أوله بصلاحيته الجديدة،
      // وكذلك إن نُقلت وحدةٌ من عقاراته إلى عقار ليس له
      const moved = await checkUnitMoves(db, remoteOf(db, uid, idToken));
      const r0 = await refreshMembership(db, remoteOf(db, uid, idToken));
      const r = r0 === 'same' && moved === 'lost' ? 'changed' : r0;
      // لا تفريغ وفي الطابور ما لم يُرفع (قاعدة المالك ٢٠٢٦-١٠-٠٥): المُزال يُسأل، وتغيّر الصلاحية ينتظر الرفع
      const queued = outboxCount(db);
      if (r === 'removed') {
        if (queued > 0) {
          setSyncState(db, 'removal_pending', '1');
          patch({ decision: { kind: 'removed', pending: queued } });
        } else {
          await wipeForRemoval(db as AppDB);
          patch({ lastError: 'أُزيلت عضويتك من المنشأة · فُرّغ هذا الجهاز من بياناتها بعد نسخة أمان' });
          onData();
        }
      } else if (r === 'changed' && queued === 0) {
        const next = readMembership(db)!;
        await wipeLocal(db as AppDB, undefined, undefined, moved === 'lost' ? 'نُقلت وحدةٌ من عقاراتك إلى عقار ليس لك' : 'تغيّرت صلاحيتك في المنشأة');
        bindMember(db, next, state.user.email, getSyncState(db, 'org_name'));
        onData();
      }
    }
  } catch (e) {
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

/** دورة مزامنة للمحادثة وحدها · تستدعيها شاشتها أيضاً · بلا جلسة أو اتصال لا تفعل شيئاً */
export async function chatSyncNow(): Promise<void> {
  const s = getSession();
  const db = appDb;
  const cfg = cloudConfig();
  const u = state.user;
  if (!s || !db || !cfg || !u || !state.online) return;
  if (activeAccount(db) !== u.uid) return;
  await runChatSync(db, { projectId: cfg.projectId, uid: u.uid, email: u.email, idToken: () => s.idToken() });
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
  patch(activeAccount(db) === u.uid ? { user: u, invites: null } : { user: u, gate: 'switching', invites: null });
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
        const inv = await findInvites(new FirestoreRemote({ projectId: cloudConfig()!.projectId, uid: u.uid, idToken: () => sess.idToken() }), u.email);
        if (inv.length) { patch({ invites: inv, gate: null }); return; }
      } catch { /* يكمل بنسخته */ }
    }
    if (fresh) {
      // نسخة جديدة أو بيانات بلا حساب · الدعوات أولاً
      let inv: Array<{ org: string; doc: MemberDoc }> | null = null;
      if (state.online) {
        try {
          const sess = s;
          inv = await findInvites(new FirestoreRemote({ projectId: cloudConfig()!.projectId, uid: u.uid, idToken: () => sess.idToken() }), u.email);
        } catch { inv = null; }
      }
      if (inv === null) { patch({ gate: 'retry' }); return; }
      if (inv.length) {
        // بيانات الجهاز التي بلا حساب لا تُعرض على مدعوّ · تُركن كما هي
        if (r === 'unbound') { parkActive(env, UNBOUND); onData(); }
        patch({ invites: inv, gate: null });
        return;
      }
      if (r === 'unbound') { patch({ gate: 'unbound' }); return; }
      // لا دعوة: صاحب الحساب مالكٌ لمنشأته · نسخته الجديدة تسحب ما في سحابته (الانضمام: السحابة تغلب)
      enableSync(db, u.uid);
    }
    setSyncState(db, 'email', u.email);
    patch({ gate: null, sync: syncStatus(db) });
  } finally {
    activating = false;
    resumeSync();
  }
  syncNow();
}

/** بيانات بلا حساب على الجهاز: يربطها الداخل بحسابه بقراره */
export function bindUnboundToAccount(db: AppDB): void {
  if (!state.user) return;
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

/**
 * «دمج مع السحابة» بقرار المستخدم · تُرفع العلامة وتعمل المزامنة بقاعدتها المعتادة (الأحدث يغلب) ·
 * وعهد المسح الحالي يُسجَّل معه، فالنسخة المستعادة لا تُفرَّغ بعهدٍ قديم (قاعدة المالك ٢٠٢٦-١٠-٠٥)
 */
export async function clearRestoredUnadopted(db: AppDB, uid: string): Promise<void> {
  const epoch = state.online ? await readEpoch(remoteFor(), orgOfAccount(db)).catch(() => null) : null;
  db.transaction(() => {
    setSyncState(db, 'restored_unadopted', null);
    if (epoch !== null) { setSyncState(db, 'wipe_epoch', String(epoch)); setSyncState(db, 'epoch_pending', null); }
  });
  enableSync(db, uid);
  patch({ sync: syncStatus(db), lastError: null });
}

function remoteFor(): FirestoreRemote {
  const s = getSession();
  const cfg = cloudConfig();
  if (!s || !cfg || !state.user) throw new Error('سجّل الدخول بحساب قوقل أولاً');
  if (!state.online) throw new Error('لا اتصال بالإنترنت · اعتماد النسخة للسحابة يحتاج اتصالاً لقراءة ما فيها');
  const sess = s;
  if (!appDb) throw new Error('القاعدة غير جاهزة');
  return remoteOf(appDb, state.user.uid, () => sess.idToken());
}

/** لقطة ما في السحابة · تُقرأ مرة والمزامنة متوقفة، فتخدم ضمّ القيود المرحّلة وخطة الاستبدال معاً */
export async function readCloudSnapshot(onProgress?: (m: string) => void): Promise<CloudSnapshot> {
  return readCloud(remoteFor(), onProgress);
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
  const plan = ready ?? await planCloudReplace(db, remoteFor(), onProgress);
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
  const snap = await readCloud(remoteFor(), onProgress);
  return { snap, keep: planKeepPosted(db, { cloud: snap.docs }), plan: planFromSnapshot(db, snap) };
}

export async function adoptPendingWithKeep(
  db: AppDB, ready: { snap: CloudSnapshot; keep: KeepPlan }
): Promise<{ queued: number; kept: number }> {
  const kept = ready.keep.entries.length ? applyKeepPosted(db, ready.keep).entries.length : 0;
  const { queued } = await adoptForCloud(db, planFromSnapshot(db, ready.snap));
  return { queued, kept };
}

/** حساب البيانات على هذا الجهاز (uid وإيميل) · آخر من دخل وارتبطت به المزامنة */
export function deviceAccount(db: DB): { uid: string; email: string } | null {
  const uid = getSyncState(db, 'uid');
  return uid ? { uid, email: getSyncState(db, 'email') ?? '' } : null;
}

/**
 * «حذف حسابي» (الدراسة أ، معتمدة): دخولٌ جديد بقوقل للحساب نفسه ثم بالترتيب ·
 * بيانات السحابة كلها (firestore.rules تأذن ساعةً بطلبٍ بوقت الخادم) · نسخ التطبيق على Drive ·
 * حساب Firebase · ثم الجهاز (resetDeviceData) · ثم الخروج. فشل خطوةٍ يوقف ما بعدها ويُبلَّغ.
 */
export async function deleteMyAccount(db: AppDB, onProgress?: (m: string) => void): Promise<void> {
  const s = getSession();
  const cfg = cloudConfig();
  if (!s || !cfg || !state.user) throw new Error('سجّل الدخول أولاً');
  if (!state.online) throw new Error('حذف الحساب يحتاج اتصالاً بالإنترنت');
  const uid = state.user.uid;
  onProgress?.('جاري تأكيد هويتك بقوقل');
  const fresh = await s.signIn();
  if (!fresh) throw new Error('أُلغي تأكيد الهوية');
  if (fresh.uid !== uid) throw new Error('اخترت حساباً آخر · اختر الحساب نفسه لحذفه');
  await pauseSync();
  try {
    onProgress?.('جاري حذف بياناتك من السحابة');
    // المنشأة (وأعضاؤها ودعواتها) ثم المسار القديم · كلٌّ بنافذة حذفه
    // ملفات المنشأة في الخادم مع صفوفها
    await deleteOrgFiles(uid, onProgress);
    for (const remote of [
      new FirestoreRemote({ projectId: cfg.projectId, uid, idToken: () => s.idToken(), org: uid }),
      new FirestoreRemote({ projectId: cfg.projectId, uid, idToken: () => s.idToken() }),
    ]) {
      await remote.deleteAllData((n) => onProgress?.('جاري حذف بياناتك من السحابة · ' + n));
    }
    onProgress?.('جاري حذف نسخك على Google Drive');
    await deleteAllAppDataFiles(driveIO, await s.driveToken());
    onProgress?.('جاري حذف الحساب');
    await deleteFirebaseAccount({ apiKey: cfg.apiKey }, await s.idToken());
    onProgress?.('جاري تفريغ هذا الجهاز');
    await resetDeviceData(db);
    await s.signOut();
    patch({ user: null, sync: syncStatus(db), lastError: null });
  } finally {
    resumeSync();
  }
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

/** أُزيلت العضوية: تفريغ بنسخة أمان وسجل، ثم يعود الجهاز لحساب صاحبه بلا منشأة غيره */
async function wipeForRemoval(db: AppDB): Promise<void> {
  await wipeLocal(db, undefined, undefined, 'أُزيلت عضويتك من المنشأة');
  db.transaction(() => {
    saveMembership(db, null);
    for (const k of ['org', 'org_name', 'wipe_epoch', 'epoch_pending', 'removal_pending', 'cursor', 'moves_seen']) setSyncState(db, k, null);
  });
}

/**
 * قرار المستخدم فيما ينتظره (state.decision) · 'keep' يُبقي بياناته: في عهد المسح تُرفع كلها إلى المنشأة من جديد،
 * وفي الإزالة يبقى الجهاز كما هو والمزامنة متوقفة · 'wipe' تفريغٌ بأمره بنسخة أمان وسجل بسببه.
 */
export async function resolveDecision(choice: 'keep' | 'wipe', onProgress?: (m: string) => void): Promise<void> {
  if (!appDb || !state.decision) return;
  const db = appDb;
  if (state.decision.kind === 'epoch') {
    await resolveEpoch(db, choice, () => wipeLocal(db, onProgress, undefined, 'مُسحت بيانات المنشأة من جهاز آخر · بأمر المستخدم').then(() => db));
  } else if (choice === 'wipe') {
    await wipeForRemoval(db);
  } else {
    return; // يبقى منتظراً · لا رفع ولا تفريغ
  }
  patch({ decision: null, sync: syncStatus(db) });
  onData();
  syncNow().catch(() => {});
}

/* ═══════════ مسح كل البيانات ═══════════ */

/** تفريغ الجهاز: القاعدة والمرفقات والمصغّرات ولقطة الودجت · بنسخة أمان، ويبقى الحساب وهوية الجهاز */
async function wipeLocal(db: AppDB, onProgress?: (m: string) => void, safety?: string, reason?: string): Promise<string> {
  const env = appBackupEnv(db);
  const path = await wipeAllData(env, onProgress, safety, reason);
  for (const d of ['thumbs', 'widget.json']) {
    try { env.fs.remove(joinPath(appDataRoot(), d)); } catch { /* غير موجود */ }
  }
  return path;
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
      const remote = new FirestoreRemote({ projectId: cfg!.projectId, uid: user!.uid, idToken: () => sess.idToken(), org: user!.uid });
      epoch = await wipeOrgCloud(remote, user!.uid, onProgress);
      await deleteOrgFiles(user!.uid, onProgress);
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
    const remote = new FirestoreRemote({ projectId: cloudConfig()!.projectId, uid: user.uid, idToken: () => sess.idToken() });
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

/** مغادرة العضو المنشأة · تُحذف عضويته ويُفرَّغ الجهاز ويخرج · ولا مغادرة قبل رفع تغييراته */
export async function leaveOrgNow(db: AppDB): Promise<void> {
  const m = readMembership(db);
  const s = getSession();
  if (!m || !s || !state.user) return;
  const waiting = outboxCount(db);
  if (waiting > 0) throw new Error('لم تُرفع ' + waiting + ' تغييرات بعد · اتصل بالإنترنت ودع المزامنة تكمل ثم غادر');
  const sess = s;
  await pauseSync();
  try {
    await leaveOrg(remoteOf(db, state.user.uid, () => sess.idToken()), m.org, m.uid);
    await resetDeviceData(db);
    await sess.signOut();
    patch({ user: null, sync: syncStatus(db) });
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
  return { remote: new FirestoreRemote({ projectId: cfg.projectId, uid: state.user.uid, idToken: () => sess.idToken(), org: state.user.uid }), org: state.user.uid };
}
const orgNameOf = (db: DB) => db.get<{ name: string }>('SELECT name FROM company WHERE id = 1')?.name || 'منشأة عقاري';

export async function listTeamNow() { const t = teamRemote(); return listTeam(t.remote, t.org); }
export async function inviteMemberNow(db: DB, spec: MemberSpec) {
  const t = teamRemote();
  const doc = await sendInvite(t.remote, t.org, spec, orgNameOf(db), state.user!.email);
  if (spec.profile && (spec.profile.name || spec.profile.phone)) logProfileEdit(db, doc.email, null, spec.profile);
  return doc;
}

/**
 * تعديل بيانات عضو في سجل العمليات بمنفّذه · الهوية لا تُكتب فيه (يقرؤه غير المالك والعضو) بل يُذكر
 * أنها أُدخلت أو تغيّرت أو حُذفت.
 */
function logProfileEdit(db: DB, label: string, before: MemberProfile | null, after: MemberProfile): void {
  const mask = (p: MemberProfile | null, other: MemberProfile | null) => p ? {
    الاسم: p.name, الجوال: p.phone, 'المسمى الوظيفي': p.title,
    الهوية: !p.nid ? '' : other && other.nid && other.nid !== p.nid ? 'قديمة' : 'مُدخلة',
  } : null;
  logAudit(db, 'الأعضاء', before ? 'update' : 'create', 'بيانات عضو', label, mask(before, after), mask(after, before));
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
  const remote = new FirestoreRemote({ projectId: cfg.projectId, uid: state.user.uid, idToken: () => sess.idToken(), org: m.org });
  const r = await updateMemberProfile(remote, m.org, m.uid, profile);
  db.transaction(() => {
    saveMembership(db, { ...m, profile });
    logProfileEdit(db, profile.name, r.before, r.after);
  });
}
export async function updateMemberNow(db: DB, uid: string, spec: MemberSpec) { const t = teamRemote(); return updateMember(t.remote, t.org, uid, spec, orgNameOf(db)); }
/** إشراف عضو في المحادثة بإيميله (src/chat) · للمالك وحده */
export async function chatSupervisorNow(email: string): Promise<string[]> {
  const s = getSession(); const cfg = cloudConfig();
  if (!s || !cfg || !state.user || !state.online || !email) return [];
  return supervisorOf({ projectId: cfg.projectId, uid: state.user.uid, email: state.user.email, idToken: () => s.idToken() }, state.user.uid, email);
}
export async function setChatSupervisorNow(email: string, sections: string[]): Promise<void> {
  const s = getSession(); const cfg = cloudConfig();
  if (!s || !cfg || !state.user) { teamRemote(); return; }
  await setSupervisor({ projectId: cfg.projectId, uid: state.user.uid, email: state.user.email, idToken: () => s.idToken() }, state.user.uid, email, sections);
}
export async function removeMemberNow(uid: string) { const t = teamRemote(); return removeMember(t.remote, t.org, uid); }
export async function revokeInviteNow(email: string) { const t = teamRemote(); return revokeInvite(t.remote, t.org, email); }

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
  if (!s || !state.user) throw new Error('سجّل الدخول بحساب قوقل أولاً');
  return s.driveToken();
}

/** نسخة جديدة تجتاز كل تحققات الإنشاء ثم تُرفع وتُطابق بصمتها على Drive */
export async function backupToDrive(db: AppDB, onProgress?: ProgressFn, signal?: CancelSignal): Promise<DriveBackup> {
  const env = appBackupEnv(db);
  const name = `عقاري · نسخة · ${toLocalISODate(new Date())}.aqbk`;
  const out = joinPath(env.tmpDir, 'drive-' + Date.now() + '.aqbk');
  // الملفات في الخادم: نسخة Drive للبيانات وقائمة الملفات وبصماتها، ومعها ما لم يُرفع بعد · فتصير صغيرة وسريعة
  const manifest = await createBackup(env, out, onProgress, { signal, dataOnly: filesCloudOn() });
  try {
    // نسخة Drive تُشفَّر أيضاً إن وُضعت كلمة مرور النسخ
    const pw = await getBackupPassword();
    if (pw) await sealBackupFile(env, out, pw, onProgress);
    throwIfCancelled(signal);
    const token = await driveToken();
    return await uploadBackupToDrive(driveIO, token, out, name, { encrypted: !!pw, notes: !!manifest.notes?.length, onProgress, signal });
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
  return remoteOf(db, state.user.uid, () => sess.idToken());
}

/** حفظ فاتورة من الشاشة · الإصدار برقم العدّاد، وبلا اتصال مسودةٌ تصدر عند عودته */
export function saveInvoiceNow(db: DB, input: InvoiceInput, status: 'مسودة' | 'مستحقة', existingId?: string): Promise<IssueResult> {
  return saveInvoiceIssued(db, invoiceSource(db), input, status, existingId);
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
  return { io: storageIO, target: { base: fc.base, bucket: fc.bucket, org, idToken: () => sess.idToken() }, access: readAccess(db) };
}

const cacheLimitOf = (db: DB) => Number(getSetting(db, 'fileCacheMb') || 500) * 1024 * 1024;

/** رفع الملفات المنتظرة في الخلفية بعد كل مزامنة · طابورها مستقل فلا يحبس البيانات، والفشل يُعاد لاحقاً */
let pumping = false;
async function pumpFilesInBackground(db: DB): Promise<void> {
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
async function deleteOrgFiles(org: string, onProgress?: (m: string) => void): Promise<number> {
  const fc = filesCloudConfig();
  const s = getSession();
  if (!fc || !s) return 0;
  const sess = s;
  const t = { base: fc.base, bucket: fc.bucket, org, idToken: () => sess.idToken() };
  const names = await listObjects(storageIO, t, filesPrefix(org));
  let n = 0;
  for (const name of names) {
    await deleteObject(storageIO, t, name);
    n++;
    onProgress?.('جاري حذف الملفات من الخادم · ' + n + ' من ' + names.length);
  }
  return n;
}
