/**
 * CSV كشف البنك: الفاصلة أو الفاصلة المنقوطة أو الجدولة أو العمود «|» بأكثرها ثباتاً في أول الأسطر، والقيم المقتبسة بعلامتين
 * مزدوجتين (والمزدوجة داخلها مكرّرة)، وBOM في أوله يُهمل.
 */
const DELIMS = [',', ';', '\t', '|'];

function splitRows(text: string, delim: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += c;
      continue;
    }
    if (c === '"' && cell === '') { quoted = true; continue; }
    if (c === delim) { row.push(cell); cell = ''; continue; }
    if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      rows.push(row); row = [];
      continue;
    }
    cell += c;
  }
  // واقتباسٌ لا يُغلق يبتلع بقية الملف: الملف لا يُقرأ (المدقق الخارجي U٥)
  if (quoted) throw new Error('csv-quote');
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim() !== ''));
}

export function parseCsv(input: string): string[][] {
  const text = input.replace(/^﻿/, '');
  const head = text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 20);
  // الفاصل: أكثرها ظهوراً بعددٍ ثابت في الأسطر الأولى
  let best = ',';
  let bestScore = -1;
  for (const d of DELIMS) {
    const counts = head.map((l) => l.split(d).length - 1).filter((n) => n > 0);
    if (!counts.length) continue;
    const mode = counts.sort((a, b) => counts.filter((x) => x === b).length - counts.filter((x) => x === a).length)[0];
    const score = counts.filter((n) => n === mode).length * 100 + mode;
    if (score > bestScore) { bestScore = score; best = d; }
  }
  return splitRows(text, best);
}

/** نص الملف: UTF-16 بعلامته، وإلا UTF-8 */
export function decodeText(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    let s = '';
    for (let i = 2; i + 1 < bytes.length; i += 2) s += String.fromCharCode(bytes[i] | (bytes[i + 1] << 8));
    return s;
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    let s = '';
    for (let i = 2; i + 1 < bytes.length; i += 2) s += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
    return s;
  }
  if (!validUtf8(bytes)) return decodeCp1256(bytes);
  // UTF-8 بلا مكتبة (Hermes لا يضمن TextDecoder)
  let out = '';
  for (let i = 0; i < bytes.length;) {
    const b = bytes[i];
    let cp = 0xfffd;
    let n = 1;
    if (b < 0x80) cp = b;
    else if (b >= 0xc2 && b < 0xe0 && i + 1 < bytes.length) { cp = ((b & 0x1f) << 6) | (bytes[i + 1] & 0x3f); n = 2; }
    else if (b >= 0xe0 && b < 0xf0 && i + 2 < bytes.length) { cp = ((b & 0x0f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f); n = 3; }
    else if (b >= 0xf0 && b < 0xf5 && i + 3 < bytes.length) {
      cp = ((b & 0x07) << 18) | ((bytes[i + 1] & 0x3f) << 12) | ((bytes[i + 2] & 0x3f) << 6) | (bytes[i + 3] & 0x3f); n = 4;
    }
    out += String.fromCodePoint(cp > 0x10ffff ? 0xfffd : cp);
    i += n;
  }
  return out;
}

/** بايتاتٌ ليست UTF-8 صحيحاً (حرفٌ عالٍ بلا تتمته) */
function validUtf8(b: Uint8Array): boolean {
  for (let i = 0; i < b.length;) {
    const c = b[i];
    const n = c < 0x80 ? 1 : c >= 0xc2 && c < 0xe0 ? 2 : c >= 0xe0 && c < 0xf0 ? 3 : c >= 0xf0 && c < 0xf5 ? 4 : 0;
    if (!n || i + n > b.length) return false;
    for (let k = 1; k < n; k++) if ((b[i + k] & 0xc0) !== 0x80) return false;
    i += n;
  }
  return true;
}

// Windows-1256 (حفظ Excel العربي «CSV» · المدقق الخارجي U١١): النصف الأعلى 0x80–0xFF
const CP1256_HIGH = '\u20AC\u067E\u201A\u0192\u201E\u2026\u2020\u2021\u02C6\u2030\u0679\u2039\u0152\u0686\u0698\u0688\u06AF\u2018\u2019\u201C\u201D\u2022\u2013\u2014\u06A9\u2122\u0691\u203A\u0153\u200C\u200D\u06BA\u00A0\u060C\u00A2\u00A3\u00A4\u00A5\u00A6\u00A7\u00A8\u00A9\u06BE\u00AB\u00AC\u00AD\u00AE\u00AF\u00B0\u00B1\u00B2\u00B3\u00B4\u00B5\u00B6\u00B7\u00B8\u00B9\u061B\u00BB\u00BC\u00BD\u00BE\u061F\u06C1\u0621\u0622\u0623\u0624\u0625\u0626\u0627\u0628\u0629\u062A\u062B\u062C\u062D\u062E\u062F\u0630\u0631\u0632\u0633\u0634\u0635\u0636\u00D7\u0637\u0638\u0639\u063A\u0640\u0641\u0642\u0643\u00E0\u0644\u00E2\u0645\u0646\u0647\u0648\u00E7\u00E8\u00E9\u00EA\u00EB\u0649\u064A\u00EE\u00EF\u064B\u064C\u064D\u064E\u00F4\u064F\u0650\u00F7\u0651\u00F9\u0652\u00FB\u00FC\u200E\u200F\u06D2'; // i18n-exempt: جدول ترميز لا نص
function decodeCp1256(b: Uint8Array): string {
  let s = '';
  for (const c of b) s += c < 0x80 ? String.fromCharCode(c) : CP1256_HIGH[c - 0x80];
  return s;
}
