/**
 * المدقق الخارجي J · الجولة الخامسة · إعادة رتبة تقرير العطل (retryCrashRank · 09afd0b إصلاح H٢) كما هي في 662e4ae.
 * engine.ts:2100 يعيد كل تقرير عطلٍ رُفض لعضوٍ بالرتبة التالية، أياً كان سبب الرفض · والقاعدة (firestore.rules:513-534) ترفضه لغير
 * تصادم الرتبة أيضاً رفضاً لا تغيّره الرتبة: يومٌ خارج نافذتها (جهازٌ بلا اتصال أكثر من ثمانية أيام، أو ساعته متقدّمة يومين)، أو قواعد
 * لم تُنشر بعد (وهذا ما يذكره تعليق engine.ts:2094 نفسه) · فيصير العطل الواحد عشرين صفاً على الجهاز ويستنفد حدّ اليوم.
 * Firestore مقلَّد بالحكم نفسه (crashDayOk) · ونسخة المحاكي بالقواعد الحقيقية في auditJ.crashRetry.emulator.test.ts · بيانات مصطنعة.
 *   TZ=Asia/Riyadh npx jest tests/auditJ.crashRetry.test.ts
 */
import { memDb } from './helpers/testDb';
import { MemoryRemote } from './helpers/memoryRemote';
import type { DB } from '@/db/adapter';
import type { RemoteDoc, WriteResult } from '@/sync/types';
import { enableSync, syncOnce } from '@/sync/engine';
import { annotate } from '@/sync/acl';
import { getMeta } from '@/repos/settings';
import { recordCrashReport, CRASH_ENTITY } from '@/domain/crashReport';
import type { Access } from '@/domain/access/access';

/** حكم crashDayOk في القاعدة: يوم المعرّف بعد (الآن − ٨ أيام) وقبل (الآن + يوم) */
function crashDayOk(id: string, now: number): boolean {
  const p = id.split('-');
  const day = p[p.length - 2];
  const t = Date.UTC(Number(day.slice(0, 4)), Number(day.slice(4, 6)) - 1, Number(day.slice(6, 8)));
  return t > now - 8 * 86400000 && t < now + 86400000;
}

class RulesRemote extends MemoryRemote {
  crashWrites = 0;
  async write(docs: RemoteDoc[]): Promise<WriteResult[]> {
    const out: WriteResult[] = [];
    for (const d of docs) {
      if (d.t === 'audit_log' && d.d?.entity_type === CRASH_ENTITY) {
        this.crashWrites++;
        if (!crashDayOk(String(d.d.id), Date.now())) { out.push({ ok: false, code: 'PERMISSION_DENIED', message: 'Missing or insufficient permissions.' }); continue; }
      }
      out.push(...(await super.write([d])));
    }
    return out;
  }
}

const crashRows = (db: DB) => db.all<{ id: string; entity_name: string }>(
  `SELECT id, entity_name FROM audit_log WHERE entity_type = ? ORDER BY rowid`, [CRASH_ENTITY]);

test('J١١ · عطلٌ واحد على جهاز عضوٍ عاد بعد تسعة أيامٍ بلا اتصال يصير عشرين تقريراً على جهازه، كلها مرفوضة، ويستنفد حدّ ذلك اليوم', async () => {
  const db = memDb();
  const a: Access = { owner: false, uid: 'U-J-OFF', perms: { props: 1 }, allProps: true, props: [] };
  enableSync(db, 'U-J-OFF');
  db.run(`INSERT OR REPLACE INTO sync_state (k, v) VALUES ('membership', ?)`, [JSON.stringify({ org: 'ORG-J', profile: { name: 'عضو مصطنع' } })]);
  const r = new RulesRemote();
  Object.assign(r, { memberMode: true, annotate: (d: DB, doc: never) => annotate(d, doc, a).doc });
  const dev = getMeta(db, 'device_id')!;
  await syncOnce(db, r, dev);
  // عطلٌ واحد قبل تسعة أيام والجهاز بلا اتصال (رحلة، أو جوالٌ مطفأ)
  const at = new Date(Date.now() - 9 * 86400000);
  expect(recordCrashReport(db, { where: 'موضع مصطنع', e: new Error('عطل مصطنع'), platform: 'android', at })).toBe(true);
  expect(crashRows(db)).toHaveLength(1);
  // ثم يعود الاتصال
  await syncOnce(db, r, dev);
  const rows = crashRows(db);
  // eslint-disable-next-line no-console
  console.log('J11 · صفوف التقرير على الجهاز بعد المزامنة:', rows.length, '· محاولات الرفع:', r.crashWrites,
    '· المعرّفات:', rows.map((x) => x.id.replace(/^crash-U-J-OFF-/, '')).join(' '),
    '· ووصل السحابةَ منها:', [...r.docs.values()].filter((d) => d.t === 'audit_log' && d.d?.entity_type === CRASH_ENTITY).length,
    '· وعطلٌ ثانٍ حقيقيٌّ في ذلك اليوم يُسجَّل؟', recordCrashReport(db, { where: 'موضع ثان', e: new Error('عطل ثان'), platform: 'android', at }));
  // المتوقع: الرفض الذي لا تغيّره الرتبة لا يُعاد بالتالية · فيبقى التقرير واحداً
  expect(rows).toHaveLength(1);
});
