/**
 * مدقق خارجي B · الهجرة ٥٠ (ecc08a6) ادّعت «فحص جهاز المالك لكتابات الأعضاء خطيٌّ لا تربيعي» وأن «كل بحثٍ في الوارد بعمودٍ من الحمولة
 * له فهرس» · الحارس في d4.memberScale يعدّ العمود مفهرساً متى وُجد فهرسه ولا يتحقق أن المخطِّط يستعمله:
 *  - rows() في قارئ المصادر: `tbl = ? AND (json_extract(...) = ? OR pk IN (json_each))` · الـ OR يُسقط فهرس العمود فيُمسح الجدول كله في الوارد.
 *  - claimants(): `... UNION SELECT pk FROM sync_inbox WHERE ... reversed_by = ?` · الدمج المرتَّب يختار (tbl, pk) فيُمسح الوارد كله.
 *  - taken(): json_each على سطور كل قيود الوارد · بلا فهرس أصلاً.
 * فقيود الأعضاء من الفواتير وعكس تحصيلها تنمو تربيعياً · بيانات مصطنعة.
 *
 * أُصلح في الجولة نفسها (الهجرة ٥٢): rows() عبارتان مفهرستان، وclaimants() عبارتان وفهرس العاكس في الدفتر وخريطة الربط بفهرسٍ عكسي،
 * وtaken() من جدول سطور الوارد بـ CROSS JOIN · فالخطط هنا العبارات كما صارت، والمعيار أن فحص العضو لا يزيد نموّ سحب المالك لكتاباته
 * (فسحب المالك وحده ينمو ×٥٫٦ في العكوس على هذا الجهاز، وذلك خارج فحص العضو) وكلفته دون الضعف.
 */
import { memDb } from './helpers/testDb';
import { saveInvoice, payInvoice, reverseInvoicePayment, type InvoiceInput } from '@/domain/invoices';
import { addProperty, addUnit } from './helpers/fixtures';
import { pair, sync, MEMBER } from './helpers/rederive';

const plan = (sql: string, p: unknown[]) => {
  const db = memDb();
  const out = db.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, p as never).map((r) => r.detail).join(' | ');
  db.close();
  return out;
};

describe('الخطط: الفهرس مستعمَل', () => {
  test('rows(): invoice_lines بـ invoice_id يستعمل ix_inbox_d_invoice_id', () => {
    const p = plan(`SELECT pk, payload, del FROM sync_inbox WHERE tbl = ? AND json_extract(payload, '$.d.invoice_id') = ?`, ['invoice_lines', 'v']);
    // eslint-disable-next-line no-console
    console.log('rows():', p);
    expect(p).toMatch(/ix_inbox_d_invoice_id \(tbl=\? AND <expr>=\?\)/);
    expect(plan(`SELECT pk, payload, del FROM sync_inbox WHERE tbl = ? AND pk IN (SELECT value FROM json_each(?))`, ['invoice_lines', '[]']))
      .toMatch(/ix_sync_inbox_tbl_pk \(tbl=\? AND pk=\?\)/);
  });
  test('claimants(): الوارد بـ reversed_by يستعمل ix_inbox_d_reversed_by، والدفتر ix_je_reversed_by', () => {
    const p = plan(`SELECT pk AS id FROM sync_inbox WHERE tbl = 'journal_entries' AND json_extract(payload, '$.d.reversed_by') = ? AND del = 0`, ['r']);
    // eslint-disable-next-line no-console
    console.log('claimants():', p);
    expect(p).toMatch(/ix_inbox_d_reversed_by/);
    expect(plan(`SELECT id FROM journal_entries WHERE reversed_by = ?`, ['r'])).toMatch(/ix_je_reversed_by/);
  });
  test('taken(): سطور الوارد من جدولها المفهرس بمعرّف السطر', () => {
    const p = plan(`SELECT 1 FROM sync_inbox_lines l CROSS JOIN sync_inbox i ON i.doc = l.doc
           WHERE l.line_id IN (SELECT value FROM json_each(?)) AND i.tbl = 'journal_entries' AND i.del = 0 AND i.pk != ?`, ['[]', 'x']);
    expect(p).toMatch(/SEARCH l USING INDEX ix_inbox_lines_line/);
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src/sync/engine.ts'), 'utf8') as string;
    expect(src).toContain('FROM sync_inbox_lines l CROSS JOIN sync_inbox i ON i.doc = l.doc');
    expect(src).not.toMatch(/json_extract\(payload, '\$\.d\.\$\{col\}'\) = \? OR pk IN/);
  });
});

