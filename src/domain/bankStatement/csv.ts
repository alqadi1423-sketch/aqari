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
