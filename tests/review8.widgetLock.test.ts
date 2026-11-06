/**
 * المراجعة الشاملة · البند ٢٣: الودجت تعرض أرقاماً مالية والتطبيق مقفل.
 *
 * قفل التطبيق يحجب الواجهة، والودجت على الشاشة الرئيسية تقرأ `widget.json` بلا قفل، فكانت المبالغ ونسبة التحصيل والنقد
 * تظهر لمن يمسك الجهاز. القرار (أ): القفل مفعّل فاللقطة بلا مبالغ (الأعداد وحدها وحالة «مقفل»)، وتُعاد كتابتها حين يُفعَّل
 * القفل أو يُطفأ. بيانات مصطنعة · خدمات الجهاز ببدائل في الذاكرة.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const kv = new Map<string, string>();
const lockFlag = { exists: false };
/** ما كُتب في مجلد التطبيق · المسار والنص */
const written = new Map<string, string>();
let writes = 0;

jest.mock('react-native', () => ({ Platform: { OS: 'android' }, NativeModules: {} }));
jest.mock('expo-secure-store', () => ({
  getItemAsync: async (k: string) => kv.get(k) ?? null,
  setItemAsync: async (k: string, v: string) => { kv.set(k, v); },
  deleteItemAsync: async (k: string) => { kv.delete(k); },
}));
jest.mock('expo-local-authentication', () => ({ SecurityLevel: { NONE: 0 }, getEnrolledLevelAsync: async () => 0, authenticateAsync: async () => ({ success: false }) }));
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
  appDataRoot: () => '/data/aqari',
  expoFs: {
    write: (p: string, bytes: Uint8Array) => { writes++; written.set(p, new TextDecoder().decode(bytes)); },
    remove: (p: string) => { written.delete(p); },
  },
}));

import { memDb } from './helpers/testDb';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { confirmContract, recordRentPayment } from '@/domain/contracts/service';
import { writeWidgetSnapshot, widgetFilePath } from '@/services/widgetService';
import { enableDeviceLock, enablePinLock, disableLock, tryPin } from '@/services/appLockService';
import type { DB } from '@/db/adapter';

const MONEY = /^-?[\d,]+\.\d{2}$/;

/** دفعة نقدية كاملة لقسط الشهر المعطى */
function payMonth(db: DB, cid: string, month: string, date: string): void {
  const inst = db.get<{ id: string; amount_halalas: number }>(
    `SELECT id, amount_halalas FROM contract_installments WHERE contract_id = ? AND due_date LIKE ? ORDER BY due_date LIMIT 1`,
    [cid, month + '%'])!;
  recordRentPayment(db, cid, {
    installmentId: inst.id, date, period: '', discountHalalas: 0, notes: '',
    lines: [{ method: 'cash', amountHalalas: Number(inst.amount_halalas) }],
  });
}

/** عقار ووحدة وعقد سنوي بأقساط شهرية، ودفعة نقدية لقسط يناير · فالمتأخر والنقد غير صفريين */
function seed(): DB {
  const db = memDb();
  const cid = confirmContract(db, contractInput(addUnit(db, addProperty(db, { name: 'برج النخيل' }), { unit_no: 'B-7' }),
    { tenant: 'مستأجر مصطنع', start: '2026-01-01', end: '2026-12-31', valueHalalas: 3600000 }));
  payMonth(db, cid, '2026-01', '2026-01-05');
  return db;
}

/** ما في ملف الودجت الآن كما يقرؤه أندرويد */
const fileNow = (): Record<string, unknown> => JSON.parse(written.get(widgetFilePath()) ?? 'null');

/** لا مبلغ ولا نسبة تحصيل ولا نقد في الملف · والعدد باقٍ */
function expectNoMoney(s: Record<string, unknown>): void {
  expect([s.lateSum, s.dueThisMonth, s.paidThisMonth, s.cash]).toEqual(['', '', '', '']);
  expect(s.monthPct).toBe(0);
  expect(s.locked).toBe(true);
  expect(JSON.stringify({ ...s, at: null })).not.toMatch(/\d\.\d{2}/);
  expect(Number(s.lateCount)).toBeGreaterThan(0);
}

beforeEach(() => { kv.clear(); lockFlag.exists = false; written.clear(); writes = 0; });

