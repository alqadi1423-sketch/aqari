/**
 * قوالب المستندات المطبوعة · وحدة نقية بلا أي اعتماد على الجهاز:
 * A4 بهوامش 20مم، ترويسة من بيانات المنشأة، تذييل بترقيم «صفحة X من Y» في المستندات
 * المرقّمة يدوياً، جداول لا يُقطع صف فيها ورأسها يتكرر مع كل صفحة، أرقام يمين
 * بخط ثابت العرض، رمز الريال SVG، والمبالغ بالأرقام والحروف في السندات.
 * الفاتورة الضريبية: QR بترميز TLV لهيئة الزكاة عند تفعيل الضريبة، ولا خانة ضريبة عند إطفائها.
 */
import qrFactory from 'qrcode-generator';
import { fmt } from './money';
import { dfmt } from './dates';
import { moneyToArabicWords } from './numberWords';
import type { HandoverSection } from './handover/build';
import { t } from '../i18n';

export const esc = (s: unknown): string =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/** رمز الريال الرسمي (البنك المركزي السعودي · ملكية عامة) */
export const SAR =
  '<svg style="height:.8em;width:auto;vertical-align:-.06em" viewBox="0 0 1124.14 1256.39" xmlns="http://www.w3.org/2000/svg">' +
  '<path fill="currentColor" d="M699.62,1113.02h0c-20.06,44.48-33.32,92.75-38.4,143.37l424.51-90.24c20.06-44.47,33.31-92.75,38.4-143.37l-424.51,90.24Z"/>' +
  '<path fill="currentColor" d="M1085.73,895.8c20.06-44.47,33.32-92.75,38.4-143.37l-330.68,70.33v-135.2l292.27-62.11c20.06-44.47,33.32-92.75,38.4-143.37l-330.68,70.27V66.13c-50.67,28.45-95.67,66.32-132.25,110.99v403.35l-132.25,28.11V0c-50.67,28.44-95.67,66.32-132.25,110.99v525.69l-295.91,62.88c-20.06,44.47-33.33,92.75-38.42,143.37l334.33-71.05v170.26l-358.3,76.14c-20.06,44.47-33.32,92.75-38.4,143.37l375.04-79.7c30.53-6.35,56.77-24.4,73.83-49.24l68.78-101.97v-.02c7.14-10.55,11.3-23.27,11.3-36.97v-149.98l132.25-28.11v270.4l424.53-90.28Z"/></svg>';

export interface CompanyInfo {
  name: string;
  vatno: string;
  cr: string;
  phone: string;
  address: string;
  vatEnabled: boolean;
}

/* ═══════════ الهوية ═══════════ */

