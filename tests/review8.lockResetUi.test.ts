/**
 * المراجعة الشاملة · البند ٥ · الواجهة: بوابة القفل تُشغَّل فعلاً لا يُقرأ نصّها (المتحقق المستقل: حذفُ حوار التنبيه وإعادة
 * كتابة السجل وتنبيه الشاشة لم يُفشل اختبار النصّ) · مشغّلُ خطافاتٍ صغير (useState وuseRef وuseEffect) يرسم المكوّنات
 * دوالَّ ويجري آثارها، والمكوّنات المرئية أسماءٌ تُفحص خصائصها وتُضغط · والخدمة حقيقية بمخزنٍ آمنٍ وملفاتٍ مصطنعة.
 */
import type { AccountProof } from '@/cloud/session';
import type { DB } from '@/db/adapter';

type Slot = { deps?: unknown[]; cleanup?: (() => void) | void } | { current: unknown } | unknown;
const mockH = {
  slots: new Map<string, Slot[]>(), path: '', i: 0, dirty: false,
  effects: [] as Array<() => void>, visited: new Set<string>(),
};
const kv = new Map<string, string>();
const files = new Map<string, string>();
const fsFail = { read: false };
const nativeClock = { ms: 80_000_000 };
const device = { level: 0, pass: false };
const mockUi = {
  account: true,
  prove: (): Promise<AccountProof> => Promise.resolve({ ok: true, serverMs: Date.now() }),
  cloudListeners: new Set<() => void>(),
  appListeners: new Set<(s: string) => void>(),
  dialogs: [] as Array<{ title: string; body?: string; actions: Array<{ label: string; onPress?: () => void | Promise<void> }> }>,
  db: null as DB | null,
  // ق٠-٦: مزوّد الحساب، ومفتاح الاسترداد للمالك (services/lockRecovery.ts)
  provider: 'google' as 'google' | 'device' | null,
  keyOffer: false,
  keyChecks: [] as string[],
  keyOk: (_k: string): boolean => false,
};

