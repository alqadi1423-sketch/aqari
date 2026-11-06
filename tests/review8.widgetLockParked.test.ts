/**
 * المراجعة الشاملة · البند ٢٣ (ملاحظة المتحقق المستقل ١): لقطة ودجتٍ مركونة مع حسابها تعود بمبالغها والقفل مفعّل.
 *
 * القفل للجهاز كله لا للحساب، ولقطة الودجت كانت تُركن مع نسخة الحساب (accountSlots: ITEMS) وتعود معها كما هي:
 * الحساب A يُركن والقفل مطفأ فتُركن لقطته بمبالغها · ثم يُفعَّل القفل تحت الحساب B · ثم يعود A فتعود لقطته القديمة
 * إلى مكان ما يقرؤه أندرويد بلا `locked` ولا تمرّ بـwriteWidgetSnapshot. واللقطة مشتقةٌ من القاعدة تُبنى عند كل كتابة،
 * فلا تُركن ولا تعود. بيانات مصطنعة · القرص في مجلد مؤقت، وخدمات الجهاز ببدائل في الذاكرة.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const kv = new Map<string, string>();
const lockFlag = { exists: false };
/** جذر بيانات التطبيق في هذا الاختبار · مجلد مؤقت حقيقي فيه القاعدة ونُسخ الحسابات ولقطة الودجت */
const disk = { root: '' };

jest.mock('react-native', () => ({ Platform: { OS: 'android' }, NativeModules: {} }));
jest.mock('expo-secure-store', () => ({
  getItemAsync: async (k: string) => kv.get(k) ?? null,
  setItemAsync: async (k: string, v: string) => { kv.set(k, v); },
  deleteItemAsync: async (k: string) => { kv.delete(k); },
}));
jest.mock('expo-local-authentication', () => ({ SecurityLevel: { NONE: 0 }, getEnrolledLevelAsync: async () => 0, authenticateAsync: async () => ({ success: false }) }));
// علامة القفل للجهاز كله · لا تُركن مع حساب
jest.mock('expo-file-system', () => ({
  Paths: { document: '/doc' },
  File: class {
    get exists() { return lockFlag.exists; }
    write() { lockFlag.exists = true; }
    delete() { lockFlag.exists = false; }
  },
}));
jest.mock('@/services/cipher', () => ({ deviceCipher: jest.requireActual('@/files/nodeCipher').nodeCipher }));
jest.mock('@/i18n', () => ({ t: (k: string) => k }));
jest.mock('@/files/expoFs', () => ({
  appDataRoot: () => disk.root,
  expoFs: jest.requireActual('@/files/nodeFs').nodeFs,
}));

import { tempDir, rmrf } from './helpers/testDb';
import { openNodeDb } from '@/db/nodeAdapter';
import { migrate } from '@/db/migrations';
import { seed as seedDb, ensureDeviceId } from '@/db/seed';
import { nodeFs } from '@/files/nodeFs';
import { enableSync } from '@/sync/engine';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { confirmContract, recordRentPayment } from '@/domain/contracts/service';
import { switchTo, slotDir, activeAccount, type SlotEnv } from '@/services/accountSlots';
import { writeWidgetSnapshot, widgetFilePath } from '@/services/widgetService';
import { enablePinLock } from '@/services/appLockService';
import type { DB } from '@/db/adapter';

const MONEY = /^-?[\d,]+\.\d{2}$/;
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmrf(d); });

/**
 * بيئة نُسخ الحسابات على قرصٍ مؤقت · والقاعدة كائنٌ واحد يبقى بعد الإغلاق وإعادة الفتح كما في التطبيق (slotsApp.ts: appDb.reopen)،
 * فاشتراك الودجت في القفل يبني من القاعدة النشطة أياً كان حسابها
 */
function makeEnv(): SlotEnv & { db(): DB } {
  const root = tempDir('aqari-widget-slots-').replace(/\\/g, '/');
  dirs.push(root);
  disk.root = root;
  nodeFs.mkdirp(root + '/SQLite');
  const dbFile = root + '/SQLite/aqari.db';
  let conn: DB = openNodeDb(dbFile);
  const db = new Proxy({} as DB, {
    get: (_t, k) => {
      const v = (conn as unknown as Record<string | symbol, unknown>)[k];
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(conn) : v;
    },
  });
  const prepareFresh = (d: DB) => { migrate(d); seedDb(d); ensureDeviceId(d); };
  prepareFresh(db);
  return {
    fs: nodeFs, root, dbFile,
    db: () => db,
    close: () => { try { conn.close(); } catch { /* مغلقة */ } },
    reopen: () => { conn = openNodeDb(dbFile); migrate(db); },
    prepareFresh,
  };
}

