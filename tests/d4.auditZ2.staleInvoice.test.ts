/**
 * المدقق Z2 · الجولة الثالثة عشرة · على db011e7 · اعتماد اقتراح تحصيل فاتورةٍ وصلها تحصيلٌ من جهازٍ آخر بعد عرضه · بياناتٌ مصطنعة كلها.
 *   TZ=Asia/Riyadh npx jest tests/d4.auditZ2.staleInvoice.test.ts
 *
 * Z2-5 · متوسط · src/domain/bankStatement/collect.ts:272-276 (approveCollectionNow للفاتورة: يفحص المتبقي بعد الإشعارات وحده، لا حالتها
 * ولا تحصيلها القائم) مع src/domain/invoices.ts:243-247 (payInvoice: «تحصيلٌ قائم يُعكس أولاً»): القسط يُفحص بقائمه (W3) والمطالبة
 * بأنها مفتوحة، والفاتورة لا · فإن وصلت المزامنةُ تحصيلَ الفاتورة من جهاز عضو (نقداً في المكتب) بعد عرض الاقتراح على جهاز المالك
 * («اعتماد الجاهزة» قائمته من لحظة فتحه)، فالاعتماد لا يُرفض: يعكس تحصيل العضو النقدي (يخرج 575 من المحفظة بقيد عكس) ويسجّل
 * تحصيلاً بنكياً مكانه · بلا سؤالٍ ولا أثرٍ في رسالة.
 * لماذا يهم: نقدٌ قبضه موظفٌ فعلاً يختفي من الدفاتر بقرار لم يتخذه أحد، وإن كان العميل دفع مرتين ضاع أثر إحداهما.
 * السلوك الصحيح: كالقسط والمطالبة: الفاتورة لم تعد مستحقة (أو لها تحصيلٌ قائم) فيُرفض الاعتماد RuleViolation ولا يمسّ تحصيلها.
 */
import { addBank } from './helpers/fixtures';
import { pair, sync, ownerPulls, MEMBER } from './helpers/rederive';
import { saveInvoice, payInvoice } from '@/domain/invoices';
import { RuleViolation } from '@/domain/contracts/service';
import { readStatementGrid } from '@/domain/bankStatement/read';
import { saveStatement } from '@/domain/bankStatement/store';
import { collectionSuggestions, approveCollection } from '@/domain/bankStatement/collect';
import { getMeta } from '@/repos/settings';
import type { MemoryRemote } from './helpers/memoryRemote';
import type { DB } from '@/db/adapter';

async function settle(p: { owner: DB; dev: DB; r: MemoryRemote }) {
  const devId = getMeta(p.dev, 'device_id');
  for (let i = 0; i < 2; i++) {
    await sync(p.owner, p.r);
    await sync(p.dev, p.r);
    for (const d of [...p.r.docs.values()]) if (d.dev === devId && d.by !== MEMBER) p.r.inject({ ...d, by: MEMBER });
    await ownerPulls(p.owner, p.r);
  }
}

test('Z2-5 · [متوسط] اقتراح الفاتورة معروضٌ على جهاز المالك، ثم تصل المزامنة تحصيلها نقداً من جهاز العضو: الاعتماد يُرفض ولا يعكس التحصيل النقدي', async () => {
  const p = await pair();
  const bank = addBank(p.owner, 'بنك مصطنع Z2-5', 0);
  const inv = saveInvoice(p.owner, { customer: 'نجم المصطنع', customerVat: '', issue: '2026-10-01', due: '2026-10-15', notes: '',
    lines: [{ descr: 'خدمة مصطنعة', qty: 1, priceHalalas: 50000, taxPct: 15 }] }, 'مستحقة');
  const invNo = p.owner.get<{ no: string }>(`SELECT no FROM invoices WHERE id = ?`, [inv])!.no;
  const g = readStatementGrid([['الرصيد الافتتاحي', '0.00'], ['التاريخ', 'البيان', 'مدين', 'دائن', 'الرصيد'],
    ['2026/10/12', 'حوالة واردة نجم سداد فاتورة ' + invNo, '', '575.00', '575.00']]);
  if (!g.ok) throw new Error(g.error);
  saveStatement(p.owner, bank, g, { name: 'z25-oct.csv', hash: 'z25' });
  await settle(p);

  // الاقتراح معروضٌ على جهاز المالك («جاهز»)
  const shown = collectionSuggestions(p.owner, bank)[0];
  expect([shown.target, shown.level]).toEqual([{ kind: 'invoice', invoiceId: inv }, 'ready']);
  // وفي الأثناء حصّلها العضو نقداً في المكتب، ووصل تحصيله بالمزامنة
  payInvoice(p.dev, inv, { method: 'cash', bankId: null, date: '2026-10-11' });
  await settle(p);
  const cashEntry = p.owner.get<{ pj: string }>(`SELECT payment_journal_entry_id AS pj FROM invoices WHERE id = ? AND payment_method = 'cash'`, [inv])?.pj;
  expect(typeof cashEntry).toBe('string');

  let refused = false;
  try { approveCollection(p.owner, shown.line.id, shown.target); } catch (e) { refused = e instanceof RuleViolation; }
  const after = {
    refused,
    method: p.owner.get<{ m: string }>(`SELECT payment_method AS m FROM invoices WHERE id = ?`, [inv])!.m,
    cashEntryReversed: !!p.owner.get(`SELECT 1 FROM journal_entries WHERE id = ? AND reversed_by IS NOT NULL`, [cashEntry!]),
  };
  // (الواقع: الاعتماد يمرّ، ويُعكس التحصيل النقدي، والفاتورة «مدفوعة» تحويلاً بنكياً)
  expect(after).toEqual({ refused: true, method: 'cash', cashEntryReversed: false });
  p.close();
});
