/**
 * الطباعة عبر expo-print · القوالب كلها في src/domain/printDocs (نقية ومختبرة):
 * A4 بترويسة المنشأة وتذييل مرقَّم، والمخرجات: مشاركة PDF باسم مفهوم،
 * وإرفاق بالسجل في المكتبة عند الطلب، والطباعة المباشرة عبر حوار النظام.
 */
import { showDialog } from '../ui/AppDialog';
import { reportFailure } from '../ui/failureDialog';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import { File, Directory, Paths } from 'expo-file-system';
import type { DB } from '../db/adapter';
import { fmt } from '../domain/money';
import { dfmt, today } from '../domain/dates';
import {
  PRINT_CSS, letterhead, esc, type CompanyInfo, type CopyKind,
  buildReceiptDoc, buildInvoiceDoc, buildStatementDoc, buildContractDoc,
  buildHandoverDoc, buildClaimDoc, type StatementRow,
} from '../domain/printDocs';
import type { HandoverSection } from '../domain/handover/build';
import { HANDOVER_LEGAL_FOOTER } from '../domain/handover/build';
import { putAttachment } from '../files/store';
import { appFilesEnv } from './filesEnv';
import { occupantsOf } from '../domain/occupants';
import { depositState } from '../domain/contracts/vocab';
import { contractStatusLabel } from '../domain/contracts/rules';

export function companyInfo(db: DB): CompanyInfo {
  const co = db.get<{ name: string; vatno: string; cr: string; phone: string; address: string; vat_enabled: number }>(
    `SELECT name, vatno, cr, phone, address, vat_enabled FROM company WHERE id = 1`
  );
  return {
    name: co?.name || '', vatno: co?.vatno || '', cr: co?.cr || '',
    phone: co?.phone || '', address: co?.address || '', vatEnabled: !!Number(co?.vat_enabled),
  };
}

/** ترويسة التقارير (تستعملها reportExport) · نفس بيانات المنشأة */
export function companyHeader(db: DB): string {
  const co = companyInfo(db);
  return `<div><div style="font-weight:800;font-size:16px">${esc(co.name || 'لا يوجد')}</div>
    ${co.vatno ? `<div style="font-size:11.5px;color:#77808F;margin-top:4px">الرقم الضريبي: <span class="num">${esc(co.vatno)}</span></div>` : ''}</div>`;
}

