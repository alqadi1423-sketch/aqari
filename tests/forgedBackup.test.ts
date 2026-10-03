/**
 * نسخ مزوّرة · الاستعادة ترفضها قبل أن تكتب بايتاً خارج مجلد التجهيز:
 *  ١) بيانٌ اسمُ مرفقه فيه «../» يقصد قاعدة البيانات الحية → يُرفض، ولا يُكتب الملف المقصود، والبيانات كما هي.
 *  ٢) قاعدة نسخةٍ امتدادُ مرفقها نصٌّ يحقن وسماً في عارض الصور → تُرفض النسخة كاملة.
 *  ٣) والامتداد الذي يصنعه التطبيق نفسه من اسم الملف لا يحمل إلا حروفاً وأرقاماً.
 */
import * as path from 'node:path';
import * as fsNode from 'node:fs';
import * as os from 'node:os';
import { unzipSync, zipSync } from 'fflate';
import { makeBackupEnv } from './helpers/backupEnv';
import { createBackup } from '@/domain/backup/create';
import { prepareRestore } from '@/domain/backup/restore';
import { putAttachment, extOf } from '@/files/store';
import { nodeHasher } from '@/files/nodeFs';
import { openNodeDb } from '@/db/nodeAdapter';

const mkroot = () => fsNode.mkdtempSync(path.join(os.tmpdir(), 'aqari-forged-')).replace(/\\/g, '/');

async function seeded() {
  const env = makeBackupEnv(mkroot());
  env.db.run(`INSERT INTO properties (id, name, created_at) VALUES ('P1','عقار الاختبار',datetime('now'))`);
  await putAttachment(env.filesEnv, new Uint8Array(512).fill(9), {
    entityType: 'property', entityId: 'P1', kind: 'deed', originalName: 'صك.png', mime: 'image/png',
  });
  const archive = path.posix.join(env.root, 'نسخة.aqbk');
  await createBackup(env, archive);
  return { env, archive };
}

/** كل ملف تحت الجذر · لإثبات أن المزوَّر لم يُكتب في أي موضع */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of fsNode.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p)); else out.push(p);
  }
  return out;
}

const intact = (env: ReturnType<typeof makeBackupEnv>) => {
  const ic = env.live().get<Record<string, string>>(`PRAGMA integrity_check`)!;
  expect(String(Object.values(ic)[0])).toBe('ok');
  expect(env.live().get<{ name: string }>(`SELECT name FROM properties WHERE id='P1'`)!.name).toBe('عقار الاختبار');
};

test('بيان مزوّر باسم مرفق فيه ../ يقصد القاعدة الحية · يُرفض قبل أي كتابة', async () => {
  const { env, archive } = await seeded();
  const entries = unzipSync(env.fs.read(archive));
  const manifest = JSON.parse(new TextDecoder().decode(entries['manifest.json']));
  const payload = new TextEncoder().encode('مزوّر يكتب فوق القاعدة');
  // مجلد التجهيز tmp/restore-staging-*/attachments · ثلاث خطوات للأعلى تبلغ الجذر حيث data.db
  const evil = { sha256: '../../../forged-target', ext: 'db', size: payload.byteLength };
  manifest.files = [evil];
  entries[`attachments/${evil.sha256}.${evil.ext}`] = payload;
  entries['manifest.json'] = new TextEncoder().encode(JSON.stringify(manifest));
  const forged = path.posix.join(env.root, 'مزوّرة-مسار.aqbk');
  env.fs.write(forged, zipSync(entries));
  const before = env.fs.read(env.dbPath);

  await expect(prepareRestore(env, forged)).rejects.toThrow(/مرفق باسم غير صالح/);
  expect(walk(env.root).filter((f) => f.includes('forged-target'))).toEqual([]);
  expect(Buffer.from(env.fs.read(env.dbPath)).equals(Buffer.from(before))).toBe(true);
  intact(env);
  env.closeLive();
});

test('قاعدة نسخة مزوّرة امتداد مرفقها يحقن وسماً في عارض الصور · تُرفض النسخة كاملة', async () => {
  const { env, archive } = await seeded();
  const entries = unzipSync(env.fs.read(archive));
  const manifest = JSON.parse(new TextDecoder().decode(entries['manifest.json']));
  // تعديل القاعدة داخل الأرشيف ثم تصحيح بصمتها في البيان · كما يفعل مزوّر يعرف الصيغة
  const tmp = path.posix.join(env.root, 'forged.db');
  fsNode.writeFileSync(tmp, entries['data.db']);
  const db = openNodeDb(tmp);
  db.run(`UPDATE blobs SET ext = ?`, ['png" onerror="fetch(1)']);
  db.close();
  entries['data.db'] = new Uint8Array(fsNode.readFileSync(tmp));
  manifest.db_sha256 = await nodeHasher(entries['data.db']);
  entries['manifest.json'] = new TextEncoder().encode(JSON.stringify(manifest));
  const forged = path.posix.join(env.root, 'مزوّرة-امتداد.aqbk');
  env.fs.write(forged, zipSync(entries));

  await expect(prepareRestore(env, forged)).rejects.toThrow(/مرفق باسم غير صالح في قاعدتها/);
  intact(env);
  env.closeLive();
});

test('النسخة السليمة نفسها تمرّ · فالرفض للمزوّر وحده', async () => {
  const { env, archive } = await seeded();
  const plan = await prepareRestore(env, archive);
  expect(plan.manifest.files).toHaveLength(1);
  env.closeLive();
});

test('امتداد الملف المضاف من الجهاز حروف وأرقام لا غير', () => {
  expect(extOf('صورة.JPG', 'image/jpeg')).toBe('jpg');
  expect(extOf('x.p"g', 'image/png')).toBe('png');
  expect(extOf('x.<b>', 'application/pdf')).toBe('pdf');
});