export const PRINT_CSS = `
  @page{size:A4;margin:20mm}
  *{box-sizing:border-box}
  body{font-family:'IBM Plex Sans Arabic','Segoe UI',Tahoma,sans-serif;color:#232A36;background:#fff;margin:0;direction:rtl;font-size:12px;line-height:1.7}
  .num{direction:ltr;unicode-bidi:isolate;font-variant-numeric:tabular-nums;text-align:left}
  td.num,th.num{text-align:left}
  .page{page-break-after:always;position:relative}
  .page:last-child{page-break-after:auto}
  .lh{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;border-bottom:3px solid #1E6E5C;padding-bottom:12px;margin-bottom:14px}
  .lh .co{font-weight:800;font-size:16px;color:#10192E}
  .lh .co-sub{font-size:10.5px;color:#525A68;margin-top:3px;line-height:1.8}
  .lh .doc-t{font-size:18px;font-weight:800;color:#10192E;text-align:left}
  .lh .doc-no{font-size:11px;color:#77808F;text-align:left;margin-top:3px}
  .copy-tag{display:inline-block;border:1px solid #B08D3D;color:#B08D3D;border-radius:6px;padding:1px 8px;font-size:10.5px;margin-top:4px}
  .lh-mini{display:flex;justify-content:space-between;border-bottom:1px solid #E4E1D8;padding-bottom:6px;margin-bottom:10px;font-size:10.5px;color:#525A68}
  .pfoot{display:flex;justify-content:space-between;border-top:1px solid #E4E1D8;margin-top:16px;padding-top:7px;font-size:10px;color:#9AA1AD}
  .inv-doc{margin:0 auto}
  .inv-top{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;border-bottom:3px solid #1E6E5C;padding-bottom:14px}
  .inv-title{font-size:18px;font-weight:700;color:#10192E}
  .inv-meta{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin:14px 0}
  .inv-box{background:#F6F4EE;border-radius:8px;padding:11px 13px;font-size:12px;line-height:1.9;border:1px solid #EDEAE0}
  table{width:100%;border-collapse:collapse;margin-top:6px}
  thead{display:table-header-group}
  tr{page-break-inside:avoid}
  th{background:#F2EFE7;color:#10192E;font-size:11px;padding:8px 9px;border:1px solid #D8D4C8;font-weight:700}
  td{padding:7px 9px;border:1px solid #E4E1D8;font-size:11.5px}
  .inv-totals{margin-top:14px;border:1px solid #D8D4C8;border-radius:8px;padding:12px 16px}
  .t-row{display:flex;justify-content:space-between;font-size:12px;padding:5px 0;color:#525A68}
  .tt{border-top:2px solid #10192E;margin-top:6px;padding-top:9px;color:#10192E;font-weight:800;font-size:14.5px}
  .words{margin-top:10px;border:1px dashed #B08D3D;border-radius:8px;padding:9px 12px;font-size:12px;color:#10192E;background:#FDFBF5}
  .sign-row{display:flex;justify-content:space-between;gap:40px;margin-top:34px}
  .sign{flex:1;text-align:center;font-size:11.5px;color:#525A68}
  .sign .line{border-bottom:1.2px solid #232A36;height:26px;margin-bottom:6px}
  .qr{display:flex;justify-content:flex-end;margin-top:12px}
  h2{color:#10192E;font-size:15px}
  h3{margin:13px 0 5px;font-size:12.5px;color:#10192E}
`;

/** الترويسة الكاملة · بيانات المنشأة من «بيانات المنشأة» لا تُكتب في كل مستند */
export function letterhead(co: CompanyInfo, docTitle: string, docNo?: string, copyLabel?: string): string {
  const sub = [
    co.cr ? 'س.ت <span class="num">' + esc(co.cr) + '</span>' : '',
    co.vatEnabled && co.vatno ? 'الرقم الضريبي <span class="num">' + esc(co.vatno) + '</span>' : '',
    co.phone ? 'هاتف <span class="num">' + esc(co.phone) + '</span>' : '',
    co.address ? esc(co.address) : '',
  ].filter(Boolean).join(' · ');
  return `<div class="lh">
    <div><div class="co">${esc(co.name || 'لا يوجد')}</div>${sub ? `<div class="co-sub">${sub}</div>` : ''}</div>
    <div><div class="doc-t">${esc(docTitle)}</div>${docNo ? `<div class="doc-no">رقم: <span class="num">${esc(docNo)}</span></div>` : ''}${copyLabel ? `<div style="text-align:left"><span class="copy-tag">${esc(copyLabel)}</span></div>` : ''}</div>
  </div>`;
}

/** ترويسة مصغّرة للصفحات التالية */
const miniHead = (co: CompanyInfo, docTitle: string, docNo?: string): string =>
  `<div class="lh-mini"><span>${esc(co.name)}</span><span>${esc(docTitle)}${docNo ? ' · ' + esc(docNo) : ''}</span></div>`;

/** التذييل · رقم الصفحة من الإجمالي إلزامي في المرقَّم */
export function pageFooter(pageNo: number, total: number, issuedAt: string): string {
  return `<div class="pfoot">
    <span>صفحة <span class="num">${pageNo}</span> من <span class="num">${total}</span></span>
    <span>صدر في <span class="num">${esc(issuedAt)}</span></span>
    <span>عقاري · منصة رِكز</span>
  </div>`;
}