describe('البند ٢٣ · الودجت والتطبيق مقفل', () => {
  test('٢٣ · القفل مفعّل: ملف الودجت بلا مبلغ ولا نسبة تحصيل ولا نقد · وعدد المتأخر وحده', () => {
    const db = seed();
    // تشغيلٌ والقفل مفعّلٌ من قبل (علامته في ملفات التطبيق): أول كتابة بعد الإقلاع
    lockFlag.exists = true;
    writeWidgetSnapshot(db);
    expectNoMoney(fileNow());
    db.close();
  });

  test('٢٣ · تفعيل القفل وإطفاؤه يعيدان كتابة اللقطة فوراً بلا انتظار تغييرٍ في البيانات', async () => {
    const db = seed();
    writeWidgetSnapshot(db);
    const open = fileNow();
    expect(open.locked).toBe(false);
    expect(open.lateSum).toMatch(MONEY);
    expect(open.cash).toMatch(MONEY);
    expect(open.cash).not.toBe('0.00');

    await enablePinLock('4826', 60);
    expectNoMoney(fileNow());

    await disableLock();
    const back = fileNow();
    expect(back.locked).toBe(false);
    expect(back.lateSum).toBe(open.lateSum);
    expect(back.cash).toBe(open.cash);

    // وبقفل الجهاز كذلك
    await enableDeviceLock(0);
    expectNoMoney(fileNow());
    db.close();
  });

  // حارسٌ للاشتراك الجديد لا دليلٌ على العيب: قبل الإصلاح لا مشترك فلا يتغيّر عدد الكتابات، وفشله عليه من expectNoMoney
  test('٢٣ · محاولة رمزٍ خاطئة لا تغيّر حال القفل فلا تعيد بناء اللقطة', async () => {
    const db = seed();
    writeWidgetSnapshot(db);
    await enablePinLock('4826', 0);
    const n = writes;
    expect(await tryPin('1111')).toBe('wrong');
    expect(writes).toBe(n);
    expectNoMoney(fileNow());
    db.close();
  });

  test('٢٣ · تعذّر بناء اللقطة والقفل يُفعَّل: لا تبقى لقطة المبالغ السابقة في الملف', async () => {
    const db = seed();
    writeWidgetSnapshot(db);
    expect(fileNow().lateSum).toMatch(MONEY);
    db.close(); // القاعدة لا تُقرأ فيتعذّر البناء
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    await enableDeviceLock(0);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
    expect(written.has(widgetFilePath())).toBe(false);
  });
});

