/**
 * MT940 (كشف SWIFT للمنشآت · الأهلي والعربي والرياض والفرنسي والبلاد حسب الدراسة): :60F:/:60M: الافتتاحي، و:61: الحركة، و:86:
 * تفاصيلها، و:62F:/:62M: الختامي · المبلغ بفاصلةٍ عشرية، والإشارة C أو D (وRC وRD عكساهما).
 */
import { cellText } from './normalize';

export interface Mt940Line { date: string; valueDate: string | null; amount: number; descr: string; ref: string | null }
export interface Mt940 { account: string | null; opening: number | null; closing: number | null; lines: Mt940Line[] }

const yymmdd = (s: string): string | null => {
  const m = /^(\d{2})(\d{2})(\d{2})$/.exec(s);
  if (!m) return null;
  const y = 2000 + Number(m[1]);
  const [mo, d] = [Number(m[2]), Number(m[3])];
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1];
  return mo >= 1 && mo <= 12 && d >= 1 && d <= (days ?? 0) ? `${y}-${m[2]}-${m[3]}` : null;
};

const halalas = (s: string): number | null => {
  const m = /^(\d+)(?:,(\d{0,2}))?$/.exec(s);
  return m ? Number(m[1]) * 100 + Number(((m[2] ?? '') + '00').slice(0, 2)) : null;
};

/** رصيد :60: أو :62: «C261001SAR10000,00» */
const balance = (v: string): number | null => {
  const m = /^([CD])(\d{6})[A-Z]{3}([\d,]+)$/.exec(v.trim());
  if (!m) return null;
  const a = halalas(m[3]);
  return a == null ? null : (m[1] === 'D' ? -a : a);
};

export function parseMt940(text: string): Mt940 {
  const out: Mt940 = { account: null, opening: null, closing: null, lines: [] };
  // كل وسمٍ يبدأ سطراً بـ«:رقم[حرف]:» وما بعده إلى الوسم التالي قيمته
  const tags: Array<[string, string]> = [];
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const m = /^:(\d{2}[A-Z]?):(.*)$/.exec(raw);
    if (m) tags.push([m[1], m[2]]);
    else if (tags.length && raw.trim() && !/^-\}?$/.test(raw.trim())) tags[tags.length - 1][1] += '\n' + raw;
  }
  for (const [tag, value] of tags) {
    if (tag === '25') out.account = value.trim();
    else if (tag === '60F' || tag === '60M') { if (out.opening == null) out.opening = balance(value); }
    else if (tag === '62F' || tag === '62M') out.closing = balance(value);
    else if (tag === '61') {
      // تاريخ القيمة YYMMDD، وتاريخ القيد MMDD اختياري، ثم C أو D أو RC أو RD، ثم حرف الأموال اختياري، ثم المبلغ
      const m = /^(\d{6})(\d{4})?(RC|RD|C|D)([A-Z])?([\d,]+)(.*)$/s.exec(value.trim());
      if (!m) continue;
      const valueDate = yymmdd(m[1]);
      const date = m[2] && valueDate ? yymmdd(valueDate.slice(2, 4) + m[2]) ?? valueDate : valueDate;
      const a = halalas(m[5]);
      if (!date || a == null) continue;
      const debit = m[3] === 'D' || m[3] === 'RC';
      const ref = /\/\/([^\n]+)/.exec(m[6])?.[1]?.trim() ?? null;
      out.lines.push({ date, valueDate, amount: debit ? -a : a, descr: '', ref });
    } else if (tag === '86' && out.lines.length) {
      const l = out.lines[out.lines.length - 1];
      l.descr = cellText((l.descr ? l.descr + ' ' : '') + value.replace(/\n/g, ' '));
    }
  }
  return out;
}