/* ═══════════ الترقيم اليدوي · صفوف لكل صفحة محسوبة فلا يُقطع صف أبداً ═══════════ */

export interface PagedChunk { html: string; rows: number }

/**
 * توزيع كتل صفوف على صفحات: سعة الصفحة الأولى أقل (ترويسة كاملة).
 * كل كتلة {html, rows} حيث rows وزنها بالصفوف · الكتلة لا تُقسم إن كانت ≤ سعة صفحة.
 */
export function paginateChunks(chunks: PagedChunk[], firstCap = 18, nextCap = 24): string[][] {
  const pages: string[][] = [[]];
  let cap = firstCap;
  let used = 0;
  for (const c of chunks) {
    const w = Math.max(1, c.rows);
    if (used + w > cap && used > 0) {
      pages.push([]);
      cap = nextCap;
      used = 0;
    }
    pages[pages.length - 1].push(c.html);
    used += w;
  }
  return pages;
}

/** غلاف مستند مرقَّم: صفحات مبنية يدوياً بترويسة وتذييل لكل صفحة */
export function pagedDoc(
  co: CompanyInfo, docTitle: string, docNo: string | undefined, issuedAt: string,
  firstPageIntro: string, chunks: PagedChunk[], copyLabel?: string
): string {
  const pages = paginateChunks(chunks);
  const total = pages.length;
  return pages.map((body, i) =>
    `<div class="page">
      ${i === 0 ? letterhead(co, docTitle, docNo, copyLabel) + firstPageIntro : miniHead(co, docTitle, docNo)}
      ${body.join('')}
      ${pageFooter(i + 1, total, issuedAt)}
    </div>`
  ).join('');
}

/* ═══════════ QR هيئة الزكاة · TLV ثم ترميز Base64 ═══════════ */

const tlvBytes = (tag: number, value: string): number[] => {
  const enc: number[] = [];
  for (const ch of unescape(encodeURIComponent(value))) enc.push(ch.charCodeAt(0));
  return [tag, enc.length, ...enc];
};

/** حمولة QR للفاتورة الضريبية المبسطة: البائع، الرقم الضريبي، الوقت، الإجمالي، الضريبة */
export function zatcaTlvBase64(sellerName: string, vatNo: string, isoDateTime: string, totalHalalas: number, vatHalalas: number): string {
  const bytes = [
    ...tlvBytes(1, sellerName),
    ...tlvBytes(2, vatNo),
    ...tlvBytes(3, isoDateTime),
    ...tlvBytes(4, (totalHalalas / 100).toFixed(2)),
    ...tlvBytes(5, (vatHalalas / 100).toFixed(2)),
  ];
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  // btoa غير متاح في هيرمس · ترميز يدوي
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  for (let i = 0; i < bin.length; i += 3) {
    const a = bin.charCodeAt(i), b = i + 1 < bin.length ? bin.charCodeAt(i + 1) : 0, c = i + 2 < bin.length ? bin.charCodeAt(i + 2) : 0;
    out += B64[a >> 2] + B64[((a & 3) << 4) | (b >> 4)]
      + (i + 1 < bin.length ? B64[((b & 15) << 2) | (c >> 6)] : '=')
      + (i + 2 < bin.length ? B64[c & 63] : '=');
  }
  return out;
}

/** رسم QR رمزاً SVG · مربعات سوداء على أبيض، حجم ثابت للطباعة */
export function qrSvg(data: string, sizeMm = 30): string {
  const qr = qrFactory(0, 'M');
  qr.addData(data, 'Byte');
  qr.make();
  const n = qr.getModuleCount();
  let rects = '';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.isDark(r, c)) rects += `<rect x="${c}" y="${r}" width="1" height="1"/>`;
    }
  }
  return `<svg width="${sizeMm}mm" height="${sizeMm}mm" viewBox="0 0 ${n} ${n}" xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges"><rect width="${n}" height="${n}" fill="#fff"/><g fill="#000">${rects}</g></svg>`;
}

