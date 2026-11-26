/**
 * ورقة Excel الأولى جدولاً من النصوص (كشف البنك بصيغة xlsx · الإنماء رسمياً والعربي للمنشآت حسب الدراسة) · بفكّ الأرشيف بحدٍّ للحجم،
 * والنصوص المشتركة والمضمّنة والأرقام كما هي (والتاريخ تسلسل إكسل يقرؤه parseStatementDate) · null لما ليس مصنف إكسل.
 */
import { unzipSync, strFromU8 } from 'fflate';

const MAX_PART = 20 * 1024 * 1024;

const unxml = (s: string): string => s
  .replace(/&#x([0-9a-f]+);/gi, (_m, h: string) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)))
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/** نص عنصرٍ فيه <t> واحد أو أكثر (النص المنسَّق <r><t>) */
const texts = (xml: string): string => [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => unxml(m[1])).join('');

const colIndex = (ref: string): number => {
  const letters = /^([A-Z]+)/.exec(ref)?.[1] ?? 'A';
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
};

export function xlsxGrid(bytes: Uint8Array): string[][] | null {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, { filter: (f) => f.originalSize <= MAX_PART && /^xl\/(workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|worksheets\/[^/]+\.xml)$/.test(f.name) });
  } catch { return null; }
  if (!files['xl/workbook.xml']) return null;
  // الورقة الأولى بترتيب المصنف وعلاقتها
  const wb = strFromU8(files['xl/workbook.xml']);
  const rid = /<sheet\b[^>]*\br:id="([^"]+)"/.exec(wb)?.[1];
  const rels = files['xl/_rels/workbook.xml.rels'] ? strFromU8(files['xl/_rels/workbook.xml.rels']) : '';
  const target = rid ? new RegExp(`<Relationship\\b[^>]*Id="${rid}"[^>]*Target="([^"]+)"`).exec(rels)?.[1]
    ?? new RegExp(`<Relationship\\b[^>]*Target="([^"]+)"[^>]*Id="${rid}"`).exec(rels)?.[1] : undefined;
  const path = target ? 'xl/' + target.replace(/^\/?xl\//, '').replace(/^\//, '') : 'xl/worksheets/sheet1.xml';
  const sheet = files[path] ?? files['xl/worksheets/sheet1.xml'];
  if (!sheet) return null;
  const shared = files['xl/sharedStrings.xml']
    ? [...strFromU8(files['xl/sharedStrings.xml']).matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => texts(m[1])) : [];
  const grid: string[][] = [];
  for (const row of strFromU8(sheet).matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells: string[] = [];
    for (const c of row[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = c[1];
      const body = c[2] ?? '';
      const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1];
      const type = /\bt="([^"]+)"/.exec(attrs)?.[1] ?? 'n';
      const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
      let text = '';
      if (type === 's') text = shared[Number(v)] ?? '';
      else if (type === 'inlineStr') text = texts(body);
      else if (v != null) text = unxml(v);
      const i = ref ? colIndex(ref) : cells.length;
      while (cells.length < i) cells.push('');
      cells[i] = text;
    }
    grid.push(cells);
  }
  return grid;
}
