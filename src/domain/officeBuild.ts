/**
 * بناء ملفات أوفيس حقيقية دون أي مكتبة خارجية إضافية:
 * إكسل (.xlsx) ووورد (.docx) · أرشيف ZIP عبر fflate و«أوبن إكس إم إل» مكتوب يدوياً،
 * كلاهما من اليمين لليسار وبأرقام رقمية حقيقية في إكسل لا نصوص.
 * ملف الإكسل مكتب لا جدول أرقام مجرد: ترويسة المنشأة، ورؤوس أعمدة ملوّنة مجمَّدة،
 * وتنسيق #,##0.00 والسالب أحمر بين قوسين، وصيغ =SUM حيّة، وعروض أعمدة محسوبة،
 * ومرشح تلقائي، وصف إجمالي بخلفية وحد علوي، وورقة «المعايير».
 */
import { zipSync, strToU8 } from 'fflate';

const xesc = (s: unknown): string =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/**
 * خلية تقرير: نص أو عدد · العدد يدخل إكسل رقماً بتنسيق عشريين.
 * f صيغة إكسل حيّة اختيارية بمراجع رمزية تُحل عند البناء والقيمة المحسوبة تبقى كاشاً:
 * {S0} مدى عمود المبالغ الأخير في القسم 0 · {S0C3} مدى العمود 3 فيه ·
 * {S0R2} خلية صفه الثاني · {T1} خلية قيمة ثاني الإجماليات في الكتلة.
 */
export type Cell = string | number | { money: number; f?: string };

export interface ReportSection {
  title: string;
  header: string[];
  rows: Cell[][];
  /** صف «الإجمالي» بصيغ =SUM حيّة على أعمدة المبالغ · أعدّل خلية فتتحدّث المجاميع */
  sum?: boolean;
}

/** كتلة جهة واحدة داخل التقرير (وحدة/عقار/مورد) */
export interface ReportBlock {
  heading: string;
  meta: Array<[string, string]>;
  sections: ReportSection[];
  totals: Array<[string, Cell, boolean?]>;
}

/* ═══════════ إكسل ═══════════ */

/**
 * ترويسة ملف الإكسل ومعاييره · الأسطر الخمسة أعلى كل ورقة (المنشأة ورقمها
 * الضريبي واسم التقرير والفترة وتاريخ الإصدار) وورقة «المعايير» في آخر المصنّف.
 */
export interface XlsxDoc {
  companyName?: string;
  companyVatno?: string;
  /** اسم التقرير كما يظهر في الترويسة */
  report: string;
  /** وصف الفترة المشمولة */
  period: string;
  /** تاريخ الإصدار ووقته · يُحقن من خارج المنطق النقي فيبقى البناء قابلاً للاختبار */
  issuedAt?: string;
  /** المرشحات والمعايير المطبقة · تُفرد في ورقة «المعايير» */
  criteria?: Array<[string, string]>;
}

export const CRITERIA_SHEET = 'المعايير';

/** فهارس cellXfs في styles.xml · الترتيب هنا هو ترتيبها هناك حرفياً */
const ST = {
  text: 0,
  bold: 1,
  money: 2,
  moneyBold: 3,
  docName: 4,
  docLine: 5,
  colHead: 6,
  totalText: 7,
  totalMoney: 8,
  secTitle: 9,
} as const;

/** نمط الصف: للنص وللمبلغ · المبلغ يحمل التنسيق الرقمي والسالب أحمر بين قوسين */
interface RowStyle { text: number; money: number }
const S_BODY: RowStyle = { text: ST.text, money: ST.money };
const S_BOLD: RowStyle = { text: ST.bold, money: ST.moneyBold };
const S_HEAD: RowStyle = { text: ST.colHead, money: ST.colHead };
const S_TOTAL: RowStyle = { text: ST.totalText, money: ST.totalMoney };
const S_DOCNAME: RowStyle = { text: ST.docName, money: ST.docName };
const S_DOCLINE: RowStyle = { text: ST.docLine, money: ST.docLine };
const S_SECTITLE: RowStyle = { text: ST.secTitle, money: ST.secTitle };