/* ═══════════ المستندات ═══════════ */

export type CopyKind = 'tenant' | 'office' | 'both';
const COPY_LABEL: Record<Exclude<CopyKind, 'both'>, string> = { tenant: 'نسخة المستأجر', office: 'نسخة المكتب' };

export interface ReceiptData {
  no: string; tenantName: string; contractNo: string; unitLabel: string;
  date: string; period: string; methodLabel: string; notes: string;
  grossHalalas: number; discountHalalas: number; netHalalas: number;
}

function receiptOne(co: CompanyInfo, r: ReceiptData, issuedAt: string, copyLabel?: string): string {
  return `<div class="page">
    ${letterhead(co, 'سند قبض', r.no, copyLabel)}
    <div class="inv-meta">
      <div class="inv-box"><b>استلمنا من:</b> ${esc(r.tenantName)}<br><b>العقد:</b> <span class="num">${esc(r.contractNo || 'لا يوجد')}</span><br><b>الوحدة:</b> ${esc(r.unitLabel)}</div>
      <div class="inv-box"><b>التاريخ:</b> <span class="num">${dfmt(r.date)}</span><br><b>الفترة:</b> ${esc(r.period || 'لا يوجد')}<br><b>طريقة السداد:</b> ${esc(r.methodLabel)}</div>
    </div>
    <div class="inv-totals">
      <div class="t-row"><span>المبلغ</span><span class="num">${fmt(r.grossHalalas)} ${SAR}</span></div>
      ${r.discountHalalas ? `<div class="t-row"><span>الخصم</span><span class="num">${fmt(r.discountHalalas)} ${SAR}</span></div>` : ''}
      <div class="t-row tt"><span>صافي المحصَّل</span><span class="num">${fmt(r.netHalalas)} ${SAR}</span></div>
    </div>
    <div class="words">${fmt(r.netHalalas)} ${SAR} · ${esc(moneyToArabicWords(r.netHalalas))}</div>
    ${r.notes ? `<p style="margin-top:10px;font-size:11.5px">${esc(r.notes)}</p>` : ''}
    <div class="sign-row">
      <div class="sign"><div class="line"></div>المستلم</div>
      <div class="sign"><div class="line"></div>المسلِّم</div>
    </div>
    ${pageFooter(1, 1, issuedAt)}
  </div>`;
}

export function buildReceiptDoc(co: CompanyInfo, r: ReceiptData, issuedAt: string, copy: CopyKind = 'tenant'): string {
  if (copy === 'both') return receiptOne(co, r, issuedAt, COPY_LABEL.tenant) + receiptOne(co, r, issuedAt, COPY_LABEL.office);
  return receiptOne(co, r, issuedAt, COPY_LABEL[copy]);
}

export interface InvoiceDocData {
  no: string; customerName: string; customerVat: string; issue: string; due: string; notes: string;
  subtotalHalalas: number; taxHalalas: number; totalHalalas: number;
  lines: Array<{ descr: string; qty: number; priceHalalas: number; taxPct: number }>;
}

