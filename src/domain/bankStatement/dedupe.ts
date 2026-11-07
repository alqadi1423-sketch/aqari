/**
 * بصمة سطر الكشف (التوجيه الرابع ٦ · ٢ · «منع التكرار»): البنك والتاريخ والمبلغ الموقَّع، ومعها رقم تكرارها في
 * الكشف نفسه (أسلوب ofxstatement) · فإعادة قراءة الكشف تعطي البصمات نفسها، والكشفان المتداخلان يتشاركانها في منطقة التداخل، وسطران
 * متطابقان حقاً (رسمان في اليوم نفسه) يبقيان اثنين · ومرجع البنك وحده لا يكفي (الحوالة ورسمها قد يشتركان فيه).
 */
import type { StatementLine } from './read';

/** FNV-1a بـ64 بتاً (قطعتان من ٣٢) ستّ عشري · ثابتٌ بين الأجهزة */
export function fnv64(s: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x050c5d1f;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c ^ (h1 >>> 7), 0x01000193) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

export function statementLineKeys(bankId: string, lines: Array<Pick<StatementLine, 'date' | 'amount' | 'balance' | 'descr'>>): string[] {
  const seen = new Map<string, number>();
  return lines.map((l) => {
    // بلا الرصيد والبيان: الحركة نفسها من صيغةٍ أخرى (MT940 بلا رصيد) أو بتصديرٍ ببيانٍ أطول بصمتها نفسها (المدقق الخارجي U١٨)
    const base = [bankId, l.date, l.amount].join('|');
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    // والرصيد المطبوع لاحقةٌ تفرّق حركتين باليوم والمبلغ نفسيهما في كشفين (صفحتا صورة · المدقق الخارجي Z١-٢)، ولا تمنع مطابقة صيغةٍ بلا
    // رصيد (sameLineKey)
    return fnv64(base + '#' + n) + (l.balance == null ? '' : '@' + l.balance);
  });
}

/** بصمة السطر بلا لاحقة الرصيد */
export const lineKeyBase = (key: string): string => key.split('@')[0];
/** السطر نفسه: البصمة نفسها، أو القاعدة نفسها وأحدهما بلا رصيد */
export function sameLineKey(a: string, b: string): boolean {
  return a === b || (lineKeyBase(a) === lineKeyBase(b) && (!a.includes('@') || !b.includes('@')));
}
/** شرط SQL للبصمة نفسها بمعيار sameLineKey · col عمود البصمة، والمعاملان البصمة ثم قاعدتها */
export const SAME_KEY_SQL = (col: string) =>
  `(${col} = ? OR ((CASE WHEN instr(${col}, '@') > 0 THEN substr(${col}, 1, instr(${col}, '@') - 1) ELSE ${col} END) = ? AND (instr(${col}, '@') = 0 OR instr(?, '@') = 0)))`;

/** بصمة بايتات الملف (منع قراءة الملف نفسه مرتين) */
export function bytesHash(bytes: Uint8Array): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x050c5d1f;
  for (let i = 0; i < bytes.length; i++) {
    h1 = Math.imul(h1 ^ bytes[i], 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ bytes[i] ^ (h1 >>> 7), 0x01000193) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0') + '-' + bytes.length;
}