describe('البند ٢٣ · الودجت في أندرويد (فحصٌ ثابت · لا يُبنى أندرويد هنا)', () => {
  const root = path.join(__dirname, '..', 'android', 'app', 'src', 'main');
  const kt = fs.readFileSync(path.join(root, 'java', 'com', 'aqari', 'app', 'AqariWidgets.kt'), 'utf8');
  const strings = fs.readFileSync(path.join(root, 'res', 'values', 'strings.xml'), 'utf8');
  const layouts = fs.readdirSync(path.join(root, 'res', 'layout'))
    .map((f) => fs.readFileSync(path.join(root, 'res', 'layout', f), 'utf8')).join('\n');

  /** جسم الكتلة بعد أول «{» يلي الموضع · بمطابقة الأقواس */
  const blockAfter = (src: string, at: number): string => {
    const open = src.indexOf('{', at);
    let depth = 0;
    for (let i = open; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) return src.slice(open + 1, i);
    }
    return src.slice(open + 1);
  };
  const AMOUNTS = /s\.(lateSum|dueThisMonth|paidThisMonth|monthPct)\b/;

  test('٢٣ · كوتلن تقرأ «locked» من اللقطة', () => {
    expect(kt).toMatch(/optBoolean\("locked"/);
    expect(kt.slice(kt.indexOf('internal data class Snapshot'), kt.indexOf('internal fun readSnapshot'))).toMatch(/val locked: Boolean/);
  });

  test.each(['TodayStripWidget', 'CollectionPanelWidget'])('٢٣ · %s: حال القفل تسبق كل مبلغ ولا تعرض شيئاً منه', (cls) => {
    const body = blockAfter(kt, kt.indexOf('class ' + cls));
    const lockAt = body.search(/if \(s\.locked\)/);
    expect(lockAt).toBeGreaterThan(-1);
    // فرع القفل قبل الفرع الذي يعرض المبالغ
    expect(lockAt).toBeLessThan(body.search(AMOUNTS));
    const branch = blockAfter(body, lockAt);
    expect(branch).not.toMatch(AMOUNTS);
    expect(branch).toMatch(/R\.string\.widget_locked/);
  });

  /** فروع سلسلة if / else if / else التي تبدأ عند الموضع · جسم كل فرع بمطابقة الأقواس */
  const ifChain = (src: string, at: number): string[] => {
    const out: string[] = [];
    let pos = at;
    for (;;) {
      const open = src.indexOf('{', pos);
      let depth = 0;
      let close = src.length;
      for (let i = open; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}' && --depth === 0) { close = i; break; }
      }
      out.push(src.slice(open + 1, close));
      const next = /^\s*else\b/.exec(src.slice(close + 1));
      if (!next) return out;
      pos = close + 1 + next[0].length;
    }
  };

  // ملاحظة المتحقق المستقل ١: الودجت كانت تثق بـ«locked» الذي يكتبه جافاسكربت وحده، فلقطةٌ لم تمرّ بـwriteWidgetSnapshot
  // (نسخة حساب مركونة عادت، أو لقطة الإصدار السابق بعد التحديث، أو تعذّر حذفها) تُعرض بمبالغها والقفل مفعّل
  test('٢٣ · كوتلن تعدّ علامة القفل نفسها قفلاً ولو خلت اللقطة من «locked» · وتعذّر فحصها قفلٌ', () => {
    const svc = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'appLockService.ts'), 'utf8');
    // العلامة في Paths.document · وهو على أندرويد context.filesDir نفسه الذي فيه widget.json (expo-file-system: persistentFilesDirectory)
    const flag = /new File\(Paths\.document, '([^']+)'\)/.exec(svc)?.[1];
    expect(flag).toBe('app-lock.flag');
    const read = blockAfter(kt, kt.indexOf('internal fun readSnapshot'));
    const assign = /\blocked = ([^\n]+)/.exec(read)?.[1] ?? '';
    expect(assign).toMatch(/optBoolean\("locked", false\)/);
    const fn = /\|\|\s*(\w+)\(context\)/.exec(assign)?.[1];
    expect(fn).toBeTruthy();
    const body = blockAfter(kt, kt.indexOf('fun ' + fn + '('));
    const constName = new RegExp(`const val (\\w+) = "${flag!.replace('.', '\\.')}"`).exec(kt)?.[1];
    expect(constName).toBeTruthy();
    expect(body).toContain(`File(context.filesDir, ${constName}).exists()`);
    expect(body).toMatch(/catch \(\w+: Exception\) \{\s*true\s*\}/);
  });

  // ملاحظة المتحقق المستقل ٢: RemoteViews يُطبَّق على العرض القائم حين لا يتغيّر التخطيط، فالشريط المخفيّ في حال القفل
  // كان يبقى مخفياً في حال «لا بيانات» و«لا صلاحية» بعدها
  test('٢٣ · لوحة التحصيل: كل فرعٍ يضبط ظهور شريط التقدّم · ويُخفيه فرع القفل وحده', () => {
    const body = blockAfter(kt, kt.indexOf('class CollectionPanelWidget'));
    const branches = ifChain(body, body.search(/if \(s\.noCollect\)/));
    expect(branches).toHaveLength(4);
    const vis = branches.map((b) => /setViewVisibility\(R\.id\.panel_bar, View\.(\w+)\)/.exec(b)?.[1] ?? null);
    // noCollect ثم empty ثم locked ثم العادي
    expect(vis).toEqual(['VISIBLE', 'VISIBLE', 'INVISIBLE', 'VISIBLE']);
  });

  test('٢٣ · كل سلسلة وكل معرّف تستعمله كوتلن معرَّفان · والسلاسل بلا شرطات طويلة', () => {
    const usedStrings = new Set([...kt.matchAll(/R\.string\.(\w+)/g)].map((m) => m[1]));
    for (const n of usedStrings) expect(strings).toContain(`<string name="${n}">`);
    const usedIds = new Set([...kt.matchAll(/R\.id\.(\w+)/g)].map((m) => m[1]));
    for (const n of usedIds) expect(layouts).toContain(`@+id/${n}"`);
    expect(strings).not.toMatch(/[—–‒−―]/);
    expect(strings).toMatch(/<string name="widget_locked_amount">[^<]+<\/string>/);
  });
});