jest.mock('react', () => {
  const actual = jest.requireActual<Record<string, unknown>>('react');
  const slot = (): { s: Slot[]; i: number } => {
    let s = mockH.slots.get(mockH.path);
    if (!s) mockH.slots.set(mockH.path, (s = []));
    return { s, i: mockH.i++ };
  };
  return {
    ...actual,
    useState: (init: unknown) => {
      const { s, i } = slot();
      if (!(i in s)) s[i] = typeof init === 'function' ? (init as () => unknown)() : init;
      const set = (v: unknown) => {
        const nv = typeof v === 'function' ? (v as (p: unknown) => unknown)(s[i]) : v;
        if (nv !== s[i]) { s[i] = nv; mockH.dirty = true; }
      };
      return [s[i], set];
    },
    useRef: (init: unknown) => {
      const { s, i } = slot();
      if (!(i in s)) s[i] = { current: init };
      return s[i];
    },
    useEffect: (fn: () => (() => void) | void, deps?: unknown[]) => {
      const { s, i } = slot();
      const prev = s[i] as { deps?: unknown[]; cleanup?: (() => void) | void } | undefined;
      if (prev && deps && prev.deps && deps.every((d, j) => Object.is(d, prev.deps![j]))) return;
      const rec: { deps?: unknown[]; cleanup?: (() => void) | void; effect: true } = { deps, cleanup: prev?.cleanup, effect: true };
      s[i] = rec;
      mockH.effects.push(() => { if (typeof rec.cleanup === 'function') rec.cleanup(); rec.cleanup = fn(); });
    },
  };
});
jest.mock('react-native', () => ({
  NativeModules: { AqariClock: { elapsedRealtime: () => nativeClock.ms } },
  AppState: {
    currentState: 'active',
    addEventListener: (_e: string, f: (s: string) => void) => { mockUi.appListeners.add(f); return { remove: () => { mockUi.appListeners.delete(f); } }; },
  },
  View: 'View',
}));
jest.mock('expo-secure-store', () => ({
  getItemAsync: async (k: string) => kv.get(k) ?? null,
  setItemAsync: async (k: string, v: string) => { kv.set(k, v); },
  deleteItemAsync: async (k: string) => { kv.delete(k); },
}));
jest.mock('expo-local-authentication', () => ({
  SecurityLevel: { NONE: 0 },
  getEnrolledLevelAsync: async () => device.level,
  authenticateAsync: async () => ({ success: device.pass }),
}));
jest.mock('expo-file-system', () => ({
  Paths: { document: '/doc' },
  File: class {
    name: string;
    constructor(_dir: string, name: string) { this.name = name; }
    get exists() { return files.has(this.name); }
    textSync() { if (fsFail.read) throw new Error('fs'); return files.get(this.name) ?? ''; }
    write(v: string) { files.set(this.name, v); }
    delete() { files.delete(this.name); }
  },
}));
jest.mock('@/services/cipher', () => ({ deviceCipher: jest.requireActual('@/files/nodeCipher').nodeCipher }));
jest.mock('@/i18n', () => ({
  t: (k: string) => k,
  useLang: () => ({ t: (k: string, p?: Record<string, unknown>) => (p ? k + ' ' + JSON.stringify(p) : k) }),
}));
jest.mock('@/ui/components', () => ({ T: 'T', BtnPrimary: 'BtnPrimary', BtnGhost: 'BtnGhost', Field: 'Field', Note: 'Note' }));
jest.mock('@/ui/theme', () => ({ C: { paper: '#fff' }, TYPE: { screenTitle: 20 } }));
jest.mock('@/ui/AppDialog', () => ({ showDialog: (d: (typeof mockUi.dialogs)[number]) => { mockUi.dialogs.push(d); } }));
jest.mock('@/ui/lockState', () => ({ setAppLocked: () => undefined }));
jest.mock('@/db/expoAdapter', () => ({ appDb: () => { if (!mockUi.db) throw new Error('db closed'); return mockUi.db; } }));
jest.mock('@/services/lockRecovery', () => ({
  keyResetOffered: async () => mockUi.keyOffer,
  checkRecoveryKey: async (k: string) => { mockUi.keyChecks.push(k); return mockUi.keyOk(k); },
}));
jest.mock('@/services/cloud', () => ({
  confirmSameAccount: () => mockUi.prove(),
  accountConfirmable: () => mockUi.account,
  accountProvider: () => mockUi.provider,
  subscribeCloud: (l: () => void) => { mockUi.cloudListeners.add(l); return () => { mockUi.cloudListeners.delete(l); }; },
}));

import * as React from 'react';
import { LockGate } from '@/ui/LockGate';
import * as svc from '@/services/appLockService';
import { RESET_LIMIT, resetWhen } from '@/domain/lockReset';
import { memDb } from './helpers/testDb';

/* ═══ الرسم ═══ */

type Host = { type: string; props: Record<string, unknown>; children: Node[] };
type Node = Host | string;
const RealFragment = (jest.requireActual('react') as typeof React).Fragment;
let root: unknown = null;
let tree: Node[] = [];

function draw(node: unknown, path: string): Node[] {
  if (node === null || node === undefined || typeof node === 'boolean') return [];
  if (Array.isArray(node)) return node.flatMap((c, i) => draw(c, `${path}.${i}`));
  if (typeof node === 'string' || typeof node === 'number') return [String(node)];
  const el = node as { type: unknown; props: Record<string, unknown> };
  if (el.type === RealFragment) return draw(el.props.children, path + '/f');
  if (typeof el.type === 'function') {
    const p = `${path}/${(el.type as { name: string }).name}`;
    mockH.visited.add(p);
    mockH.path = p; mockH.i = 0;
    return draw((el.type as (props: unknown) => unknown)(el.props), p);
  }
  const type = String(el.type);
  return [{ type, props: el.props, children: draw(el.props.children, `${path}/${type}`) }];
}

