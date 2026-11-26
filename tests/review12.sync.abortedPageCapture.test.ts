/**
 * المراجعة الشاملة 2026-11-13 · R12-SYN-1 (ملاحظة المشكك الإضافية) · بيانات مصطنعة كلها.
 *
 * العيب: إذا ألغت SQLite معاملة صفحة الوارد بنفسها (قرصٌ ممتلئ) عاد إطفاء الالتقاط (sync_ctl.capture) إلى ١ مع الإلغاء، فكان كل صفٍّ
 *   وارد يُطبَّق بعده في الصفحة نفسها يُكتب خارج أي معاملة ويُلتقط في طابور جهاز المالك، فيرفعه المالك كأنه كتابته ويحلّ جهازه
 *   ووقته محل كاتبه الحقيقي في السحابة (وحرّاس الأعضاء يعتمدون على الكاتب).
 * الصحيح: الصفحة الملغاة تُلغى كلها: لا صفّ وارد يُطبَّق بعد الإلغاء، ولا يدخل طابور المالك شيءٌ منها، وتعود علامتا الالتقاط
 *   والتطبيق كما كانتا قبل الدورة · وبعد عودة المكان يصل الصفّان ويبقى كاتبهما في السحابة جهازه الأصلي.
 *   TZ=Asia/Riyadh npx jest tests/review12.sync.abortedPageCapture.test.ts
 */
import { addProperty } from './helpers/fixtures';
import { pair, sync } from './helpers/rederive';
import { getMeta } from '@/repos/settings';

test('صفحة الوارد التي تلغيها SQLite لا تُطبَّق بعدها صفوفٌ تُلتقط في طابور المالك', async () => {
  const p = await pair();
  await sync(p.owner, p.r);
  await sync(p.dev, p.r);
  const first = addProperty(p.dev, { name: 'عقار مصطنع أول' });
  const second = addProperty(p.dev, { name: 'عقار مصطنع ثانٍ' });
  await sync(p.dev, p.r);
  const devId = getMeta(p.dev, 'device_id')!;

  const db = p.owner as unknown as { run: (s: string, a?: unknown[]) => unknown; exec: (s: string) => void };
  const run = db.run.bind(db);
  let full = true;
  db.run = (sql: string, args?: unknown[]) => {
    if (full && sql.startsWith('INSERT INTO "properties"')) {
      full = false;
      db.exec('ROLLBACK');
      throw new Error('database or disk is full');
    }
    return run(sql, args);
  };
  // الدورة تفشل بسبب الإلغاء نفسه لا بخطأ الحفظ بعده («cannot commit - no transaction is active»)
  const err = await sync(p.owner, p.r).then(() => '', (e: unknown) => (e instanceof Error ? e.message : String(e)));

  const ids = [first, second];
  const ctl = (k: string) => Number(p.owner.get<{ v: number }>(`SELECT v FROM sync_ctl WHERE k = ?`, [k])?.v ?? 0);
  const afterAbort = {
    err,
    // الصفحة كلها أُلغيت: لا عقار منهما هنا ولا في الطابور، وما زالا في الصندوق الوارد
    applied: p.owner.all<{ id: string }>(`SELECT id FROM properties WHERE id IN (?, ?)`, ids).length,
    outbox: p.owner.all<{ pk: string }>(`SELECT pk FROM sync_outbox WHERE tbl = 'properties' AND pk IN (?, ?)`, ids).length,
    inbox: p.owner.all<{ pk: string }>(`SELECT pk FROM sync_inbox WHERE tbl = 'properties' AND pk IN (?, ?)`, ids).length,
    capture: ctl('capture'),
    applying: ctl('applying'),
  };
  // (الالتقاط كان مفعّلاً قبل الدورة فيبقى ١، والتطبيق ٠ · والصفّان في الصندوق: ٢)
  expect(afterAbort).toEqual({ err: 'database or disk is full', applied: 0, outbox: 0, inbox: 2, capture: 1, applying: 0 });

  await sync(p.owner, p.r);
  await sync(p.owner, p.r);
  const outboxAfter = p.owner.all<{ pk: string }>(`SELECT pk FROM sync_outbox WHERE tbl = 'properties' AND pk IN (?, ?)`, ids).length;
  const writers = ids.map((k) => p.r.docs.get('properties__' + k)?.dev);
  expect({ outboxAfter, writers }).toEqual({ outboxAfter: 0, writers: [devId, devId] });
  p.close();
});
