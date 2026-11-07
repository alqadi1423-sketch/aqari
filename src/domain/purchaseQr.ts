/**
 * مسودة فاتورة الشراء من QR الفاتورة (التوجيه الرابع ٦ · ١): المورد بالرقم الضريبي إن كان في الموردين وإلا باسم البائع في الرمز،
 * والتاريخ يوم الإصدار بتوقيت الجهاز، والمبالغ كما في الرمز (الصافي الإجمالي ناقص الضريبة) · والوضع الضريبي لا يُقرأ من الرمز: الرمز
 * لا يحمل المشتري، والمعيار «هل الفاتورة باسم المنشأة وبرقمها؟» (purchases.ts) فيبقى الافتراض حتى يختار المستخدم · مسودةٌ تُراجع
 * ولا تُحفظ بنفسها.
 */
import type { DB } from '../db/adapter';
import { localDateOf, today } from './dates';
import type { ZatcaQr } from './zatcaQr';

export interface PurchaseQrDraft {
  supplier: string;
  /** المورد موجودٌ بهذا الرقم الضريبي */
  supplierId: string | null;
  /** مورد جديد يُنشأ برقمه حين يحفظ المستخدم */
  newSupplierVat: string | null;
  date: string;
  subtotalHalalas: number;
  taxHalalas: number;
  totalHalalas: number;
  warnings: ZatcaQr['warnings'];
}

export function purchaseDraftFromQr(db: DB, qr: ZatcaQr, now: () => string = today): PurchaseQrDraft {
  // بالرقم الضريبي أولاً، ثم بالاسم (موردٌ سُجّل بلا رقمه) فلا يُقترح موردٌ يرفضه الحفظ مكرَّراً (suppliers.ts)
  const known = (qr.vatNo
    ? db.get<{ id: string; name: string }>(`SELECT id, name FROM suppliers WHERE TRIM(vat) = ? AND deleted_at IS NULL ORDER BY created_at LIMIT 1`, [qr.vatNo])
    : null)
    ?? db.get<{ id: string; name: string }>(`SELECT id, name FROM suppliers WHERE TRIM(name) = ? AND deleted_at IS NULL ORDER BY created_at LIMIT 1`, [qr.sellerName.trim()]);
  const date = qr.warnings.includes('issuedAt') ? now() : localDateOf(qr.issuedAt);
  return {
    supplier: known?.name ?? qr.sellerName,
    supplierId: known?.id ?? null,
    newSupplierVat: known ? null : (qr.warnings.includes('vatNo') ? null : qr.vatNo),
    date,
    subtotalHalalas: qr.subtotalHalalas,
    taxHalalas: qr.vatHalalas,
    totalHalalas: qr.totalHalalas,
    warnings: qr.warnings,
  };
}