export function buildInvoiceDoc(co: CompanyInfo, v: InvoiceDocData, issuedAt: string): string {
  const vat = co.vatEnabled;
  const title = vat ? 'فاتورة ضريبية' : 'فاتورة';
  const header = vat
    ? ['الوصف', 'الكمية', 'السعر', 'الضريبة', 'الإجمالي']
    : ['الوصف', 'الكمية', 'السعر', 'الإجمالي'];
  const rows = v.lines.map((l) => {
    const line = Math.round(l.qty * l.priceHalalas);
    const cells = vat
      ? [esc(l.descr || 'لا يوجد'), `<span class="num">${l.qty}</span>`, `<span class="num">${fmt(l.priceHalalas)}</span>`, `<span class="num">${l.taxPct}٪</span>`, `<span class="num">${fmt(line)}</span>`]
      : [esc(l.descr || 'لا يوجد'), `<span class="num">${l.qty}</span>`, `<span class="num">${fmt(l.priceHalalas)}</span>`, `<span class="num">${fmt(line)}</span>`];
    return `<tr>${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`;
  }).join('');
  const qr = vat && co.vatno
    ? `<div class="qr">${qrSvg(zatcaTlvBase64(co.name, co.vatno, v.issue + 'T00:00:00Z', v.totalHalalas, v.taxHalalas))}</div>`
    : '';
  return `<div class="page">
    ${letterhead(co, title, v.no)}
    <div class="inv-meta">
      <div class="inv-box"><b>تاريخ الإصدار:</b> <span class="num">${dfmt(v.issue)}</span><br><b>تاريخ الاستحقاق:</b> <span class="num">${dfmt(v.due)}</span></div>
      <div class="inv-box"><b>العميل:</b> ${esc(v.customerName)}${vat ? `<br><b>الرقم الضريبي للعميل:</b> <span class="num">${esc(v.customerVat || 'لا يوجد')}</span>` : ''}</div>
    </div>
    <table><thead><tr>${header.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>
    <div class="inv-totals">
      ${vat ? `<div class="t-row"><span>الإجمالي قبل الضريبة</span><span class="num">${fmt(v.subtotalHalalas)} ${SAR}</span></div>
      <div class="t-row"><span>ضريبة القيمة المضافة</span><span class="num">${fmt(v.taxHalalas)} ${SAR}</span></div>` : ''}
      <div class="t-row tt"><span>الإجمالي المستحق</span><span class="num">${fmt(v.totalHalalas)} ${SAR}</span></div>
    </div>
    <div class="words">${fmt(v.totalHalalas)} ${SAR} · ${esc(moneyToArabicWords(v.totalHalalas))}</div>
    ${qr}
    ${v.notes ? `<p style="font-size:11px;color:#77808F;margin-top:10px">${esc(v.notes)}</p>` : ''}
    ${pageFooter(1, 1, issuedAt)}
  </div>`;
}

export interface StatementRow { date: string; descr: string; debitHalalas: number; creditHalalas: number; future?: boolean }

export interface StatementData {
  tenantName: string; contractNo: string; unitLabel: string; start: string | null; end: string | null;
  rows: StatementRow[];
}

/** كشف حساب مستأجر · ما له وما عليه برصيد جارٍ، مرقَّم الصفحات */
export function buildStatementDoc(co: CompanyInfo, d: StatementData, issuedAt: string): string {
  let running = 0;
  const head = '<table><thead><tr><th>التاريخ</th><th>البيان</th><th>مستحق</th><th>مسدَّد</th><th>الرصيد</th></tr></thead><tbody>';
  const chunks: PagedChunk[] = [];
  let buf = head;
  let rowsInBuf = 0;
  const flush = () => {
    if (rowsInBuf) { chunks.push({ html: buf + '</tbody></table>', rows: rowsInBuf + 2 }); buf = head; rowsInBuf = 0; }
  };
  for (const r of d.rows) {
    // القادم (لم يحلّ بتاريخ الكشف) يُعرض ولا يدخل الرصيد (مراجعة التثبيت #12)
    if (!r.future) running += r.debitHalalas - r.creditHalalas;
    buf += `<tr><td class="num">${dfmt(r.date)}</td><td>${esc(r.descr)}</td>
      <td class="num">${r.debitHalalas ? fmt(r.debitHalalas) : ''}</td>
      <td class="num">${r.creditHalalas ? fmt(r.creditHalalas) : ''}</td>
      <td class="num">${r.future ? '' : fmt(running)}</td></tr>`;
    rowsInBuf += 1;
    if (rowsInBuf >= 20) flush();
  }
  flush();
  const current = d.rows.filter((r) => !r.future);
  const totalDue = current.reduce((s, r) => s + r.debitHalalas, 0);
  const totalPaid = current.reduce((s, r) => s + r.creditHalalas, 0);
  const upcoming = d.rows.filter((r) => r.future).reduce((s, r) => s + r.debitHalalas - r.creditHalalas, 0);
  chunks.push({
    html: `<div class="inv-totals">
      <div class="t-row"><span>إجمالي المستحق</span><span class="num">${fmt(totalDue)} ${SAR}</span></div>
      <div class="t-row"><span>إجمالي المسدَّد</span><span class="num">${fmt(totalPaid)} ${SAR}</span></div>
      <div class="t-row tt"><span>${totalDue - totalPaid >= 0 ? 'الرصيد المستحق على المستأجر' : 'الرصيد الدائن للمستأجر'}</span><span class="num">${fmt(Math.abs(totalDue - totalPaid))} ${SAR}</span></div>
      ${upcoming > 0 ? `<div class="t-row"><span>${t('statement.upcomingTotal', { lng: 'ar' })}</span><span class="num">${fmt(upcoming)} ${SAR}</span></div>` : ''}
    </div>`, rows: 5,
  });
  const intro = `<div class="inv-meta">
    <div class="inv-box"><b>المستأجر:</b> ${esc(d.tenantName)}<br><b>العقد:</b> <span class="num">${esc(d.contractNo || 'لا يوجد')}</span><br><b>الوحدة:</b> ${esc(d.unitLabel)}</div>
    <div class="inv-box"><b>المدة:</b> <span class="num">${d.start ? dfmt(d.start) : 'لا يوجد'}</span> إلى <span class="num">${d.end ? dfmt(d.end) : 'لا يوجد'}</span><br><b>عدد الحركات:</b> <span class="num">${d.rows.length}</span></div>
  </div>`;
  return pagedDoc(co, 'كشف حساب مستأجر', d.contractNo || undefined, issuedAt, intro, chunks);
}

