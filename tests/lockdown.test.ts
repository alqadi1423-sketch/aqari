/**
 * توجيه إقفال الثغرات · القسم ٣ بنداً بنداً:
 * أ) الأذونات المحذوفة وallowBackup في الـManifest وapp.json · ب) expo-dev-client خارج البناء ·
 * ج) لا نسخة بلا تحقق كامل · د) القيد المرحّل: لا غير متوازن ولو أُدرج مباشرة، ولا سلة ولا حذف ·
 * هـ) المسدَّد مع الخصم لا يتجاوز مبلغ القسط في الخدمة والقاعدة والاستعادة · و) allowBackup = false.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { zipSync, unzipSync } from 'fflate';
import { memDb, tempDir, rmrf } from './helpers/testDb';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { makeBackupEnv } from './helpers/backupEnv';
import { createBackup, tableCounts } from '@/domain/backup/create';
import { prepareRestore, abortRestore } from '@/domain/backup/restore';
import { BackupIntegrityError, BackupVerificationError, HashingUnavailableError, RestoreError } from '@/domain/backup/types';
import { putAttachment } from '@/files/store';
import { nodeHasher } from '@/files/nodeFs';
import { openNodeDb } from '@/db/nodeAdapter';
import { confirmContract, recordRentPayment, recordBulkRentPayment, RuleViolation } from '@/domain/contracts/service';
import { DISCOUNT_AFTER_DUE, DISCOUNT_REDUCES_INSTALLMENT } from '@/domain/contracts/installments';
import { postEntry, voidEntryById } from '@/domain/accounting/post';
import { savePurchase, deletePurchase } from '@/domain/purchases';
import { wipeAllData } from '@/domain/wipe';
import { trashItems, purgeManyFromTrash } from '@/domain/trash';
import type { DB } from '@/db/adapter';

const ROOT = path.resolve(__dirname, '..');
const dirs: string[] = [];
const newDir = () => { const d = tempDir('aq-lock-'); dirs.push(d); return d; };
afterAll(() => { for (const d of dirs) rmrf(d); });

const UNBALANCED = `SELECT e.no FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id
  WHERE e.status = 'مرحّل' GROUP BY e.id HAVING SUM(l.debit_halalas - l.credit_halalas) != 0`;

function contractWithInstallments(db: DB, monthly = 100000, tenant = 'مستأجر الاختبار') {
  const p = addProperty(db);
  const u = addUnit(db, p, { rent: monthly });
  const cid = confirmContract(db, contractInput(u, {
    tenant, valueHalalas: monthly * 12, depositHalalas: 0,
    idNumber: '10' + String(Math.floor(Math.random() * 1e8)).padStart(8, '0'),
  }));
  const insts = db.all<{ id: string }>(`SELECT id FROM contract_installments WHERE contract_id = ? ORDER BY due_date`, [cid]);
  return { cid, insts: insts.map((i) => i.id) };
}
/** دفعة بالمقبوض فعلاً وخصم فوقه · والخصم «بعد الاستحقاق» ما لم يُذكر غيره */
const pay = (db: DB, cid: string, instId: string | null, received: number, discount = 0, kind: string | null = DISCOUNT_AFTER_DUE) =>
  recordRentPayment(db, cid, {
    installmentId: instId, period: 'يناير', date: '2026-01-05', discountHalalas: discount, notes: '',
    discountKind: (discount ? kind : null) as never,
    lines: [{ method: 'cash', amountHalalas: received }],
  });
const inst = (db: DB, id: string) => db.get<{ amount: number; paid: number; disc: number }>(
  `SELECT i.amount_halalas AS amount, i.paid_halalas AS paid,
     COALESCE((SELECT SUM(p.discount_halalas) FROM contract_payments p WHERE p.installment_id = i.id), 0) AS disc
   FROM contract_installments i WHERE i.id = ?`, [id])!;

