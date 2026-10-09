/**
 * مراجعة التثبيت #48: الاستعادة لا تثق بمحفّزات النسخة وعروضها · تُطابَق بمرجعٍ يُبنى من الهجرات نفسها، فيُحذف المزروع
 * وتُعاد الحماية المحذوفة · بيانات مصطنعة.
 */
import * as path from 'node:path';
import * as fsNode from 'node:fs';
import * as os from 'node:os';
import { unzipSync, zipSync } from 'fflate';
import { makeBackupEnv } from './helpers/backupEnv';
import { createBackup } from '@/domain/backup/create';
import { restoreBackup } from '@/domain/backup/restore';
import { nodeHasher } from '@/files/nodeFs';
import { openNodeDb } from '@/db/nodeAdapter';

const mkroot = () => fsNode.mkdtempSync(path.join(os.tmpdir(), 'aqari-schema-')).replace(/\\/g, '/');

test('نسخة مزوّرة حذفت حماية القيد وزرعت محفّزاً وعرضاً · تُستعاد بمخطط التطبيق لا مخططها', async () => {
  const env = makeBackupEnv(mkroot());
  env.db.run(`INSERT INTO properties (id, name, created_at) VALUES ('P1','عقار مخطط مصطنع',datetime('now'))`);
  const archive = path.posix.join(env.root, 'نسخة.aqbk');
  await createBackup(env, archive);
  const entries = unzipSync(env.fs.read(archive));
  const manifest = JSON.parse(new TextDecoder().decode(entries['manifest.json']));
  const tmp = path.posix.join(env.root, 'forged.db');
  fsNode.writeFileSync(tmp, entries['data.db']);
  const db = openNodeDb(tmp);
  db.exec(`DROP TRIGGER trg_jl_frozen_upd`);
  db.exec(`CREATE TRIGGER trg_evil AFTER INSERT ON properties BEGIN DELETE FROM journal_lines; END`);
  db.exec(`CREATE VIEW v_evil AS SELECT 1 AS x`);
  db.close();
  entries['data.db'] = new Uint8Array(fsNode.readFileSync(tmp));
  manifest.db_sha256 = await nodeHasher(entries['data.db']);
  entries['manifest.json'] = new TextEncoder().encode(JSON.stringify(manifest));
  const forged = path.posix.join(env.root, 'مزوّرة-مخطط.aqbk');
  env.fs.write(forged, zipSync(entries));

  await restoreBackup(env, forged);
  const names = env.live().all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type IN ('trigger','view')`).map((r) => r.name);
  expect(names).toContain('trg_jl_frozen_upd');
  expect(names).not.toContain('trg_evil');
  expect(names).not.toContain('v_evil');
  expect(env.live().get(`SELECT name FROM properties WHERE id = 'P1'`)).toEqual({ name: 'عقار مخطط مصطنع' });
  env.closeLive();
});
