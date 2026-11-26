/**
 * المدقق الخارجي F · الجولة الثالثة · أيّ الأعطال يصل المالك؟
 * DESIGN §١٣.١٩: «كل عطلٍ يمرّ بحوار الفشل أو تسجيله (reportFailure وrecordFailure) أو بالمعالج العام والقاعدة مفتوحة يُكتب صفاً في سجل
 * العمليات بنوع تقرير عطل» · وقرار المالك 2026-11-07 «نعم توصلني» (أعطال جوالات الأعضاء تصله).
 * لكن reportFailure لا يكتب التقرير إلا إن مُرِّر db (src/ui/failureDialog.ts: `if (db) { … recordCrashReport(db, …) }`)، ولا يرجع إلى
 * القاعدة المفتوحة كما يرجع المعالج العام (openedAppDb) · وأغلب مواضع الحوار لا تمرّره (التحصيل والعقود والمشتريات والفواتير…).
 * بيانات مصطنعة · وحدات الجهاز مقلَّدة.
 */
import fs from 'fs';
import path from 'path';
import { memDb } from './helpers/testDb';
import type { DB } from '@/db/adapter';

const opened: { db: DB | null } = { db: null };
jest.mock('react-native', () => ({ Share: { share: jest.fn(async () => ({})) }, Platform: { OS: 'android' } }));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(async () => true) }));
jest.mock('@/ui/AppDialog', () => ({ showDialog: jest.fn() }));
jest.mock('@/ui/Toast', () => ({ showToast: jest.fn() }));
jest.mock('@/services/errorReport', () => ({ errorReportText: () => 'تقرير', saveErrorReport: async () => '' }));
// القاعدة مفتوحة على الجهاز (ما يقرؤه المعالج العام في app/_layout.tsx)
jest.mock('@/db/expoAdapter', () => ({ openedAppDb: () => opened.db }));

import { reportFailure } from '@/ui/failureDialog';
import { CRASH_ENTITY } from '@/domain/crashReport';

test('F5 · عطلٌ غير متوقع في تسجيل دفعة التحصيل (app/(tabs)/collect.tsx:319) لا يصل المالك: الحوار بلا db فلا تقرير', async () => {
  const db = memDb();
  db.run(`INSERT OR REPLACE INTO sync_state (k, v) VALUES ('uid', 'U-COL-F')`);
  db.run(`INSERT OR REPLACE INTO sync_state (k, v) VALUES ('membership', ?)`, [JSON.stringify({ org: 'ORG-F', profile: { name: 'محصّل مصطنع' } })]);
  opened.db = db;
  // كما في الشاشة حرفاً: reportFailure({ title: 'تعذّر التسجيل', e })
  const e = new Error('database or disk is full (code 13 SQLITE_FULL)');
  await reportFailure({ title: 'تعذّر التسجيل', e });
  const n = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM audit_log WHERE entity_type = ?`, [CRASH_ENTITY])!.n;

  // وكم موضعاً للحوار مثله في الشاشات (بلا db)
  const root = path.join(__dirname, '..');
  const files: string[] = [];
  const walk = (d: string) => {
    for (const x of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, x.name);
      if (x.isDirectory()) walk(p); else if (/\.tsx?$/.test(x.name) && !p.endsWith(path.join('ui', 'failureDialog.ts'))) files.push(p);
    }
  };
  walk(path.join(root, 'app'));
  walk(path.join(root, 'src'));
  let withDb = 0;
  const without: string[] = [];
  for (const f of files) {
    const s = fs.readFileSync(f, 'utf8');
    const re = /(?<![\w.])(reportFailure|recordFailure)\(\{/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(s))) {
      let i = m.index + m[1].length;
      let depth = 0;
      do { if (s[i] === '(') depth++; else if (s[i] === ')') depth--; i++; } while (depth > 0 && i < s.length);
      const call = s.slice(m.index, i);
      if (/[{,]\s*db\s*[,}:]/.test(call)) withDb++;
      else without.push(path.relative(root, f) + ':' + s.slice(0, m.index).split('\n').length);
    }
  }
  // eslint-disable-next-line no-console
  console.log('F5 · تقارير مكتوبة:', n, '· مواضع الحوار بقاعدة:', withDb, '· وبلا قاعدة (لا يصل منها شيء):', without.length,
    '· منها:', without.filter((x) => /collect|contracts|purchases|invoices/.test(x)).slice(0, 12).join(' '));
  expect(n).toBe(1);
});