/** أرشيف صحيح البصمات والبيان من قاعدة عُبث بها بعد النسخ · ليصل الفحص الدلالي لا ما قبله */
async function craftArchive(mutate: (db: DB) => void): Promise<string> {
  const src = makeBackupEnv(newDir());
  const base = path.join(src.root, 'base.aqbk');
  await createBackup(src, base);
  src.closeLive();
  const entries: Record<string, Uint8Array> = unzipSync(new Uint8Array(fs.readFileSync(base)));
  const dbPath = path.join(src.root, 'mutated.db');
  fs.writeFileSync(dbPath, entries['data.db']);
  const db = openNodeDb(dbPath);
  mutate(db);
  const counts = tableCounts(db);
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.close();
  const bytes = new Uint8Array(fs.readFileSync(dbPath));
  const manifest = JSON.parse(new TextDecoder().decode(entries['manifest.json']));
  manifest.db_sha256 = await nodeHasher(bytes);
  manifest.table_counts = counts;
  entries['data.db'] = bytes;
  entries['manifest.json'] = new TextEncoder().encode(JSON.stringify(manifest));
  const out = path.join(src.root, 'crafted.aqbk');
  fs.writeFileSync(out, zipSync(entries));
  return out;
}

/** يمثّل كاتباً لا يمرّ بالخدمات (إصدار قديم أو استيراد): يعطّل محفّزات الإقفال على تلك النسخة وحدها */
function dropLockTriggers(db: DB): void {
  for (const t of ['trg_je_insert_balanced', 'trg_inst_update_cap', 'trg_inst_insert_cap', 'trg_pay_insert_cap', 'trg_pay_update_cap'])
    db.exec(`DROP TRIGGER IF EXISTS ${t}`);
}

describe('أ و و · الأذونات وallowBackup', () => {
  const manifest = fs.readFileSync(path.join(ROOT, 'android/app/src/main/AndroidManifest.xml'), 'utf8');
  const app = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8')).expo.android;

  test.each(['RECORD_AUDIO', 'SYSTEM_ALERT_WINDOW', 'READ_EXTERNAL_STORAGE', 'WRITE_EXTERNAL_STORAGE'])(
    '%s مُزال من الـManifest بـ tools:node="remove" ومحجوب في app.json', (perm) => {
      expect(manifest).toMatch(new RegExp(`android\\.permission\\.${perm}" tools:node="remove"`));
      expect(app.blockedPermissions).toContain('android.permission.' + perm);
    });

  test.each(['USE_BIOMETRIC', 'USE_FINGERPRINT'])(
    '%s الذي يجلبه المخزن الآمن مُزال · لا إذن جديد يدخل مع القسم ٤', (perm) => {
      expect(manifest).toMatch(new RegExp(`android\\.permission\\.${perm}" tools:node="remove"`));
      expect(app.blockedPermissions).toContain('android.permission.' + perm);
    });

  test('DUMP لا يطلبه التطبيق', () => {
    expect(manifest).not.toMatch(/permission\.DUMP/);
  });

  test('allowBackup = false و requestLegacyExternalStorage = false', () => {
    expect(manifest).toMatch(/android:allowBackup="false"/);
    expect(manifest).not.toMatch(/android:allowBackup="true"/);
    expect(manifest).toMatch(/android:requestLegacyExternalStorage="false"/);
    expect(app.allowBackup).toBe(false);
  });
});

describe('ب · expo-dev-client خارج البناء', () => {
  test('لا حزمة dev-client ولا launcher ولا menu في الاعتمادات ولا في القفل', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const all = { ...pkg.dependencies, ...pkg.devDependencies };
    for (const name of ['expo-dev-client', 'expo-dev-launcher', 'expo-dev-menu']) {
      expect(all[name]).toBeUndefined();
    }
    const lock = fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8');
    expect(lock).not.toMatch(/"node_modules\/expo-dev-(client|launcher|menu)"/);
  });
});

