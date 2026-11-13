/**
 * مدقق المرحلة ١ المستقل (المراجعة الشاملة 2026-11-13) · المزامنة × adapter.ts (ad7d943، بلا مشكك خاص به) · بيانات مصطنعة كلها.
 *
 * العيب: إصلاح adapter.ts يبتلع فشل «ROLLBACK TO» حين تكون SQLite قد ألغت المعاملة كلها بنفسها (امتلاء القرص، خطأ إدخال وإخراج ·
 *   ووثائق SQLite: «might be necessary to rollback and cancel the entire transaction») ويرمي الخطأ الأصلي · وفي المعاملة المتداخلة يرمي
 *   الخطأ إلى المستدعي والمعاملة الخارجية قد انتهت، فلا يعلم بها · وapplyOne (engine.ts) يمسك كل خطأ من معاملته الداخلية ويعدّه رفضاً
 *   لهذا المستند وحده، فيكتب سطر المرفوض ويحذف المستند من الصندوق الوارد، وكل ذلك يقع الآن خارج أي معاملة فيُحفظ فوراً، ثم يفشل
 *   COMMIT الصفحة («cannot commit - no transaction is active») · والمؤشر قد تقدّم عند السحب، فلا يعود المستند أبداً.
 * السيناريو: جهاز المالك الثاني يضيف عقارين ويزامن · جهاز المالك يسحب، وفي أثناء تطبيق أول عقار تلغي SQLite المعاملة (قرصٌ ممتلئ
 *   مصطنع: كما يفعل اختبار webStudy.txAfterCommitFail بوضع autoRollback) · ثم يتوفر المكان وتعود المزامنة دورتين.
 * اليوم: العقار الأول لا يصل جهاز المالك أبداً، ومسجَّلٌ مرفوضاً بسبب «database or disk is full»، والثاني يصل.
 * الصحيح: عطلٌ عابر في القاعدة لا يُسقط مستنداً وارداً: تُلغى الصفحة كلها ويبقى ما فيها في الصندوق، فيصل العقاران بعد عودة المكان،
 *   ولا يبقى رفضٌ بسبب امتلاء القرص.
 *   TZ=Asia/Riyadh npx jest tests/review12.sync.autoRollbackLoss.test.ts
 */
import { addProperty } from './helpers/fixtures';
import { pair, sync } from './helpers/rederive';

test('المعاملة التي تلغيها SQLite بنفسها أثناء تطبيق الوارد لا تُسقط المستند الوارد إلى الأبد', async () => {
  const p = await pair();
  await sync(p.owner, p.r);
  await sync(p.dev, p.r);
  const first = addProperty(p.dev, { name: 'عقار مصطنع أول' });
  const second = addProperty(p.dev, { name: 'عقار مصطنع ثانٍ' });
  await sync(p.dev, p.r);

  // قرصٌ ممتلئ مرةً واحدة عند إدراج أول عقار: SQLite تلغي المعاملة كلها ثم يفشل الأمر (كما في webStudy.txAfterCommitFail)
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
  await sync(p.owner, p.r).catch(() => { /* الدورة تفشل: مقبول */ });
  // ثم يتوفر المكان وتعود المزامنة
  await sync(p.owner, p.r);
  await sync(p.owner, p.r);

  const names = p.owner.all<{ name: string }>(`SELECT name FROM properties WHERE id IN (?, ?) ORDER BY name`, [first, second]).map((x) => x.name);
  const diskRejects = p.owner.all<{ pk: string }>(`SELECT pk FROM sync_rejects WHERE reason LIKE '%disk is full%'`).map((x) => x.pk);
  // eslint-disable-next-line no-console
  console.log('إلغاء SQLite للمعاملة ·', JSON.stringify({ names, diskRejects }));
  // اليوم: names = ['عقار مصطنع ثانٍ'] و diskRejects = [معرّف العقار الأول]
  expect({ names, diskRejects }).toEqual({ names: ['عقار مصطنع أول', 'عقار مصطنع ثانٍ'], diskRejects: [] });
  p.close();
});
