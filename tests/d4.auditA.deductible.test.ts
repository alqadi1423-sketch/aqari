/**
 * اختبارات المدقق الخارجي أُبقيت حارساً بعد إصلاح ما أثبتته (التوجيه الرابع ٣ · الجولة الأولى) ·
 * مدقق خارجي (أ) · «قابلة للخصم» للمنشأة المسجّلة وحدها (35d35ab · البند ١٣): هل يمرّ من جهاز عضو؟ · بيانات مصطنعة.
 */
import { savePurchase, TS_DEDUCTIBLE } from '@/domain/purchases';
import { pair, sync, ownerPulls, asMember, has, reasonOf, net, MEMBER } from './helpers/rederive';
import type { DB } from '@/db/adapter';

/** جهاز العضو يرى المنشأة مسجّلة (إصدارٌ قبل 35d35ab، أو نسخةٌ قديمة من صفّ المنشأة قبل إلغاء تسجيلها) دون أن يرفع ذلك */
function localVat(db: DB, on: boolean) {
  db.run(`UPDATE sync_ctl SET v = 0 WHERE k = 'capture'`);
  db.run(`UPDATE company SET vat_enabled = ? WHERE id = 1`, [on ? 1 : 0]);
  db.run(`UPDATE sync_ctl SET v = 1 WHERE k = 'capture'`);
}

test('جهاز المالك لا يقبل من عضوٍ فاتورةً «قابلة للخصم» والمنشأة غير مسجّلة', async () => {
  const s = await pair();
  for (const db of [s.owner, s.dev]) {
    db.run(`INSERT INTO suppliers (id, name, vat, created_at) VALUES ('S-AU', 'مورد تدقيق مصطنع', '300000000000003', '2026-01-01T00:00:00.000Z')`);
  }
  await sync(s.owner, s.r);
  await sync(s.dev, s.r);
  expect(s.owner.get<{ v: number }>(`SELECT vat_enabled AS v FROM company WHERE id = 1`)!.v).toBe(0);
  localVat(s.dev, true);
  const id = savePurchase(s.dev, {
    supplier: 'مورد تدقيق مصطنع', date: '2026-10-01', due: '2026-10-31', category: 'صيانة', incorpItem: '', amortize: false,
    amortizeMonths: null, exempt: false, excludeFromVat: false, subtotalHalalas: 100000, taxHalalas: 15000, totalHalalas: 115000,
    taxStatus: TS_DEDUCTIBLE, notes: '',
  } as never);
  localVat(s.dev, false);
  await sync(s.dev, s.r);
  const k = asMember(s.r, 'purchase');
  // وصفّ الفاتورة يكتبه العضو نفسه كما في السحابة
  for (const d of [...s.r.docs.values()].filter((x) => x.t === 'purchases')) s.r.inject({ ...d, by: MEMBER });
  await ownerPulls(s.owner, s.r);
  const st = s.owner.get<{ s: string }>(`SELECT tax_status AS s FROM purchases WHERE id = ?`, [id]);
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ ownerRegistered: s.owner.get(`SELECT vat_enabled AS v FROM company WHERE id = 1`), status: st, entryAccepted: has(s.owner, k), reason: reasonOf(s.owner, k), vat1270: net(s.owner, '1270') }));
  expect(has(s.owner, k)).toBe(false);
  expect(net(s.owner, '1270')).toBe(0);
  // ولا يدخل الإقرار: الصف لا يُطبَّق «قابلةً للخصم»
  expect(st?.s ?? null).not.toBe(TS_DEDUCTIBLE);
  expect(reasonOf(s.owner, k)).toMatch(/غير مسجّلة|لم يصل مستنده/);
  s.close();
});