describe('ج · لا نسخة بلا تحقق كامل', () => {
  async function envWithFile(name: string) {
    const env = makeBackupEnv(newDir());
    const bytes = new Uint8Array(2048).map((_, i) => (i * 13) % 251);
    const a = await putAttachment(env.filesEnv, bytes, { entityType: 'library', kind: 'other', originalName: name });
    return { env, a, bytes, file: path.join(env.attachmentsDir, `${a.sha256}.${a.ext}`) };
  }

  test('وحدة البصمة غير متاحة: يُرفض برسالة عربية', async () => {
    const env = makeBackupEnv(newDir());
    await expect(createBackup({ ...env, db: env.db, hasher: null }, path.join(env.root, 'x.aqbk')))
      .rejects.toThrow(HashingUnavailableError);
    env.closeLive();
  });

  test('تعذّر حساب بصمة ملف: يُرفض ويُسمّى الملف ولا يبقى أرشيف', async () => {
    const { env, bytes } = await envWithFile('صك العقار.jpg');
    const throwing = async (b: Uint8Array) => {
      if (b.byteLength === bytes.byteLength && b[7] === bytes[7]) throw new Error('digest failed');
      return nodeHasher(b);
    };
    const out = path.join(env.root, 'x.aqbk');
    await expect(createBackup({ ...env, db: env.db, hasher: throwing }, out))
      .rejects.toThrow('تعذّر حساب بصمة الملف «صك العقار.jpg» · يُرفض إنشاء النسخة');
    expect(fs.existsSync(out)).toBe(false);
    env.closeLive();
  });

  test('تعذّر حساب بصمة لقطة القاعدة: يُرفض', async () => {
    const env = makeBackupEnv(newDir());
    let first = true;
    const throwing = async (b: Uint8Array) => { if (first) { first = false; throw new Error('x'); } return nodeHasher(b); };
    await expect(createBackup({ ...env, db: env.db, hasher: throwing }, path.join(env.root, 'x.aqbk')))
      .rejects.toThrow('تعذّر حساب بصمة لقطة قاعدة البيانات (data.db)');
    env.closeLive();
  });

  test('ملف تالف على القرص (بصمة لا تطابق): يُرفض ويُسمّى الملف', async () => {
    const { env, file } = await envWithFile('إيصال.pdf');
    const b = fs.readFileSync(file); b[10] ^= 0xff; fs.writeFileSync(file, b);
    const out = path.join(env.root, 'x.aqbk');
    await expect(createBackup(env, out))
      .rejects.toThrow('بصمة الملف «إيصال.pdf» لا تطابق المسجَّلة له · الملف تالف · يُرفض إنشاء النسخة');
    expect(fs.existsSync(out)).toBe(false);
    env.closeLive();
  });

  test('ملف مفقود من القرص: يُرفض ويُسمّى الملف', async () => {
    const { env, file } = await envWithFile('هوية المستأجر.png');
    fs.rmSync(file);
    await expect(createBackup(env, path.join(env.root, 'x.aqbk')))
      .rejects.toThrow(BackupVerificationError);
    await expect(createBackup(env, path.join(env.root, 'x.aqbk')))
      .rejects.toThrow('الملف «هوية المستأجر.png» مفقود من القرص');
    env.closeLive();
  });

  test('فحص سلامة مختلّ: يُرفض إنشاء النسخة ويُسمّى الفحص وقيمته', async () => {
    const env = makeBackupEnv(newDir());
    // تأمين على عقد سارٍ بلا قيده: «التأمينات المحتجزة» لا تطابق رصيد 2400
    env.db.run(`INSERT INTO properties (id,name,created_at) VALUES ('P','ع','x')`);
    env.db.run(`INSERT INTO units (id,property_id,unit_no,created_at) VALUES ('U','P','1','x')`);
    env.db.run(`INSERT INTO contracts (id,contract_no,tenant_name,unit_id,value_halalas,start,end,deposit_halalas,status,created_at)
                VALUES ('C','EJ-1','ف','U',100,'2026-01-01','2026-12-31',5000,'سارٍ','x')`);
    const out = path.join(env.root, 'x.aqbk');
    const err = await createBackup(env, out).catch((e) => e);
    expect(err).toBeInstanceOf(BackupIntegrityError);
    expect(err.message).toContain('يُرفض إنشاء النسخة · فحص السلامة مختلّ');
    expect(err.message).toContain('«تأمينات المستأجرين = التأمينات المحتجزة (غير المُسوَّاة)» (0.00 / 50.00)');
    expect(fs.existsSync(out)).toBe(false);
    env.closeLive();
  });

  test('النسخة الناجحة: كل ملف داخلها ولا شيء اسمه ناقصة', async () => {
    const { env, a } = await envWithFile('سليم.jpg');
    const m = await createBackup(env, path.join(env.root, 'ok.aqbk'));
    expect(m.complete).toBe(true);
    expect(m.missing_files).toEqual([]);
    expect(m.files.map((f) => f.sha256)).toContain(a.sha256);
    expect(m.integrity.every((c) => c.ok)).toBe(true);
    env.closeLive();
  });
});

