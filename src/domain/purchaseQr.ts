/**
 * مسودة فاتورة الشراء من QR الفاتورة (التوجيه الرابع ٦ · ١): المورد برقمه الضريبي إن كان في الموردين، ثم باسمه إن لم يكن له رقمٌ آخر،
 * والتاريخ يوم الإصدار (الوقت بلا منطقة وقتُ الفاتورة المحلي، وبمنطقة يُحوَّل إلى توقيت الجهاز)، والمبالغ كما في الرمز (الصافي الإجمالي
 * ناقص الضريبة) · والوضع الضريبي لا يُقرأ من الرمز: الرمز لا يحمل المشتري، والمعيار «هل الفاتورة باسم المنشأة وبرقمها؟» (purchases.ts)
 * فيبقى الافتراض حتى يختار المستخدم · مسودةٌ تُراجع ولا تُحفظ بنفسها.
 */
import type { DB } from '../db/adapter';
import { localDateOf, today } from './dates';
import { hasZone, latinDigits, type ZatcaQr } from './zatcaQr';

export interface PurchaseQrDraft {
  supplier: string;
  /** المورد موجودٌ بهذا الرقم الضريبي (أو بالاسم وبلا رقمٍ آخر) */
  supplierId: string | null;
  /** مورد جديد يُنشأ برقمه حين يحفظ المستخدم */
  newSupplierVat: string | null;
  date: string;
  subtotalHalalas: number;
  taxHalalas: number;
  totalHalalas: number;
  /** تنبيهات الرمز، و«supplierVat»: موردٌ بالاسم نفسه برقمٍ ضريبي آخر، فاقتُرح موردٌ باسمٍ يميّزه برقم البائع */
  warnings: Array<ZatcaQr['warnings'][number] | 'supplierVat' | 'supplierArchived'>;
}

// والرقم أرقامه وحدها: بشرطاتٍ أو مسافاتٍ أو علامة اتجاه (U+200F) كما يُلصق (المدقق الخارجي L٣)
const normVat = (v: string | null | undefined) => latinDigits(String(v ?? '')).replace(/\D/g, '');
/**
 * بطاقةٌ تحمل الرقم: أرقامها كلها، أو مقطعٌ منها بين فواصل غير الشرطة والمسافة (المدقق الخارجي N١: «300000000000003 / س.ت 1010101010»
 * فيها الرقم الضريبي ورقم السجل التجاري، فكانت تُعدّ رقماً آخر)
 */
const cardHasVat = (card: string | null | undefined, vat: string): boolean => {
  if (!vat) return false;
  const text = latinDigits(String(card ?? ''));
  return normVat(text) === vat || text.split(/[^\d\s\-.\u200E\u200F]+/).some((seg) => normVat(seg) === vat);
};

export function purchaseDraftFromQr(db: DB, qr: ZatcaQr, now: () => string = today): PurchaseQrDraft {
  const vat = qr.warnings.includes('vatNo') ? '' : normVat(qr.vatNo);
  const seller = qr.sellerName.trim();
  // بالرقم الضريبي أولاً، ورقم البطاقة قد يكون بأرقامٍ عربية هندية (المدقق الخارجي J٥) · ثم بالاسم وحده إن لم يكن للبطاقة رقمٌ يخالف
  // رقم البائع (J١: كانت فاتورة بائعٍ برقمٍ آخر تُنسب صامتةً لموردٍ بالاسم نفسه فتُحفظ برقم البطاقة لا برقم البائع)
  const live = db.all<{ id: string; name: string; vat: string | null; archived: number }>(
    `SELECT id, name, vat, archived FROM suppliers WHERE deleted_at IS NULL ORDER BY archived, created_at`);
  const byVat = vat ? live.find((s) => cardHasVat(s.vat, vat)) : undefined;
  const byName = live.find((s) => s.name.trim() === seller);
  const nameClash = !byVat && !!byName && !!vat && !!normVat(byName.vat) && !cardHasVat(byName.vat, vat);
  const match = byVat ?? (nameClash ? undefined : byName);
  // والمورد المؤرشف لا يختاره نموذج الفاتورة (المدقق الخارجي L٤): يُنبَّه ليُعاد من الموردين، ولا يُقترح موردٌ مكرَّر باسمه
  const archived = !!match && Number(match.archived) === 1;
  const known = archived ? undefined : match;
  const at = qr.issuedAt.trim().replace(' ', 'T');
  const date = qr.warnings.includes('issuedAt') ? now() : hasZone(at) ? localDateOf(at) : at.slice(0, 10);
  return {
    supplier: known?.name ?? match?.name ?? (nameClash ? `${seller} · ${vat}` : seller),
    supplierId: known?.id ?? null,
    newSupplierVat: known || archived ? null : (vat || null),
    date,
    subtotalHalalas: qr.subtotalHalalas,
    taxHalalas: qr.vatHalalas,
    totalHalalas: qr.totalHalalas,
    warnings: [...qr.warnings, ...(nameClash ? ['supplierVat' as const] : []), ...(archived ? ['supplierArchived' as const] : [])],
  };
}
