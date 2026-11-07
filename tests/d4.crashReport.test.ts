/**
 * التوجيه الرابع ٤ · ٤ · قرار المالك 2026-11-07 «نعم توصلني» (تقارير أعطال الأعضاء تصل المالك بعد الحجب): العطل على جهاز العضو صفٌّ
 * في سجل العمليات للمالك وحده، بموضعه ونوعه وأثره محجوباً (redactForReport) ورقم الإصدار والمنصة، بمعرّفٍ يحمل كاتبه ويومه ورتبته فلا
 * يتجاوز عشرين في اليوم، وحمولته دون حدّها · ويُرفع بمسار العضو عن نفسه (SELF_OP) بلا رموز رؤية لغير المالك · بيانات مصطنعة.
 */
import fs from 'fs';
import path from 'path';
import { memDb } from './helpers/testDb';
import {
  recordCrashReport, crashReportBody, crashDay, CRASH_ENTITY, CRASH_MODULE, CRASH_DAILY_LIMIT, CRASH_BODY_MAX, crashReports,
} from '@/domain/crashReport';
import { readSectionsOf } from '@/domain/access/readSections';
import { annotate } from '@/sync/acl';
import { buildDoc } from '@/sync/engine';
import { SELF_OP } from '@/domain/access/opWrites';
import { APP_VERSION_LABEL } from '@/version';
import type { DB } from '@/db/adapter';

const AT = new Date('2026-11-07T09:30:00.000Z');

function member(db: DB, uid = 'MEMBER-UID-1') {
  db.run(`INSERT OR REPLACE INTO sync_state (k, v) VALUES ('uid', ?)`, [uid]);
  db.run(`INSERT OR REPLACE INTO sync_state (k, v) VALUES ('org', 'ORG-OWNER')`);
  db.run(`INSERT OR REPLACE INTO sync_state (k, v) VALUES ('membership', ?)`, [JSON.stringify({ org: 'ORG-OWNER', profile: { name: 'عضو مصطنع' } })]);
}

const boom = () => {
  const e = new Error('تعذّر تحصيل قسط «محمد المصطنع» بمبلغ 1,250.00 للعقد 0500000001');
  e.stack = e.message + '\n    at collect (index.android.bundle:1:2345)\n    at pay (index.android.bundle:9:87)';
  return e;
};