async function round(): Promise<boolean> {
  mockH.dirty = false;
  mockH.visited = new Set();
  tree = draw(root, 'r');
  // ما لم يُرسم أُزيل: تُنظَّف آثاره
  for (const [p, s] of [...mockH.slots]) {
    if (mockH.visited.has(p)) continue;
    for (const x of s) {
      const c = x && typeof x === 'object' && 'effect' in x ? (x as { cleanup?: unknown }).cleanup : undefined;
      if (typeof c === 'function') c();
    }
    mockH.slots.delete(p);
  }
  const effects = mockH.effects.splice(0);
  for (const f of effects) f();
  await new Promise((r) => setTimeout(r, 4));
  return mockH.dirty || effects.length > 0;
}
/** يُرسم حتى يتحقق الشرط (أو تمضي عشر ثوانٍ) */
async function until(pred: () => boolean, what: string): Promise<void> {
  const end = Date.now() + 10_000;
  for (;;) {
    await round();
    if (pred()) return;
    if (Date.now() > end) throw new Error('لم يتحقق: ' + what + '\n' + JSON.stringify(flat().map((n) => [n.type, n.props.title ?? n.props.label ?? text(n)])));
  }
}
/** يُرسم حتى تسكن الآثار والوعود */
async function settle(): Promise<void> {
  let quiet = 0;
  for (let k = 0; k < 200 && quiet < 6; k++) quiet = (await round()) ? 0 : quiet + 1;
}
function mount(): void {
  mockH.slots.clear();
  root = React.createElement(LockGate, null, React.createElement('T', null, 'محتوى التطبيق'));
}
function unmount(): Promise<void> {
  root = null;
  return settle();
}

const flat = (ns: Node[] = tree): Host[] => ns.flatMap((n) => (typeof n === 'string' ? [] : [n, ...flat(n.children)]));
const text = (n: Host): string => n.children.map((c) => (typeof c === 'string' ? c : text(c))).join('');
const button = (title: string): Host | undefined => flat().find((n) => /^Btn/.test(n.type) && n.props.title === title);
const field = (label: string): Host | undefined => flat().find((n) => n.type === 'Field' && n.props.label === label);
const notes = (): string[] => flat().filter((n) => n.type === 'Note').map(text);
const lockShown = (): boolean => flat().some((n) => n.type === 'T' && text(n) === 'lock.title');
const press = (h: Host | undefined): unknown => (h!.props.onPress as () => unknown)();
const type = (label: string, v: string): void => { (field(label)!.props.onChange as (s: string) => void)(v); };
const appState = (s: string): void => { for (const f of [...mockUi.appListeners]) f(s); };
/** خروجٌ إلى الخلفية وعودة (المهلة «فوراً») · بعد انقضاء نافذة قوقل بالساعة الرتيبة */
const leaveAndReturn = (): void => { nativeClock.ms += 5_000; appState('background'); appState('active'); };
const auditRows = (): number =>
  mockUi.db!.get<{ n: number }>(`SELECT COUNT(*) AS n FROM audit_log WHERE entity_name LIKE '%أُعيد ضبط رمزه%'`)!.n;
const proveOk = (): Promise<AccountProof> => Promise.resolve({ ok: true, serverMs: Date.now() });

async function newPin(pin: string): Promise<void> {
  await until(() => !!field('lock.newPin'), 'نموذج الرمز الجديد');
  type('lock.newPin', pin); type('lock.repeatPin', pin);
  await round();
  press(button('lock.saveNewPin'));
  await until(() => !lockShown(), 'الفتح بعد حفظ الرمز الجديد');
}

beforeEach(async () => {
  await unmount();
  kv.clear(); files.clear(); fsFail.read = false;
  nativeClock.ms += 10_000_000; device.level = 0; device.pass = false;
  mockUi.account = true; mockUi.prove = proveOk; mockUi.dialogs = []; mockUi.cloudListeners.clear();
  mockUi.provider = 'google'; mockUi.keyOffer = false; mockUi.keyChecks = []; mockUi.keyOk = () => false;
  mockUi.db = memDb();
});
afterAll(() => unmount());

/* ═══ الحدّ يُرى في الواجهة قبل الضغط ═══ */

