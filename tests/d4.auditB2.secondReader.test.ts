/**
 * المدقق B2 · الجولة الرابعة عشرة · على 52f19cb · «الأقدم إنشاءً يغلب» (Z1-4) يمحو اعتماد الجهاز الذي قرأ الملف نفسه بعده · بياناتٌ
 * مصطنعة كلها.
 *   TZ=Asia/Riyadh npx jest tests/d4.auditB2.secondReader.test.ts
 *
 * B2-8 · متوسط · src/sync/engine.ts:1866-1867 (recreated: الوارد الأقدم إنشاءً يغلب تعديل هذا الجهاز المعلَّق أياً كان) وengine.ts:1776-1779
 * (keepLocal: الوارد الأحدث إنشاءً لا يُطبَّق أياً كان ما فيه) مع src/domain/bankStatement/store.ts:47-58 (الملف نفسه على جهازين يلتقي
 * بالمعرّفات نفسها · Y3 وW1): المالك يقرأ كشف أكتوبر ويرفعه · والعضو بلا اتصال (لم يسحبه) يقرأ الملف نفسه فيأخذ السطر المعرّف نفسه
 * بوقت إنشاءٍ أحدث، ويعتمد الإيداع لقسط ماجد · عند المزامنة (السحب قبل الرفع) يغلب صفُّ المالك المفتوح (الأقدم إنشاءً) اعتمادَ العضو
 * المعلَّق على جهازه فلا يُرفع أصلاً (ولو رُفع لأبقى جهاز المالك صفّه · keepLocal): السطر مفتوح على الجهازين، والتحصيل حيٌّ «في الدفاتر وحدها»، والإيداع «في الكشف وحده» · ويكفي عضواً أن يكتب
 * created_at أقدم ليغلب أي تعديلٍ أحدث للمالك على السطر.
 * لماذا يهم: القاعدة بُنيت لتحمي قرار الجهاز الأقدم (اعتماداً واستبعاداً)، فصارت تمحو قرار الأحدث بالحجة نفسها، والمستخدم يرى إيداعاً
 * اعتمده «غير مطابَق» ويُدفع إلى إعادة العمل أو إلى تحصيله ثانيةً.
 * السلوك الصحيح: وقت الإنشاء يحسم الإنشاء وحده: تعديلٌ حقيقي على السطر (المطابقة) يبقى، فالسطر على جهاز المالك مطابَقٌ بحركة تحصيل
 * العضو، ولا شيء «في الدفاتر وحدها».
 */
import { addBank, addProperty, addUnit, contractInput } from './helpers/fixtures';
import { sync, ownerPulls, MEMBER, UID } from './helpers/rederive';
import { memDb } from './helpers/testDb';
import { MemoryRemote } from './helpers/memoryRemote';
import { enableSync } from '@/sync/engine';
import { confirmContract } from '@/domain/contracts/service';
import { readStatementGrid } from '@/domain/bankStatement/read';
import { saveStatement, reconciliation } from '@/domain/bankStatement/store';
import { collectionSuggestions, approveCollection } from '@/domain/bankStatement/collect';
import { getMeta } from '@/repos/settings';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('B2-8 · [متوسط] الملف نفسه يقرؤه المالك ثم عضوٌ بلا اتصال فيعتمد منه: الاعتماد يبقى على جهاز المالك (السطر مطابَق بحركة التحصيل)', async () => {
  const r = new MemoryRemote();
  const owner = memDb(); const m = memDb();
  for (const d of [owner, m]) enableSync(d, UID);
  const bank = addBank(owner, 'بنك مصطنع B28', 0);
  const prop = addProperty(owner, { name: 'عقار مصطنع B28' });
  confirmContract(owner, contractInput(addUnit(owner, prop, { unit_no: 'B28-1' }), {
    tenant: 'ماجد المصطنع', idNumber: '1000003901', phone: '0500003901', valueHalalas: 1200000, cycle: 'شهرية',
    start: '2026-10-01', end: '2027-09-30', depositHalalas: 0,
  }));
  await sync(owner, r); await sync(m, r); await sync(m, r);
  const g = readStatementGrid([['الرصيد الافتتاحي', '0.00'], ['التاريخ', 'البيان', 'مدين', 'دائن', 'الرصيد'],
    ['2026/10/02', 'حوالة واردة ماجد', '', '1,000.00', '1,000.00']]);
  if (!g.ok) throw new Error(g.error);
  // المالك يقرأ الكشف ويرفعه
  saveStatement(owner, bank, g, { name: 'b28.csv', hash: 'b28' });
  await sync(owner, r);
  await wait(5);
  // العضو بلا اتصال يقرأ الملف نفسه (المعرّفات نفسها) ويعتمد الإيداع
  saveStatement(m, bank, g, { name: 'b28.csv', hash: 'b28' });
  const s = collectionSuggestions(m, bank)[0];
  expect(s.line.id).toBe(owner.get<{ id: string }>(`SELECT id FROM bank_statement_lines`)!.id);
  const { txId } = approveCollection(m, s.line.id, s.target);
  const dev = getMeta(m, 'device_id');
  for (let i = 0; i < 3; i++) {
    await sync(m, r);
    for (const d of [...r.docs.values()]) if (d.dev === dev && d.by !== MEMBER) r.inject({ ...d, by: MEMBER });
    await ownerPulls(owner, r);
  }

  const view = {
    line: owner.get<{ status: string; tx: string | null }>(`SELECT status, bank_tx_id AS tx FROM bank_statement_lines WHERE id = ?`, [s.line.id]),
    onlyInBooks: reconciliation(owner, bank, '2026-10').onlyInBooks.map((x) => x.id),
  };
  // (الواقع: السطر مفتوح على الجهازين، وحركة التحصيل «في الدفاتر وحدها»)
  expect(view).toEqual({ line: { status: 'matched', tx: txId }, onlyInBooks: [] });
  owner.close(); m.close();
});
