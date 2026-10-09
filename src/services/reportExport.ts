/**
 * تصدير التقارير المفصلة · PDF بهوية مستندات التطبيق، وإكسل (.xlsx حقيقي بأرقام
 * رقمية ومن اليمين لليسار)، ووورد (.docx) · ثلاثتها من مجمّع البيانات نفسه،
 * والتقرير الواحد يقبل أكثر من جهة (وحدات/عقارات/موردين) مع إجمالي موحَّد.
 */
import type { DB } from '../db/adapter';
import { fmt } from '../domain/money';
import { dfmt } from '../domain/dates';
import { printHtmlDoc, companyHeader, companyInfo } from './print';
import {
  unitReportData, propertyReportData, supplierReportData, invoicesReportData,
} from '../domain/reportData';
import { buildXlsx, buildDocx, type ReportBlock, type Cell, type XlsxDoc } from '../domain/officeBuild';
import { shareOfficeFile } from './officeFiles';

export type ExportKind = 'pdf' | 'xlsx' | 'docx';

const esc = (s: unknown): string =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

const M = (h: number): Cell => ({ money: Number(h) });
const periodLabel = (from: string | null, to: string) =>
  from ? `عن الفترة من ${dfmt(from)} إلى ${dfmt(to)}` : `حتى ${dfmt(to)} (كل الفترات)`;

/* ═══════════ ترويسة ملفات الإكسل ومعاييرها ═══════════ */