describe('د · القيد المرحّل', () => {
  test('إدراج قيد مرحّل مباشرة بلا سطور: مرفوض', () => {
    const db = memDb();
    expect(() => db.run(`INSERT INTO journal_entries (id,no,date,memo,status,auto,created_at)
      VALUES ('X1','JE-X1','2026-01-01','م','مرحّل',0,'x')`)).toThrow('قيد بلا سطور');
    db.close();
  });

  test('سطور غير متوازنة سابقة ثم إدراج القيد مرحّلاً (المفاتيح معطّلة): مرفوض · والمتوازن يمرّ', () => {
    const db = memDb();
    db.exec('PRAGMA foreign_keys = OFF');
    db.run(`INSERT INTO journal_lines (id,entry_id,account_code,descr,debit_halalas,credit_halalas) VALUES ('L1','X2','1100','',100,0)`);
    expect(() => db.run(`INSERT INTO journal_entries (id,no,date,memo,status,auto,created_at)
      VALUES ('X2','JE-X2','2026-01-01','م','مرحّل',0,'x')`)).toThrow('قيد غير متوازن');
    db.run(`INSERT INTO journal_lines (id,entry_id,account_code,descr,debit_halalas,credit_halalas) VALUES ('L2','X3','1100','',100,0),('L3','X3','4200','',0,100)`);
    db.run(`INSERT INTO journal_entries (id,no,date,memo,status,auto,created_at) VALUES ('X3','JE-X3','2026-01-01','م','مرحّل',0,'x')`);
    db.exec('PRAGMA foreign_keys = ON');
    expect(db.all(UNBALANCED)).toHaveLength(0);
    db.close();
  });

  test('ترقية مسودة غير متوازنة بـ UPDATE: مرفوضة كما كانت', () => {
    const db = memDb();
    db.run(`INSERT INTO journal_entries (id,no,date,memo,status,auto,created_at) VALUES ('X4','JE-X4','2026-01-01','م','قيد الإنشاء',0,'x')`);
    db.run(`INSERT INTO journal_lines (id,entry_id,account_code,descr,debit_halalas,credit_halalas) VALUES ('L4','X4','1100','',100,0)`);
    expect(() => db.run(`UPDATE journal_entries SET status = 'مرحّل' WHERE id = 'X4'`)).toThrow('قيد غير متوازن');
    db.close();
  });

  test('القيد المرحّل لا يدخل السلة ولا يُحذف ولا تتغيّر حالته ولا تُحذف سطوره', () => {
    const db = memDb();
    const e = postEntry(db, { date: '2026-01-01', memo: 'م', lines: [
      { account: '1100', debit: 500, credit: 0 }, { account: '4200', debit: 0, credit: 500 }] })!;
    expect(() => db.run(`UPDATE journal_entries SET deleted_at = 'x' WHERE id = ?`, [e.id])).toThrow('قيد مرحّل لا يدخل السلة');
    expect(() => db.run(`DELETE FROM journal_entries WHERE id = ?`, [e.id])).toThrow('قيد مرحّل لا يُحذف');
    expect(() => db.run(`UPDATE journal_entries SET status = 'قيد الإنشاء' WHERE id = ?`, [e.id])).toThrow('قيد مرحّل لا تتغيّر حالته');
    expect(() => db.run(`DELETE FROM journal_lines WHERE entry_id = ?`, [e.id])).toThrow('قيد مرحّل لا يُعدَّل');
    // الإلغاء بالمسار الوحيد: voidEntryById لا يمسّ المرحّل
    voidEntryById(db, e.id);
    expect(db.get<{ d: string | null }>(`SELECT deleted_at AS d FROM journal_entries WHERE id = ?`, [e.id])!.d).toBeNull();
    db.close();
  });

  test('حذف فاتورة شراء: قيدها يُعكس ويبقى مرحّلاً خارج السلة', () => {
    const db = memDb();
    const id = savePurchase(db, {
      supplier: 'مورد', date: '2026-02-01', due: '2026-03-01', category: 'صيانة', incorpItem: '',
      amortize: false, amortizeMonths: null, exempt: true, excludeFromVat: true,
      subtotalHalalas: 10000, taxHalalas: 0, totalHalalas: 10000,
    });
    const je = db.get<{ j: string }>(`SELECT journal_entry_id AS j FROM purchases WHERE id = ?`, [id])!.j;
    deletePurchase(db, id);
    const row = db.get<{ status: string; deleted_at: string | null; reversed_by: string | null }>(
      `SELECT status, deleted_at, reversed_by FROM journal_entries WHERE id = ?`, [je])!;
    expect(row).toMatchObject({ status: 'مرحّل', deleted_at: null });
    expect(row.reversed_by).toBeTruthy();
    db.close();
  });

  test('مسح كل البيانات: لا قيد مرحّل في السلة · كل قيد يُعكس والأرصدة صفر', async () => {
    const env = makeBackupEnv(newDir());
    const db = env.db;
    const k = contractWithInstallments(db);
    pay(db, k.cid, k.insts[0], 100000);
    pay(db, k.cid, k.insts[1], 95000, 5000);
    savePurchase(db, {
      supplier: 'مورد', date: '2026-02-01', due: '2026-03-01', category: 'صيانة', incorpItem: '',
      amortize: false, amortizeMonths: null, exempt: true, excludeFromVat: true,
      subtotalHalalas: 7000, taxHalalas: 0, totalHalalas: 7000,
    });
    const before = Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM journal_entries WHERE status='مرحّل'`)!.n);
    await wipeAllData(env);
    const live = env.live();
    expect(Number(live.get<{ n: number }>(`SELECT COUNT(*) AS n FROM journal_entries WHERE status='مرحّل' AND deleted_at IS NOT NULL`)!.n)).toBe(0);
    expect(Number(live.get<{ n: number }>(`SELECT COUNT(*) AS n FROM journal_entries WHERE status='مرحّل'`)!.n)).toBe(before * 2);
    const nonZero = live.all(`SELECT l.account_code FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
      WHERE e.status = 'مرحّل' AND e.deleted_at IS NULL GROUP BY l.account_code HAVING SUM(l.debit_halalas - l.credit_halalas) != 0`);
    expect(nonZero).toEqual([]);
    expect(trashItems(live).filter((t) => t.table === 'journal_entries')).toHaveLength(0);
    env.closeLive();
  });

  test('قيد مرحّل في السلة من إصدار سابق: لا يُعرض فيها ولا يحذفه الحذف النهائي', () => {
    const db = memDb();
    const e = postEntry(db, { date: '2026-01-01', memo: 'قديم', lines: [
      { account: '1100', debit: 300, credit: 0 }, { account: '4200', debit: 0, credit: 300 }] })!;
    db.exec('DROP TRIGGER trg_je_posted_no_trash'); // حالة إصدار سابق
    db.run(`UPDATE journal_entries SET deleted_at = 'x' WHERE id = ?`, [e.id]);
    expect(trashItems(db).find((t) => t.id === e.id)).toBeUndefined();
    purgeManyFromTrash(db, [{ table: 'journal_entries', id: e.id }]);
    expect(db.get(`SELECT id FROM journal_entries WHERE id = ?`, [e.id])).toBeTruthy();
    expect(Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM journal_lines WHERE entry_id = ?`, [e.id])!.n)).toBe(2);
    db.close();
  });

  test('استعادة نسخة فيها قيد مرحّل غير متوازن: تُرفض كاملة ويُسمّى القيد والبيانات الحالية كما هي', async () => {
    const archive = await craftArchive((db) => {
      dropLockTriggers(db);
      db.exec('PRAGMA foreign_keys = OFF');
      db.run(`INSERT INTO journal_lines (id,entry_id,account_code,descr,debit_halalas,credit_halalas) VALUES ('LZ','XZ','1100','',5000,0)`);
      db.run(`INSERT INTO journal_entries (id,no,date,memo,status,auto,created_at) VALUES ('XZ','JE-9001','2026-01-01','م','مرحّل',0,'x')`);
    });
    const target = makeBackupEnv(newDir());
    const before = tableCounts(target.db);
    const err = await prepareRestore(target, archive).catch((e) => e);
    expect(err).toBeInstanceOf(RestoreError);
    expect(err.message).toContain('النسخة مرفوضة');
    expect(err.message).toContain('قيد مرحّل غير متوازن: JE-9001 (الفرق 50.00)');
    expect(tableCounts(target.db)).toEqual(before);
    target.closeLive();
  });
});

