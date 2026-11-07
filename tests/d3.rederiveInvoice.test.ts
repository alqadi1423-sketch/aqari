/**
 * التوجيه الثالث · ١ · إعادة الاشتقاق: قيد فاتورة المبيعات وإشعارها الدائن (invoice بنوعه) وقيد تحصيلها (invoice_pay) من الفاتورة ·
 * قيدٌ كتبه عضو بمبلغٍ غير مبلغها، أو بضريبةٍ منقولة إلى الإيراد، أو بأبعاد وحدةٍ أخرى، أو من فاتورةٍ سطرها الصفري بنسبة ١٥٪
 * (المراجعة الشاملة · البند ٦)، أو من إشعارٍ رُمِّز كله خاضعاً على فاتورةٍ مختلطة (البند ٧)، أو تحصيلٌ بإجماليها متجاهلاً إشعارها، يُرفض
 * على جهاز المالك ولا يدخل الدفتر · وما يكتبه التطبيق يُقبل · بيانات مصطنعة.
 */
import { saveInvoice, saveCreditNote, payInvoice, setInvoiceStatus, type InvoiceInput } from '@/domain/invoices';
import { addProperty, addUnit } from './helpers/fixtures';
import { pair, sync, ownerPulls, asMember, has, reasonOf, doubled, moved, otherDims, net, srcAsMember, lastEntry, holdBack, type Lines } from './helpers/rederive';
import type { MemoryRemote } from './helpers/memoryRemote';
import type { DB } from '@/db/adapter';

async function setup() {
  const p = await pair();
  for (const db of [p.owner, p.dev]) db.run(`UPDATE company SET vat_enabled = 1 WHERE id = 1`);
  const pa = addProperty(p.owner, { name: 'عقار فاتورة أ مصطنع' });
  const pb = addProperty(p.owner, { name: 'عقار فاتورة ب مصطنع' });
  const ua = addUnit(p.owner, pa, { unit_no: 'IN-A' });
  const ub = addUnit(p.owner, pb, { unit_no: 'IN-B' });
  await sync(p.owner, p.r);
  await sync(p.dev, p.r);
  return { ...p, pa, pb, ua, ub };
}

const ISSUED = 'مستحقة'; // i18n-exempt: حالة مخزّنة
const inv = (unitId: string | null, lines: InvoiceInput['lines']): InvoiceInput =>
  ({ customer: 'عميل مصطنع', customerVat: '', issue: '2026-10-10', due: '2026-10-31', notes: '', unitId, propertyId: null, lines });
const mixed = (db: DB, unitId: string | null) => saveInvoice(db, inv(unitId, [
  { descr: 'خاضع مصطنع', qty: 1, priceHalalas: 60000, taxPct: 15, taxCode: 'S' },
  { descr: 'معفى مصطنع', qty: 1, priceHalalas: 30000, taxPct: 0, taxCode: 'E' },
  { descr: 'صفري مصطنع', qty: 1, priceHalalas: 10000, taxPct: 0, taxCode: 'Z' },
]), ISSUED);
const plain = (db: DB, unitId: string | null) => saveInvoice(db, inv(unitId, [
  { descr: 'خدمة مصطنعة', qty: 1, priceHalalas: 100000, taxPct: 15, taxCode: 'S' },
]), ISSUED);
const credit = (db: DB, id: string, sub: number, date = '2026-10-12') => saveCreditNote(db, id, { date, subtotalHalalas: sub, reason: 'تصحيح مصطنع' });

/** مستندات الحساب بجدولها وعمودٍ وقيمته */
const docsOf = (r: MemoryRemote, t: string, col: string, value: string) =>
  [...r.docs.values()].filter((d) => d.t === t && String(d.d?.[col] ?? '') === value);
/** قيدٌ بمبالغ سطورٍ معطاة لكل حساب (القيد يبقى متوازناً) */
const amounts = (m: Record<string, [number, number]>) => (ls: Lines): Lines =>
  ls.map((l) => (m[String(l.account_code)] ? { ...l, debit_halalas: m[String(l.account_code)][0], credit_halalas: m[String(l.account_code)][1] } : l));

