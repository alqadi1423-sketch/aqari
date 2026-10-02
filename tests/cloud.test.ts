/**
 * القسم ٤أ و٤ب · الدخول بقوقل عبر Firebase والنسخ على Google Drive.
 * الجلسة: الرموز في المخزن الآمن وحده، والخروج لا يمسّ البيانات المحلية.
 * Drive: نطاق appdata وحده، الملف نفسه بعد تحققاته، مطابقة البصمة بعد الرفع وقبل الاستعادة،
 * والاستعادة من Drive تمرّ بمسار الاستعادة المحلي نفسه.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { memDb, tempDir, rmrf } from './helpers/testDb';
import { makeBackupEnv } from './helpers/backupEnv';
import { createSession, KEYS, type SecureKV } from '@/cloud/session';
import { signInWithGoogleIdToken, refreshIdToken } from '@/cloud/authRest';
import { DRIVE_SCOPE } from '@/cloud/config';
import { uploadBackupToDrive, downloadBackupFromDrive, listDriveBackups, type DriveIO } from '@/cloud/drive';
import { createBackup, tableCounts } from '@/domain/backup/create';
import { prepareRestore, abortRestore } from '@/domain/backup/restore';
import { nodeHasher } from '@/files/nodeFs';

const dirs: string[] = [];
const newDir = () => { const d = tempDir('aq-cloud-'); dirs.push(d); return d; };
afterAll(() => { for (const d of dirs) rmrf(d); });

function memKV(): SecureKV & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    get: async (k) => data.get(k) ?? null,
    set: async (k, v) => { data.set(k, v); },
    del: async (k) => { data.delete(k); },
  };
}

describe('٤أ · الجلسة', () => {
  function makeSession(now = { t: 1_000_000 }) {
    const kv = memKV();
    const calls: string[] = [];
    const s = createSession({
      google: {
        signIn: async () => ({ idToken: 'G-ID', email: 'owner@gmail.com' }),
        signInSilently: async () => true,
        accessToken: async () => 'DRIVE-TOKEN',
        signOut: async () => { calls.push('google.signOut'); },
      },
      store: kv,
      signInWithIdp: async (t) => { calls.push('idp:' + t); return { uid: 'U1', email: 'owner@gmail.com', idToken: 'FB-1', refreshToken: 'R-1', expiresAt: now.t + 3_600_000 }; },
      refresh: async (r) => { calls.push('refresh:' + r); return { uid: 'U1', idToken: 'FB-2', refreshToken: 'R-2', expiresAt: now.t + 3_600_000 }; },
      now: () => now.t,
    });
    return { s, kv, calls, now };
  }

  test('الدخول: رمز قوقل يُبدَّل بهوية Firebase · ورمز التحديث والهوية في المخزن الآمن', async () => {
    const { s, kv, calls } = makeSession();
    const u = await s.signIn();
    expect(u).toEqual({ uid: 'U1', email: 'owner@gmail.com' });
    expect(calls).toContain('idp:G-ID');
    expect(kv.data.get(KEYS.refresh)).toBe('R-1');
    expect(kv.data.get(KEYS.uid)).toBe('U1');
    expect(await s.idToken()).toBe('FB-1');
  });

  test('انتهاء رمز الدخول: يُجدَّد من رمز التحديث ويُحفظ الجديد', async () => {
    const { s, kv, now } = makeSession();
    await s.signIn();
    now.t += 3_600_000;
    expect(await s.idToken()).toBe('FB-2');
    expect(kv.data.get(KEYS.refresh)).toBe('R-2');
  });

  test('الخروج: الرموز وحدها تُمسح · والبيانات المحلية كما هي', async () => {
    const db = memDb();
    db.run(`INSERT INTO properties (id, name, created_at) VALUES ('P', 'برج', 'x')`);
    const before = tableCounts(db);
    const { s, kv, calls } = makeSession();
    await s.signIn();
    await s.signOut();
    expect(calls).toContain('google.signOut');
    expect([...kv.data.keys()]).toEqual([]);
    expect(s.current()).toBeNull();
    expect(tableCounts(db)).toEqual(before);
    await expect(s.idToken()).rejects.toThrow('لا جلسة محفوظة');
    db.close();
  });

  test('بعد إعادة تشغيل التطبيق: الجلسة تُستعاد من المخزن الآمن بلا نافذة دخول', async () => {
    const { s, kv } = makeSession();
    await s.signIn();
    const again = createSession({
      google: { signIn: async () => null, signInSilently: async () => true, accessToken: async () => 'x', signOut: async () => {} },
      store: kv, signInWithIdp: async () => { throw new Error('لا يُنادى'); }, refresh: async () => ({ uid: 'U1', idToken: 'FB-3', refreshToken: 'R-1', expiresAt: Date.now() + 3_600_000 }),
    });
    expect(await again.restore()).toEqual({ uid: 'U1', email: 'owner@gmail.com' });
    expect(await again.idToken()).toBe('FB-3');
  });
});

describe('٤أ · طلبات Firebase Auth', () => {
  test('signInWithIdp برمز قوقل ومزوّد google.com · والتجديد بنموذج securetoken', async () => {
    const seen: Array<{ url: string; body: string }> = [];
    const fake = (async (url: string, init: { body: string }) => {
      seen.push({ url, body: init.body });
      const ok = url.includes('signInWithIdp')
        ? { localId: 'U9', email: 'a@b.c', idToken: 'ID', refreshToken: 'RT', expiresIn: '3600' }
        : { user_id: 'U9', id_token: 'ID2', refresh_token: 'RT2', expires_in: '3600' };
      return { ok: true, status: 200, text: async () => JSON.stringify(ok) };
    }) as unknown as typeof fetch;
    const u = await signInWithGoogleIdToken({ apiKey: 'K', fetchImpl: fake, now: () => 0 }, 'GOOGLE.ID.TOKEN');
    expect(u).toMatchObject({ uid: 'U9', idToken: 'ID', refreshToken: 'RT', expiresAt: 3_600_000 });
    expect(seen[0].url).toBe('https://identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=K');
    expect(JSON.parse(seen[0].body).postBody).toBe('id_token=GOOGLE.ID.TOKEN&providerId=google.com');
    const r = await refreshIdToken({ apiKey: 'K', fetchImpl: fake, now: () => 0 }, 'RT');
    expect(r.idToken).toBe('ID2');
    expect(seen[1].url).toBe('https://securetoken.googleapis.com/v1/token?key=K');
    expect(seen[1].body).toBe('grant_type=refresh_token&refresh_token=RT');
  });

  test('رفض الخادم يعود رسالة عربية لا نصّاً تقنياً', async () => {
    const fake = (async () => ({ ok: false, status: 400, text: async () => '{"error":{"message":"INVALID_IDP_RESPONSE"}}' })) as unknown as typeof fetch;
    await expect(signInWithGoogleIdToken({ apiKey: 'K', fetchImpl: fake }, 'x')).rejects.toThrow('تعذّر الدخول: رفضت قوقل رمز الدخول');
  });
});

describe('٤ب · Google Drive', () => {
  test('النطاق drive.appdata وحده', () => {
    expect(DRIVE_SCOPE).toBe('https://www.googleapis.com/auth/drive.appdata');
  });

  /** Drive وهمي: يحفظ الملف المرفوع ويحسب بصمته كما يفعل Drive */
  function fakeDrive(opts: { corruptUpload?: boolean; corruptDownload?: boolean } = {}) {
    const store = new Map<string, { bytes: Uint8Array; name: string; sha: string }>();
    const log: Array<{ method: string; url: string; headers?: Record<string, string>; body?: string }> = [];
    let pendingMeta: { name: string } | null = null;
    const io: DriveIO = {
      fetch: (async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
        log.push({ method: init.method ?? 'GET', url, headers: init.headers, body: init.body });
        if (url.includes('uploadType=resumable')) {
          pendingMeta = JSON.parse(init.body!);
          return { ok: true, status: 200, headers: { get: () => 'https://upload/session/1' }, text: async () => '' };
        }
        if (init.method === 'DELETE') { store.delete(url.split('/').pop()!); return { ok: true, status: 204, text: async () => '' }; }
        if (url.includes('/files?')) {
          const files = [...store.entries()].map(([id, f]) => ({ id, name: f.name, size: String(f.bytes.length), createdTime: '2026-10-01T10:00:00Z', sha256Checksum: f.sha }));
          return { ok: true, status: 200, text: async () => JSON.stringify({ files }) };
        }
        return { ok: false, status: 404, text: async () => '' };
      }) as unknown as typeof fetch,
      async putFile(url, p) {
        log.push({ method: 'PUT', url });
        const bytes = new Uint8Array(fs.readFileSync(p));
        const stored = opts.corruptUpload ? bytes.slice(0, bytes.length - 1) : bytes;
        const sha = await nodeHasher(stored);
        store.set('F1', { bytes: stored, name: pendingMeta!.name, sha });
        return { status: 200, body: JSON.stringify({ id: 'F1', name: pendingMeta!.name, size: String(stored.length), sha256Checksum: sha }) };
      },
      async downloadFile(url, p) {
        const f = store.get(url.split('/files/')[1].split('?')[0])!;
        const bytes = opts.corruptDownload ? f.bytes.slice(1) : f.bytes;
        fs.writeFileSync(p, bytes);
        return { status: 200 };
      },
      sha256OfFile: async (p) => nodeHasher(new Uint8Array(fs.readFileSync(p))),
      sizeOf: (p) => fs.statSync(p).size,
    };
    return { io, store, log };
  }

  async function archive() {
    const env = makeBackupEnv(newDir());
    env.db.run(`INSERT INTO properties (id, name, created_at) VALUES ('P', 'برج النخيل', 'x')`);
    const p = path.join(env.root, 'b.aqbk');
    await createBackup(env, p);
    env.closeLive();
    return p;
  }

  test('الرفع: إلى appDataFolder بالملف نفسه · وبصمة Drive تطابق المحلية', async () => {
    const p = await archive();
    const { io, log } = fakeDrive();
    const b = await uploadBackupToDrive(io, 'T', p, 'عقاري · نسخة.aqbk');
    const init = log.find((l) => l.url.includes('uploadType=resumable'))!;
    expect(JSON.parse(init.body!).parents).toEqual(['appDataFolder']);
    expect(init.headers!.Authorization).toBe('Bearer T');
    expect(b.sha256).toBe(await nodeHasher(new Uint8Array(fs.readFileSync(p))));
    const list = await listDriveBackups(io, 'T');
    expect(list.map((x) => x.id)).toEqual(['F1']);
    expect(log.find((l) => l.url.startsWith('https://www.googleapis.com/drive/v3/files?'))!.url).toContain('spaces=appDataFolder');
  });

  test('الرفع ببصمة لا تطابق: يُحذف المرفوع ويُرفض برسالة تسمّي الملف', async () => {
    const p = await archive();
    const { io, store } = fakeDrive({ corruptUpload: true });
    await expect(uploadBackupToDrive(io, 'T', p, 'عقاري · نسخة.aqbk'))
      .rejects.toThrow('بصمة «عقاري · نسخة.aqbk» على Drive لا تطابق الملف المحلي');
    expect(store.size).toBe(0);
  });

  test('الاستعادة: التنزيل يُطابَق ثم يمرّ بمسار الاستعادة المحلي نفسه · والتالف يُرفض قبله', async () => {
    const p = await archive();
    const up = fakeDrive();
    const b = await uploadBackupToDrive(up.io, 'T', p, 'n.aqbk');
    const target = makeBackupEnv(newDir());
    const dl = path.join(target.root, 'restore-input.aqbk');
    await downloadBackupFromDrive(up.io, 'T', b, dl);
    const plan = await prepareRestore(target, dl);   // المسار المحلي نفسه
    expect(plan.incoming.properties).toBe(1);
    abortRestore(target, plan.stagingDir);

    const bad = fakeDrive({ corruptDownload: true });
    const b2 = await uploadBackupToDrive(bad.io, 'T', p, 'n.aqbk');
    await expect(downloadBackupFromDrive(bad.io, 'T', b2, path.join(target.root, 'x.aqbk')))
      .rejects.toThrow('بصمة «n.aqbk» بعد التنزيل لا تطابق بصمتها على Drive');
    target.closeLive();
  });
});