export interface ContractDocData {
  contractNo: string; tenantName: string; idNumber: string; phone: string;
  unitLabel: string; propertyName: string; start: string | null; end: string | null;
  valueHalalas: number; depositHalalas: number;
  /** الخدمات والمواقف فوق قيمة الإيجار · وإجمالي العقد مجموع الثلاثة (المراجعة #4) */
  servicesHalalas?: number; parkingHalalas?: number;
  /** جهة قبض التأمين · تُطبع نصاً بجانب مبلغه */
  depositHolderLabel?: string;
  cycle: string; status: string;
  installments: Array<{ dueDate: string; amountHalalas: number; paidHalalas: number; status: string }>;
}

/** عقد الإيجار · نسخة المكتب: الأطراف والوحدة والمدة والقيمة وجدول الأقساط */
export function buildContractDoc(co: CompanyInfo, c: ContractDocData, issuedAt: string): string {
  const chunks: PagedChunk[] = [];
  const services = Math.max(0, c.servicesHalalas ?? 0);
  const parking = Math.max(0, c.parkingHalalas ?? 0);
  const total = c.valueHalalas + services + parking;
  const ar = (k: string) => esc(t(k, { lng: 'ar' }));
  // سطر التفصيل حين يكون في العقد خدمات أو مواقف · وإلا فالقيمة هي الإجمالي
  const splitHtml = services || parking
    ? `<br><b>${ar('lease.print.services')}:</b> <span class="num">${fmt(services)}</span> ${SAR}<br><b>${ar('lease.print.parking')}:</b> <span class="num">${fmt(parking)}</span> ${SAR}<br><b>${ar('lease.print.total')}:</b> <span class="num">${fmt(total)}</span> ${SAR}`
    : '';
  chunks.push({
    html: `<h3>جدول الأقساط (${c.installments.length})</h3>
    <table><thead><tr><th>م</th><th>تاريخ الاستحقاق</th><th>القسط</th><th>المسدَّد</th><th>الحالة</th></tr></thead><tbody>
    ${c.installments.slice(0, 18).map((i, n) => `<tr><td class="num">${n + 1}</td><td class="num">${dfmt(i.dueDate)}</td><td class="num">${fmt(i.amountHalalas)}</td><td class="num">${fmt(i.paidHalalas)}</td><td>${esc(i.status)}</td></tr>`).join('')}
    </tbody></table>`, rows: Math.min(18, c.installments.length) + 3,
  });
  for (let s = 18; s < c.installments.length; s += 22) {
    const part = c.installments.slice(s, s + 22);
    chunks.push({
      html: `<table><thead><tr><th>م</th><th>تاريخ الاستحقاق</th><th>القسط</th><th>المسدَّد</th><th>الحالة</th></tr></thead><tbody>
      ${part.map((i, n) => `<tr><td class="num">${s + n + 1}</td><td class="num">${dfmt(i.dueDate)}</td><td class="num">${fmt(i.amountHalalas)}</td><td class="num">${fmt(i.paidHalalas)}</td><td>${esc(i.status)}</td></tr>`).join('')}
      </tbody></table>`, rows: part.length + 2,
    });
  }
  chunks.push({
    html: `<div class="words">${services || parking ? ar('lease.print.total') : ar('lease.print.value')}: ${fmt(total)} ${SAR} · ${esc(moneyToArabicWords(total))}</div>
    <div class="sign-row">
      <div class="sign"><div class="line"></div>المستأجر: ${esc(c.tenantName)}</div>
      <div class="sign"><div class="line"></div>ممثل ${esc(co.name || 'المكتب')}</div>
    </div>`, rows: 6,
  });
  const intro = `<div class="inv-meta">
    <div class="inv-box"><b>المستأجر:</b> ${esc(c.tenantName)}<br><b>الهوية:</b> <span class="num">${esc(c.idNumber || 'لا يوجد')}</span><br><b>الجوال:</b> <span class="num">${esc(c.phone || 'لا يوجد')}</span></div>
    <div class="inv-box"><b>العقار:</b> ${esc(c.propertyName)}<br><b>الوحدة:</b> ${esc(c.unitLabel)}<br><b>الحالة:</b> ${esc(c.status)}</div>
  </div>
  <div class="inv-meta">
    <div class="inv-box"><b>المدة:</b> <span class="num">${c.start ? dfmt(c.start) : 'لا يوجد'}</span> إلى <span class="num">${c.end ? dfmt(c.end) : 'لا يوجد'}</span><br><b>الدورية:</b> ${esc(c.cycle)}</div>
    <div class="inv-box"><b>${services || parking ? ar('lease.print.rent') : ar('lease.print.value')}:</b> <span class="num">${fmt(c.valueHalalas)}</span> ${SAR}${splitHtml}<br><b>التأمين:</b> <span class="num">${fmt(c.depositHalalas)}</span> ${SAR}${c.depositHolderLabel ? ' · ' + esc(c.depositHolderLabel) : ''}</div>
  </div>`;
  return pagedDoc(co, 'عقد إيجار · نسخة المكتب', c.contractNo || undefined, issuedAt, intro, chunks);
}

