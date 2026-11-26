/**
 * المدقق المستقل على إصلاح B-1 · منخفض · src/sync/engine.ts: issuedInvoiceSealed («if (!lines.length) return false») ·
 * src/domain/vatReturn.ts: invoiceSales (رموزٌ مختلطة فتُحسب سطراً سطراً)
 *
 * السيناريو (بيانات مصطنعة): عند المالك فاتورةٌ صادرة كتبها هو بلا سطور (قديمةٌ قبل السطور كما يذكرها deriveSources.ts: linesShort
 * وcreditNote.ts)، خاضعة بـ ١٬٠٠٠ ريال وضريبتها ١٥٠. عضوٌ له «كامل» الفواتير يكتب لها سطرين (خاضعٌ بـ ١٠٠٬٠٠٠ ريال ومعفى بهللة).
 * القاعدة تقبلهما («كامل»)، وجهاز المالك يقبلهما لأن الفاتورة عنده لم «تكتمل» (لا سطور تعيد رأسها) · فيصير البند ١ ١٠٠٬٠٠٠ وضريبته
 * ١٥٬٠٠٠، والدفتر ١٥٠.
 *
 * لماذا يهم: «الاكتمال» يُستعمل لتمييز السطور التي في الطريق من المزوَّرة، لكن فاتورةً كتبها المالك نفسه لا سطور لها في الطريق أبداً ·
 * فقبول سطر العضو لها فتحٌ للقفل حيث لا حاجة إليه.
 *
 * السلوك الصحيح: فاتورةٌ صادرة كتبها المالك (لا كاتب عضوٍ لها) مقفلة أمام سطور العضو ولو لم تكن لها سطور عنده، فيُرفض السطران
 * ويبقى الإقرار كما كان.
 */
import { memDb } from './helpers/testDb';
import { MemoryRemote } from './helpers/memoryRemote';
import { enableSync, syncOnce } from '@/sync/engine';
import { annotate } from '@/sync/acl';
import { getMeta } from '@/repos/settings';
import { saveInvoice } from '@/domain/invoices';
import { vatReturnData } from '@/domain/vatReturn';
import type { Access } from '@/domain/access/access';
import type { RemoteDoc } from '@/sync/types';

test('B-1 · فاتورة المالك الصادرة بلا سطور لا يضيف لها «كامل» سطراً', async () => {
  const db = memDb();
  const r = new MemoryRemote();
  enableSync(db, 'OWNER-R11L');
  const dev = getMeta(db, 'device_id')!;
  db.run(`UPDATE company SET vat_enabled = 1, name = 'منشأة مصطنعة', vatno = '300000000000003' WHERE id = 1`);
  const id = saveInvoice(db, {
    customer: 'عميل مصطنع', customerVat: '', issue: '2026-04-10', due: '2026-04-30', notes: '',
    lines: [{ descr: 'خدمة مصطنعة', qty: 1, priceHalalas: 100_000, taxPct: 15 }],
  }, 'مستحقة');
  // فاتورةٌ قديمة قبل السطور: رأسها وقيدها كما هما بلا سطور
  db.run(`DELETE FROM invoice_lines WHERE invoice_id = ?`, [id]);
  db.run(`DELETE FROM sync_outbox WHERE tbl = 'invoice_lines'`);
  await syncOnce(db, r, dev);
  const item1 = () => vatReturnData(db, 2026, 2).items.find((x) => x.no === '1')!;
  const before = item1();
  expect(before).toMatchObject({ amountHalalas: 100_000, taxHalalas: 15_000 });

  const m: Access = { owner: false, uid: 'MEMBER-R11L', perms: { invoices: 3 }, allProps: true, props: [] };
  for (const [k, price, pct, code] of [['R11L-S', 10_000_000, 15, 'S'], ['R11L-E', 1, 0, 'E']] as const) {
    r.inject(annotate(db, {
      id: 'invoice_lines__' + k, t: 'invoice_lines', k, u: new Date().toISOString(), dev: 'DEV-M', del: false,
      d: { id: k, invoice_id: id, descr: 'سطر مضاف', qty: 1, price_halalas: price, tax_pct: pct, sort: 9, tax_code: code },
    } as RemoteDoc, m).doc);
  }
  await syncOnce(db, r, dev);
  await syncOnce(db, r, dev);

  const lines = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM invoice_lines WHERE invoice_id = ?`, [id])!.n;
  const after = item1();
  // eslint-disable-next-line no-console
  console.log('B-1 بلا سطور · سطورها بعد المزامنة:', lines, '· البند ١ قبل:', before.taxHalalas, '· بعد:', after.taxHalalas);
  expect(lines).toBe(0);
  expect(after).toEqual(before);
  db.close();
});