/** عقار ووحدة وعقد سنوي بأقساط شهرية، ودفعة نقدية لقسط يناير · فالمتأخر والنقد غير صفريين */
function seedAccount(db: DB): void {
  const cid = confirmContract(db, contractInput(addUnit(db, addProperty(db, { name: 'برج الياسمين' }), { unit_no: 'C-3' }),
    { tenant: 'مستأجر مصطنع', start: '2026-01-01', end: '2026-12-31', valueHalalas: 4800000 }));
  const inst = db.get<{ id: string; amount_halalas: number }>(
    `SELECT id, amount_halalas FROM contract_installments WHERE contract_id = ? ORDER BY due_date LIMIT 1`, [cid])!;
  recordRentPayment(db, cid, {
    installmentId: inst.id, date: '2026-01-05', period: '', discountHalalas: 0, notes: '',
    lines: [{ method: 'cash', amountHalalas: Number(inst.amount_halalas) }],
  });
}

/** ما في ملف الودجت الآن كما يقرؤه أندرويد · null بلا ملف («لا بيانات بعد») */
const fileNow = (): Record<string, unknown> | null =>
  fs.existsSync(widgetFilePath()) ? JSON.parse(fs.readFileSync(widgetFilePath(), 'utf8')) : null;

/** لا مبلغ ولا نسبة تحصيل ولا نقد · وعدد المتأخر باقٍ */
function expectNoMoney(s: Record<string, unknown> | null): void {
  expect(s).not.toBeNull();
  expect([s!.lateSum, s!.dueThisMonth, s!.paidThisMonth, s!.cash]).toEqual(['', '', '', '']);
  expect(s!.monthPct).toBe(0);
  expect(s!.locked).toBe(true);
  expect(JSON.stringify({ ...s, at: null })).not.toMatch(/\d\.\d{2}/);
  expect(Number(s!.lateCount)).toBeGreaterThan(0);
}

beforeEach(() => { kv.clear(); lockFlag.exists = false; });

describe('البند ٢٣ · لقطة الودجت لا تُركن مع الحساب ولا تعود معه', () => {
  test('٢٣ · حسابٌ رُكن والقفل مطفأ ثم فُعّل القفل تحت غيره: عودته لا تعيد لقطته بمبالغها', async () => {
    const env = makeEnv();
    const db = env.db();
    enableSync(db, 'ACC-A');
    seedAccount(db);
    // الحساب A والقفل مطفأ: لقطته بمبالغها
    writeWidgetSnapshot(db);
    const open = fileNow()!;
    expect(open.locked).toBe(false);
    expect(open.lateSum).toMatch(MONEY);
    expect(open.cash).not.toBe('0.00');

    // يدخل B فيُركن A · ثم يفعّل القفل تحت B (للجهاز كله)
    expect(switchTo(env, 'ACC-B')).toBe('switched');
    enableSync(db, 'ACC-B');
    await enablePinLock('4826', 0);
    expect(lockFlag.exists).toBe(true);

    // يعود A · ما يقرؤه أندرويد الآن وقبل أي كتابة جديدة لا يحمل مبالغ A
    expect(switchTo(env, 'ACC-A')).toBe('switched');
    expect(activeAccount(db)).toBe('ACC-A');
    expect(fileNow()).toBeNull();

    // وأول كتابة بعد العودة (onData) تبني من نسخة A بحال القفل ساعتها
    writeWidgetSnapshot(db);
    expectNoMoney(fileNow());
    env.close();
  });

  test('٢٣ · نسخةٌ رُكنت قبل هذا الإصلاح ومعها لقطةٌ بمبالغ: لا تعود اللقطة ولا تبقى في مكان النسخة', async () => {
    const env = makeEnv();
    const db = env.db();
    enableSync(db, 'ACC-A');
    seedAccount(db);
    writeWidgetSnapshot(db);
    const old = fs.readFileSync(widgetFilePath(), 'utf8');
    expect(JSON.parse(old).lateSum).toMatch(MONEY);

    expect(switchTo(env, 'ACC-B')).toBe('switched');
    // كما كان يركنها الإصدار السابق: اللقطة في مجلد نسخة A
    const parked = path.join(slotDir(env, 'ACC-A'), 'widget.json').replace(/\\/g, '/');
    fs.writeFileSync(parked, old);
    writeWidgetSnapshot(db);
    await enablePinLock('4826', 0);

    expect(switchTo(env, 'ACC-A')).toBe('switched');
    expect(fileNow()).toBeNull();
    expect(fs.existsSync(parked)).toBe(false);
    env.close();
  });

  // حارس: الركن صار حذفاً لا نقلاً، وما زال الداخل بعده لا يرى لقطة من قبله
  test('٢٣ · ركن الحساب لا يترك لقطته للداخل بعده', () => {
    const env = makeEnv();
    const db = env.db();
    enableSync(db, 'ACC-A');
    seedAccount(db);
    writeWidgetSnapshot(db);
    expect(fileNow()!.lateSum).toMatch(MONEY);
    expect(switchTo(env, 'ACC-B')).toBe('switched');
    expect(fileNow()).toBeNull();
    env.close();
  });
});