test('٥ الواجهة: ما فشل قبل الدخول لا يُحسب فلا يُعرض الزر ثم يرفض · وبعد ثلاث إعادات يختفي «نسيت الرمز» ويظهر كم بقي', async () => {
  await svc.enablePinLock('4826', 0);
  mount();
  await until(() => !!button('lock.forgotPin'), 'زر «نسيت الرمز»');
  // ثلاث نقرات تفشل قبل الدخول: الشبكة، والإلغاء، وساعةٌ منحرفة · الزر باقٍ والرابعة تبلغ قوقل فعلاً
  const failing: Array<() => Promise<AccountProof>> = [
    () => Promise.reject(new Error('Network request failed')),
    () => Promise.resolve({ ok: false, why: 'cancel' }),
    () => Promise.resolve({ ok: false, why: 'stale' }),
  ];
  for (const f of failing) {
    mockUi.prove = f;
    await press(button('lock.forgotPin'));
    await settle();
    expect(button('lock.forgotPin')).toBeDefined();
  }
  let proved = 0;
  mockUi.prove = () => { proved++; return proveOk(); };
  await press(button('lock.forgotPin'));
  expect(proved).toBe(1);
  await newPin('2468');
  // إعادتان أخريان فيبلغ الحدّ
  for (let i = 1; i < RESET_LIMIT; i++) expect(await svc.recoverByAccount(proveOk, () => undefined)).toEqual({ ok: true });
  leaveAndReturn();
  await until(lockShown, 'القفل عند العودة');
  await settle();
  expect(button('lock.forgotPin')).toBeUndefined();
  expect(notes()).toContain('lock.resetLimit {"n":24}');
});

test('٥ الواجهة: بلا حساب على الجهاز لا يظهر «نسيت الرمز» (كان يظهر ولا ينجح أبداً) · ويظهر حين يُستعاد الحساب · وتعذّر قراءة السجل يُقال كما هو', async () => {
  await svc.enablePinLock('4826', 0);
  mockUi.account = false;
  mount();
  await until(lockShown, 'شاشة القفل');
  await settle();
  expect(button('lock.forgotPin')).toBeUndefined();
  mockUi.account = true;
  for (const l of [...mockUi.cloudListeners]) l();
  await until(() => !!button('lock.forgotPin'), 'الزر بعد استعادة الجلسة');
  await unmount();
  // سجلٌّ تعذّرت قراءته بنسختيه: لا زرّ ولا «بعد ٢٤ ساعة»
  expect(await svc.recoverByAccount(proveOk, () => undefined)).toEqual({ ok: true });
  for (const k of [...kv.keys()]) if (k !== 'aqari_app_lock') kv.set(k, '{bad');
  fsFail.read = true;
  mount();
  await until(() => notes().includes('lock.resetStoreFailed'), 'سبب تعذّر السجل');
  expect(button('lock.forgotPin')).toBeUndefined();
  expect(notes().some((n) => n.startsWith('lock.resetLimit'))).toBe(false);
});

/* ═══ الإشعار: تنبيه الشاشة · وحوار الفتح التالي · وسطر السجل المتعذّر ═══ */

test('٥ الواجهة: بعد إعادة الضبط تنبيهٌ على شاشة القفل وحوارٌ في الفتح التالي لا في فتحها نفسه · وسطر السجل المتعذّر يُكتب عند الفتح', async () => {
  await svc.enablePinLock('4826', 0);
  const db = mockUi.db!;
  mockUi.db = null; // تتعذّر القاعدة عند إعادة الضبط
  mount();
  await until(() => !!button('lock.forgotPin'), 'زر «نسيت الرمز»');
  await press(button('lock.forgotPin'));
  await newPin('2468');
  await settle();
  // الفتح الذي يلي إعادة الضبط نفسها: لا حوار
  expect(mockUi.dialogs).toEqual([]);
  mockUi.db = db;
  expect(auditRows()).toBe(0);
  leaveAndReturn();
  await until(lockShown, 'القفل عند العودة');
  await until(() => notes().some((n) => n.startsWith('lock.resetNotice')), 'تنبيه شاشة القفل');
  const at = (await svc.resetStatus()).notice!.at;
  expect(notes()).toContain('lock.resetNotice ' + JSON.stringify({ when: resetWhen(at) }));
  type('lock.pinLabel', '2468');
  await round();
  press(button('lock.open'));
  await until(() => mockUi.dialogs.length === 1, 'حوار التنبيه بعد الفتح التالي');
  expect(mockUi.dialogs[0].title).toBe('lock.resetNoticeTitle');
  // وسطر السجل الذي تعذّر يُكتب عند هذا الفتح · مرةً واحدة
  expect(auditRows()).toBe(1);
  await mockUi.dialogs[0].actions[0].onPress?.();
  expect((await svc.resetStatus()).notice).toBeNull();
  leaveAndReturn();
  await until(lockShown, 'القفل عند العودة');
  await settle();
  expect(notes().some((n) => n.startsWith('lock.resetNotice'))).toBe(false);
  type('lock.pinLabel', '2468');
  await round();
  press(button('lock.open'));
  await until(() => !lockShown(), 'الفتح');
  await settle();
  expect(mockUi.dialogs.length).toBe(1);
  expect(auditRows()).toBe(1);
});