describe('تقرير العطل للمالك', () => {
  test('صفٌّ في سجل العمليات بمعرّف الكاتب واليوم والرتبة، وأثرٍ محجوب، ورقم الإصدار والمنصة', () => {
    const db = memDb();
    member(db);
    expect(recordCrashReport(db, { where: 'التحصيل', e: boom(), platform: 'android', at: AT })).toBe(true);
    const r = db.get<Record<string, string>>(`SELECT * FROM audit_log WHERE entity_type = ?`, [CRASH_ENTITY])!;
    expect(r.id).toBe(`crash-MEMBER-UID-1-${crashDay(AT)}-0`);
    expect(crashDay(AT)).toBe('20261107');
    expect([r.module, r.action_type, r.entity_name, r.user_name]).toEqual([CRASH_MODULE, 'update', 'التحصيل', 'عضو مصطنع']);
    expect(r.ts).toBe('2026-11-07T09:30:00');
    const body = JSON.parse(r.after_json);
    expect(body.v).toBe(APP_VERSION_LABEL);
    expect(body.p).toBe('android');
    expect(body.k).toBe('Error');
    expect(body.s).toMatch(/at collect \(index\.android\.bundle:1:2345\)/);
    // لا اسم ولا مبلغ ولا رقم جوال
    expect(body.s).not.toMatch(/محمد|1,250|0500000001/);
    expect(r.before_json).toBeNull();
  });

  test('عشرون في اليوم لكل كاتب · الحادي والعشرون لا يُكتب، واليوم التالي يبدأ من جديد', () => {
    const db = memDb();
    member(db);
    for (let i = 0; i < CRASH_DAILY_LIMIT; i++) expect(recordCrashReport(db, { where: 'موضع', e: boom(), platform: 'android', at: AT })).toBe(true);
    expect(recordCrashReport(db, { where: 'موضع', e: boom(), platform: 'android', at: AT })).toBe(false);
    expect(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM audit_log WHERE entity_type = ?`, [CRASH_ENTITY])!.n).toBe(CRASH_DAILY_LIMIT);
    const next = new Date(AT.getTime() + 24 * 3600 * 1000);
    expect(recordCrashReport(db, { where: 'موضع', e: boom(), platform: 'android', at: next })).toBe(true);
    expect(db.get<{ id: string }>(`SELECT id FROM audit_log WHERE entity_type = ? ORDER BY ts DESC LIMIT 1`, [CRASH_ENTITY])!.id)
      .toBe(`crash-MEMBER-UID-1-${crashDay(next)}-0`);
  });

  test('الحمولة دون حدّها ولو طال الأثر · والموضع محدود ومحجوبةٌ أرقامه وما بين «»', () => {
    const e = new Error('x');
    e.stack = 'Error: x\n' + '    at f (index.android.bundle:1:1)\n'.repeat(2000);
    const body = crashReportBody(e, 'android');
    expect(JSON.stringify(body).length).toBeLessThanOrEqual(CRASH_BODY_MAX);
    const db = memDb();
    member(db);
    recordCrashReport(db, { where: 'تحصيل «عميل مصطنع» 0500000009 ' + 'م'.repeat(400), e, platform: 'android', at: AT });
    const r = db.get<{ entity_name: string; after_json: string }>(`SELECT entity_name, after_json FROM audit_log WHERE entity_type = ?`, [CRASH_ENTITY])!;
    expect(r.entity_name.length).toBeLessThanOrEqual(120);
    expect(r.entity_name).not.toMatch(/عميل مصطنع|0500000009/);
    expect(r.after_json.length).toBeLessThanOrEqual(CRASH_BODY_MAX);
  });

  test('للمالك وحده: لا قسم يقرؤه، ويُرفع بمسار العضو عن نفسه بلا رموز رؤية لغيره', () => {
    const db = memDb();
    member(db);
    recordCrashReport(db, { where: 'موضع', e: boom(), platform: 'android', at: AT });
    const id = db.get<{ id: string }>(`SELECT id FROM audit_log WHERE entity_type = ?`, [CRASH_ENTITY])!.id;
    const row = db.get<Record<string, unknown>>(`SELECT * FROM audit_log WHERE id = ?`, [id])!;
    expect(readSectionsOf('audit_log', row)).toEqual([]);
    const access = { owner: false, uid: 'MEMBER-UID-1', sections: { collect: 3, audit: 1 }, props: ['*'] } as never;
    const { doc } = annotate(db, buildDoc(db, 'audit_log', id, 'upsert', AT.toISOString(), 'dev-m'), access);
    expect(doc.op).toBe(SELF_OP);
    expect(doc.g).toEqual([]);
    expect(doc.pids).toEqual(['*']);
    expect(doc.by).toBe('MEMBER-UID-1');
  });

  test('جهاز المالك يكتبها لنفسه بمعرّفه، وقائمة المالك الأحدث أولاً بأعمدتها', () => {
    const db = memDb();
    db.run(`INSERT OR REPLACE INTO sync_state (k, v) VALUES ('uid', 'OWNER-UID')`);
    db.run(`INSERT OR REPLACE INTO sync_state (k, v) VALUES ('org', 'OWNER-UID')`);
    recordCrashReport(db, { where: 'أول', e: boom(), platform: 'android', at: AT });
    recordCrashReport(db, { where: 'ثانٍ', e: boom(), platform: 'android', at: new Date(AT.getTime() + 60000) });
    const list = crashReports(db, 30, new Date(AT.getTime() + 120000));
    expect(list.map((x) => x.where)).toEqual(['ثانٍ', 'أول']);
    expect(list[0].id).toBe(`crash-OWNER-UID-${crashDay(AT)}-1`);
    expect(list[0].version).toBe(APP_VERSION_LABEL);
    expect(list[0].who).toBe('المالك');
  });

  test('حوار الفشل وتسجيله يكتبان التقرير · والقاعدة المرفوضة لا', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src/ui/failureDialog.ts'), 'utf8');
    expect(src.match(/recordCrashReport\(/g)?.length).toBeGreaterThanOrEqual(2);
    const rv = src.indexOf('if (e instanceof RuleViolation)');
    const first = src.indexOf('recordCrashReport(', src.indexOf('export async function reportFailure'));
    expect(rv).toBeGreaterThan(0);
    expect(first).toBeGreaterThan(rv);
  });

  test('القاعدة المولَّدة تقبل تقرير العضو بمعرّفه ويومه ورتبته وحدّ حمولته', () => {
    const rules = fs.readFileSync(path.join(__dirname, '..', 'firestore.rules'), 'utf8');
    expect(rules).toMatch(/function memberCrashReport\(r\)/);
    expect(rules).toContain("'crash-' + request.auth.uid + '-[0-9]{8}-([0-9]|1[0-9])'");
  });
});

test('المالك يراها في «حالة المزامنة» بعددها، وكلٌّ بتفصيله ونسخه وإرساله', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'app/settings.tsx'), 'utf8');
  expect(src).toMatch(/\{admin \? \(\(\) => \{\s*let n = 0;\s*try \{ n = crashReports\(db\)\.length; \}/);
  expect(src).toContain("onPress: () => shareFailureDetails(full)");
  for (const k of ['row', 'title', 'close', 'copy', 'share']) {
    expect(require('../src/i18n/locales/ar.json').crash[k]).toBeTruthy();
    expect(require('../src/i18n/locales/en.json').crash[k]).toBeTruthy();
  }
});
