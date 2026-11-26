/**
 * المدقق الخارجي F · الجولة الثالثة · تقارير الأعطال إلى المالك (381460e) كما هي في 1f21568.
 * قرار المالك 2026-11-07 «نعم توصلني»: تقارير أعطال الأعضاء تصل المالك بعد الحجب (لا اسم ولا رقم ولا مبلغ)، بإصدار التطبيق، للمالك وحده،
 * بحدٍّ للحجم ولليوم، وتُرى في شاشة الحال · وقرار المالك 2026-10-15 «١٠»: «شاشة السجل تعرض الكاتب من معرّفه».
 * بيانات مصطنعة كلها.
 */
import { memDb } from './helpers/testDb';
import { recordCrashReport, crashReports, CRASH_ENTITY } from '@/domain/crashReport';
import { AUDIT_WRITER_SQL, auditWriter } from '@/domain/audit';
import type { DB } from '@/db/adapter';

const AT = new Date('2026-11-07T09:30:00.000Z');

function memberDevice(db: DB, uid: string, name: string) {
  db.run(`INSERT OR REPLACE INTO sync_state (k, v) VALUES ('uid', ?)`, [uid]);
  db.run(`INSERT OR REPLACE INTO sync_state (k, v) VALUES ('org', 'ORG-F')`);
  db.run(`INSERT OR REPLACE INTO sync_state (k, v) VALUES ('membership', ?)`, [JSON.stringify({ org: 'ORG-F', profile: { name } })]);
}

test('F3 · قائمة المالك تعرض كاتب التقرير من الاسم المكتوب لا من معرّفه: عضوٌ يرفع تقريراً باسم عضوٍ آخر فيُنسب إليه', () => {
  // جهاز المالك بعد السحب: سطرٌ كتبه U-A (row_by من «by» الذي تفرضه القاعدة) واسمه المكتوب اسم U-B · والقاعدة memberCrashReport
  // لا تربط user_name بالكاتب (تمنع «المالك» وحده) · وأثبت المحاكي قبوله (tests/auditF.crashRules.emulator.test.ts)
  const owner = memDb();
  owner.run(`INSERT OR REPLACE INTO sync_state (k, v) VALUES ('uid', 'ORG-F')`);
  owner.run(`INSERT OR REPLACE INTO sync_state (k, v) VALUES ('org', 'ORG-F')`);
  owner.run(`INSERT INTO chat_people (uid, name) VALUES ('U-A', 'عضو أول مصطنع'), ('U-B', 'عضو ثانٍ مصطنع')`);
  const id = 'crash-U-A-20261107-0';
  owner.run(`INSERT INTO audit_log (id, ts, user_name, module, action_type, entity_type, entity_name, before_json, after_json)
    VALUES (?, '2026-11-07T09:30:00', 'عضو ثانٍ مصطنع', 'تقارير الأعطال', 'update', ?, 'موضع', NULL, '{"v":"1","p":"android","k":"Error","s":"x"}')`,
  [id, CRASH_ENTITY]);
  owner.run(`INSERT INTO row_by (tbl, pk, uid) VALUES ('audit_log', ?, 'U-A')`, [id]);

  // شاشة السجل (app/audit-log.tsx) تنسبه إلى كاتبه من معرّفه وتعلّم الانتحال
  const r = owner.get<{ user_name: string; writer_uid: string | null; writer_name: string | null }>(
    `SELECT audit_log.user_name, rb.uid AS writer_uid, cp.name AS writer_name FROM audit_log ${AUDIT_WRITER_SQL} WHERE audit_log.id = ?`, [id])!;
  expect(auditWriter(r, 'ORG-F')).toEqual({ name: 'عضو أول مصطنع', mismatch: true });

  // وقائمة تقارير الأعطال (settings.tsx: label … + c.who، والنص المنسوخ «تقارير الأعطال · » + c.who) من crashReports
  const list = crashReports(owner, 30, new Date(AT.getTime() + 60_000));
  // eslint-disable-next-line no-console
  console.log('F3 · قائمة الأعطال تنسبه إلى:', list[0].who, '· وكاتبه من معرّفه:', auditWriter(r, 'ORG-F').name);
  expect(list[0].who).toBe('عضو أول مصطنع');
});

test('F4 · الحجب لا يشمل الأسماء بغير الحرفين العربي واللاتيني: اسم مستأجرٍ بالهندية أو البنغالية أو المليالمية يصل المالك في الأثر', () => {
  const db = memDb();
  memberDevice(db, 'U-F4', 'عضو مصطنع');
  // رسالة دومين حقيقية الشكل (src/domain/ledgerReview.ts:176: `تغيّر قسط ${ch.tenant} · ${ch.due} منذ عرض التصحيح · أعد العرض`)
  // باسم مستأجرٍ مكتوبٍ بغير الحرف العربي واللاتيني (عمالةٌ وافدة شائعةٌ في السكن)
  const names = ['राजेश कुमार', 'রহিম উদ্দিন', 'അനിൽ കുമാർ'];
  for (const n of names) {
    const e = new Error(`تغيّر قسط ${n} · 2026-11-01 منذ عرض التصحيح · أعد العرض`);
    e.stack = e.message + '\n    at apply (index.android.bundle:1:2345)';
    expect(recordCrashReport(db, { where: 'تصحيح الأقساط', e, platform: 'android', at: AT })).toBe(true);
  }
  const bodies = db.all<{ after_json: string }>(`SELECT after_json FROM audit_log WHERE entity_type = ? ORDER BY id`, [CRASH_ENTITY])
    .map((r) => (JSON.parse(r.after_json) as { s: string }).s);
  // eslint-disable-next-line no-console
  console.log('F4 · الأثر المحجوب كما يصل المالك:\n' + bodies.join('\n'));
  const leaked = names.filter((n) => bodies.some((s) => s.includes(n.split(' ')[0])));
  expect(leaked).toEqual([]);
});