/* ═══ النظير: «تأكيد حسابي» حين لا قفل للجهاز ═══ */

test('٥ الواجهة: بلا قفل للجهاز «تأكيد حسابي» يمرّ بالحدّ والسجل ثم يُختار رمزٌ للتطبيق (كان يفتح بلا حدٍّ ولا سجل) · ولا يظهر بلا حساب أو إذا بلغ الحدّ', async () => {
  await svc.enableDeviceLock(0);
  mount();
  await until(() => !!button('lock.confirmAccount'), 'زر «تأكيد حسابي»');
  await press(button('lock.confirmAccount'));
  // لا يفتح بالتأكيد وحده: رمزٌ للتطبيق أولاً
  await until(() => !!field('lock.newPin'), 'نموذج الرمز');
  expect(lockShown()).toBe(true);
  await newPin('1357');
  expect((await svc.loadLock()).method).toBe('pin');
  expect(auditRows()).toBe(1);
  expect((await svc.resetStatus()).notice).not.toBeNull();
  await unmount();
  // بلغ الحدّ: لا زرّ ويظهر كم بقي
  for (let i = 1; i < RESET_LIMIT; i++) expect(await svc.recoverByAccount(proveOk, () => undefined)).toEqual({ ok: true });
  await svc.enableDeviceLock(0);
  mount();
  await until(() => notes().includes('lock.resetLimit {"n":24}'), 'كم بقي');
  expect(button('lock.confirmAccount')).toBeUndefined();
  await unmount();
  // بلا حساب: لا زرّ
  kv.clear(); files.clear();
  await svc.enableDeviceLock(0);
  mockUi.account = false;
  mount();
  await until(lockShown, 'شاشة القفل');
  await settle();
  expect(button('lock.confirmAccount')).toBeUndefined();
});

/* ═══ ق٠-٦ · F-3: «نسيت الرمز» بلا قوقل ═══ */

import { generateRecoveryKey, formatRecoveryKey } from '@/domain/backup/recoveryKey';

const auditTexts = (): string[] =>
  mockUi.db!.all<{ entity_name: string }>(`SELECT entity_name FROM audit_log WHERE entity_name LIKE '%أُعيد ضبط رمزه%'`).map((r) => r.entity_name);
const KEY = generateRecoveryKey(() => new Uint8Array(15).fill(7));
const OTHER_KEY = generateRecoveryKey(() => new Uint8Array(15).fill(9));

test('ق٠-٦ الواجهة: بلا حسابٍ ولا قوقل (البناء المحلي) والمالك له مفتاح استرداد: «نسيت الرمز · مفتاح الاسترداد» · الخاطئ يُقال ولا يُحسب · والصحيح يعطي رمزاً جديداً بالسجل والتنبيه', async () => {
  await svc.enablePinLock('4826', 0);
  mockUi.account = false; mockUi.provider = null; mockUi.keyOffer = true;
  mockUi.keyOk = (k) => k.replace(/[\s-]/g, '').toUpperCase() === KEY;
  mount();
  await until(() => !!button('lock.forgotPinKey'), 'زر مفتاح الاسترداد');
  expect(button('lock.forgotPin')).toBeUndefined();
  press(button('lock.forgotPinKey'));
  await until(() => !!field('lock.recoveryKeyLabel'), 'حقل المفتاح');
  // لا يُرسل حتى يصحّ شكله ومحرف تحققه
  type('lock.recoveryKeyLabel', 'ABC');
  await round();
  expect(button('lock.useRecoveryKey')!.props.disabled).toBe(true);
  type('lock.recoveryKeyLabel', OTHER_KEY);
  await round();
  await press(button('lock.useRecoveryKey'));
  await until(() => notes().includes('lock.recoveryKeyWrong'), 'رسالة المفتاح الخاطئ');
  expect((await svc.resetStatus()).notice).toBeNull();
  expect((await svc.resetStatus()).waitMs).toBe(0);
  const typed = formatRecoveryKey(KEY).toLowerCase();
  type('lock.recoveryKeyLabel', typed);
  await round();
  expect(button('lock.useRecoveryKey')!.props.disabled).toBe(false);
  await press(button('lock.useRecoveryKey'));
  await newPin('2468');
  expect(mockUi.keyChecks).toEqual([OTHER_KEY, typed]);
  expect(auditTexts()).toEqual(['قفل التطبيق · أُعيد ضبط رمزه بمفتاح الاسترداد']);
  leaveAndReturn();
  await until(lockShown, 'القفل عند العودة');
  const at = (await svc.resetStatus()).notice!.at;
  await until(() => notes().includes('lock.resetNoticeKey ' + JSON.stringify({ when: resetWhen(at) })), 'تنبيه المفتاح على شاشة القفل');
  type('lock.pinLabel', '2468');
  await round();
  press(button('lock.open'));
  await until(() => mockUi.dialogs.length === 1, 'حوار التنبيه');
  expect(mockUi.dialogs[0].body).toBe('lock.resetNoticeKey ' + JSON.stringify({ when: resetWhen(at) }));
});