const issuedNow = (): string => {
  const d = new Date();
  const two = (n: number) => String(n).padStart(2, '0');
  return `${dfmt(`${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`)} ${two(d.getHours())}:${two(d.getMinutes())}`;
};

/** توليد PDF باسم مفهوم · يعيد مساره */
async function renderPdf(title: string, bodyHtml: string, filename: string): Promise<string> {
  const html = `<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="UTF-8"><title>${esc(title)}</title><style>${PRINT_CSS}</style></head><body>${bodyHtml}</body></html>`;
  const { uri } = await Print.printToFileAsync({ html });
  const dir = new Directory(Paths.cache.uri + 'prints/');
  if (!dir.exists) dir.create({ intermediates: true });
  const safe = filename.replace(/[\\/:*?"<>|]/g, '-');
  const dest = new File(dir.uri + safe + '.pdf');
  if (dest.exists) dest.delete();
  new File(uri).moveSync(dest);
  return dest.uri;
}

export interface AttachTarget { entityType: string; entityId: string; kind: string }

async function sharePdf(uri: string, title: string): Promise<void> {
  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(uri, { mimeType: 'application/pdf', dialogTitle: title, UTI: 'com.adobe.pdf' });
  } else {
    await Print.printAsync({ uri });
  }
}

async function attachPdf(db: DB, uri: string, filename: string, target: AttachTarget): Promise<void> {
  const bytes = new File(uri).bytesSync();
  await putAttachment(appFilesEnv(db), bytes, {
    entityType: target.entityType, entityId: target.entityId, kind: target.kind,
    originalName: filename + '.pdf', mime: 'application/pdf',
  });
}

/** المخرجات: مشاركة أو إرفاق بالسجل أو كلاهما · عند غياب جهة الربط تُشارك مباشرة */
async function outputPdf(db: DB, uri: string, title: string, filename: string, target?: AttachTarget): Promise<void> {
  if (!target) { await sharePdf(uri, title); return; }
  // حوار التطبيق لا حوار النظام · مقفول فلا يُغلق بالنقر خارجه بلا اختيار، والتراجع خيار صريح
  await new Promise<void>((resolve) => {
    showDialog({
      title, body: 'كيف تريد إخراج المستند؟', tone: 'normal', locked: true,
      actions: [
        { label: 'تراجع', variant: 'ghost', onPress: () => resolve() },
        { label: 'مشاركة', variant: 'ghost', onPress: () => { sharePdf(uri, title).catch(() => {}).finally(resolve); } },
        {
          label: 'إرفاق بالسجل', variant: 'ghost',
          onPress: () => { attachPdf(db, uri, filename, target).catch((e) => reportFailure({ title: 'تعذّر الإرفاق', where: 'إرفاق المستند بالسجل', db, e })).finally(resolve); },
        },
        {
          label: 'كلاهما', variant: 'primary',
          onPress: () => {
            attachPdf(db, uri, filename, target)
              .catch((e) => reportFailure({ title: 'تعذّر الإرفاق', where: 'إرفاق المستند بالسجل', db, e }))
              .then(() => sharePdf(uri, title)).catch(() => {}).finally(resolve);
          },
        },
      ],
    });
  });
}

/** مستند عام (التقارير) · نفس القشرة والهوية */
export async function printHtmlDoc(title: string, bodyHtml: string, filename?: string): Promise<void> {
  const brand = '<div style="text-align:center;margin-top:22px;font-size:10.5px;color:#9AA1AD">صدر عبر تطبيق عقاري · أحد حلول منصة رِكز · ' + esc(issuedNow()) + '</div>';
  const uri = await renderPdf(title, bodyHtml + brand, filename || title);
  await sharePdf(uri, title);
}

/** سند قبض لدفعة إيجار · نسخة المستأجر أو المكتب أو كلاهما */
export async function printReceipt(db: DB, paymentId: string, copy: CopyKind = 'tenant'): Promise<void> {
  const p = db.get<{
    id: string; period: string; date: string; gross_halalas: number; discount_halalas: number;
    net_halalas: number; method_label: string; notes: string; tenant_name: string;
    contract_no: string | null; unit_label: string; contract_id: string;
  }>(
    `SELECT p.id, p.period, p.date, p.gross_halalas, p.discount_halalas, p.net_halalas,
            p.method_label, p.notes, c.tenant_name, c.contract_no, c.unit_label, c.id AS contract_id
     FROM contract_payments p JOIN contracts c ON c.id = p.contract_id WHERE p.id = ?`,
    [paymentId]
  );
  if (!p) return;
  const no = 'RCP-' + p.id.slice(0, 8).toUpperCase();
  const body = buildReceiptDoc(companyInfo(db), {
    no, tenantName: p.tenant_name, contractNo: p.contract_no || '', unitLabel: p.unit_label,
    date: p.date, period: p.period, methodLabel: p.method_label, notes: p.notes,
    grossHalalas: Number(p.gross_halalas), discountHalalas: Number(p.discount_halalas), netHalalas: Number(p.net_halalas),
  }, issuedNow(), copy);
  const filename = 'سند قبض · ' + no;
  const uri = await renderPdf('سند قبض · ' + p.tenant_name, body, filename);
  await outputPdf(db, uri, 'سند قبض', filename, { entityType: 'contract', entityId: p.contract_id, kind: 'receipt' });
}

/** فاتورة · ضريبية بQR هيئة الزكاة عند تفعيل الضريبة، وبلا أي خانة ضريبة عند إطفائها */
export async function printInvoice(db: DB, invoiceId: string): Promise<void> {
  const v = db.get<{
    id: string; no: string; customer_name: string; customer_vat: string; issue: string; due: string;
    subtotal_halalas: number; tax_halalas: number; total_halalas: number; notes: string;
  }>(`SELECT * FROM invoices WHERE id = ?`, [invoiceId]);
  if (!v) return;
  const lines = db.all<{ descr: string; qty: number; price_halalas: number; tax_pct: number }>(
    `SELECT descr, qty, price_halalas, tax_pct FROM invoice_lines WHERE invoice_id = ? ORDER BY sort`,
    [invoiceId]
  );
  const body = buildInvoiceDoc(companyInfo(db), {
    no: v.no, customerName: v.customer_name, customerVat: v.customer_vat, issue: v.issue, due: v.due,
    notes: v.notes, subtotalHalalas: Number(v.subtotal_halalas), taxHalalas: Number(v.tax_halalas),
    totalHalalas: Number(v.total_halalas),
    lines: lines.map((l) => ({ descr: l.descr, qty: Number(l.qty), priceHalalas: Number(l.price_halalas), taxPct: Number(l.tax_pct) })),
  }, issuedNow());
  const filename = 'فاتورة · ' + v.no;
  const uri = await renderPdf('فاتورة ' + v.no, body, filename);
  await outputPdf(db, uri, 'فاتورة ' + v.no, filename, { entityType: 'invoice', entityId: v.id, kind: 'invoice' });
}

/** كشف حساب مستأجر · كل ما له وما عليه برصيد جارٍ */
export async function printTenantStatement(db: DB, contractId: string): Promise<void> {
  const c = db.get<{ id: string; tenant_name: string; contract_no: string | null; unit_label: string; start: string | null; end: string | null }>(
    `SELECT id, tenant_name, contract_no, unit_label, start, end FROM contracts WHERE id = ?`, [contractId]
  );
  if (!c) return;
  const rows: StatementRow[] = [];
  for (const i of db.all<{ due_date: string; amount_halalas: number; status: string }>(
    `SELECT due_date, amount_halalas, status FROM contract_installments
     WHERE contract_id = ? AND status != 'ملغية' ORDER BY due_date`, [contractId])) {
    rows.push({ date: i.due_date, descr: 'قسط إيجار مستحق', debitHalalas: Number(i.amount_halalas), creditHalalas: 0 });
  }
  for (const p of db.all<{ date: string; period: string; net_halalas: number; method_label: string }>(
    `SELECT date, period, net_halalas, method_label FROM contract_payments WHERE contract_id = ? ORDER BY date`, [contractId])) {
    rows.push({ date: p.date, descr: 'سداد' + (p.period ? ' · ' + p.period : '') + ' · ' + p.method_label, debitHalalas: 0, creditHalalas: Number(p.net_halalas) });
  }
  for (const cl of db.all<{ date: string; amount_halalas: number; reason: string }>(
    `SELECT date, amount_halalas, reason FROM claims WHERE contract_id = ? AND deleted_at IS NULL ORDER BY date`, [contractId])) {
    rows.push({ date: cl.date, descr: 'مطالبة · ' + (cl.reason || ''), debitHalalas: Number(cl.amount_halalas), creditHalalas: 0 });
  }
  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const body = buildStatementDoc(companyInfo(db), {
    tenantName: c.tenant_name, contractNo: c.contract_no || '', unitLabel: c.unit_label,
    start: c.start, end: c.end, rows,
  }, issuedNow());
  const filename = 'كشف حساب · ' + (c.contract_no || c.tenant_name);
  const uri = await renderPdf('كشف حساب · ' + c.tenant_name, body, filename);
  await outputPdf(db, uri, 'كشف حساب مستأجر', filename, { entityType: 'contract', entityId: c.id, kind: 'statement' });
}

/** عقد الإيجار · نسخة المكتب بجدول الأقساط */
export async function printContractDoc(db: DB, contractId: string): Promise<void> {
  const c = db.get<{
    id: string; contract_no: string | null; tenant_name: string; id_number: string; phone: string;
    unit_label: string; unit_id: string | null; start: string | null; end: string | null;
    value_halalas: number; deposit_halalas: number; cycle: string; status: string;
    deposit_holder: string | null; deposit_holder_name: string | null;
  }>(`SELECT * FROM contracts WHERE id = ?`, [contractId]);
  if (!c) return;
  const propertyName = c.unit_id
    ? db.get<{ name: string }>(
        `SELECT p.name FROM properties p JOIN units u ON u.property_id = p.id WHERE u.id = ?`, [c.unit_id]
      )?.name ?? 'لا يوجد'
    : 'لا يوجد';
  const installments = db.all<{ due_date: string; amount_halalas: number; paid_halalas: number; status: string }>(
    `SELECT due_date, amount_halalas, paid_halalas, status FROM contract_installments
     WHERE contract_id = ? AND status != 'ملغية' ORDER BY due_date`, [contractId]
  ).map((i) => ({ dueDate: i.due_date, amountHalalas: Number(i.amount_halalas), paidHalalas: Number(i.paid_halalas), status: i.status }));
  const body = buildContractDoc(companyInfo(db), {
    contractNo: c.contract_no || '', tenantName: c.tenant_name, idNumber: c.id_number || '',
    phone: c.phone || '', unitLabel: c.unit_label, propertyName, start: c.start, end: c.end,
    valueHalalas: Number(c.value_halalas), depositHalalas: Number(c.deposit_halalas),
    depositHolderLabel: Number(c.deposit_halalas) > 0
      ? depositState(c.deposit_holder, c.deposit_holder_name).label
      : undefined,
    // الحالة في المطبوعة محسوبة كما تظهر في الشاشات · لا الحالة المخزّنة الخام
    cycle: c.cycle || 'لا يوجد', status: contractStatusLabel(c), installments,
  }, issuedNow());
  const filename = 'عقد · ' + (c.contract_no || c.tenant_name);
  const uri = await renderPdf('عقد إيجار · ' + c.tenant_name, body, filename);
  await outputPdf(db, uri, 'عقد إيجار', filename, { entityType: 'contract', entityId: c.id, kind: 'lease' });
}

/** إشعار مطالبة */
export async function printClaim(db: DB, claimId: string): Promise<void> {
  const cl = db.get<{ id: string; contract_id: string; amount_halalas: number; reason: string; date: string }>(
    `SELECT id, contract_id, amount_halalas, reason, date FROM claims WHERE id = ?`, [claimId]
  );
  if (!cl) return;
  const c = db.get<{ contract_no: string | null; tenant_name: string; unit_label: string }>(
    `SELECT contract_no, tenant_name, unit_label FROM contracts WHERE id = ?`, [cl.contract_id]
  );
  const body = buildClaimDoc(companyInfo(db), {
    contractNo: c?.contract_no || '', tenantName: c?.tenant_name || 'لا يوجد', unitLabel: c?.unit_label || '',
    amountHalalas: Number(cl.amount_halalas), reason: cl.reason, date: cl.date,
  }, issuedNow());
  const filename = 'إشعار مطالبة · ' + (c?.contract_no || dfmt(cl.date));
  const uri = await renderPdf('إشعار مطالبة', body, filename);
  await outputPdf(db, uri, 'إشعار مطالبة', filename, { entityType: 'claim', entityId: cl.id, kind: 'claim' });
}

/** محضر الاستلام والتسليم · نسخة المكتب أو المستأجر أو كلاهما */
export async function printHandoverDoc(
  db: DB,
  h: {
    type: string; tenantName: string; idNumber: string; phone: string; address: string;
    unitFloor: string; contractPeriod: string; date: string; tenantSign: string; companySign: string;
    sections: HandoverSection[];
    contractId?: string;
  },
  copy: CopyKind = 'office'
): Promise<void> {
  const occ = h.contractId ? occupantsOf(db, h.contractId)
    .filter((o) => !o.moved_out)
    .map((o) => ({ name: o.name, relation: o.relation, nationalId: o.national_id })) : [];
  const body = buildHandoverDoc(companyInfo(db), { ...h, occupants: occ, legalFooter: HANDOVER_LEGAL_FOOTER }, issuedNow(), copy);
  const filename = 'محضر · ' + h.type + ' · ' + h.tenantName;
  const uri = await renderPdf('محضر ' + h.type + ' · ' + h.tenantName, body, filename);
  await sharePdf(uri, 'محضر ' + h.type);
}

