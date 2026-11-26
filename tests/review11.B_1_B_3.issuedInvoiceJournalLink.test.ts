/**
 * المدقق المستقل على إصلاح B-1 (ب) · عالٍ · src/sync/engine.ts: ISSUED_INVOICE_FROZEN (قائمة منعٍ بلا journal_entry_id) ·
 * src/domain/access/rulesGen.ts: ISSUED_INVOICE_RULE_COLS (كذلك) · src/domain/invoices.ts: setInvoiceStatus وpayInvoice
 *
 * السيناريو (بيانات مصطنعة): المالك أصدر فاتورة بيعٍ خاضعة بـ ١٬٠٠٠ ريال وضريبتها ١٥٠ وزامنها. عضوٌ له «كامل» الفواتير يكتب صفّها
 * في السحابة كما هو إلا journal_entry_id = null (رابطها بقيد إصدارها). القاعدة تقبله (العمود ليس في قائمتها)، وجهاز المالك يطبّقه بلا
 * رفض (ليس في ISSUED_INVOICE_FROZEN). فيقع على المالك:
 *  - التحصيل يُرفض «أصدر الفاتورة أولاً · المسودة لا تُحصَّل» (payInvoice يشترط journal_entry_id).
 *  - وتعليمها «متأخرة» (setInvoiceStatus) يرى صادرةً بلا قيدٍ فيرحّل قيد إصدارٍ ثانياً: حساب 2200 يصير ٣٠٠ ريال والإقرار ١٥٠.
 *
 * لماذا يهم: التقرير (B-1 · الإصلاح ١) يقول «في invoices الصادرة لا يقبل إلا ما يكتبه التطبيق: مستحقة↔متأخرة، وحقول التحصيل»، أي قائمة
 * سماح. والإصلاح قائمة منعٍ فاتها رابط القيد، فبقي للعضو أن يغيّر الفاتورة الصادرة بما يُختلف به الدفتر عن الإقرار.
 *
 * السلوك الصحيح: جهاز المالك لا يقبل من عضوٍ تغيير قيد إصدار الفاتورة الصادرة (يرفضه ويعيد نسخته)، فيبقى رابطها، ويُحصَّل،
 * وتعليمها «متأخرة» لا يرحّل قيداً ثانياً · ويبقى 2200 بقيمة ضريبتها وحدها.
 */
import { memDb } from './helpers/testDb';
import { MemoryRemote } from './helpers/memoryRemote';
import { enableSync, syncOnce, buildDoc } from '@/sync/engine';
import { annotate } from '@/sync/acl';
import { getMeta } from '@/repos/settings';
import { saveInvoice, setInvoiceStatus } from '@/domain/invoices';
import type { Access } from '@/domain/access/access';

test('B-1 (ب) · «كامل» الفواتير لا يمحو قيد إصدار الصادرة فيُرحَّل عند المالك قيدٌ ثانٍ', async () => {
  const db = memDb();
  const r = new MemoryRemote();
  enableSync(db, 'OWNER-R11J');
  const dev = getMeta(db, 'device_id')!;
  db.run(`UPDATE company SET vat_enabled = 1, name = 'منشأة مصطنعة', vatno = '300000000000003' WHERE id = 1`);
  const id = saveInvoice(db, {
    customer: 'عميل مصطنع', customerVat: '', issue: '2026-04-10', due: '2026-04-30', notes: '',
    lines: [{ descr: 'خدمة مصطنعة', qty: 1, priceHalalas: 100_000, taxPct: 15 }],
  }, 'مستحقة');
  await syncOnce(db, r, dev);
  const je = db.get<{ j: string }>(`SELECT journal_entry_id AS j FROM invoices WHERE id = ?`, [id])!.j;
  const out2200 = () => Number(db.get<{ n: number }>(`SELECT COALESCE(SUM(l.credit_halalas - l.debit_halalas), 0) AS n
    FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id WHERE e.status = 'مرحّل' AND l.account_code = '2200'`)!.n);
  expect(out2200()).toBe(15_000);

  const m: Access = { owner: false, uid: 'MEMBER-R11J', perms: { invoices: 3 }, allProps: true, props: [] };
  const cur = buildDoc(db, 'invoices', id, 'upsert', new Date().toISOString(), 'DEV-M');
  const forged = annotate(db, { ...cur, dev: 'DEV-M', d: { ...cur.d!, journal_entry_id: null } }, m).doc;
  expect(forged.op).toBe('invoices');
  r.inject(forged);
  await syncOnce(db, r, dev);
  await syncOnce(db, r, dev);

  const link = db.get<{ j: string | null }>(`SELECT journal_entry_id AS j FROM invoices WHERE id = ?`, [id])!.j;
  // المالك يعلّمها متأخرة كما تتيح الشاشة
  setInvoiceStatus(db, id, 'متأخرة');
  const issued = db.all<{ id: string }>(`SELECT id FROM journal_entries WHERE src_type = 'invoice' AND src_id = ? AND status = 'مرحّل' AND reversed_by IS NULL`, [id]);
  // eslint-disable-next-line no-console
  console.log('B-1 (ب) رابط القيد · بعد كتابة العضو:', link, '· قيود الإصدار الحية:', issued.length, '· 2200:', out2200());
  expect(link).toBe(je);
  expect(issued.length).toBe(1);
  expect(out2200()).toBe(15_000);
  db.close();
});
