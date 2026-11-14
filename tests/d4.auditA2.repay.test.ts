/**
 * المدقق A2 · الجولة الرابعة عشرة · على 52f19cb · تصحيح تحصيل الفاتورة على جهاز العضو (إرجاعها «مستحقة» ثم تحصيلها بتاريخها الصحيح) يُرفض
 * «تحصيلاً ثانياً» على جهاز المالك · بياناتٌ مصطنعة كلها، ولا كشف بنك.
 *   TZ=Asia/Riyadh npx jest tests/d4.auditA2.repay.test.ts
 *
 * A2-3 · عالٍ · src/sync/engine.ts:1827-1834 (التحصيل الثاني الحيّ للفاتورة من عضو يُرفض بما هنا لحظة وصوله) مع engine.ts:1536-1537 و459-469
 * (applyJournal/linkReversal: الأصل الواصل معكوساً يُدرج حيّاً وربطه معلَّقٌ حتى يُطبَّق عاكسه) وengine.ts:507 (العاكس قبل أصله ينتظر):
 * العضو بلا اتصال يحصّل فاتورة نجم نقداً بتاريخ 5 أكتوبر، ثم يتبيّن أن التاريخ خطأ فيعيدها «مستحقة» (setInvoiceStatus يعكس التحصيل) ويحصّلها
 * بتاريخ 6 أكتوبر · يصل جهازَ المالك العاكس R ثم الأصل E (معكوساً) ثم التحصيل الجديد P2: العاكس ينتظر أصله، والأصل يُدرج وربطه معلَّق،
 * فيجد حارس Z2-6 قيد تحصيلٍ «حيّاً» هنا فيرفض P2 نهائياً قبل أن يُطبَّق R في المرور التالي · والفاتورة «مدفوعة» تسمّي P2 المرفوض: لا تحصيل
 * حيّ لها في دفاتر المالك، و«ذمم الفواتير = الفواتير المصدرة غير المحصّلة» أحمر · وكان قبل 52f19cb ينتظر P2 («await») حتى يُربط العكس.
 * والترتيب R قبل E هو الطبيعي على هاتفٍ حقيقي (العاكس يُكتب قبل ربط أصله، وكل عبارةٍ تأخذ جزءاً من الثانية): الاختبار يحاكي جهازاً تأخذ
 * كل عبارةٍ فيه ميلي ثانيتين؛ وبلا محاكاةٍ يسقط في نحو سدس التشغيلات على Node بحسب حدّ الميلي ثانية · والآلية نفسها تُسقط إعادة اعتماد
 * الإيداع بعد إلغاء دفعته على جهاز العضو (حارس stmt_line_id في engine.ts:1820-1826).
 * لماذا يهم: تصحيح تاريخ التحصيل أو طريقته مسارٌ عادي في شاشة الفواتير («تغيير الحالة» ثم «تسجيل التحصيل»)، فيضيع التحصيل الصحيح من دفاتر
 * المالك والمال في الصندوق.
 * السلوك الصحيح: التحصيل الجديد ينتظر ربط عكس السابق ولا يُرفض: على جهاز المالك قيد تحصيلٍ حيٌّ واحد بتاريخ 6 أكتوبر والفحوص خضراء.
 */
import { pair, sync, ownerPulls, MEMBER } from './helpers/rederive';
import { saveInvoice, payInvoice, setInvoiceStatus } from '@/domain/invoices';
import { integrityChecks } from '@/domain/accounting/integrity';
import { getMeta } from '@/repos/settings';
import type { DB } from '@/db/adapter';

test('A2-3 · [عالٍ] العضو يحصّل الفاتورة ثم يعيدها مستحقة ويحصّلها بتاريخها الصحيح بلا اتصال: على جهاز المالك تحصيلٌ حيٌّ واحد بتاريخ 6 أكتوبر', async () => {
  const p = await pair();
  const inv = saveInvoice(p.owner, { customer: 'نجم المصطنع', customerVat: '', issue: '2026-10-01', due: '2026-10-15', notes: '',
    lines: [{ descr: 'خدمة مصطنعة', qty: 1, priceHalalas: 50000, taxPct: 15 }] }, 'مستحقة');
  const devId = getMeta(p.dev, 'device_id');
  const settle = async () => {
    for (let i = 0; i < 3; i++) {
      await sync(p.owner, p.r);
      await sync(p.dev, p.r);
      for (const d of [...p.r.docs.values()]) if (d.dev === devId && d.by !== MEMBER) p.r.docs.set(d.id, { ...d, by: MEMBER });
      await ownerPulls(p.owner, p.r);
    }
  };
  await settle();

  // هاتف العضو: كل عبارةٍ تأخذ ميلي ثانيتين (المحاكاة الوحيدة هنا)
  const run0 = p.dev.run.bind(p.dev);
  const slow: DB['run'] = (sql, params) => { const t0 = Date.now(); while (Date.now() - t0 < 2) { /* هاتفٌ أبطأ من Node */ } return run0(sql, params); };
  (p.dev as { run: DB['run'] }).run = slow;
  payInvoice(p.dev, inv, { method: 'cash', bankId: null, date: '2026-10-05' });
  setInvoiceStatus(p.dev, inv, 'مستحقة');
  payInvoice(p.dev, inv, { method: 'cash', bankId: null, date: '2026-10-06' });
  (p.dev as { run: DB['run'] }).run = run0;
  await settle();

  const live = (db: DB) => db.all<{ date: string }>(
    `SELECT date FROM journal_entries WHERE src_type = 'invoice_pay' AND src_id = ? AND reversed_by IS NULL AND status = 'مرحّل'`, [inv]).map((x) => x.date);
  // جهاز العضو سليم: تحصيلٌ حيٌّ واحد بتاريخ 6 أكتوبر
  expect(live(p.dev)).toEqual(['2026-10-06']);
  const state = {
    invoice: p.owner.get<{ s: string }>(`SELECT status AS s FROM invoices WHERE id = ?`, [inv])!.s,
    liveCollections: live(p.owner),
    failing: integrityChecks(p.owner).filter((x) => !x.ok).map((x) => x.name),
  };
  // (الواقع: التحصيل الجديد «تحصيلٌ ثانٍ … رُفض»، فلا تحصيل حيّ والفاتورة «مدفوعة»، و«ذمم الفواتير = الفواتير المصدرة غير المحصّلة» أحمر)
  expect(state).toEqual({ invoice: 'مدفوعة', liveCollections: ['2026-10-06'], failing: [] });
  p.close();
});