export interface HandoverDocData {
  occupants?: Array<{ name: string; relation: string; nationalId: string }>;
  type: string; tenantName: string; idNumber: string; phone: string; address: string;
  unitFloor: string; contractPeriod: string; date: string; tenantSign: string; companySign: string;
  sections: HandoverSection[];
  legalFooter: string;
}

/** محضر الاستلام والتسليم · الأقسام السبعة مرقَّمة الصفحات وتوقيعان */
export function buildHandoverDoc(co: CompanyInfo, h: HandoverDocData, issuedAt: string, copy: CopyKind = 'office'): string {
  const build = (copyLabel?: string): string => {
    const chunks: PagedChunk[] = [];
    if (h.occupants?.length) {
      chunks.push({
        html: '<h3>ساكنو الوحدة (' + h.occupants.length + ')</h3>' +
          '<table><thead><tr><th>الاسم</th><th>الصلة</th><th>رقم الهوية</th></tr></thead><tbody>' +
          h.occupants.map((o) => '<tr><td>' + esc(o.name) + '</td><td>' + esc(o.relation) + '</td><td class="num">' + esc(o.nationalId) + '</td></tr>').join('') +
          '</tbody></table>',
        rows: h.occupants.length + 3,
      });
    }
    chunks.push(...h.sections.map((s, si) => ({
      html: `<h3>${si + 1}. ${esc(s.section)}</h3>
      <table><thead><tr><th>البند</th><th>العدد</th><th>الحالة عند الاستلام</th><th>الحالة عند التسليم</th><th>ملاحظات</th></tr></thead><tbody>
      ${s.items.map((it) => `<tr><td>${esc(it.name)}</td><td class="num">${esc(it.count)}</td><td>${esc(it.receiveCondition)}</td><td>${esc(it.deliverCondition)}</td><td>${esc(it.notes)}</td></tr>`).join('')}
      </tbody></table>`,
      rows: s.items.length + 3,
    })));
    chunks.push({
      html: `<div style="margin-top:14px;font-size:11px;line-height:1.9;background:#F6F4EE;border-radius:8px;padding:10px 12px;border:1px solid #EDEAE0">${esc(h.legalFooter)}</div>
      <div class="sign-row">
        <div class="sign"><div class="line"></div>المستأجر: ${esc(h.tenantSign || h.tenantName)}</div>
        <div class="sign"><div class="line"></div>ممثل الشركة: ${esc(h.companySign || '')}</div>
      </div>`, rows: 8,
    });
    const intro = `<div class="inv-meta">
      <div class="inv-box"><b>المستأجر:</b> ${esc(h.tenantName)}<br><b>الهوية:</b> <span class="num">${esc(h.idNumber)}</span><br><b>الهاتف:</b> <span class="num">${esc(h.phone)}</span></div>
      <div class="inv-box"><b>الوحدة:</b> ${esc(h.unitFloor)}<br><b>العنوان:</b> ${esc(h.address)}<br><b>مدة العقد:</b> ${esc(h.contractPeriod)}<br><b>التاريخ:</b> <span class="num">${dfmt(h.date)}</span></div>
    </div>`;
    return pagedDoc(co, 'محضر ' + h.type, undefined, issuedAt, intro, chunks, copyLabel);
  };
  if (copy === 'both') return build(COPY_LABEL.tenant) + build(COPY_LABEL.office);
  return build(COPY_LABEL[copy]);
}