const ISSUED = 'مستحقة'; // i18n-exempt: حالة مخزّنة
const inv = (unitId: string): InvoiceInput =>
  ({ customer: 'عميل مصطنع', customerVat: '', issue: '2026-10-10', due: '2026-10-31', notes: '', unitId, propertyId: null,
    lines: [{ descr: 'خدمة مصطنعة', qty: 1, priceHalalas: 100000, taxPct: 15, taxCode: 'S' }] });

/** n فاتورة من الجهاز الثاني (ومع reverse: تحصيلها ثم عكسه) · قيودها بكاتبها العضو · يعيد زمن سحب المالك ثلاث مرات */
async function run(n: number, opts: { member: boolean; reverse: boolean }) {
  const s = await pair();
  for (const db of [s.owner, s.dev]) db.run(`UPDATE company SET vat_enabled = 1 WHERE id = 1`);
  const p = addProperty(s.owner, { name: 'عقار مصطنع' });
  const u = addUnit(s.owner, p, { unit_no: 'U-1' });
  await sync(s.owner, s.r);
  await sync(s.dev, s.r);
  for (let i = 0; i < n; i++) {
    const id = saveInvoice(s.dev, inv(u), ISSUED);
    if (opts.reverse) { payInvoice(s.dev, id, { method: 'cash', bankId: null, date: '2026-10-12' }); reverseInvoicePayment(s.dev, id); }
  }
  await sync(s.dev, s.r);
  if (opts.member) for (const d of [...s.r.docs.values()]) if (d.t === 'journal_entries' && String(d.d?.src_type).startsWith('invoice')) s.r.inject({ ...d, by: MEMBER });
  const t0 = process.hrtime.bigint();
  for (let k = 0; k < 3; k++) await sync(s.owner, s.r);
  const secs = Number(process.hrtime.bigint() - t0) / 1e9;
  const posted = Number(s.owner.get<{ n: number }>(`SELECT COUNT(*) AS n FROM journal_entries WHERE src_type LIKE 'invoice%' AND status = 'مرحّل'`)!.n);
  s.close();
  return { secs, posted };
}

describe('النمو خطي كما في d4.memberScale (×٤ في الحجم دون ×٦ في الزمن)', () => {
  test('فواتير العضو: ٧٥٠ ثم ٣٠٠٠', async () => {
    const small = await run(750, { member: true, reverse: false });
    const big = await run(3000, { member: true, reverse: false });
    const own = await run(3000, { member: false, reverse: false });
    const ownSmall = await run(750, { member: false, reverse: false });
    const ownRatio = own.secs / ownSmall.secs;
    // eslint-disable-next-line no-console
    console.log('member-invoices', JSON.stringify({ small, big, own, ownSmall, ratio: big.secs / small.secs, ownRatio, overhead: big.secs / own.secs }));
    expect(big.posted).toBe(own.posted);
    expect(big.secs / small.secs).toBeLessThan(Math.max(6, ownRatio * 1.25));
    expect(big.secs / own.secs).toBeLessThan(2);
  }, 900000);

  test('عكس تحصيل فواتير العضو: ٥٠٠ ثم ٢٠٠٠', async () => {
    const small = await run(500, { member: true, reverse: true });
    const big = await run(2000, { member: true, reverse: true });
    const own = await run(2000, { member: false, reverse: true });
    const ownSmall = await run(500, { member: false, reverse: true });
    const ownRatio = own.secs / ownSmall.secs;
    // eslint-disable-next-line no-console
    console.log('member-reversals', JSON.stringify({ small, big, own, ownSmall, ratio: big.secs / small.secs, ownRatio, overhead: big.secs / own.secs }));
    expect(big.posted).toBe(own.posted);
    expect(big.secs / small.secs).toBeLessThan(Math.max(6, ownRatio * 1.25));
    expect(big.secs / own.secs).toBeLessThan(2);
  }, 900000);
});
