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
import { signInWithGoogleIdToken, refreshIdToken } from '../cloud/authRest';
import { createSession, type Session, type SessionUser } from '../cloud/session';
import { FirestoreRemote } from '../cloud/firestore';
import { listDriveBackups, uploadBackupToDrive, downloadBackupFromDrive, type DriveBackup, type DriveIO } from '../cloud/drive';
import { enableSync, syncOnce, syncStatus, setSyncState, type SyncStatus } from '../sync/engine';
import { ensureDeviceId } from '../db/seed';
import { expoHasher } from '../files/expoFs';
import { joinPath } from '../files/fsAdapter';
import { createBackup, ensureFreeSpace } from '../domain/backup/create';
import { prepareRestore, type RestorePlan } from '../domain/backup/restore';
import type { BackupEnv } from '../domain/backup/types';
import { toLocalISODate } from '../domain/dates';
import { appBackupEnv } from './backupService';

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
}

let state: CloudState = { configured: !!cloudConfig(), user: null, online: false, syncing: false, progress: null, lastError: null, sync: null };
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

export async function syncNow(): Promise<void> {
  const s = getSession();
  const db = appDb;
  const cfg = cloudConfig();
  if (!s || !db || !cfg || running || !state.user || !state.online) return;
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

/** يبدأ مع التطبيق · يعيد دالة الإيقاف */
export function startCloud(db: AppDB, onRemoteData?: () => void): () => void {
  appDb = db;
  onData = onRemoteData ?? (() => {});
  const s = getSession();
  patch({ configured: !!s, sync: syncStatus(db) });
  if (!s) return () => {};
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
    patch({ user: u });
    if (u) syncNow();
  }).catch(() => {});

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
  enableSync(appDb, u.uid);
  patch({ user: u, sync: syncStatus(appDb) });
  syncNow();
  return u;
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
  await createBackup(env, out, onProgress);
  try {
    onProgress?.('جاري الرفع إلى Google Drive');
    const token = await driveToken();
    return await uploadBackupToDrive(driveIO, token, out, name);
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
  db: AppDB, b: DriveBackup, onProgress?: (m: string) => void
): Promise<{ env: BackupEnv; plan: RestorePlan; archiveTmp: string }> {
  const env = appBackupEnv(db);
  // القرص يسع العملية قبل أن يبدأ التنزيل · كما في الاستعادة من ملف
  await ensureFreeSpace(env);
  env.fs.mkdirp(env.tmpDir);
  const archiveTmp = joinPath(env.tmpDir, 'restore-input.aqbk');
  onProgress?.('جاري التنزيل من Google Drive');
  await downloadBackupFromDrive(driveIO, await driveToken(), b, archiveTmp);
  try {
    const plan = await prepareRestore(env, archiveTmp, onProgress);
    return { env, plan, archiveTmp };
  } catch (e) {
    try { env.fs.remove(archiveTmp); } catch { /* يكنسه الإقلاع */ }
    throw e;
  }
}
