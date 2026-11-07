/**
 * التوجيه الرابع · ٣ · ٤: الصغير من المحسوم بالقاعدة ٩٩ (تقرير القرارات المعلّقة، القسم ٥):
 * ١٣ · لا «فاتورة ضريبية · قابلة للخصم» لمنشأة غير مسجّلة في ضريبة القيمة المضافة: لا يُخصم ما لا يُقدَّم عنه إقرار ·
 * ١٨ · لا رقم ضريبي فيما يخرج لمنشأة غير مسجّلة (رأس التقارير المطبوعة وملفات إكسل كرأس المستندات): لا يوحي المستند بأنه ضريبي ·
 * بيانات مصطنعة.
 */
import fs from 'fs';
import path from 'path';
import { memDb } from './helpers/testDb';
import { savePurchase, taxStatusesFor, TS_DEDUCTIBLE, TS_EXCLUDED, TAX_STATUSES } from '@/domain/purchases';
import { buildXlsx } from '@/domain/officeBuild';
import { shownVatNo } from '@/domain/printDocs';
import { unzipSync, strFromU8 } from 'fflate';
import type { DB } from '@/db/adapter';

const register = (db: DB, on: boolean) => db.run(`UPDATE company SET vat_enabled = ?, vatno = ? WHERE id = 1`, [on ? 1 : 0, '300000000000003']);
const supplier = (db: DB) => db.run(`INSERT INTO suppliers (id, name, vat, created_at) VALUES ('S1', 'مورد مصطنع', '311111111100003', '2026-01-01T00:00:00.000Z')`);
const purchase = (status: typeof TS_DEDUCTIBLE) => ({
  supplier: 'مورد مصطنع', date: '2026-03-01', due: '2026-03-31', category: 'مصروفات أخرى', incorpItem: '', amortize: false,
  amortizeMonths: null, exempt: false, excludeFromVat: false, subtotalHalalas: 100000, taxHalalas: 15000, totalHalalas: 115000,
  taxStatus: status, notes: '',
} as never);

describe('١٣ · «قابلة للخصم» للمنشأة المسجّلة وحدها', () => {
  test('غير مسجّلة: الحفظ يُرفض بسببه، والخيار لا يظهر', () => {
    const db = memDb();
    supplier(db);
    register(db, false);
    expect(() => savePurchase(db, purchase(TS_DEDUCTIBLE))).toThrow(/غير مسجّلة/);
    expect(taxStatusesFor(db)).not.toContain(TS_DEDUCTIBLE);
    expect(taxStatusesFor(db)).toContain(TS_EXCLUDED);
  });

  test('مسجّلة: تُحفظ قابلةً للخصم، والخيارات كلها', () => {
    const db = memDb();
    supplier(db);
    register(db, true);
    expect(() => savePurchase(db, purchase(TS_DEDUCTIBLE))).not.toThrow();
    expect(taxStatusesFor(db)).toEqual(TAX_STATUSES);
  });

  test('فاتورةٌ قابلة للخصم من زمن التسجيل تبقى كما هي عند تعديلها بعد إلغائه، ولا تُحوَّل إليها فاتورةٌ أخرى', () => {
    const db = memDb();
    supplier(db);
    register(db, true);
    const id = savePurchase(db, purchase(TS_DEDUCTIBLE));
    const other = savePurchase(db, purchase(TS_EXCLUDED));
    register(db, false);
    expect(() => savePurchase(db, { ...(purchase(TS_DEDUCTIBLE) as object), notes: 'تعديل مصطنع' } as never, id)).not.toThrow();
    expect(taxStatusesFor(db, TS_DEDUCTIBLE)).toContain(TS_DEDUCTIBLE);
    expect(() => savePurchase(db, purchase(TS_DEDUCTIBLE), other)).toThrow(/غير مسجّلة/);
  });
});