describe('إعادة اشتقاق قيود فاتورة المبيعات وإشعارها وتحصيلها من الفاتورة', () => {
  test('سلبي · الفاتورة بضعف مبلغها (متوازن): يُرفض ولا يدخل الدفتر', async () => {
    const s = await setup();
    plain(s.dev, s.ua);
    await sync(s.dev, s.r);
    const k = asMember(s.r, 'invoice', doubled);
    await ownerPulls(s.owner, s.r);
    expect(has(s.owner, k)).toBe(false);
    expect(reasonOf(s.owner, k)).toMatch(/invoice/);
    expect(net(s.owner, '1200')).toBe(0);
    s.close();
  });

  test('سلبي · ضريبة المخرجات منقولةٌ إلى الإيراد 4100، أو سطورها بوحدةٍ أخرى: يُرفض', async () => {
    const s = await setup();
    plain(s.dev, s.ua);
    await sync(s.dev, s.r);
    const k1 = asMember(s.r, 'invoice', moved('2200', '4100'));
    await ownerPulls(s.owner, s.r);
    plain(s.dev, s.ua);
    await sync(s.dev, s.r);
    const k2 = asMember(s.r, 'invoice', otherDims({ unit_id: s.ub, property_id: s.pb }));
    await ownerPulls(s.owner, s.r);
    expect(has(s.owner, k1)).toBe(false);
    expect(reasonOf(s.owner, k1)).toMatch(/4100|2200/);
    expect(has(s.owner, k2)).toBe(false);
    expect(reasonOf(s.owner, k2)).toMatch(/بُعد/);
    s.close();
  });

  test('سلبي · البند ٦: سطرٌ صفري بنسبة ١٥٪ في الفاتورة وضريبته في رأسها وقيدها: يُرفض ولا تدخل ضريبته 2200', async () => {
    const s = await setup();
    const id = saveInvoice(s.dev, inv(s.ua, [
      { descr: 'خاضع مصطنع', qty: 1, priceHalalas: 10000, taxPct: 15, taxCode: 'S' },
      { descr: 'صفري مصطنع', qty: 1, priceHalalas: 20000, taxPct: 0, taxCode: 'Z' },
    ]), ISSUED);
    await sync(s.dev, s.r);
    // العضو يكتب السطر الصفري بنسبة ١٥٪ ويحمّل ضريبته على رأس الفاتورة وقيدها
    const zero = docsOf(s.r, 'invoice_lines', 'invoice_id', id).find((d) => d.d?.tax_code === 'Z')!;
    s.r.inject({ ...zero, d: { ...zero.d, tax_pct: 15 } });
    const head = docsOf(s.r, 'invoices', 'id', id)[0];
    s.r.inject({ ...head, d: { ...head.d, tax_halalas: 4500, total_halalas: 34500 } });
    const k = asMember(s.r, 'invoice', amounts({ '1200': [34500, 0], '2200': [0, 4500] }));
    await ownerPulls(s.owner, s.r);
    expect(has(s.owner, k)).toBe(false);
    expect(reasonOf(s.owner, k)).toMatch(/سطورها برموزها/);
    expect(net(s.owner, '2200')).toBe(0);
    s.close();
  });

  test('سلبي · البند ٧: إشعارٌ على فاتورةٍ مختلطة رُمِّزت سطوره كلها خاضعة: يُرفض قيده', async () => {
    const s = await setup();
    const id = mixed(s.dev, s.ua);
    await sync(s.dev, s.r);
    srcAsMember(s.r, /^invoice$/);
    await ownerPulls(s.owner, s.r);
    const cn = credit(s.dev, id, 50000);
    await sync(s.dev, s.r);
    for (const d of docsOf(s.r, 'invoice_lines', 'invoice_id', cn)) s.r.inject({ ...d, d: { ...d.d, tax_code: 'S', tax_pct: 15 } });
    const k = asMember(s.r, 'invoice');
    expect(lastEntry(s.r, 'invoice').d?.src_id).toBe(cn);
    await ownerPulls(s.owner, s.r);
    expect(has(s.owner, k)).toBe(false);
    expect(reasonOf(s.owner, k)).toMatch(/الإشعار الدائن/);
    s.close();
  });

  test('سلبي · قيد الإشعار بضعف مبلغه: يُرفض', async () => {
    const s = await setup();
    const id = mixed(s.dev, s.ua);
    await sync(s.dev, s.r);
    srcAsMember(s.r, /^invoice$/);
    await ownerPulls(s.owner, s.r);
    credit(s.dev, id, 50000);
    await sync(s.dev, s.r);
    const k = asMember(s.r, 'invoice', doubled);
    await ownerPulls(s.owner, s.r);
    expect(has(s.owner, k)).toBe(false);
    s.close();
  });

  test('سلبي · التحصيل بإجمالي الفاتورة متجاهلاً إشعارها الدائن، أو بضعفه: يُرفض', async () => {
    const s = await setup();
    const a = plain(s.dev, s.ua);
    const b = plain(s.dev, s.ua);
    credit(s.dev, a, 20000);
    await sync(s.dev, s.r);
    srcAsMember(s.r, /^invoice$/);
    await ownerPulls(s.owner, s.r);
    payInvoice(s.dev, a, { method: 'cash', bankId: null, date: '2026-10-20' });
    await sync(s.dev, s.r);
    const k1 = asMember(s.r, 'invoice_pay', amounts({ '1100': [115000, 0], '1200': [0, 115000] }));
    await ownerPulls(s.owner, s.r);
    payInvoice(s.dev, b, { method: 'cash', bankId: null, date: '2026-10-21' });
    await sync(s.dev, s.r);
    const k2 = asMember(s.r, 'invoice_pay', doubled);
    await ownerPulls(s.owner, s.r);
    expect(has(s.owner, k1)).toBe(false);
    expect(reasonOf(s.owner, k1)).toMatch(/invoice_pay/);
    expect(has(s.owner, k2)).toBe(false);
    s.close();
  });

  test('إيجابي · ما يكتبه التطبيق يُقبل: فاتورةٌ مختلطة، ومسودةٌ تصدر، وإشعاران على رموزها، وتحصيل الباقي · والدفتر يطابق المستندات', async () => {
    const s = await setup();
    const id = mixed(s.dev, s.ua);
    const draft = saveInvoice(s.dev, inv(s.ub, [{ descr: 'مسودة مصطنعة', qty: 2, priceHalalas: 15000, taxPct: 15, taxCode: 'S' }]), 'مسودة');
    setInvoiceStatus(s.dev, draft, ISSUED);
    await sync(s.dev, s.r);
    const ids = srcAsMember(s.r, /^invoice$/);
    await ownerPulls(s.owner, s.r);
    credit(s.dev, id, 50000);
    credit(s.dev, id, 20000, '2026-10-13');
    await sync(s.dev, s.r);
    ids.push(...srcAsMember(s.r, /^invoice$/));
    await ownerPulls(s.owner, s.r);
    payInvoice(s.dev, id, { method: 'cash', bankId: null, date: '2026-10-20' });
    await sync(s.dev, s.r);
    ids.push(asMember(s.r, 'invoice_pay'));
    await ownerPulls(s.owner, s.r);
    for (const k of new Set(ids)) {
      expect(reasonOf(s.owner, k)).toBe('');
      expect(has(s.owner, k)).toBe(true);
    }
    expect(new Set(ids).size).toBe(5);
    expect(net(s.owner, '1200')).toBe(34500);
    expect(net(s.owner, '2200')).toBe(-(9000 - 4500 - 1800 + 4500));
    s.close();
  });
  test('إيجابي · قيد فاتورةٍ وصل قبل بعض سطورها (رفع العضو على دفعات) يُنتظر ثم يُقبل حين تصل', async () => {
    const s = await setup();
    const id = mixed(s.dev, s.ua);
    await sync(s.dev, s.r);
    const k = asMember(s.r, 'invoice');
    const late = docsOf(s.r, 'invoice_lines', 'invoice_id', id).find((d) => d.d?.tax_code === 'E')!;
    s.r.docs.delete(late.id);
    await ownerPulls(s.owner, s.r);
    expect(has(s.owner, k)).toBe(false);
    expect(reasonOf(s.owner, k)).toBe('');
    s.r.inject(late);
    await ownerPulls(s.owner, s.r);
    expect(reasonOf(s.owner, k)).toBe('');
    expect(has(s.owner, k)).toBe(true);
    s.close();
  });
  test('إيجابي · قيد إشعارٍ وصل قبل بعض سطوره يُنتظر ثم يُقبل حين تصل', async () => {
    const s = await setup();
    const id = mixed(s.dev, s.ua);
    await sync(s.dev, s.r);
    srcAsMember(s.r, /^invoice$/);
    await ownerPulls(s.owner, s.r);
    const cn = credit(s.dev, id, 50000);
    await sync(s.dev, s.r);
    const k = asMember(s.r, 'invoice');
    const late = docsOf(s.r, 'invoice_lines', 'invoice_id', cn).find((d) => d.d?.tax_code === 'Z')!;
    s.r.docs.delete(late.id);
    await ownerPulls(s.owner, s.r);
    expect(has(s.owner, k)).toBe(false);
    expect(reasonOf(s.owner, k)).toBe('');
    s.r.inject(late);
    await ownerPulls(s.owner, s.r);
    expect(reasonOf(s.owner, k)).toBe('');
    expect(has(s.owner, k)).toBe(true);
    s.close();
  });

  test('إيجابي · مسودةٌ عرفها المالك ثم صدرت، ووصل قيدها قبل صفّها المحدَّث: يُنتظر ثم يُقبل (المتحقق المستقل)', async () => {
    const s = await setup();
    const draft = saveInvoice(s.dev, inv(s.ua, [{ descr: 'مسودة مصطنعة', qty: 2, priceHalalas: 15000, taxPct: 15, taxCode: 'S' }]), 'مسودة');
    await sync(s.dev, s.r);
    await ownerPulls(s.owner, s.r);
    setInvoiceStatus(s.dev, draft, ISSUED);
    await sync(s.dev, s.r);
    const k = asMember(s.r, 'invoice');
    const late = holdBack(s.r, (d) => d.t === 'invoices' && d.k === draft);
    expect(late.count).toBe(1);
    await ownerPulls(s.owner, s.r);
    expect(reasonOf(s.owner, k)).toBe('');
    expect(has(s.owner, k)).toBe(false);
    late.release();
    await ownerPulls(s.owner, s.r);
    expect(reasonOf(s.owner, k)).toBe('');
    expect(has(s.owner, k)).toBe(true);
    expect(net(s.owner, '1200')).toBe(34500);
    s.close();
  });

  test('إيجابي · تحصيل فاتورةٍ محصّلة من قبل بتاريخٍ جديد، ووصل قيده قبل صفّها المحدَّث: يُنتظر ثم يُقبل (المتحقق المستقل)', async () => {
    const s = await setup();
    const id = plain(s.dev, s.ua);
    payInvoice(s.dev, id, { method: 'cash', bankId: null, date: '2026-10-20' });
    await sync(s.dev, s.r);
    srcAsMember(s.r, /^invoice(_pay)?$/);
    await ownerPulls(s.owner, s.r);
    payInvoice(s.dev, id, { method: 'cash', bankId: null, date: '2026-10-22' });
    await sync(s.dev, s.r);
    const ids = srcAsMember(s.r, /^invoice_pay(_rev)?$/);
    expect(ids.length).toBe(3);
    const k = lastEntry(s.r, 'invoice_pay').k;
    const late = holdBack(s.r, (d) => d.t === 'invoices' && d.k === id);
    await ownerPulls(s.owner, s.r);
    expect(reasonOf(s.owner, k)).toBe('');
    expect(has(s.owner, k)).toBe(false);
    late.release();
    await ownerPulls(s.owner, s.r);
    for (const x of ids) {
      expect(reasonOf(s.owner, x)).toBe('');
      expect(has(s.owner, x)).toBe(true);
    }
    expect(net(s.owner, '1200')).toBe(0);
    s.close();
  });

  test('إيجابي · مسودةٌ عُدّلت سطورها وصدرت في حفظٍ واحد، ووصلت سطورها الجديدة قبل حذف القديمة: يُنتظر ثم يُقبل (المتحقق المستقل)', async () => {
    const s = await setup();
    const draft = saveInvoice(s.dev, inv(s.ua, [
      { descr: 'سطر أول مصطنع', qty: 1, priceHalalas: 10000, taxPct: 15, taxCode: 'S' },
      { descr: 'سطر ثانٍ مصطنع', qty: 1, priceHalalas: 20000, taxPct: 15, taxCode: 'S' },
    ]), 'مسودة');
    await sync(s.dev, s.r);
    await ownerPulls(s.owner, s.r);
    saveInvoice(s.dev, inv(s.ua, [{ descr: 'سطر معدَّل مصطنع', qty: 1, priceHalalas: 50000, taxPct: 15, taxCode: 'S' }]), ISSUED, draft);
    await sync(s.dev, s.r);
    const k = asMember(s.r, 'invoice');
    // حذف السطرين القديمين في دفعةٍ لاحقة: المالك يرى القديمين والجديد معاً
    const late = holdBack(s.r, (d) => d.t === 'invoice_lines' && !!d.del);
    expect(late.count).toBe(2);
    await ownerPulls(s.owner, s.r);
    expect(reasonOf(s.owner, k)).toBe('');
    expect(has(s.owner, k)).toBe(false);
    late.release();
    await ownerPulls(s.owner, s.r);
    expect(reasonOf(s.owner, k)).toBe('');
    expect(has(s.owner, k)).toBe(true);
    expect(net(s.owner, '1200')).toBe(57500);
    s.close();
  });
});
