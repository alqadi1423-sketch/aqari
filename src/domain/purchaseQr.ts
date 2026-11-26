/**
 * مسودة فاتورة الشراء من QR الفاتورة (التوجيه الرابع ٦ · ١): المورد برقمه الضريبي إن كان في الموردين، ثم باسمه إن لم يكن له رقمٌ آخر،
 * والتاريخ يوم الإصدار (الوقت بلا منطقة وقتُ الفاتورة المحلي، وبمنطقة يُحوَّل إلى توقيت الجهاز)، والمبالغ كما في الرمز (الصافي الإجمالي
 * ناقص الضريبة) · والوضع الضريبي لا يُقرأ من الرمز: الرمز لا يحمل المشتري، والمعيار «هل الفاتورة باسم المنشأة وبرقمها؟» (purchases.ts)
 * فيبقى الافتراض حتى يختار المستخدم · مسودةٌ تُراجع ولا تُحفظ بنفسها.
 */
import type { DB } from '../db/adapter';
import { today } from './dates';
import { issueDayOf, latinDigits, parseIssued, stripInvisible, type ZatcaQr } from './zatcaQr';

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
 * بطاقةٌ تحمل الرقم: في مقطعٍ منها بين فواصل غير الشرطة والمسافة والنقطة (المدقق الخارجي N١: «300000000000003 / س.ت 1010101010»)
 * مجموعاتُ أرقامٍ متتالية هي الرقم كله · فالرقم المكتوب مجموعاتٍ («300 0000 …») يُعرف، ومعه السجل التجاري بشرطةٍ أو مسافة
 * («V - CR» و«V CR» · P٢) يُعرف أيضاً، ولا يُعدّ جزءٌ من رقمٍ أطول رقماً
 */
export const cardHasVat = (card: string | null | undefined, vat: string): boolean => {
  if (!vat) return false;
  for (const seg of stripInvisible(latinDigits(String(card ?? ''))).split(/[^\d\s\-.]+/)) {
    const groups = seg.split(/\D+/).filter(Boolean);
    for (let i = 0; i < groups.length; i++) {
      let run = '';
      for (let j = i; j < groups.length && run.length < vat.length; j++) { run += groups[j]; if (run === vat) return true; }
    }
  }
  return false;
};
// والاسم بلا ما لا يُرى وبمسافاتٍ موحّدة (P٤ب: «RLM + الاسم» كان يُعدّ اسماً آخر فتُضاف بطاقةٌ ثانية تبدو نفسها) · وبيونيكود موحَّد
// (NFKC: المفكَّك وأشكال العرض العربية حروفها نفسها · المدقق الخارجي R٥)
const nfkc = (v: string) => { try { return v.normalize('NFKC'); } catch { return v; } };
export const normName = (v: string | null | undefined) => nfkc(stripInvisible(String(v ?? ''))).replace(/\s+/g, ' ').trim();

export function purchaseDraftFromQr(db: DB, qr: ZatcaQr, now: () => string = today): PurchaseQrDraft {
  const vat = qr.warnings.includes('vatNo') ? '' : normVat(qr.vatNo);
  const seller = normName(qr.sellerName);
  // بالرقم الضريبي أولاً، ورقم البطاقة قد يكون بأرقامٍ عربية هندية (المدقق الخارجي J٥) · ثم بالاسم وحده إن لم يكن للبطاقة رقمٌ يخالف
  // رقم البائع (J١: كانت فاتورة بائعٍ برقمٍ آخر تُنسب صامتةً لموردٍ بالاسم نفسه فتُحفظ برقم البطاقة لا برقم البائع)
  const live = db.all<{ id: string; name: string; vat: string | null; archived: number }>(
    `SELECT id, name, vat, archived FROM suppliers WHERE deleted_at IS NULL ORDER BY archived, created_at`);
  // وبين البطاقات التي تحمل الرقم: غير المؤرشفة أولاً، ثم ما رقمها هو الرقم وحده، ثم ما اسمها اسم البائع (المدقق الخارجي P١: بطاقةٌ
  // أقدم «فيها» الرقم بين أرقامٍ أخرى كانت تسبق بطاقةً رقمها هو الرقم واسمها اسمه، فتُنسب الفاتورة صامتةً لموردٍ آخر)
  // (والمؤرشف يُفاضَل به بعد المطابقة لا قبلها: بطاقةٌ مؤرشفة رقمها رقم البائع واسمها اسمه تُنبَّه ولا تغلبها بطاقةٌ أخرى · R٨)
  const rank = (s: (typeof live)[number]) =>
    (normVat(s.vat) === vat ? 0 : 4) + (normName(s.name) === seller ? 0 : 2) + (Number(s.archived) === 1 ? 1 : 0);
  const byVat = vat ? live.filter((s) => cardHasVat(s.vat, vat)).reduce<(typeof live)[number] | undefined>(
    (best, s) => (!best || rank(s) < rank(best) ? s : best), undefined) : undefined;
  const byName = live.find((s) => normName(s.name) === seller);
  const nameClash = !byVat && !!byName && !!vat && !!normVat(byName.vat) && !cardHasVat(byName.vat, vat);
  const match = byVat ?? (nameClash ? undefined : byName);
  // والمورد المؤرشف لا يختاره نموذج الفاتورة (المدقق الخارجي L٤): يُنبَّه ليُعاد من الموردين، ولا يُقترح موردٌ مكرَّر باسمه
  const archived = !!match && Number(match.archived) === 1;
  const known = archived ? undefined : match;
  // يوم الفاتورة: المكتوب لتاريخٍ وحده أو لمنتصف ليلٍ محشوّ، وبتوقيت المملكة لذي المنطقة، وما لا يُقرأ يومه تاريخ اليوم (R٦ وR٧ وT٤ وT٥)
  const date = issueDayOf(parseIssued(qr.issuedAt)) ?? now();
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
