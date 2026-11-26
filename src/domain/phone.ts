import { toLatinDigits } from './money';

/**
 * توحيد رقم الجوال السعودي · كل الصيغ تُقبل وتُخزَّن بصيغة واحدة 05XXXXXXXX:
 * ‏+966… · 00966… · 0966… · 05… · 5… · بمسافات أو شرطات · وبالأرقام العربية والفارسية (E-16).
 */
export function normalizePhone(raw: string | null | undefined): string | null {
  let s = toLatinDigits(String(raw || '')).replace(/[^\d+]/g, '');
  s = s.replace(/^\+?00/, '').replace(/^\+/, '').replace(/^0(?=966)/, '');
  if (s.startsWith('966')) s = s.slice(3);
  if (s.startsWith('0')) s = s.slice(1);
  return /^5\d{8}$/.test(s) ? '0' + s : null;
}

/** صيغة العرض: 05 4599 5268 */
export function displayPhone(stored: string): string {
  const p = normalizePhone(stored);
  if (!p) return stored;
  return p.slice(0, 2) + ' ' + p.slice(2, 6) + ' ' + p.slice(6);
}

/** صيغة الاتصال الدولية: +966545995268 */
export function dialPhone(stored: string): string | null {
  const p = normalizePhone(stored);
  return p ? '+966' + p.slice(1) : null;
}