describe('١٨ · لا رقم ضريبي فيما يخرج لمنشأة غير مسجّلة', () => {
  test('shownVatNo: الرقم للمسجّلة وحدها', () => {
    expect(shownVatNo({ vatEnabled: true, vatno: '300000000000003' })).toBe('300000000000003');
    expect(shownVatNo({ vatEnabled: false, vatno: '300000000000003' })).toBeUndefined();
  });

  const sheetText = (doc: Parameters<typeof buildXlsx>[1]) => {
    const z = unzipSync(buildXlsx([{ name: 'ورقة', blocks: [{ heading: 'كتلة', meta: [], sections: [{ title: 'قسم', header: ['أ'], rows: [['ب']] }], totals: [] }] }], doc));
    return Object.entries(z).filter(([k]) => /sharedStrings|sheet\d*\.xml/.test(k)).map(([, v]) => strFromU8(v)).join('\n');
  };

  test('ملف إكسل: سطر الرقم الضريبي وخانته للمسجّلة وحدها', () => {
    const base = { companyName: 'منشأة مصطنعة', report: 'تقرير مصطنع', period: '2026' };
    expect(sheetText({ ...base, companyVatno: '300000000000003' })).toMatch(/الرقم الضريبي/);
    expect(sheetText({ ...base })).not.toMatch(/الرقم الضريبي/);
  });

  test('رأس التقارير المطبوعة وملفات التصدير يأخذان الرقم من shownVatNo', () => {
    const src = (rel: string) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
    expect(src('src/services/print.ts')).toMatch(/function companyHeader[\s\S]{0,200}shownVatNo\(/);
    expect(src('src/services/reportExport.ts')).toMatch(/companyVatno: (vatReturn \? vatReturnVatNo\(co\) : )?shownVatNo\(/);
  });
});

// ١٦ · نسخة أمانٍ من قاعدةٍ فارغة لا تحذف نسخةً فيها بيانات (القاعدة ٩٩ · القرارات المعلّقة القسم ٥ البند ١٦): كانت «نسخة واحدة تبقى»
// فمسحٌ ثم مسحٌ آخر يترك نسخة القاعدة الفارغة وحدها وقد حذف التي فيها البيانات
import { makeSafetyBackup, safetyBackupsDir } from '@/domain/backup/create';
import { fileDb, tempDir, rmrf } from './helpers/testDb';
import { openNodeDb } from '@/db/nodeAdapter';
import { nodeFs, nodeHasher } from '@/files/nodeFs';
import { addProperty } from './helpers/fixtures';
import type { BackupEnv } from '@/domain/backup/types';

describe('١٦ · نسخة الأمان من قاعدةٍ فارغة', () => {
  const envOf = (root: string, db: DB, dbPath: string): BackupEnv => ({
    db, dbPath, fs: nodeFs, hasher: nodeHasher,
    attachmentsDir: path.join(root, 'attachments'), tmpDir: path.join(root, 'tmp'), appVersion: '1.0.0-test',
    openDb: (p) => openNodeDb(p), closeLive: () => { /* لا يُغلق هنا */ }, reopenLive: () => db,
  });

  test('لا تحذف نسخةً فيها بيانات، والقاعدة ذات البيانات تُبقي نسختها وحدها كما كانت', async () => {
    const root = tempDir('aqari-safety-');
    try {
      const full = fileDb(root, 'full.db');
      addProperty(full.db, { name: 'عقار نسخة أمان مصطنع' });
      const withData = envOf(root, full.db, full.path);
      const first = await makeSafetyBackup(withData, 'pre-wipe');
      const empty = fileDb(root, 'empty.db');
      const emptyEnv = envOf(root, empty.db, empty.path);
      await makeSafetyBackup(emptyEnv, 'pre-wipe');
      const names = () => nodeFs.list(safetyBackupsDir(emptyEnv)).filter((n) => n.endsWith('.aqbk'));
      expect(names()).toContain(path.basename(first));
      expect(names().length).toBe(2);
      // ونسخةٌ جديدة من قاعدةٍ فيها بيانات تحلّ محل ما قبلها كما كانت
      const last = await makeSafetyBackup(withData, 'pre-restore');
      expect(names()).toEqual([path.basename(last)]);
      full.db.close();
      empty.db.close();
    } finally {
      rmrf(root);
    }
  });

  test('سطر المساحة يعدّ نسخ الأمان كلها باسمها', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'app/settings.tsx'), 'utf8');
    expect(src).not.toMatch(/نسخة الأمان قبل آخر استيراد أو مسح/);
    expect(src).toMatch(/storageRow\('نسخ الأمان'/);
  });
});