describe('هـ · المسدَّد مع الخصم لا يتجاوز مبلغ القسط', () => {
  test('الخدمة: دفعة على قسط مسدَّد بالكامل مرفوضة', () => {
    const db = memDb();
    const k = contractWithInstallments(db);
    pay(db, k.cid, k.insts[0], 100000);
    expect(() => pay(db, k.cid, k.insts[0], 100000)).toThrow('القسط مسدَّد بالكامل');
    expect(inst(db, k.insts[0])).toEqual({ amount: 100000, paid: 100000, disc: 0 });
    db.close();
  });

  test('الخدمة: دفعة أكبر من المتبقي مرفوضة · ولا قيد ولا دفعة', () => {
    const db = memDb();
    const k = contractWithInstallments(db);
    const entries = () => Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM journal_entries`)!.n);
    const n0 = entries();
    expect(() => pay(db, k.cid, k.insts[0], 150000))
      .toThrow('المقبوض مع الخصم (1,500.00) يتجاوز المتبقي على القسط (1,000.00)');
    expect(entries()).toBe(n0);
    expect(db.get(`SELECT id FROM contract_payments WHERE installment_id = ?`, [k.insts[0]])).toBeFalsy();
    db.close();
  });

  test('الخدمة: خصم سالب أو بلا نوع أو يتجاوز مع المقبوض المتبقي مرفوض · والخصم الأكبر من المقبوض يُقبل ما لم يتجاوزه', () => {
    const db = memDb();
    const k = contractWithInstallments(db);
    expect(() => pay(db, k.cid, k.insts[0], 100000, 150000)).toThrow(RuleViolation);
    expect(() => pay(db, k.cid, k.insts[0], 100000, 150000)).toThrow('المقبوض مع الخصم (2,500.00) يتجاوز المتبقي على القسط (1,000.00)');
    expect(() => pay(db, k.cid, k.insts[0], 100000, -1)).toThrow('الخصم لا يكون سالباً');
    expect(() => pay(db, k.cid, k.insts[0], 47000, 53000, null)).toThrow('حدّد نوع الخصم');
    expect(inst(db, k.insts[0]).paid).toBe(0);
    // ٤٧٠ مقبوضة وخصم ٥٣٠ أكبر منها · يغطيان القسط بالضبط
    pay(db, k.cid, k.insts[0], 47000, 53000);
    expect(inst(db, k.insts[0])).toEqual({ amount: 100000, paid: 47000, disc: 53000 });
    db.close();
  });

  test('الخدمة: المتبقي تماماً مع خصم يُقبل ويبلغ مبلغ القسط بالضبط', () => {
    const db = memDb();
    const k = contractWithInstallments(db);
    pay(db, k.cid, k.insts[0], 60000);
    pay(db, k.cid, k.insts[0], 30000, 10000);
    expect(inst(db, k.insts[0])).toEqual({ amount: 100000, paid: 90000, disc: 10000 });
    db.close();
  });

  test('القاعدة: كتابة مباشرة بمسدَّد يتجاوز المبلغ أو سالب مرفوضة', () => {
    const db = memDb();
    const k = contractWithInstallments(db);
    expect(() => db.run(`UPDATE contract_installments SET paid_halalas = amount_halalas * 3 WHERE id = ?`, [k.insts[0]]))
      .toThrow('المسدَّد مع الخصم يتجاوز مبلغ القسط');
    expect(() => db.run(`UPDATE contract_installments SET paid_halalas = -1 WHERE id = ?`, [k.insts[0]]))
      .toThrow('مسدَّد سالب على القسط');
    expect(() => db.run(`UPDATE contract_installments SET amount_halalas = 10 WHERE id = ?`, [k.insts[1]]))
      .not.toThrow(); // مبلغ أقل من غير مسدَّد يتجاوزه يمرّ
    db.close();
  });

  test('القاعدة: إدراج دفعة بخصم يتجاوز المتبقي أو بصافٍ سالب مرفوض · وقسط بمسدَّد يتجاوز مبلغه', () => {
    const db = memDb();
    const k = contractWithInstallments(db);
    // دفعة بنوع خصم تتجاوز وحدها مبلغ قسطها · ودفعة بلا نوع (صف قديم) يحرسها سقف القسط بخصمها
    expect(() => db.run(`INSERT INTO contract_payments (id,contract_id,installment_id,period,date,gross_halalas,discount_halalas,net_halalas,created_at,discount_kind)
      VALUES ('PV',?,?,'م','2026-01-01',200100,100,200000,'x','${DISCOUNT_REDUCES_INSTALLMENT}')`, [k.cid, k.insts[0]])).toThrow('الدفعة مع الخصم تتجاوز مبلغ القسط');
    expect(() => db.run(`INSERT INTO contract_payments (id,contract_id,installment_id,period,date,gross_halalas,discount_halalas,net_halalas,created_at)
      VALUES ('PX',?,?,'م','2026-01-01',200000,200000,0,'x')`, [k.cid, k.insts[0]])).toThrow('الخصم يتجاوز المتبقي على القسط');
    pay(db, k.cid, k.insts[0], 90000);
    expect(() => db.run(`INSERT INTO contract_payments (id,contract_id,installment_id,period,date,gross_halalas,discount_halalas,net_halalas,created_at)
      VALUES ('PW',?,?,'م','2026-01-02',20000,20000,0,'x')`, [k.cid, k.insts[0]])).toThrow('الخصم يتجاوز المتبقي على القسط');
    expect(() => db.run(`INSERT INTO contract_payments (id,contract_id,installment_id,period,date,gross_halalas,discount_halalas,net_halalas,created_at)
      VALUES ('PY',?,?,'م','2026-01-01',0,0,-5,'x')`, [k.cid, k.insts[0]])).toThrow('دفعة بصافٍ أو خصم سالب');
    expect(() => db.run(`INSERT INTO contract_installments (id,contract_id,due_date,amount_halalas,paid_halalas)
      VALUES ('IX',?,'2027-01-01',100,200)`, [k.cid])).toThrow('المسدَّد يتجاوز مبلغ القسط');
    db.close();
  });

  test('التحصيل الجماعي كما هو: الفائض رصيد دائن والأقساط لا تتجاوز مبلغها', () => {
    const db = memDb();
    const k = contractWithInstallments(db);
    recordBulkRentPayment(db, k.cid, { installmentIds: [k.insts[0], k.insts[1]], date: '2026-02-01', notes: '',
      lines: [{ method: 'cash', amountHalalas: 260000 }] });
    expect(inst(db, k.insts[0]).paid).toBe(100000);
    expect(inst(db, k.insts[1]).paid).toBe(100000);
    expect(Number(db.get<{ c: number }>(`SELECT t.credit_halalas AS c FROM tenants t JOIN contracts c ON c.tenant_id = t.id WHERE c.id = ?`, [k.cid])!.c)).toBe(60000);
    db.close();
  });

  test('الاستعادة: قسط يتجاوزه مسدَّده مع خصمه يرفض النسخة كاملة ويُسمّى المستأجر والقسط', async () => {
    const archive = await craftArchive((db) => {
      const k = contractWithInstallments(db, 100000, 'سلوى التجريبية');
      dropLockTriggers(db);
      db.run(`UPDATE contract_installments SET paid_halalas = 300000 WHERE id = ?`, [k.insts[0]]);
    });
    const target = makeBackupEnv(newDir());
    const err = await prepareRestore(target, archive).catch((e) => e);
    expect(err).toBeInstanceOf(RestoreError);
    expect(err.message).toContain('قسط يتجاوز المسدَّدُ مع الخصم مبلغَه أو مسدَّده سالب: سلوى التجريبية');
    expect(err.message).toContain('(3,000.00 من 1,000.00)');
    target.closeLive();
  });

  test('الاستعادة: مبلغ بالهللات ليس عدداً صحيحاً في أي جدول يرفض النسخة كاملة ويُسمّى الجدول والعمود', async () => {
    const archive = await craftArchive((db) => {
      contractWithInstallments(db, 100000, 'سلوى التجريبية');
      // قيد متوازن بسطور كسرية · محفّز التوازن يمرّره فلا يمسكه إلا فحص الأعداد
      db.run(`INSERT INTO journal_entries (id,no,date,memo,status,auto,created_at) VALUES ('XF','JE-9002','2026-01-01','م','قيد الإنشاء',0,'x')`);
      db.run(`INSERT INTO journal_lines (id,entry_id,account_code,descr,debit_halalas,credit_halalas) VALUES ('LF1','XF','1100','',500.5,0)`);
      db.run(`INSERT INTO journal_lines (id,entry_id,account_code,descr,debit_halalas,credit_halalas) VALUES ('LF2','XF','4200','',0,500.5)`);
      db.run(`UPDATE journal_entries SET status = 'مرحّل' WHERE id = 'XF'`);
      db.run(`UPDATE tenants SET credit_halalas = 10.25`);
    });
    const target = makeBackupEnv(newDir());
    const before = tableCounts(target.db);
    const err = await prepareRestore(target, archive).catch((e) => e);
    expect(err).toBeInstanceOf(RestoreError);
    expect(err.message).toBe('تعذّرت الاستعادة: النسخة مرفوضة · مبلغ بالهللات ليس عدداً صحيحاً: سطور القيود · مدين (1 سجل)، سطور القيود · دائن (1 سجل)، المستأجرون · دائن (1 سجل)');
    expect(tableCounts(target.db)).toEqual(before);
    target.closeLive();
  });

  test('الاستعادة: النسخة السليمة تمرّ بالفحص الدلالي نفسه', async () => {
    const archive = await craftArchive((db) => {
      const k = contractWithInstallments(db);
      recordRentPayment(db, k.cid, { installmentId: k.insts[0], period: 'يناير', date: '2026-01-05',
        discountHalalas: 20000, discountKind: DISCOUNT_AFTER_DUE, notes: '', lines: [{ method: 'cash', amountHalalas: 80000 }] });
    });
    const target = makeBackupEnv(newDir());
    const plan = await prepareRestore(target, archive);
    expect(plan.incoming.contract_payments).toBe(1);
    abortRestore(target, plan.stagingDir);
    target.closeLive();
  });
});