export interface ClaimDocData {
  contractNo: string; tenantName: string; unitLabel: string;
  amountHalalas: number; reason: string; date: string;
}

/** إشعار مطالبة · يُسلَّم أو يُرسل */
export function buildClaimDoc(co: CompanyInfo, cl: ClaimDocData, issuedAt: string): string {
  return `<div class="page">
    ${letterhead(co, 'إشعار مطالبة')}
    <div class="inv-meta">
      <div class="inv-box"><b>المستأجر:</b> ${esc(cl.tenantName)}<br><b>العقد:</b> <span class="num">${esc(cl.contractNo || 'لا يوجد')}</span><br><b>الوحدة:</b> ${esc(cl.unitLabel || 'لا يوجد')}</div>
      <div class="inv-box"><b>تاريخ الإشعار:</b> <span class="num">${dfmt(cl.date)}</span><br><b>مبلغ المطالبة:</b> <span class="num">${fmt(cl.amountHalalas)}</span> ${SAR}</div>
    </div>
    <p style="font-size:12.5px;line-height:2">تحية طيبة وبعد،<br>
    نفيدكم بوجود مطالبة مالية مستحقة بذمتكم بمبلغ <b class="num">${fmt(cl.amountHalalas)}</b> ${SAR}
    (${esc(moneyToArabicWords(cl.amountHalalas))})، وبيانها: ${esc(cl.reason || 'لا يوجد')}.<br>
    نأمل المبادرة بالسداد أو التواصل معنا خلال مدة أقصاها سبعة أيام من تاريخ هذا الإشعار.</p>
    <div class="sign-row">
      <div class="sign"><div class="line"></div>${esc(co.name || 'المكتب')}</div>
    </div>
    ${pageFooter(1, 1, issuedAt)}
  </div>`;
}