// ٣ · أبعاد القيد المرحّل (العقار والوحدة والعقد ومركز التكلفة والأصل) تُملأ مرةً إن كانت فارغة ولا تُغيَّر قيمةٌ قائمة (القاعدة ٩٩ ·
// القرارات المعلّقة القسم ٥ البند ٣ · قاعدة المالك ٩٠ «سطور القيد المختوم لا تُمسّ»)
import { postEntry } from '@/domain/accounting/post';
import { pair, sync, has } from './helpers/rederive';

describe('٣ · أبعاد القيد المرحّل تُملأ ولا تُغيَّر', () => {
  const posted = (db: DB, propertyId: string | null) => postEntry(db, {
    date: '2026-03-01', memo: 'قيد يدوي مصطنع', srcType: null as never, srcId: null as never,
    lines: [
      { account: '1100', descr: 'مدين', debit: 1000, credit: 0, dims: { propertyId } },
      { account: '4300', descr: 'دائن', debit: 0, credit: 1000, dims: { propertyId } },
    ],
  } as never)!;

  test('القاعدة نفسها ترفض تغيير بُعدٍ قائم في سطرٍ مرحّل، وتقبل ملء الفارغ', () => {
    const db = memDb();
    const pa = addProperty(db, { name: 'عقار بُعد أ مصطنع' });
    const pb = addProperty(db, { name: 'عقار بُعد ب مصطنع' });
    const e1 = posted(db, pa);
    expect(() => db.run(`UPDATE journal_lines SET property_id = ? WHERE entry_id = ?`, [pb, e1.id])).toThrow(/بُعد/);
    const e2 = posted(db, null);
    expect(() => db.run(`UPDATE journal_lines SET property_id = ? WHERE entry_id = ?`, [pb, e2.id])).not.toThrow();
    expect(db.get<{ p: string }>(`SELECT property_id AS p FROM journal_lines WHERE entry_id = ? LIMIT 1`, [e2.id])!.p).toBe(pb);
  });

  test('المزامنة تملأ الفارغ ولا تغيّر القائم، ولا يُرفض القيد بسببه', async () => {
    const s = await pair();
    const pa = addProperty(s.owner, { name: 'عقار بُعد أ مصطنع' });
    const pb = addProperty(s.owner, { name: 'عقار بُعد ب مصطنع' });
    await sync(s.owner, s.r);
    await sync(s.dev, s.r);
    const e = posted(s.owner, pa);
    await sync(s.owner, s.r);
    await sync(s.dev, s.r);
    const doc = [...s.r.docs.values()].find((d) => d.t === 'journal_entries' && d.k === e.id)!;
    s.r.inject({ ...doc, lines: doc.lines!.map((l) => ({ ...l, property_id: pb, unit_id: 'U-مصطنعة' })) });
    await sync(s.dev, s.r);
    const lines = s.dev.all<{ p: string | null; u: string | null }>(`SELECT property_id AS p, unit_id AS u FROM journal_lines WHERE entry_id = ?`, [e.id]);
    expect(lines.every((l) => l.p === pa)).toBe(true);
    expect(lines.every((l) => l.u === 'U-مصطنعة')).toBe(true);
    expect(has(s.dev, e.id)).toBe(true);
    s.close();
  });
});
