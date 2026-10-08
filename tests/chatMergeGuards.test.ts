/**
 * تحقق الدمج (قرار المالك 2026-10-08T10:24Z: «يتحقق الوكيل المستقل من الدمج نفسه») · ما وجده المتحقق في تداخل المزامنتين:
 *  ف٢ تفريغ الجهاز لتغيّر الصلاحية ينتظر ما لم يُرسل من المحادثة كما ينتظر طابور المزامنة
 *  ف٥ إزالة العضو تمّت فلا يُظهرها فشلُ تنظيف المحادثة بعدها فاشلة
 *  ف٦ المحادثة موقوفة أثناء تفريغ الجهاز
 *  ف٧ «إعلان مهم» لا يُرسل ممن ليس مسؤولاً ولو بقي مختاراً
 * بيانات مصطنعة.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { openNodeDb } from '@/db/nodeAdapter';
import { migrate } from '@/db/migrations';
import { chatUnsentCount, openDirect, sendLocal, createGroup } from '@/chat';
import { markMessageRejected, markThreadRejected, markSent } from '@/chat/store';
import { permWipeDue, notePermWipe, PERM_WIPE_KEY } from '@/services/org';
import { getSyncState } from '@/sync/engine';

const ROOT = join(__dirname, '..');
const src = (f: string) => readFileSync(join(ROOT, f), 'utf8');
/** جسم الدالة من تعريفها حتى أول سطر يبدأ بـ «}» */
function body(file: string, decl: string): string {
  const s = src(file);
  const i = s.indexOf(decl);
  if (i < 0) throw new Error('لا تعريف: ' + decl);
  return s.slice(i, s.indexOf('\n}', i));
}

test('ف٢ ما ينتظر الرفع من المحادثة: غير المرسلة في محادثة لم تُرفض · لا المرسلة ولا المرفوضة', () => {
  const db = openNodeDb(':memory:');
  migrate(db);
  const me = { uid: 'u-a', name: 'عضو أ' };
  const d = openDirect(db, me.uid, 'u-b');
  const m1 = sendLocal(db, d, me, 'أولى');
  const m2 = sendLocal(db, d, me, 'ثانية');
  sendLocal(db, d, me, 'ثالثة');
  expect(chatUnsentCount(db)).toBe(3);
  markSent(db, m1, '2026-01-01T00:00:00.000000000Z');
  markMessageRejected(db, m2);
  expect(chatUnsentCount(db)).toBe(1);
  // محادثة رفض الخادم إنشاءها: رسائلها لا تُرفع أبداً فلا تؤخر التفريغ
  const g = createGroup(db, me.uid, 'مجموعة مرفوضة', ['u-b']);
  sendLocal(db, g, me, 'في مرفوضة');
  expect(chatUnsentCount(db)).toBe(2);
  markThreadRejected(db, g);
  expect(chatUnsentCount(db)).toBe(1);
  db.close();
});

test('ف٢ ف٦ تفريغ الجهاز لتغيّر الصلاحية ينتظر رسائل المحادثة · والمحادثة موقوفة أثناء كل تفريغ', () => {
  const sync = body('src/services/cloud.ts', 'export async function syncNow(');
  expect(sync).toMatch(/const due = permWipeDue\(db, r, moved, queued \+ chatUnsentCount\(db\)\);/);
  expect(sync).toMatch(/setSyncState\(db, PERM_WIPE_KEY, null\)/);
  // نقل الوحدة يُسجَّل قبل طلب العضوية (التحقق الثالث)
  expect(sync).toMatch(/const moved = await checkUnitMoves\([^\n]*\);\s*\/\/[^\n]*\n\s*if \(moved === 'lost'\) notePermWipe\(db, 'moved'\);\s*const r0 = await refreshMembership/);
  const wipe = body('src/services/cloud.ts', 'async function wipeLocal(');
  expect(wipe).toMatch(/return holdChat\(async \(\) => \{/);
  const chatNow = body('src/services/cloud.ts', 'export async function chatSyncNow(');
  expect(chatNow).toMatch(/if \(paused \|\| chatHeld \|\|/);
  // وكل تفريغ في الخدمة يمرّ بـ wipeLocal وحدها
  const cloud = src('src/services/cloud.ts');
  const direct = [...cloud.matchAll(/(?<![A-Za-z])wipeAllData\(/g)].length;
  expect(direct).toBe(1);
});

test('ف٥ إزالة العضو لا تُظهر فشلاً بعد نجاحها لفشل تنظيف المحادثة', () => {
  const rm = body('src/services/cloud.ts', 'export async function removeMemberNow(');
  expect(rm).toMatch(/await removeMember\(/);
  expect(rm).toMatch(/chatRemoveMember\([^;]*\)\s*\.catch\(\(\) => \{\}\)/);
});

test('ف٧ «إعلان مهم» يُرسل من المسؤول وحده ولو بقي مختاراً بعد زوال صفته', () => {
  const chat = src('app/chat.tsx');
  expect(chat).toMatch(/const canAck = me\.owner \|\| \(thread\?\.kind === 'group' && isGroupAdmin\(me, thread\)\);/);
  expect(chat).toMatch(/sendLocal\(db, id, me, text, link, \{ men, tag, ack: ack && canAck \}\)/);
  expect(chat).toMatch(/\{canAck \? \(\s*<Chip label=\{t\('chat\.important'\)\}/);
});

test('ف٢ (التحقق الثاني) التفريغ المؤجَّل لا يضيع: يُحفظ عند اكتشاف التغيّر ويقع حين يخلو ما ينتظر الرفع ولو عادت العضوية «كما هي»', () => {
  const db = openNodeDb(':memory:');
  migrate(db);
  // الدورة الأولى: تغيّرت الصلاحية وعلى الجهاز رسالة محادثة لم تُرسل
  expect(permWipeDue(db, 'changed', 'none', 1)).toBeNull();
  expect(getSyncState(db, PERM_WIPE_KEY)).toBe('changed');
  // الدورة التالية: العضوية المحفوظة «كما هي» وما زال شيء ينتظر
  expect(permWipeDue(db, 'same', 'none', 2)).toBeNull();
  // ثم خلا: يقع التفريغ
  expect(permWipeDue(db, 'same', 'none', 0)).toBe('changed');
  // نقل وحدة يغلب في السبب ولو تلاه تغيّر صلاحية
  const d2 = openNodeDb(':memory:');
  migrate(d2);
  expect(permWipeDue(d2, 'changed', 'lost', 3)).toBeNull();
  expect(permWipeDue(d2, 'changed', 'none', 0)).toBe('moved');
  // ولا تفريغ بلا تغيّر
  const d3 = openNodeDb(':memory:');
  migrate(d3);
  expect(permWipeDue(d3, 'same', 'none', 0)).toBeNull();
  db.close(); d2.close(); d3.close();
});

test('التحقق الثالث: نقل وحدة سُجّل ثم فشل طلب العضوية · فالدورة التالية «كما هي» بلا نقل جديد تفرّغ', () => {
  const db = openNodeDb(':memory:');
  migrate(db);
  notePermWipe(db, 'moved');
  // (هنا كان يُرمى استثناء الشبكة فيضيع «lost") · الدورة التالية: لا نقل جديد والعضوية كما هي
  expect(permWipeDue(db, 'same', 'none', 0)).toBe('moved');
  // ولا يُنزَّل «moved» بتغيّر صلاحيةٍ بعده
  notePermWipe(db, 'changed');
  expect(getSyncState(db, PERM_WIPE_KEY)).toBe('moved');
  db.close();
});
