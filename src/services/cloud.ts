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
}

let state: CloudState = { configured: !!cloudConfig(), user: null, online: false, syncing: false, progress: null, lastError: null, sync: null, restored: false };
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
    enableSync(db, state.user.uid);
    const remote = new FirestoreRemote({ projectId: cfg.projectId, uid: state.user.uid, idToken: () => s.idToken() });
    const rep = await syncOnce(db, remote, ensureDeviceId(db), (msg) => patch({ progress: msg }));
    setSyncState(db, 'last_error', null);
    if (rep.applied || rep.conflicts) onData();
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
    if (u) syncNow();
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
  // على الجهاز بيانات حساب آخر · لا تُرفع إلى هذا الحساب ولا يُنضمّ بها: بوابة الدخول تعرض الاختيار
  const owner = deviceAccount(appDb);
  if (owner && owner.uid !== u.uid) { patch({ user: u }); return u; }
  // نسخة مستعادة لم تُعتمد · لا يُفعَّل الانضمام فيغلب ما في السحابة عليها صامتاً
  if (getSyncState(appDb, 'restored_unadopted') !== '1') enableSync(appDb, u.uid);
  // إيميل الحساب على الجهاز · تقرؤه شاشة الدخول إن خرج صاحبه أو دخل غيره
  setSyncState(appDb, 'email', u.email);
  patch({ user: u, sync: syncStatus(appDb) });
  syncNow();
  return u;
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
  return new FirestoreRemote({ projectId: cfg.projectId, uid: state.user.uid, idToken: () => sess.idToken() });
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

/** بعد تفريغ جهازٍ كانت عليه بيانات حساب آخر · يرتبط الجهاز بالحساب الداخل ويبدأ مزامنته */
export async function bindDeviceToCurrentAccount(db: AppDB): Promise<void> {
  if (!state.user) return;
  await resetDeviceData(db);
  enableSync(db, state.user.uid);
  setSyncState(db, 'email', state.user.email);
  patch({ sync: syncStatus(db), lastError: null });
  syncNow();
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
    const remote = new FirestoreRemote({ projectId: cfg.projectId, uid, idToken: () => s.idToken() });
    onProgress?.('جاري حذف بياناتك من السحابة');
    await remote.deleteAllData((n) => onProgress?.('جاري حذف بياناتك من السحابة · ' + n));
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
export async function cloudSignOut(): Promise<void> {
  const s = getSession();
  if (!s) return;
  await s.signOut();
  patch({ user: null });
}

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
