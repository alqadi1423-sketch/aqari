/**
 * ترقيم لا يتصادم بين الأجهزة (قرار المالك ٢٠٢٦-١٠-٠٣):
 * كل جهاز يأخذ حرفاً لاتينياً عند أول دخول بالحساب، والجهاز الأول بلا حرف ·
 * الحرف بعد الرقم: JE-0042 · JE-0042-B · EJ-2026-007-B · INV-2026-0103-B · PUR-012-B.
 * والتسلسل لكل جهاز من أرقامه وحده، فلا يعطي جهازان الرقم نفسه ولو عملا شهراً بلا اتصال.
 * لاتيني لا عربي: الحرف العربي داخل رقم لاتيني ينقلب اتجاهه في الطباعة والعرض.
 * والأرقام القائمة لا تُمسّ.
 */
import type { DB } from '../db/adapter';

const LETTER_KEY = 'device_letter';
/** «'» = بلا حرف بعد التسجيل · والغياب = لم يُسجَّل الجهاز بعد (جهاز وحيد بلا مزامنة: بلا حرف) */
const NONE = "'";

export function deviceLetter(db: DB): string {
  const v = db.get<{ value: string }>(`SELECT value FROM meta WHERE key = ?`, [LETTER_KEY])?.value;
  return !v || v === NONE ? '' : v;
}

export function deviceLetterAssigned(db: DB): boolean {
  return !!db.get(`SELECT 1 FROM meta WHERE key = ?`, [LETTER_KEY]);
}

export function setDeviceLetter(db: DB, letter: string): void {
  if (letter && !/^[A-Z]{1,2}$/.test(letter)) throw new Error('حرف جهاز غير صالح');
  db.run(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`, [LETTER_KEY, letter || NONE]);
}

/** الحرف التالي لجهاز جديد · الأول بلا حرف، ثم B وC … Z ثم AA … */
export function nextDeviceLetter(taken: string[]): string {
  const used = new Set(taken);
  if (!used.has('')) return '';
  const all: string[] = [];
  for (let c = 66; c <= 90; c++) all.push(String.fromCharCode(c));
  for (let a = 65; a <= 90; a++) for (let b = 65; b <= 90; b++) all.push(String.fromCharCode(a) + String.fromCharCode(b));
  const free = all.find((l) => !used.has(l));
  if (!free) throw new Error('نفدت حروف الأجهزة');
  return free;
}

/**
 * شرط SQL لأرقام هذا الجهاز وحده · `glob` نمط الرقم بلا لاحقة (مثل 'JE-[0-9]*').
 * بلا حرف: ما لا لاحقة له · وبحرف: ما ينتهي بـ «-حرف».
 */
export function ownNumbersSql(column: string, glob: string, letter: string): { sql: string; params: string[] } {
  if (!letter) return { sql: `${column} GLOB ? AND NOT (${column} GLOB '*-[A-Z]' OR ${column} GLOB '*-[A-Z][A-Z]')`, params: [glob] };
  return { sql: `${column} GLOB ?`, params: [glob + '-' + letter] };
}

/** الرقم بحرف الجهاز إن كان له حرف */
export function withLetter(no: string, letter: string): string {
  return letter ? no + '-' + letter : no;
}
