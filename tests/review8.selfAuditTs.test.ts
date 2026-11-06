/**
 * المراجعة الشاملة · البند ٢٨ (تتمة · المتحقق المستقل): وقت سطر العضو عن نفسه في سجل العمليات (المسار self في القواعد) · كانت صيغته
 * تفحص شكل الأرقام وحده، فيُقبل بتاريخ اليوم وقتٌ مثل T99:99:99 ليس بصيغة toISOString · فيظهر تاريخه ووقته «NaN» على جهاز المالك
 * (app/audit-log.tsx)، ويغيب عن مرشحات الشهر والتسعين يوماً والسنة (date(ts) في SQLite تعيده NULL)، ويُرتَّب فوق سطور يومه.
 * الآن الساعة 00 إلى 23 والدقيقة والثانية 00 إلى 59 · والقواعد نفسها على المحاكي في tests/orgRules.emulator.test.ts (البند ٢٨) · بيانات مصطنعة.
 */
import { generateOrgRules } from '@/domain/access/rulesGen';
import { logAudit } from '@/domain/audit';
import { memDb } from './helpers/testDb';

/** صيغة الوقت في selfAuditSized كما تولَّد · و matches() في القواعد يطابق النص كله */
function tsPattern(): RegExp {
  const rules = generateOrgRules();
  const fn = rules.slice(rules.indexOf('function selfAuditSized('));
  const m = /d\.ts\.matches\('([^']+)'\)/.exec(fn);
  expect(m).not.toBeNull();
  return new RegExp('^(?:' + m![1] + ')$');
}

test('٢٨ وقت سطر العضو عن نفسه: الساعة والدقيقة والثانية في مداها وحده · وما يكتبه التطبيق يطابق', () => {
  const re = tsPattern();
  const db = memDb();
  logAudit(db, 'الأعضاء', 'update', 'بيانات عضو', 'عضو مصطنع');
  const ts = db.get<{ ts: string }>(`SELECT ts FROM audit_log ORDER BY rowid DESC LIMIT 1`)!.ts;
  db.close();
  expect(re.test(ts)).toBe(true);
  expect(re.test(new Date().toISOString())).toBe(true);
  const day = ts.slice(0, 10);
  // كل ساعات اليوم بأطراف دقائقها وثوانيها
  const hh = (h: number) => String(h).padStart(2, '0');
  const okTimes = Array.from({ length: 24 }, (_, h) => [`T${hh(h)}:00:00`, `T${hh(h)}:59:59`]).flat();
  expect(okTimes.filter((t) => !re.test(day + t))).toEqual([]);
  expect(re.test(day + 'T12:30:45.123Z')).toBe(true);
  // وما فوق المدى مرفوض · وهو ما لا يقرؤه جهاز المالك وقتاً
  const bad = ['T99:99:99', 'T24:00:00', 'T23:60:00', 'T23:59:60', 'T29:00:00.000Z', 'T30:15:00'];
  expect(bad.filter((t) => re.test(day + t))).toEqual([]);
  expect(Number.isNaN(new Date(day + 'T99:99:99Z').getTime())).toBe(true);
});