const issuedAt = (): string => {
  const d = new Date();
  const two = (n: number) => String(n).padStart(2, '0');
  return `${dfmt(`${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`)} ${two(d.getHours())}:${two(d.getMinutes())}`;
};

/** معايير الفترة · أول ما يظهر في ورقة «المعايير» بعد بيانات المنشأة */
const periodCriteria = (from: string | null, to: string): Array<[string, string]> => [
  ['من تاريخ', from ? dfmt(from) : 'كل الفترات'],
  ['إلى تاريخ', dfmt(to)],
];

/** الجهات المشمولة في تقرير متعدد · معيار يوضّح ما دخل الملف وما استُبعد */
const scopeCriteria = (label: string, blocks: ReportBlock[]): Array<[string, string]> => [
  ['عدد ' + label, String(blocks.length)],
  ...blocks.map((b): [string, string] => ['مشمول في التقرير', b.heading]),
];

/** ترويسة الملف: المنشأة ورقمها الضريبي من جدول company · واسم التقرير وفترته ووقت إصداره */
function xlsxDoc(db: DB, report: string, period: string, criteria: Array<[string, string]>): XlsxDoc {
  const co = companyInfo(db);
  return {
    companyName: co.name || 'لا يوجد',
    companyVatno: co.vatno || 'لا يوجد',
    report, period, issuedAt: issuedAt(), criteria,
  };
}

/* ═══════════ كتل البيانات ═══════════ */

function unitBlock(db: DB, unitId: string, from: string | null, to: string): ReportBlock | null {
  const d = unitReportData(db, unitId, from, to);
  if (!d) return null;
  const splitCols = d.contracts.some((c) => Number(c.services_halalas) || Number(c.parking_halalas));
  return {
    heading: `وحدة ${d.unit.unit_no} · ${d.propertyName}`,
    meta: [
      ['النوع', d.unit.type + (d.unit.subtype ? ' · ' + d.unit.subtype : '')],
      ['الطابق', d.unit.floor || 'لا يوجد'],
      ['الإيجار الشهري', fmt(d.unit.rent_monthly_halalas)],
      ['نماذج الاستلام', String(d.handoversCount)],
    ],
    sections: [
      // إجمالي العقد، وتفصيله بأعمدة حين يكون في عقد منها خدمات أو مواقف (المراجعة #5)
      { title: `العقود (${d.contracts.length})`, header: [...['رقم العقد', 'المستأجر', 'من', 'إلى'], ...(splitCols ? [t('lease.print.rent'), t('lease.print.services'), t('lease.print.parking')] : []), t('lease.contractTotal'), 'الحالة'],
        rows: d.contracts.map((c) => [c.contract_no ?? 'لا يوجد', c.tenant_name, c.start ? dfmt(c.start) : 'لا يوجد', c.end ? dfmt(c.end) : 'لا يوجد', ...(splitCols ? [M(c.value_halalas), M(c.services_halalas), M(c.parking_halalas)] : []), M(c.total_halalas), c.status]) },
      { title: 'الأقساط', header: ['عدد الأقساط', 'المستحق حتى نهاية المدة', 'المحصَّل', 'المتبقي'],
        rows: [[d.installments.count, M(d.installments.due), M(d.installments.collected), M(d.installments.outstanding)]] },
      { title: `المقبوضات خلال المدة (${d.payments.length})`, header: ['التاريخ', 'الفترة', 'المستأجر', 'الطريقة', 'الصافي'],
        rows: d.payments.map((p) => [dfmt(p.date), p.period || 'لا يوجد', p.tenant_name, p.method_label, M(p.net_halalas)]) },
      { title: `المصاريف خلال المدة (${d.expenses.length})`, header: ['التاريخ', 'المورد', 'الفئة', 'المبلغ', 'الحالة'],
        rows: d.expenses.map((e) => [dfmt(e.date), e.supplier_name, e.category, M(e.total_halalas), Number(e.paid) ? 'مسدَّدة' : 'مستحقة']) },
      ...(d.meters.length ? [{ title: `العدادات (${d.meters.length})`, header: ['النوع', 'رقم العداد', 'المورد'],
        rows: d.meters.map((m) => [m.kind, m.number, m.supplier] as Cell[]) }] : []),
    ],
    // صيغ حيّة في إكسل: الدخل مجموع عمود «الصافي» في المقبوضات (القسم ٢)،
    // والمصاريف مجموع عمود «المبلغ» في المصاريف (القسم ٣) · لا أثر لها في PDF ووورد
    totals: [
      ['الدخل المحصَّل', { money: d.totals.income, f: 'SUM({S2C4})' }],
      ['المصاريف', { money: d.totals.expenses, f: 'SUM({S3C3})' }],
      ['الصافي', { money: d.totals.net, f: '{T0}-{T1}' }, true],
    ],
  };
}

function propertyBlock(db: DB, propertyId: string, from: string | null, to: string): ReportBlock | null {
  const d = propertyReportData(db, propertyId, from, to);
  if (!d) return null;
  return {
    heading: `عقار ${d.property.name}`,
    meta: [
      ['العنوان', d.property.address || 'لا يوجد'],
      ['الملكية', d.property.ownership || 'لا يوجد'],
      ['الصك', d.property.deed_no || 'لا يوجد'],
      ['التشغيل', `${d.occupancy.occupied} من ${d.occupancy.total} (${d.occupancy.pct}٪)`],
    ],
    sections: [
      { title: `الوحدات (${d.units.length})`, header: ['الوحدة', 'الطابق', 'النوع', 'الإيجار الشهري', 'المستأجر الحالي'],
        rows: d.units.map((u) => [u.unit_no, u.floor || 'لا يوجد', u.type, M(u.rent_monthly_halalas), u.tenant ?? 'شاغرة']) },
      { title: 'صافي كل وحدة خلال المدة', header: ['الوحدة', 'الدخل', 'المصاريف', 'الصافي'],
        rows: d.perUnit.map((u) => [u.unit_no, M(u.income), M(u.expenses), M(u.net)]) },
      { title: `المقبوضات خلال المدة (${d.payments.length})`, header: ['التاريخ', 'الوحدة', 'المستأجر', 'الفترة', 'الصافي'],
        rows: d.payments.map((p) => [dfmt(p.date), p.unit_label, p.tenant_name, p.period || 'لا يوجد', M(p.net_halalas)]) },
      { title: `المصاريف المشتركة (${d.sharedExpenses.length})`, header: ['التاريخ', 'المورد', 'الفئة', 'المبلغ'],
        rows: d.sharedExpenses.map((e) => [dfmt(e.date), e.supplier_name, e.category, M(e.total_halalas)]) },
      { title: `مصاريف الوحدات (${d.unitExpenses.length})`, header: ['التاريخ', 'الوحدة', 'المورد', 'الفئة', 'المبلغ'],
        rows: d.unitExpenses.map((e) => [dfmt(e.date), e.unit_no, e.supplier_name, e.category, M(e.total_halalas)]) },
    ],
    totals: [
      ['الدخل المحصَّل', { money: d.totals.income, f: 'SUM({S2C4})' }],
      ['المصاريف المشتركة', { money: d.totals.shared, f: 'SUM({S3C3})' }],
      ['مصاريف الوحدات', { money: d.totals.units, f: 'SUM({S4C4})' }],
      ['الصافي', { money: d.totals.net, f: '{T0}-{T1}-{T2}' }, true],
    ],
  };
}

function supplierBlock(db: DB, supplierId: string, from: string | null, to: string): ReportBlock | null {
  const d = supplierReportData(db, supplierId, from, to);
  if (!d) return null;
  // قسم الفواتير يزحف رقمه بقسم العدادات إن وُجد · مرجع الصيغة الحيّة يتبعه
  const invSec = d.meters.length ? 1 : 0;
  return {
    heading: `مورد ${d.supplier.name}`,
    meta: [
      ['الرقم الضريبي', d.supplier.vat || 'لا يوجد'],
      ['الجوال', d.supplier.phone || 'لا يوجد'],
      ['الفئة', d.supplier.category || 'لا يوجد'],
      ['نوع الخدمة', d.supplier.utility_type || 'لا يوجد'],
    ],
    sections: [
      ...(d.meters.length ? [{ title: `العدادات (${d.meters.length})`, header: ['النوع', 'رقم العداد', 'الموقع'],
        rows: d.meters.map((m) => [m.kind, m.number, m.label] as Cell[]) }] : []),
      { title: `الفواتير خلال المدة (${d.purchases.length})`, header: ['الرقم', 'التاريخ', 'الفئة', 'الجهة', 'المبلغ', 'الحالة'],
        rows: d.purchases.map((p) => [p.no, dfmt(p.date), p.category, p.target, M(p.total_halalas), Number(p.paid) ? 'مسدَّدة' : 'مستحقة']) },
      { title: 'حسب الفئة', header: ['الفئة', 'العدد', 'الإجمالي'],
        rows: d.byCategory.map((c) => [c.category, c.count, M(c.total)]) },
    ],
    totals: [
      ['عدد الفواتير', String(d.totals.count)],
      ['الإجمالي', { money: d.totals.total, f: `SUM({S${invSec}C4})` }],
      ['المسدَّد', M(d.totals.paid)],
      ['المتبقي', { money: d.totals.outstanding, f: '{T1}-{T2}' }, true],
    ],
  };
}

function invoicesBlock(db: DB, from: string | null, to: string): ReportBlock {
  const d = invoicesReportData(db, from, to);
  return {
    heading: 'الفواتير',
    meta: [],
    sections: [
      { title: `الفواتير (${d.rows.length})`, header: ['الرقم', 'العميل', 'الإصدار', 'الاستحقاق', 'الحالة', 'الإجمالي'],
        rows: d.rows.map((r) => [r.no, r.customer_name, dfmt(r.issue), dfmt(r.due), r.status, M(r.total_halalas)]) },
      { title: 'حسب الحالة', header: ['الحالة', 'العدد', 'الإجمالي'],
        rows: d.byStatus.map((s) => [s.status, s.count, M(s.total)]) },
      { title: 'حسب العميل', header: ['العميل', 'العدد', 'الإجمالي'],
        rows: d.byCustomer.map((c) => [c.customer, c.count, M(c.total)]) },
    ],
    totals: [
      ['عدد الفواتير', String(d.grand.count)],
      ['الإجمالي العام', { money: d.grand.total, f: 'SUM({S0C5})' }, true],
    ],
  };
}

/** إجمالي موحَّد عند تعدد الجهات: جمع بنود «الإجماليات» المشتركة عبر الكتل */
function combinedBlock(blocks: ReportBlock[]): ReportBlock | null {
  if (blocks.length < 2) return null;
  const sums = new Map<string, number>();
  const order: string[] = [];
  for (const b of blocks) {
    for (const [k, v] of b.totals) {
      if (typeof v !== 'object') continue;
      if (!sums.has(k)) order.push(k);
      sums.set(k, (sums.get(k) ?? 0) + v.money);
    }
  }
  return {
    heading: `الإجمالي الموحَّد (${blocks.length} جهات)`,
    meta: [],
    sections: [],
    totals: order.map((k, i) => [k, M(sums.get(k)!), i === order.length - 1]),
  };
}

/* ═══════════ العرض بالصيغ الثلاث ═══════════ */

const cellHtml = (c: Cell): string => (typeof c === 'object' ? fmt(c.money) : String(c ?? ''));
const isNum = (c: Cell): boolean => typeof c === 'object' || typeof c === 'number' || /^[\d,./%-]+$/.test(String(c));

const htmlTable = (header: string[], rows: Cell[][]) =>
  `<table><thead><tr>${header.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>` +
  rows.map((r) => `<tr>${r.map((c) => `<td class="${isNum(c) ? 'num' : ''}">${esc(cellHtml(c))}</td>`).join('')}</tr>`).join('') +
  '</tbody></table>';

function blocksToHtml(db: DB, title: string, sub: string, blocks: ReportBlock[]): string {
  const inner = blocks.map((b, bi) => {
    const metaHtml = b.meta.length
      ? `<div class="inv-meta"><div class="inv-box">${b.meta.map(([k, v]) => `<b>${esc(k)}:</b> ${esc(v)}`).join('<br>')}</div></div>`
      : '';
    const secs = b.sections.map((s) => `<h3>${esc(s.title)}</h3>${htmlTable(s.header, s.rows)}`).join('');
    const totals = b.totals.length
      ? `<div class="inv-totals">${b.totals.map(([k, v, big]) => `<div class="t-row${big ? ' tt' : ''}"><span>${esc(k)}</span><span class="num">${esc(cellHtml(v))}</span></div>`).join('')}</div>`
      : '';
    const head = blocks.length > 1 ? `<h2 style="margin:6px 0 10px">${esc(b.heading)}</h2>` : '';
    const brk = bi < blocks.length - 1 ? '<div style="page-break-after:always"></div>' : '';
    return head + metaHtml + secs + totals + brk;
  }).join('');
  return `<div class="inv-doc"><div class="inv-top">${companyHeader(db)}
    <div style="text-align:left"><div class="inv-title">${esc(title)}</div>
    <div style="font-size:11px;color:#77808F">${esc(sub)}</div></div></div>${inner}</div>`;
}

async function renderBlocks(
  db: DB, title: string, filenameBase: string, from: string | null, to: string,
  blocks: ReportBlock[], kind: ExportKind,
  /** معايير التقرير · تُفرد في ورقة «المعايير» داخل ملف الإكسل */
  criteria: Array<[string, string]> = []
): Promise<void> {
  const sub = periodLabel(from, to);
  if (kind === 'pdf') {
    await printHtmlDoc(title, blocksToHtml(db, title, sub, blocks));
    return;
  }
  if (kind === 'xlsx') {
    const sheets = blocks.map((b) => ({ name: b.heading, blocks: [b] }));
    await shareOfficeFile(filenameBase + '.xlsx',
      buildXlsx(sheets, xlsxDoc(db, title, sub, [...periodCriteria(from, to), ...criteria])), 'xlsx');
    return;
  }
  await shareOfficeFile(filenameBase + '.docx',
    buildDocx(title, sub, blocks, 'صدر عبر تطبيق عقاري · أحد حلول منصة رِكز'), 'docx');
}

/* ═══════════ الواجهات ═══════════ */

function withCombined(blocks: ReportBlock[]): ReportBlock[] {
  const c = combinedBlock(blocks);
  return c ? [...blocks, c] : blocks;
}

export async function exportUnitsReport(db: DB, unitIds: string[], from: string | null, to: string, kind: ExportKind): Promise<void> {
  const blocks = unitIds.map((id) => unitBlock(db, id, from, to)).filter((b): b is ReportBlock => !!b);
  if (!blocks.length) throw new Error('تعذّر العثور على الوحدات المحددة');
  const title = blocks.length === 1 ? `تقرير ${blocks[0].heading}` : `تقرير ${blocks.length} وحدات`;
  await renderBlocks(db, title, 'units-report', from, to, withCombined(blocks), kind,
    scopeCriteria('الوحدات', blocks));
}

export async function exportPropertiesReport(db: DB, ids: string[], from: string | null, to: string, kind: ExportKind): Promise<void> {
  const blocks = ids.map((id) => propertyBlock(db, id, from, to)).filter((b): b is ReportBlock => !!b);
  if (!blocks.length) throw new Error('تعذّر العثور على العقارات المحددة');
  const title = blocks.length === 1 ? `تقرير ${blocks[0].heading}` : `تقرير ${blocks.length} عقارات`;
  await renderBlocks(db, title, 'properties-report', from, to, withCombined(blocks), kind,
    scopeCriteria('العقارات', blocks));
}

export async function exportSuppliersReport(db: DB, ids: string[], from: string | null, to: string, kind: ExportKind): Promise<void> {
  const blocks = ids.map((id) => supplierBlock(db, id, from, to)).filter((b): b is ReportBlock => !!b);
  if (!blocks.length) throw new Error('تعذّر العثور على الموردين المحددين');
  const title = blocks.length === 1 ? `تقرير ${blocks[0].heading}` : `تقرير ${blocks.length} موردين`;
  await renderBlocks(db, title, 'suppliers-report', from, to, withCombined(blocks), kind,
    scopeCriteria('الموردين', blocks));
}

export async function exportInvoicesReport(db: DB, from: string | null, to: string, kind: ExportKind): Promise<void> {
  const block = invoicesBlock(db, from, to);
  await renderBlocks(db, 'تقرير الفواتير', 'invoices-report', from, to, [block], kind,
    [['نطاق التقرير', 'كل فواتير الفترة'], ['عدد الفواتير', String(block.sections[0].rows.length)]]);
}

/* ═══════════ الإقرار الضريبي · ١٦ بنداً والمستبعدة في سطر رقابة ═══════════ */

import { vatReturnData } from '../domain/vatReturn';
import { filedReturn } from '../domain/vatFilings';
import { QUARTER_AR } from '../domain/periods';
import { trialBalance, costCenterReport, type DimFilter } from '../domain/accounting/ledger';
import { dimsLabel } from '../domain/accounting/dimensions';

/** معيار التصفية بالأبعاد في رأس التقرير وورقة المعايير · لا شيء بلا تصفية */
const dimsMeta = (db: DB, dims?: DimFilter | null): Array<[string, string]> => {
  const l = dimsLabel(db, dims);
  return l ? [['التصفية', l]] : [];
};

const WATERMARK = '<div style="position:fixed;top:38%;left:0;right:0;text-align:center;transform:rotate(-28deg);font-size:96px;color:rgba(176,141,61,.14);font-weight:800;pointer-events:none">مسودة</div>';

export async function exportVatReturn(
  db: DB, year: number, quarter: 1 | 2 | 3 | 4, kind: ExportKind,
  /** معتمد = بلا علامة «مسودة» */
  approved = false
): Promise<void> {
  const live = vatReturnData(db, year, quarter);
  // الإقرار المقدَّم يُصدَّر بلقطة بنوده كما قُدِّم (قرار المالك على #30) · والكشوف المساندة من المستندات
  const filed = filedReturn(db, year, quarter);
  const d = filed ? { ...live, items: filed.items, excluded: filed.excluded } : live;
  const title = 'الإقرار الضريبي · ' + d.period;
  const mainBlock: ReportBlock = {
    heading: 'نموذج الإقرار · ' + d.period,
    meta: [
      ['الفترة', `${dfmt(d.from)} إلى ${dfmt(d.to)}`],
      ['أعمدة الإفصاح الذاتي والتعديل وسبب التعديل', 'تُملأ يدوياً في الملف المصدَّر'],
      ...(filed ? [[t('vat.filedLabel', { lng: 'ar' }), dfmt(filed.filedAt)] as [string, string]] : []),
    ],
    sections: [
      // بنود الإقرار الستة عشر لا تُجمع: كل بند مستقل ولا معنى لمجموعها
      { title: 'بنود الإقرار (يُملأ عمود الإقرار آلياً)', sum: false,
        header: ['#', 'البند', 'المبلغ', 'مبلغ الضريبة', 'الإفصاح الذاتي', 'مبلغ التعديل', 'سبب التعديل'],
        rows: d.items.map((i) => [i.no, i.label + (i.manual ? ' (يدوي)' : ''), M(i.amountHalalas), M(i.taxHalalas), '', '', '']) },
    ],
    totals: [
      ['فواتير غير قابلة للخصم خلال الفترة (لا تدخل البند ٧)', String(d.excluded.count) + ' فاتورة'],
      // سطر رقابة: الإيجار التجاري المحصَّل خارج البند ٥ حتى تُبنى ضريبة التجاري (دراسة القائم)
      ...(live.commercialRentHalalas ? [[t('vat.commercialRentControl', { lng: 'ar' }), M(live.commercialRentHalalas)] as [string, string]] : []),
      ['مبلغها شاملاً ضريبتها غير المخصومة', M(d.excluded.amountHalalas), true],
    ],
  };
  const schedules: ReportBlock = {
    heading: 'الكشوف المساندة',
    meta: [],
    sections: [
      { title: `١ · المشتريات القابلة للخصم (${d.schedules.deductiblePurchases.length})`, sum: true,
        header: ['الرقم', 'التاريخ', 'المورد', 'رقمه الضريبي', 'قبل الضريبة', 'الضريبة', 'الإجمالي'],
        rows: d.schedules.deductiblePurchases.map((r) => [r.no, dfmt(r.date), r.supplier, r.supplierVatno || 'لا يوجد', M(r.subtotal), M(r.tax), M(r.total)]) },
      { title: `٢ · غير القابلة للخصم (${d.schedules.excludedPurchases.length})`, sum: true,
        header: ['الرقم', 'التاريخ', 'المورد', 'قبل الضريبة', 'الضريبة (ضمن التكلفة)', 'الإجمالي', 'سبب الاستبعاد'],
        rows: d.schedules.excludedPurchases.map((r) => [r.no, dfmt(r.date), r.supplier, M(r.subtotal), M(r.tax), M(r.total), r.reason || 'لا يوجد']) },
      { title: `٣ · المبيعات المعفاة · إيرادات الإيجار السكني (${d.schedules.exemptSales.length})`, sum: true,
        header: ['التاريخ', 'المستأجر', 'العقد', 'الوحدة', 'المحصَّل'],
        rows: d.schedules.exemptSales.map((r) => [dfmt(r.date), r.tenant, r.contractNo, r.unitLabel, M(r.net)]) },
      { title: `٤ · بيان الحوالات (${d.schedules.transfers.length})`, sum: true,
        header: ['التاريخ', 'المبلغ', 'الجهة', 'الغرض', 'رقم المرجع البنكي', 'رقم الفاتورة'],
        rows: d.schedules.transfers.map((r) => [dfmt(r.date), M(r.amount), r.party, r.purpose, r.bankRef, r.invoiceNo]) },
    ],
    totals: [],
  };
  const filenameBase = 'vat-return-' + d.period + (approved ? '' : '-draft');
  if (kind === 'pdf') {
    const html = blocksToHtml(db, title, `${dfmt(d.from)} إلى ${dfmt(d.to)}` + (approved ? '' : ' · مسودة'), [mainBlock, schedules]);
    await printHtmlDoc(title, (approved ? '' : WATERMARK) + html, filenameBase);
    return;
  }
  if (kind === 'xlsx') {
    const raw: ReportBlock = {
      heading: 'البيانات الخام', meta: [],
      sections: [{
        title: 'كل فواتير الفترة', sum: true,
        header: ['الرقم', 'التاريخ', 'المورد', 'الوضع الضريبي', 'قبل الضريبة', 'الضريبة', 'الإجمالي'],
        rows: [...d.schedules.deductiblePurchases.map((r) => [r.no, r.date, r.supplier, 'فاتورة ضريبية · قابلة للخصم', M(r.subtotal), M(r.tax), M(r.total)] as Cell[]),
               ...d.schedules.excludedPurchases.map((r) => [r.no, r.date, r.supplier, 'غير قابلة للخصم', M(r.subtotal), M(r.tax), M(r.total)] as Cell[])],
      }],
      totals: [],
    };
    await shareOfficeFile(filenameBase + '.xlsx',
      buildXlsx([
        { name: 'الملخص', blocks: [mainBlock] },
        { name: 'الكشوف المساندة', blocks: [schedules] },
        { name: 'البيانات الخام', blocks: [raw] },
      ], xlsxDoc(db, title, `${dfmt(d.from)} إلى ${dfmt(d.to)}`, [
        ...periodCriteria(d.from, d.to),
        ['السنة', String(year)],
        ['الربع', QUARTER_AR[quarter]],
        ['حالة الإقرار', approved ? 'معتمد' : 'مسودة'],
        ['عدد بنود النموذج', String(d.items.length)],
        ['المشتريات القابلة للخصم', String(d.schedules.deductiblePurchases.length) + ' فاتورة'],
        ['غير القابلة للخصم (مستبعدة من البند ٧)', String(d.schedules.excludedPurchases.length) + ' فاتورة'],
        ['المبيعات المعفاة · الإيجار السكني', String(d.schedules.exemptSales.length) + ' مقبوض'],
        ['بيان الحوالات', String(d.schedules.transfers.length) + ' حوالة'],
      ])), 'xlsx');
    return;
  }
  await shareOfficeFile(filenameBase + '.docx',
    buildDocx(title, `${dfmt(d.from)} إلى ${dfmt(d.to)}`, [mainBlock, schedules],
      'صدر عبر تطبيق عقاري · أحد حلول منصة رِكز', ['المحاسب', 'المدير']), 'docx');
}

/* ═══════════ ميزان المراجعة ═══════════ */

export async function exportTrialBalance(db: DB, from: string | null, to: string, kind: ExportKind, dims?: DimFilter | null): Promise<void> {
  const rows = trialBalance(db, from, to, dims);
  const totD = rows.reduce((s2, r) => s2 + r.debitHalalas, 0);
  const totC = rows.reduce((s2, r) => s2 + r.creditHalalas, 0);
  const block: ReportBlock = {
    heading: 'ميزان المراجعة',
    meta: [['المدة', periodLabel(from, to)], ...dimsMeta(db, dims)],
    sections: [{
      title: 'الحسابات', sum: true,
      header: ['م', 'اسم الحساب', 'رصيد أول المدة', 'إجمالي الحركة المدينة', 'إجمالي الحركة الدائنة', 'رصيد آخر المدة'],
      rows: rows.map((r) => [r.code, r.name, M(r.openingHalalas), M(r.debitHalalas), M(r.creditHalalas), M(r.closingHalalas)]),
    }],
    totals: [
      // صيغ إكسل حيّة على عمودي الحركة المدينة (3) والدائنة (4) والقيمة المحسوبة كاش
      ['إجمالي الحركة المدينة', { money: totD, f: 'SUM({S0C3})' }],
      ['إجمالي الحركة الدائنة', { money: totC, f: 'SUM({S0C4})' }],
      [totD === totC ? 'المدين = الدائن ✓' : 'غير متوازن · تحقق من القيود', { money: totD - totC, f: '{T0}-{T1}' }, true],
    ],
  };
  await renderBlocks(db, 'ميزان المراجعة', 'trial-balance', from, to, [block], kind, [
    ['عدد الحسابات', String(rows.length)],
    ['مصدر الأرقام', 'قيود دفتر الأستاذ المرحّلة'],
    ['حالة التوازن', totD === totC ? 'متوازن' : 'غير متوازن'],
    ...dimsMeta(db, dims),
  ]);
}

/** الإيرادات والمصروفات حسب مركز التكلفة (قرار المالك ٢٠٢٦-١٠-٠٤) */
export async function exportCostCenterReport(db: DB, from: string | null, to: string, kind: ExportKind, dims?: DimFilter | null): Promise<void> {
  const rows = costCenterReport(db, from, to, dims);
  const block: ReportBlock = {
    heading: 'حسب مركز التكلفة',
    meta: [['المدة', periodLabel(from, to)], ...dimsMeta(db, { ...(dims ?? {}), costCenterId: null })],
    sections: [{
      title: 'المراكز', sum: true,
      header: ['مركز التكلفة', 'الإيرادات', 'المصروفات', 'الصافي'],
      rows: rows.map((r) => [r.name, M(r.revenue), M(r.expense), M(r.net)]),
    }],
    totals: [
      ['إجمالي الإيرادات', { money: rows.reduce((a, r) => a + r.revenue, 0), f: 'SUM({S0C1})' }],
      ['إجمالي المصروفات', { money: rows.reduce((a, r) => a + r.expense, 0), f: 'SUM({S0C2})' }],
      ['الصافي', { money: rows.reduce((a, r) => a + r.net, 0), f: '{T0}-{T1}' }, true],
    ],
  };
  await renderBlocks(db, 'الإيرادات والمصروفات حسب مركز التكلفة', 'cost-centers', from, to, [block], kind, [
    ['عدد المراكز', String(rows.length)],
    ['مصدر الأرقام', 'قيود دفتر الأستاذ المرحّلة'],
    ...dimsMeta(db, { ...(dims ?? {}), costCenterId: null }),
  ]);
}

/* القوائم المالية الأربع · المنطق النقي في src/domain/finStatements.ts */
import { financialStatementBlock, FIN_TITLES, withLiveFormulas, type FinStatement } from '../domain/finStatements';
import { t } from '../i18n';
export type { FinStatement };

export async function exportFinancialStatement(db: DB, tab: FinStatement, from: string | null, to: string, kind: ExportKind, dims?: DimFilter | null): Promise<void> {
  const base = financialStatementBlock(db, tab, from, to, dims);
  const block = withLiveFormulas(tab, { ...base, meta: [...base.meta, ...dimsMeta(db, dims)] });
  await renderBlocks(db, FIN_TITLES[tab], 'fin-' + tab, from, to, [block], kind, [
    ['القائمة', FIN_TITLES[tab]],
    ['مصدر الأرقام', 'قيود دفتر الأستاذ المرحّلة'],
    ...block.meta.map(([k, v]): [string, string] => [k, v]),
  ]);
}
