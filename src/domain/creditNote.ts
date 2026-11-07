/**
 * حساب الإشعار الدائن على رموز فاتورته (المراجعة الشاملة · البند ٧) بلا قاعدة بيانات: من سطور الفاتورة وإشعاراتها السابقة ·
 * به يكتب saveCreditNote الإشعار، وبه يعيد جهاز المالك اشتقاق إشعار العضو وقيده (التوجيه الثالث · ١ · إعادة الاشتقاق)
 */
import { lineTaxCode, type TaxCode } from './taxCode';
import { mulQty, pctOf } from './money';

/** سطر فاتورةٍ أو إشعارٍ كما يُخزَّن (invoice_lines) */
export interface StoredInvoiceLine { qty: number; price_halalas: number; tax_pct: number; tax_code: string | null }
/** إشعارٌ دائن سابق على الفاتورة: ضريبته (سالبة) وسطوره */
export interface PriorCreditNote { tax: number; lines: StoredInvoiceLine[] }

export interface CodePart { code: TaxCode; net: number; tax: number; pct: number }

/**
 * صافي كل رمزٍ ضريبي في الفاتورة وضريبته، ناقصاً ما أشعرت به إشعاراتها الدائنة من الرمز نفسه (المراجعة الشاملة · البند ٧) ·
 * ضريبة الإشعار على سطره الخاضع (الصفري والمعفى نسبتهما صفر · البند ٦) · والنسبة نسبة سطور الرمز إن اتحدت، وإلا الفعلية
 */
export function remainingByCodeOf(invoiceLines: StoredInvoiceLine[], notes: PriorCreditNote[]): CodePart[] {
  const parts = new Map<TaxCode, CodePart & { pcts: Set<number> }>();
  const at = (code: TaxCode) => {
    let p = parts.get(code);
    if (!p) { p = { code, net: 0, tax: 0, pct: 0, pcts: new Set() }; parts.set(code, p); }
    return p;
  };
  for (const l of invoiceLines) {
    const pct = Number(l.tax_pct);
    const p = at(lineTaxCode(l.tax_code, pct));
    const net = mulQty(Number(l.qty), Number(l.price_halalas));
    p.net += net; p.tax += pctOf(net, pct); p.pcts.add(pct);
  }
  for (const n of notes) {
    let taxLeft = Number(n.tax);
    const codes = n.lines.map((l) => lineTaxCode(l.tax_code, Number(l.tax_pct)));
    const taxed = codes.includes('S') ? 'S' : codes[0];
    n.lines.forEach((l, i) => {
      const p = at(codes[i]);
      p.net += mulQty(Number(l.qty), Number(l.price_halalas));
      if (codes[i] === taxed) { p.tax += taxLeft; taxLeft = 0; }
    });
  }
  return [...parts.values()].map(({ pcts, ...p }) => ({
    ...p, pct: pcts.size === 1 ? [...pcts][0] : p.net ? Math.round((p.tax * 100) / p.net) : 0,
  }));
}

/**
 * توزيع صافي الإشعار على رموز فاتورته بنسبة الباقي من صافي كل رمز (البند ٧) · بالهللة الصحيحة: الكسور الأكبر تأخذ الباقي،
 * ولا يزيد رمزٌ على باقيه · وإشعار الباقي كله يأخذ باقي كل رمز
 */
export function splitCredit(parts: CodePart[], sub: number): Array<CodePart & { take: number }> {
  const open = parts.filter((p) => p.net > 0);
  const room = open.reduce((s, p) => s + p.net, 0);
  if (!room) return [];
  const out = open.map((p) => {
    const exact = (sub * p.net) / room;
    return { ...p, take: Math.min(p.net, Math.floor(exact)), frac: exact - Math.floor(exact) };
  });
  let left = sub - out.reduce((s, p) => s + p.take, 0);
  for (const p of [...out].sort((a, b) => b.frac - a.frac)) {
    if (left <= 0) break;
    const add = Math.min(left, p.net - p.take);
    p.take += add; left -= add;
  }
  return out.filter((p) => p.take > 0).map(({ frac: _f, ...p }) => p);
}

/** ضريبة مبلغٍ بنسبة ضريبة الفاتورة نفسها (صافيها إلى ضريبتها) */
export function creditTaxFor(inv: { subtotal: number; tax: number }, subtotal: number): number {
  return inv.subtotal ? Math.round((subtotal * inv.tax) / inv.subtotal) : 0;
}

/** سطرٌ من سطور الإشعار كما يُكتب: رمزه ونسبته وصافيه (سالباً) */
export interface CreditNoteLine { code: TaxCode; pct: number; price: number }

/**
 * سطور الإشعار وضريبته من فاتورته وما بقي منها (saveCreditNote): سطرٌ لكل رمزٍ ضريبي بنسبة الباقي من صافيه، وضريبة كل رمزٍ
 * بنسبته · وفاتورةٌ بلا سطور أو بباقٍ سالبٍ لرمزٍ (إشعارٌ قديم قبل البند ٧) سطرٌ واحد بضريبتها كما كان
 * byCode: remainingByCodeOf · left: ما بقي من صافيها وضريبتها بعد إشعاراتها · sub: صافي الإشعار (موجباً)
 */
export function creditNoteAmounts(inv: { subtotal: number; tax: number }, byCode: CodePart[], left: { sub: number; tax: number }, sub: number):
  { tax: number; lines: CreditNoteLine[] } {
  const split = byCode.some((p) => p.net < 0) ? [] : splitCredit(byCode, sub);
  const lineTax = split.map((p) => (p.take === p.net ? p.tax : Math.min(p.tax, p.pct > 0 ? pctOf(p.take, p.pct) : 0)));
  const splitTax = lineTax.reduce((s, x) => s + x, 0);
  const tax = sub === left.sub ? left.tax
    : split.length ? Math.min(left.tax, splitTax)
      : Math.min(left.tax, creditTaxFor(inv, sub));
  if (split.length) return { tax, lines: split.map((p) => ({ code: p.code, pct: p.code === 'S' ? p.pct : 0, price: -p.take })) };
  const pct = inv.subtotal ? Math.round((inv.tax * 100) / inv.subtotal) : 0;
  return { tax, lines: [{ code: tax > 0 ? 'S' : 'E', pct, price: -sub }] };
}