test('ق٠-٦ الواجهة: بلا قفلٍ للجهاز ولا حساب: المفتاح طريق المالك · ونصّ الشاشة لا يطلب قوقل', async () => {
  await svc.enableDeviceLock(0);
  mockUi.account = false; mockUi.provider = null; mockUi.keyOffer = true; mockUi.keyOk = () => true;
  mount();
  await until(() => !!button('lock.forgotPinKey'), 'زر المفتاح');
  expect(notes()).toContain('lock.noDeviceLockAny');
  expect(button('lock.confirmAccount')).toBeUndefined();
  press(button('lock.forgotPinKey'));
  await until(() => !!field('lock.recoveryKeyLabel'), 'حقل المفتاح');
  type('lock.recoveryKeyLabel', KEY);
  await round();
  await press(button('lock.useRecoveryKey'));
  await newPin('1357');
  expect((await svc.loadLock()).method).toBe('pin');
});

test('ق٠-٦ الواجهة: مزوّد الجهاز: «تأكيد هذا الجوال» · والجوال المسحوب يُقال · وحدّ الخادم يُخفي الزر بكم بقي بساعته', async () => {
  await svc.enablePinLock('4826', 0);
  mockUi.provider = 'device';
  mockUi.prove = () => Promise.resolve({ ok: false, why: 'revoked' });
  mount();
  await until(() => !!button('lock.forgotPinDevice'), 'زر تأكيد هذا الجوال');
  expect(button('lock.forgotPin')).toBeUndefined();
  await press(button('lock.forgotPinDevice'));
  await until(() => notes().includes('lock.deviceRevoked'), 'رسالة السحب');
  expect((await svc.resetStatus()).waitMs).toBe(0);
  mockUi.prove = () => Promise.resolve({ ok: false, why: 'limit', waitMs: 5 * 3_600_000 });
  await press(button('lock.forgotPinDevice'));
  await until(() => notes().includes('lock.resetLimit {"n":5}'), 'كم بقي بساعة الخادم');
  expect(button('lock.forgotPinDevice')).toBeUndefined();
  await unmount();
  // ونجاحه يكتب سطر الجهاز ويُنبَّه بنصّه
  mockUi.prove = proveOk;
  mount();
  await until(() => !!button('lock.forgotPinDevice'), 'الزر من جديد');
  await press(button('lock.forgotPinDevice'));
  await newPin('2468');
  expect(auditTexts()).toEqual(['قفل التطبيق · أُعيد ضبط رمزه بشهادة الخادم أنه الجوال المربوط']);
  expect((await svc.resetStatus()).notice).toMatchObject({ via: 'device' });
});

test('ق٠-٦ الواجهة: بقوقل ولا مفتاح يُعرض (العضو): كما كان · ولا زرّ مفتاح', async () => {
  await svc.enablePinLock('4826', 0);
  mount();
  await until(() => !!button('lock.forgotPin'), 'زر قوقل');
  expect(button('lock.forgotPinKey')).toBeUndefined();
  await press(button('lock.forgotPin'));
  await newPin('2468');
  expect(auditTexts()).toEqual(['قفل التطبيق · أُعيد ضبط رمزه بتأكيد حساب قوقل']);
});