const colName = (i: number): string => {
  let n = i, out = '';
  do { out = String.fromCharCode(65 + (n % 26)) + out; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return out;
};

/** طول النص المعروض · مقياس عرض العمود (المبلغ يزيد بفواصل الآلاف) */
const dispLen = (c: Cell): number =>
  typeof c === 'object' ? (c.money / 100).toFixed(2).length + 2 : String(c ?? '').length;

const cellXml = (c: Cell, col: number, row: number, st: RowStyle, f?: string | null): string => {
  const ref = colName(col) + row;
  if (typeof c === 'object')
    return `<c r="${ref}" s="${st.money}">${f ? `<f>${xesc(f)}</f>` : ''}<v>${(c.money / 100).toFixed(2)}</v></c>`;
  if (typeof c === 'number') return `<c r="${ref}" s="${st.text}"><v>${c}</v></c>`;
  return `<c r="${ref}" s="${st.text}" t="inlineStr"><is><t xml:space="preserve">${xesc(c)}</t></is></c>`;
};

function sheetXml(blocks: ReportBlock[], doc?: XlsxDoc): string {
  let r = 0;
  const rows: string[] = [];
  let maxCols = 2;
  /** أطول محتوى في كل عمود · منه تُحسب عروض cols */
  const widths: number[] = [];
  /** صف رأس الجدول الأول ذي البيانات · عنده تُجمَّد الألواح ويبدأ المرشح التلقائي */
  let freezeAt = 0;
  let firstHead = 0;
  let filterRef = '';
  // سياق الصيغ الحيّة داخل الكتلة الحالية: مدايات الأقسام وخلايا الإجماليات المكتوبة ·
  // المراجع الرمزية تشير للخلف فقط فتُحل لحظة كتابة الخلية
  let secs: Array<{ first: number; last: number; cols: Set<number> }> = [];
  let totalRefs: string[] = [];
  const resolve = (tpl: string): string | null => {
    let ok = true;
    const out = tpl.replace(/\{S(\d+)C(\d+)\}|\{S(\d+)R(\d+)\}|\{S(\d+)\}|\{T(\d+)\}/g,
      (m, sc, cc, sr, rr, ss, tt) => {
        if (tt !== undefined) { const ref = totalRefs[Number(tt)]; if (!ref) ok = false; return ref ?? m; }
        const s = secs[Number(sc ?? sr ?? ss)];
        if (!s || s.last < s.first) { ok = false; return m; }
        const col = cc !== undefined ? Number(cc) : Math.max(...s.cols);
        if (!s.cols.has(col)) { ok = false; return m; }
        if (rr !== undefined) {
          const row = s.first + Number(rr) - 1;
          if (row > s.last) { ok = false; return m; }
          return colName(col) + row;
        }
        return colName(col) + s.first + ':' + colName(col) + s.last;
      });
    return ok ? out : null;
  };
  const push = (cells: Cell[], st: RowStyle, measure = true) => {
    r += 1;
    maxCols = Math.max(maxCols, cells.length);
    if (measure) cells.forEach((c, i) => { widths[i] = Math.max(widths[i] ?? 0, dispLen(c)); });
    rows.push(`<row r="${r}">${cells.map((c, i) =>
      cellXml(c, i, r, st, typeof c === 'object' && c.f ? resolve(c.f) : null)).join('')}</row>`);
    return r;
  };
  const blank = () => { r += 1; rows.push(`<row r="${r}"/>`); };
  if (doc) {
    // الترويسة: أسطر أعلى الجدول بخط أعرض · لا تدخل حساب عرض الأعمدة كي لا تمدّها
    push([doc.companyName || 'لا يوجد'], S_DOCNAME, false);
    push(['الرقم الضريبي: ' + (doc.companyVatno || 'لا يوجد')], S_DOCLINE, false);
    push([doc.report], S_DOCLINE, false);
    push(['الفترة: ' + doc.period], S_DOCLINE, false);
    if (doc.issuedAt) push(['تاريخ الإصدار: ' + doc.issuedAt], S_DOCLINE, false);
    blank();
  }
  for (const b of blocks) {
    secs = [];
    totalRefs = [];
    push([b.heading], S_SECTITLE, false);
    for (const [k, v] of b.meta) push([k, v], S_BODY);
    blank();
    for (const sec of b.sections) {
      push([sec.title], S_SECTITLE, false);
      const headRow = push(sec.header, S_HEAD);
      if (!firstHead) firstHead = headRow;
      const ctx = { first: r + 1, last: r, cols: new Set<number>() };
      /** أعمدة قابلة للجمع: المبالغ والأعداد المجردة */
      const nums = new Set<number>();
      secs.push(ctx);
      for (const row of sec.rows) {
        row.forEach((c, i) => {
          if (typeof c === 'object') { ctx.cols.add(i); nums.add(i); }
          else if (typeof c === 'number') nums.add(i);
        });
        push(row, S_BODY);
        ctx.last = r;
      }
      if (sec.rows.length) {
        if (!freezeAt) freezeAt = headRow;
        // مرشح تلقائي على رأس أول جدول فيه بيانات · بلا صف الإجمالي كي لا يُفلتَر
        if (!filterRef) filterRef = `A${headRow}:${colName(Math.max(sec.header.length, 1) - 1)}${ctx.last}`;
      }
      // صف الإجمالي افتراضياً لكل جدول متعدد الصفوف فيه عمود قابل للجمع · sum: false يمنعه
      const wantSum = sec.sum ?? (nums.size > 0 && sec.rows.length > 1);
      if (wantSum && sec.rows.length && nums.size) {
        // صيغ حيّة لا قيم ثابتة: تعديل خلية يحدّث المجموع
        r += 1;
        const cells = sec.header.map((_h, i) => {
          const ref = colName(i) + r;
          if (i === 0) return `<c r="${ref}" s="${ST.totalText}" t="inlineStr"><is><t>الإجمالي</t></is></c>`;
          if (!nums.has(i)) return `<c r="${ref}" s="${ST.totalText}"/>`;
          return `<c r="${ref}" s="${ctx.cols.has(i) ? ST.totalMoney : ST.totalText}">` +
            `<f>SUM(${colName(i)}${ctx.first}:${colName(i)}${ctx.last})</f></c>`;
        }).join('');
        rows.push(`<row r="${r}">${cells}</row>`);
      }
      blank();
    }
    if (b.totals.length) {
      push(['الإجماليات'], S_SECTITLE, false);
      for (const [k, v, big] of b.totals) {
        push([k, v], big ? S_TOTAL : S_BOLD);
        totalRefs.push(colName(1) + r);
      }
      blank();
    }
  }
  const cols = Array.from({ length: maxCols }, (_, i) => {
    const w = Math.min(54, Math.max(11, Math.round(((widths[i] ?? 0) * 1.15 + 4) * 10) / 10));
    return `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`;
  }).join('');
  const fz = freezeAt || firstHead || (doc ? 5 : 1);
  // ترتيب عناصر worksheet ملزم: dimension ثم sheetViews ثم sheetFormatPr ثم cols ثم sheetData ثم autoFilter
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<dimension ref="A1:${colName(maxCols - 1)}${Math.max(r, 1)}"/>
<sheetViews><sheetView rightToLeft="1" workbookViewId="0"><pane ySplit="${fz}" topLeftCell="A${fz + 1}" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A${fz + 1}" sqref="A${fz + 1}"/></sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="15"/>
<cols>${cols}</cols>
<sheetData>${rows.join('')}</sheetData>${filterRef ? `<autoFilter ref="${filterRef}"/>` : ''}
</worksheet>`;
}

/** ورقة «المعايير»: الفترة والمرشحات المطبقة وما يعرفه المصدِّر من معايير أخرى */
const criteriaBlock = (doc: XlsxDoc): ReportBlock => ({
  heading: 'معايير التقرير',
  meta: [],
  sections: [{
    title: 'المعايير المطبقة',
    sum: false,
    header: ['المعيار', 'القيمة'],
    rows: ([
      ['اسم التقرير', doc.report],
      ['المنشأة', doc.companyName || 'لا يوجد'],
      ['الرقم الضريبي', doc.companyVatno || 'لا يوجد'],
      ['الفترة', doc.period],
      ...(doc.issuedAt ? [['تاريخ الإصدار', doc.issuedAt]] : []),
      ...(doc.criteria ?? []),
    ] as Array<[string, string]>).map(([k, v]) => [k, v] as Cell[]),
  }],
  totals: [],
});

/** اسم ورقة صالح لإكسل: بلا محارف ممنوعة، بحد ٣١ محرفاً، وغير مكرر في المصنّف */
function sheetNames(names: string[]): string[] {
  const used = new Set<string>();
  return names.map((raw, i) => {
    let name = raw.replace(/[\\/?*[\]:]/g, ' ').replace(/^'+|'+$/g, '').trim().slice(0, 31) || `ورقة ${i + 1}`;
    if (used.has(name)) {
      const base = name.slice(0, 28).trim();
      let n = 2;
      while (used.has(`${base} ${n}`)) n += 1;
      name = `${base} ${n}`;
    }
    used.add(name);
    return name;
  });
}

export function buildXlsx(sheets: Array<{ name: string; blocks: ReportBlock[] }>, doc?: XlsxDoc): Uint8Array {
  const all = doc ? [...sheets, { name: CRITERIA_SHEET, blocks: [criteriaBlock(doc)] }] : sheets;
  const names = sheetNames(all.map((s) => s.name));
  const sheetEntries = all.map((sh, i) => ({
    id: i + 1,
    name: names[i],
    xml: sheetXml(sh.blocks, doc),
  }));
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
${sheetEntries.map((s) => `<Override PartName="/xl/worksheets/sheet${s.id}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`;
  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;
  // fullCalcOnLoad: إكسل يحسب صيغ =SUM عند الفتح فلا حاجة لقيم مخبَّأة ولا لسلسلة حساب
  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${sheetEntries.map((s) => `<sheet name="${xesc(s.name)}" sheetId="${s.id}" r:id="rIdS${s.id}"/>`).join('')}</sheets>
<calcPr calcId="191029" fullCalcOnLoad="1"/>
</workbook>`;
  const wbRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${sheetEntries.map((s) => `<Relationship Id="rIdS${s.id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${s.id}.xml"/>`).join('')}
<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;
  // ترتيب عناصر styleSheet ملزم: numFmts ثم fonts ثم fills ثم borders ثم cellStyleXfs ثم cellXfs ثم cellStyles
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0.00;[Red](#,##0.00)"/></numFmts>
<fonts count="5">
<font><sz val="11"/><color rgb="FF1F2430"/><name val="Arial"/></font>
<font><b/><sz val="11"/><color rgb="FF1F2430"/><name val="Arial"/></font>
<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Arial"/></font>
<font><b/><sz val="14"/><color rgb="FF0F5132"/><name val="Arial"/></font>
<font><b/><sz val="12"/><color rgb="FF1F2430"/><name val="Arial"/></font>
</fonts>
<fills count="4">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FF0F5132"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFF2EFE7"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="2">
<border><left/><right/><top/><bottom/><diagonal/></border>
<border><left/><right/><top style="medium"><color rgb="FF0F5132"/></top><bottom/><diagonal/></border>
</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="10">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="164" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>
<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="4" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="2" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="1" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>
<xf numFmtId="164" fontId="1" fillId="3" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1"/>
<xf numFmtId="0" fontId="4" fillId="0" borderId="0" xfId="0" applyFont="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;
  const parts: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(contentTypes),
    '_rels/.rels': strToU8(rootRels),
    'xl/workbook.xml': strToU8(workbook),
    'xl/_rels/workbook.xml.rels': strToU8(wbRels),
    'xl/styles.xml': strToU8(styles),
  };
  for (const s of sheetEntries) parts[`xl/worksheets/sheet${s.id}.xml`] = strToU8(s.xml);
  return zipSync(parts);
}

/* ═══════════ وورد ═══════════ */

const runProps = (bold: boolean, size: number, color?: string) =>
  `<w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/>${bold ? '<w:b/><w:bCs/>' : ''}<w:sz w:val="${size}"/><w:szCs w:val="${size}"/>${color ? `<w:color w:val="${color}"/>` : ''}<w:rtl/></w:rPr>`;

const para = (text: string, opts?: { bold?: boolean; size?: number; color?: string; spaceAfter?: number }): string =>
  `<w:p><w:pPr><w:bidi/><w:spacing w:after="${opts?.spaceAfter ?? 80}"/><w:rPr>${opts?.bold ? '<w:b/>' : ''}</w:rPr></w:pPr>` +
  `<w:r>${runProps(opts?.bold ?? false, opts?.size ?? 22, opts?.color)}<w:t xml:space="preserve">${xesc(text)}</w:t></w:r></w:p>`;

const cellText = (c: Cell): string => (typeof c === 'object' ? (c.money / 100).toFixed(2) : String(c ?? ''));

const wordTable = (header: string[], rows: Cell[][]): string => {
  const borders = '<w:tblBorders><w:top w:val="single" w:sz="4" w:color="D8D4C8"/><w:bottom w:val="single" w:sz="4" w:color="D8D4C8"/><w:start w:val="single" w:sz="4" w:color="D8D4C8"/><w:end w:val="single" w:sz="4" w:color="D8D4C8"/><w:insideH w:val="single" w:sz="4" w:color="D8D4C8"/><w:insideV w:val="single" w:sz="4" w:color="D8D4C8"/></w:tblBorders>';
  const tc = (c: Cell, bold: boolean, shade?: string) =>
    `<w:tc><w:tcPr>${shade ? `<w:shd w:val="clear" w:fill="${shade}"/>` : ''}<w:vAlign w:val="center"/></w:tcPr>` +
    `<w:p><w:pPr><w:bidi/><w:spacing w:after="20" w:before="20"/></w:pPr><w:r>${runProps(bold, 19)}<w:t xml:space="preserve">${xesc(cellText(c))}</w:t></w:r></w:p></w:tc>`;
  return `<w:tbl><w:tblPr><w:bidiVisual/><w:tblW w:w="5000" w:type="pct"/>${borders}</w:tblPr>` +
    `<w:tr>${header.map((h) => tc(h, true, 'F2EFE7')).join('')}</w:tr>` +
    rows.map((r) => `<w:tr>${r.map((c) => tc(c, false)).join('')}</w:tr>`).join('') +
    '</w:tbl><w:p><w:pPr><w:bidi/><w:spacing w:after="60"/></w:pPr></w:p>';
};

export function buildDocx(
  title: string, sub: string, blocks: ReportBlock[], footer: string,
  /** مساحات توقيع تُذيَّل بها الوثيقة (المحاسب · المدير …) */
  signatures?: string[]
): Uint8Array {
  let body = para(title, { bold: true, size: 32, spaceAfter: 40 }) + para(sub, { size: 20, color: '77808F', spaceAfter: 160 });
  blocks.forEach((b, bi) => {
    if (blocks.length > 1) body += para(b.heading, { bold: true, size: 26, color: '0F5132', spaceAfter: 100 });
    for (const [k, v] of b.meta) body += para(k + ': ' + v, { size: 20, spaceAfter: 40 });
    for (const sec of b.sections) {
      body += para(sec.title, { bold: true, size: 22, spaceAfter: 60 });
      body += wordTable(sec.header, sec.rows);
    }
    if (b.totals.length) {
      body += para('الإجماليات', { bold: true, size: 22, spaceAfter: 60 });
      body += wordTable(['البند', 'القيمة'], b.totals.map(([k, v]) => [k, v]));
    }
    if (bi < blocks.length - 1) body += '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
  });
  if (signatures?.length) {
    body += para('', { spaceAfter: 240 });
    body += wordTable(signatures, [signatures.map(() => '                    ')]);
  }
  body += para(footer, { size: 17, color: '9AA1AD', spaceAfter: 0 });
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>${body}<w:sectPr><w:footerReference xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" w:type="default" r:id="rIdF1"/><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1000" w:right="1000" w:bottom="1100" w:left="1000" w:footer="500"/><w:bidi/></w:sectPr></w:body>
</w:document>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>
</Types>`;
  const fld = (instr: string) =>
    `<w:r>${runProps(false, 17, '9AA1AD')}<w:fldChar w:fldCharType="begin"/></w:r>` +
    `<w:r>${runProps(false, 17, '9AA1AD')}<w:instrText xml:space="preserve"> ${instr} </w:instrText></w:r>` +
    `<w:r>${runProps(false, 17, '9AA1AD')}<w:fldChar w:fldCharType="end"/></w:r>`;
  const footer1 = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:p><w:pPr><w:bidi/><w:jc w:val="center"/><w:spacing w:after="0"/></w:pPr>
<w:r>${runProps(false, 17, '9AA1AD')}<w:t xml:space="preserve">صفحة </w:t></w:r>${fld('PAGE')}
<w:r>${runProps(false, 17, '9AA1AD')}<w:t xml:space="preserve"> من </w:t></w:r>${fld('NUMPAGES')}
</w:p></w:ftr>`;
  const docRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rIdF1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>
</Relationships>`;
  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;
  return zipSync({
    '[Content_Types].xml': strToU8(contentTypes),
    '_rels/.rels': strToU8(rootRels),
    'word/document.xml': strToU8(doc),
    'word/_rels/document.xml.rels': strToU8(docRels),
    'word/footer1.xml': strToU8(footer1),
  });
}

