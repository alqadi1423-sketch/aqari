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
import { cloudConfig, DRIVE_SCOPE } from '../cloud/config';
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
import { expoHasher } from '../files/expoFs';
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
import { setCapture, outboxCount } from '../sync/engine';
import { switchTo, parkActive, activeAccount, UNBOUND } from './accountSlots';
import { appSlotEnv } from './slotsApp';
import { readAccess, readMembership, saveMembership, type Membership } from './access';
import {
  moveOwnerToOrg, refreshMembership, findInvites, acceptInvite, leaveOrg, listTeam, sendInvite, updateMember, removeMember, revokeInvite,
  type MemberDoc, type MemberSpec,
} from './org';

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
}

let state: CloudState = { configured: !!cloudConfig(), user: null, online: false, syncing: false, progress: null, lastError: null, sync: null, restored: false, invites: null, gate: null };
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
    const member = readMembership(db);
    if (!member) {
      enableSync(db, uid);
      // المالك ينتقل إلى منشأته مرة (صلاحيات الأقسام) · حروف أجهزته تنتقل كما هي
      await moveOwnerToOrg(db, remoteOf(db, uid, idToken, true), new FirestoreRemote({ projectId: cfg.projectId, uid, idToken, org: uid }), uid);
    }
    const rep = await syncOnce(db, remoteOf(db, uid, idToken), ensureDeviceId(db), (msg) => patch({ progress: msg }));
    setSyncState(db, 'last_error', null);
    if (rep.applied || rep.conflicts) onData();
    if (member) {
      // العضوية في الخادم: أُزيلت فيُفرَّغ الجهاز · تغيّرت فيُعاد السحب من أوله بصلاحيته الجديدة
      const r = await refreshMembership(db, remoteOf(db, uid, idToken));
      if (r === 'removed') {
        await resetDeviceData(db as AppDB);
        patch({ lastError: 'أُزيلت عضويتك من المنشأة · فُرّغ هذا الجهاز من بياناتها' });
        onData();
      } else if (r === 'changed') {
        const next = readMembership(db)!;
        await resetDeviceData(db as AppDB);
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
  }
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
    if (u && activeAccount(db) !== u.uid) activateAccount(u);
    else if (u) syncNow();
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
  patch({ user: u, gate: 'switching', invites: null });
  await pauseSync();
  try {
    const env = appSlotEnv(db);
    const r = switchTo(env, u.uid);
    onData();
    if (activeAccount(db) !== u.uid) {
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

/** «دمج مع السحابة» بقرار المستخدم · تُرفع العلامة وتعمل المزامنة بقاعدتها المعتادة (الأحدث يغلب) */
export function clearRestoredUnadopted(db: AppDB, uid: string): void {
  setSyncState(db, 'restored_unadopted', null);
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
  const res = adoptAsCloudTruth(db, state.user!.uid, plan);
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
    if (activeAccount(db) || hasUserData(db)) throw new Error('على الجهاز نسخة فيها بيانات لهذا الحساب · لا تُستبدل بعضوية');
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
export async function inviteMemberNow(db: DB, spec: MemberSpec) { const t = teamRemote(); return sendInvite(t.remote, t.org, spec, orgNameOf(db), state.user!.email); }
export async function updateMemberNow(db: DB, uid: string, spec: MemberSpec) { const t = teamRemote(); return updateMember(t.remote, t.org, uid, spec, orgNameOf(db)); }
export async function removeMemberNow(uid: string) { const t = teamRemote(); return removeMember(t.remote, t.org, uid); }
export async function revokeInviteNow(email: string) { const t = teamRemote(); return revokeInvite(t.remote, t.org, email); }

/* ═══════════ Google Drive ═══════════ */

const driveIO: DriveIO = {
  fetch: (...a) => fetch(...a),
  async putFile(url, path, headers) {
    const r = await LegacyFS.uploadAsync(url, new File(path).uri, {
      httpMethod: 'PUT', uploadType: LegacyFS.FileSystemUploadType.BINARY_CONTENT, headers,
    });
    return { status: r.status, body: r.body };
  },
  async downloadFile(url, path, headers) {
    const r = await LegacyFS.downloadAsync(url, new File(path).uri, { headers });
    return { status: r.status };
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
export async function backupToDrive(db: AppDB, onProgress?: (m: string) => void): Promise<DriveBackup> {
  const env = appBackupEnv(db);
  const name = `عقاري · نسخة · ${toLocalISODate(new Date())}.aqbk`;
  const out = joinPath(env.tmpDir, 'drive-' + Date.now() + '.aqbk');
  const manifest = await createBackup(env, out, onProgress);
  try {
    // نسخة Drive تُشفَّر أيضاً إن وُضعت كلمة مرور النسخ
    const pw = await getBackupPassword();
    if (pw) await sealBackupFile(env, out, pw, onProgress);
    onProgress?.('جاري الرفع إلى Google Drive');
    const token = await driveToken();
    return await uploadBackupToDrive(driveIO, token, out, name, { encrypted: !!pw, notes: !!manifest.notes?.length });
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
  db: AppDB, b: DriveBackup, onProgress?: (m: string) => void, opts?: PrepareOptions
): Promise<{ env: BackupEnv; plan: RestorePlan; archiveTmp: string }> {
  const env = appBackupEnv(db);
  // القرص يسع العملية قبل أن يبدأ التنزيل · كما في الاستعادة من ملف
  await ensureFreeSpace(env);
  env.fs.mkdirp(env.tmpDir);
  const archiveTmp = joinPath(env.tmpDir, 'restore-input.aqbk');
  onProgress?.('جاري التنزيل من Google Drive');
  await downloadBackupFromDrive(driveIO, await driveToken(), b, archiveTmp);
  try {
    const plan = await prepareRestore(env, archiveTmp, onProgress, opts);
    return { env, plan, archiveTmp };
  } catch (e) {
    try { env.fs.remove(archiveTmp); } catch { /* يكنسه الإقلاع */ }
    throw e;
  }
}
