/**
 * الأصول (قرار المالك ٢٠٢٦-١٠-٠٤ على موجز الأصول): سبع فئات بحساباتها وأعمارها الافتراضية،
 * ومجمع إهلاك واحد ومصروفه وخسارة الاستبعاد وأرباح البيع.
 * الحالات والمصادر وأنواع الأحداث رموزٌ ثابتة تُترجم عند العرض (assets.* في ملفات الترجمة).
 */
import { t } from '../../i18n';

export interface AssetCategory { code: string; lifeMonths: number }

/** الفئات بحساباتها · والعمر الافتراضي يُعدَّل لكل أصل */
export const ASSET_CATEGORIES: AssetCategory[] = [
  { code: '1410', lifeMonths: 84 },
  { code: '1420', lifeMonths: 60 },
  { code: '1430', lifeMonths: 60 },
  { code: '1440', lifeMonths: 36 },
  { code: '1450', lifeMonths: 36 },
  { code: '1460', lifeMonths: 120 },
  { code: '1470', lifeMonths: 60 },
];
export const isAssetCategory = (code: string | null | undefined): boolean => ASSET_CATEGORIES.some((c) => c.code === code);
export const defaultLife = (code: string): number => ASSET_CATEGORIES.find((c) => c.code === code)?.lifeMonths ?? 60;
export const categoryName = (code: string): string => t('assets.cat.' + code);

export const ACC_ACCUM = '1490';
export const ACC_DEPRECIATION = '5600';
export const ACC_DISPOSAL_LOSS = '5700';
export const ACC_SALE_GAIN = '4400';
export const ACC_CAPITAL = '3100';
export const ACC_RETAINED = '3200';
export const ACC_CASH = '1100';

/** حسابات القسم بأسمائها العربية المخزّنة في الدليل (الهجرة ٢٩) · تتبع اللغة في مرحلة الرموز الثابتة */
export const ASSET_ACCOUNTS: Array<{ code: string; type: 'asset' | 'expense' | 'revenue' }> = [
  ...ASSET_CATEGORIES.map((c) => ({ code: c.code, type: 'asset' as const })),
  { code: ACC_ACCUM, type: 'asset' },
  { code: ACC_DEPRECIATION, type: 'expense' },
  { code: ACC_DISPOSAL_LOSS, type: 'expense' },
  { code: ACC_SALE_GAIN, type: 'revenue' },
];

export type AssetStatus = 'in_service' | 'maintenance' | 'disposed' | 'sold';
export type AssetSource = 'manual' | 'purchase' | 'convert' | 'contents';
export type AssetEventKind = 'cost' | 'transfer' | 'dispose' | 'sell' | 'status' | 'convert';
export const ENDED: AssetStatus[] = ['disposed', 'sold'];

/**
 * الفئة المقترحة من اسم البند · كلماتها في ملفي الترجمة (assets.keywords.<الفئة>) فتُطابق باللغتين ·
 * وما لا يطابق شيئاً لا يُقترح له شيء (المفاتيح والجدران ليست أصولاً)
 */
/** توحيد الهمزات والتاء المربوطة والتشكيل للمطابقة */
const fold = (s: string) => s.toLowerCase()
  .replace(/[ً-ْـ]/g, '')
  .replace(/[أإآ]/g, 'ا') // i18n-exempt: حرف مطابقة لا نص عرض
  .replace(/ة/g, 'ه'); // i18n-exempt: حرف مطابقة لا نص عرض

export function suggestCategory(name: string): string | null {
  const n = ' ' + fold(name) + ' ';
  for (const c of ASSET_CATEGORIES) {
    for (const lng of ['ar', 'en']) {
      const words = t('assets.keywords.' + c.code, { lng }).split('|').map((w) => fold(w.trim())).filter(Boolean);
      if (words.some((w) => n.includes(w))) return c.code;
    }
  }
  return null;
}
