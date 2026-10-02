/**
 * ملفات أوفيس المبنية يدوياً · الدليل بفكّ الأرشيف لا بالظن:
 * xlsx فيه الأجزاء الأربعة وورقة من اليمين لليسار وأرقام رقمية،
 * وdocx فيه document.xml باتجاه يمين-يسار وجداول معكوسة الأعمدة.
 * ثم كسوة المكتب: ترويسة، ورؤوس ملوّنة مجمَّدة، وتنسيق رقمي والسالب أحمر بين قوسين،
 * وصيغ حيّة، وعروض محسوبة، ومرشح تلقائي، وصف إجمالي، وورقة «المعايير».
 */
import { unzipSync, strFromU8 } from 'fflate';
import { buildXlsx, buildDocx, CRITERIA_SHEET, type ReportBlock, type XlsxDoc } from '@/domain/officeBuild';

const block: ReportBlock = {
  heading: 'وحدة A-1 · برج الاختبار',
  meta: [['النوع', 'شقة'], ['الطابق', '2']],
  sections: [
    { title: 'المقبوضات', header: ['التاريخ', 'المبلغ'],
      rows: [['2026-02-05', { money: 100000 }], ['2026-03-05', { money: 105027 }]] },
  ],
  totals: [['الدخل', { money: 205027 }], ['الصافي', { money: 205027 }, true]],
};

describe('بناء ملفات أوفيس', () => {
  test('xlsx: أرشيف سليم بأجزائه، ورقة يمين-يسار، والمبالغ أرقام لا نصوص', () => {
    const bytes = buildXlsx([{ name: 'وحدة A-1', blocks: [block] }]);
    expect(bytes.length).toBeGreaterThan(500);
    const parts = unzipSync(bytes);
    for (const name of ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/worksheets/sheet1.xml']) {
      expect(Object.keys(parts)).toContain(name);
    }
    const sheet = strFromU8(parts['xl/worksheets/sheet1.xml']);
    expect(sheet).toContain('rightToLeft="1"');
    // المبلغ 1000.00 رقم حقيقي في خلية رقمية، ليس نصاً
    expect(sheet).toContain('<v>1000.00</v>');
    expect(sheet).toContain('<v>1050.27</v>');
    expect(sheet).toContain('المقبوضات');
    const wb = strFromU8(parts['xl/workbook.xml']);
    expect(wb).toContain('وحدة A-1');
  });

  test('xlsx: ورقة لكل جهة عند التعدد', () => {
    const b2: ReportBlock = { ...block, heading: 'وحدة B-2 · برج الاختبار' };
    const parts = unzipSync(buildXlsx([
      { name: 'وحدة A-1', blocks: [block] },
      { name: 'وحدة B-2', blocks: [b2] },
    ]));
    expect(Object.keys(parts)).toContain('xl/worksheets/sheet1.xml');
    expect(Object.keys(parts)).toContain('xl/worksheets/sheet2.xml');
    expect(strFromU8(parts['xl/workbook.xml'])).toContain('وحدة B-2');
  });

  test('docx: أرشيف سليم واتجاه يمين-يسار وجداول معكوسة وفاصل صفحات بين الجهات', () => {
    const b2: ReportBlock = { ...block, heading: 'وحدة B-2 · برج الاختبار' };
    const bytes = buildDocx('تقرير وحدتين', 'حتى 2026-08-19', [block, b2], 'صدر عبر تطبيق عقاري · أحد حلول منصة رِكز');
    const parts = unzipSync(bytes);
    for (const name of ['[Content_Types].xml', '_rels/.rels', 'word/document.xml']) {
      expect(Object.keys(parts)).toContain(name);
    }
    const doc = strFromU8(parts['word/document.xml']);
    expect(doc).toContain('<w:bidi/>');
    expect(doc).toContain('<w:bidiVisual/>');
    expect(doc).toContain('تقرير وحدتين');
    expect(doc).toContain('وحدة B-2 · برج الاختبار');
    expect(doc).toContain('<w:br w:type="page"/>');
    expect(doc).toContain('1,000.00'.replace(',', '')); // المبالغ بعشريين
    expect(doc).toContain('منصة رِكز');
  });

  test('تهريب المحارف: أسماء فيها & و< لا تكسر الأرشيف', () => {
    const tricky: ReportBlock = {
      heading: 'مورد <أ&ب>', meta: [], totals: [],
      sections: [{ title: 'فواتير', header: ['الاسم'], rows: [['شركة "الاختبار" & شركاه']] }],
    };
    // كتلتان كي يُعرض العنوان (الكتلة الواحدة تكتفي بعنوان التقرير)
    const doc = strFromU8(unzipSync(buildDocx('ت', 'م', [tricky, { ...tricky, heading: 'ثانية' }], 'ذيل'))['word/document.xml']);
    expect(doc).toContain('&lt;أ&amp;ب&gt;');
    expect(doc).not.toContain('<أ');
    const sheet = strFromU8(unzipSync(buildXlsx([{ name: 'ت', blocks: [tricky] }]))['xl/worksheets/sheet1.xml']);
    expect(sheet).toContain('&quot;الاختبار&quot; &amp; شركاه');
  });
});

describe('إكسل تفاعلي لا جدولاً ميتاً', () => {
  test('صف الإجمالي صيغة =SUM حيّة، والصف الأول مجمَّد، والسالب أحمر بالتنسيق', () => {
    const b: ReportBlock = {
      heading: 'اختبار الصيغ', meta: [],
      sections: [{
        title: 'حركات', sum: true,
        header: ['البيان', 'المبلغ'],
        rows: [['أ', { money: 100000 }], ['ب', { money: -25000 }], ['ج', { money: 50000 }]],
      }],
      totals: [],
    };
    const parts = unzipSync(buildXlsx([{ name: 'صيغ', blocks: [b] }]));
    const sheet = strFromU8(parts['xl/worksheets/sheet1.xml']);
    expect(sheet).toMatch(/<f>SUM\(B\d+:B\d+\)<\/f>/); // صيغة حيّة: تعديل خلية يحدّث المجموع
    expect(sheet).toContain('state="frozen"'); // تجميد الصف العلوي
    const styles = strFromU8(parts['xl/styles.xml']);
    expect(styles).toContain('[Red]'); // السالب أحمر
  });

  test('المراجع الرمزية في «الإجماليات» تُحل مدايات وخلايا، والمتعذّر منها يسقط للقيمة الثابتة', () => {
    const b: ReportBlock = {
      heading: 'إجماليات حيّة', meta: [],
      sections: [
        { title: 'مقبوضات', header: ['التاريخ', 'الطريقة', 'الصافي'],
          rows: [['1', 'نقداً', { money: 30000 }], ['2', 'تحويل', { money: 20000 }]] },
        { title: 'مصاريف', header: ['التاريخ', 'المبلغ'], rows: [['3', { money: 10000 }]] },
        { title: 'قسم فارغ', header: ['أ', 'المبلغ'], rows: [] },
      ],
      totals: [
        ['إجمالي الدخل', { money: 50000, f: 'SUM({S0C2})' }],
        ['إجمالي المصاريف', { money: 10000, f: 'SUM({S1C1})' }],
        ['من قسم فارغ', { money: 700, f: 'SUM({S2C1})' }],
        ['صافي المدة', { money: 40000, f: '{T0}-{T1}' }, true],
      ],
    };
    const sheet = strFromU8(unzipSync(buildXlsx([{ name: 'حيّة', blocks: [b] }]))['xl/worksheets/sheet1.xml']);
    const totals = (t: string) => rowXml(sheet, t);
    // مدى عمود «الصافي» في القسم الأول من أول صف بياناته إلى آخره
    expect(totals('إجمالي الدخل')).toContain(`<f>SUM(C${rowOf(sheet, 'نقداً')}:C${rowOf(sheet, 'تحويل')})</f>`);
    const one = rowOf(sheet, '<v>100.00</v>'); // قسم بصف واحد
    expect(totals('إجمالي المصاريف')).toContain(`<f>SUM(B${one}:B${one})</f>`);
    // قسم بلا صفوف: لا صيغة معلَّقة على مدى فارغ · تبقى القيمة المحسوبة
    expect(totals('من قسم فارغ')).not.toContain('<f>');
    expect(totals('من قسم فارغ')).toContain('<v>7.00</v>');
    // {T0}-{T1} تشير لخليتي الإجماليين المكتوبين قبلها
    const dakhl = rowOf(sheet, 'إجمالي الدخل');
    expect(totals('صافي المدة')).toContain(`<f>B${dakhl}-B${dakhl + 1}</f>`);
  });
});

/* ═══════════ كسوة المكتب · البنود التسعة ═══════════ */

const DOC: XlsxDoc = {
  companyName: 'مؤسسة الاختبار العقارية',
  companyVatno: '300000000000003',
  report: 'تقرير وحدات',
  period: 'عن الفترة من 01/01/2026 إلى 31/12/2026',
  issuedAt: '19/08/2026 10:30',
  criteria: [['من تاريخ', '01/01/2026'], ['إلى تاريخ', '31/12/2026'], ['مشمول في التقرير', 'وحدة A-1']],
};

/** الصفوف كما كُتبت في XML · للبحث عن رقم صف بمحتواه */
const sheetRows = (sheet: string): string[] =>
  sheet.match(/<row r="\d+"\/>|<row r="\d+">[\s\S]*?<\/row>/g) ?? [];
const rowOf = (sheet: string, text: string): number => {
  const hit = sheetRows(sheet).find((x) => x.includes(text));
  return hit ? Number(/<row r="(\d+)"/.exec(hit)![1]) : -1;
};
const rowXml = (sheet: string, text: string): string =>
  sheetRows(sheet).find((x) => x.includes(text)) ?? '';
/** فهرس النمط المستعمل في خلية تحوي هذا النص */
const styleOfText = (sheet: string, text: string): number => {
  const m = new RegExp(`<c r="[A-Z]+\\d+" s="(\\d+)" t="inlineStr"><is><t[^>]*>${text}</t>`).exec(sheet);
  return m ? Number(m[1]) : -1;
};
const styleOfValue = (sheet: string, v: string): number => {
  const m = new RegExp(`<c r="[A-Z]+\\d+" s="(\\d+)"><v>${v}</v></c>`).exec(sheet);
  return m ? Number(m[1]) : -1;
};
const chunk = (xml: string, tag: string): string =>
  xml.slice(xml.indexOf('<' + tag), xml.indexOf('</' + tag + '>'));
const listOf = (xml: string, tag: string, item: string): string[] =>
  // المغلق ذاتياً أولاً وإلا ابتلع البديل الأول عدة عناصر حتى أقرب وسم إغلاق
  chunk(xml, tag).match(new RegExp(`<${item}[^>]*\\/>|<${item}[ >][\\s\\S]*?<\\/${item}>`, 'g')) ?? [];

const demo: ReportBlock = {
  heading: 'وحدة A-1 · برج الاختبار',
  meta: [['النوع', 'شقة'], ['الطابق', '2']],
  sections: [
    { title: 'المقبوضات', header: ['التاريخ', 'المستأجر بالاسم الرباعي الطويل جداً', 'الصافي'],
      rows: [
        ['2026-02-05', 'أ', { money: 100000 }],
        ['2026-03-05', 'ب', { money: -105027 }],
        ['2026-04-05', 'ج', { money: 250000 }],
      ] },
  ],
  totals: [['الدخل', { money: 244973 }], ['صافي الفترة', { money: 244973 }, true]],
};
const built = () => {
  const parts = unzipSync(buildXlsx([{ name: 'وحدة A-1', blocks: [demo] }], DOC));
  return {
    parts,
    sheet: strFromU8(parts['xl/worksheets/sheet1.xml']),
    criteria: strFromU8(parts['xl/worksheets/sheet2.xml']),
    styles: strFromU8(parts['xl/styles.xml']),
    wb: strFromU8(parts['xl/workbook.xml']),
  };
};

describe('إكسل مكتبي · لا أرقاماً مجردة بلا تنسيق', () => {
  test('١ ترويسة: المنشأة ورقمها الضريبي واسم التقرير والفترة وتاريخ الإصدار بخط أعرض أعلى الجدول', () => {
    const { sheet, styles } = built();
    expect(rowOf(sheet, 'مؤسسة الاختبار العقارية')).toBe(1);
    expect(sheet).toContain('الرقم الضريبي: 300000000000003');
    expect(sheet).toContain('تقرير وحدات');
    expect(sheet).toContain('الفترة: عن الفترة من 01/01/2026 إلى 31/12/2026');
    expect(sheet).toContain('تاريخ الإصدار: 19/08/2026 10:30');
    // الترويسة فوق الجدول لا تحته
    expect(rowOf(sheet, 'مؤسسة الاختبار العقارية')).toBeLessThan(rowOf(sheet, 'المقبوضات'));
    // خط أعرض: نمط اسم المنشأة يشير إلى خط بحجم أكبر من الخط العادي
    const nameFont = /fontId="(\d+)"/.exec(listOf(styles, 'cellXfs', 'xf')[styleOfText(sheet, 'مؤسسة الاختبار العقارية')])![1];
    expect(listOf(styles, 'fonts', 'font')[Number(nameFont)]).toContain('<sz val="14"/>');
  });

  test('٢ رؤوس أعمدة ملوّنة: خلفية داكنة وخط أبيض مع تجميد الألواح عند رأس الجدول', () => {
    const { sheet, styles } = built();
    const head = rowOf(sheet, 'المستأجر بالاسم الرباعي الطويل جداً');
    const xf = listOf(styles, 'cellXfs', 'xf')[styleOfText(sheet, 'التاريخ')];
    const fontId = Number(/fontId="(\d+)"/.exec(xf)![1]);
    const fillId = Number(/fillId="(\d+)"/.exec(xf)![1]);
    expect(listOf(styles, 'fonts', 'font')[fontId]).toContain('<color rgb="FFFFFFFF"/>'); // خط أبيض
    const fill = listOf(styles, 'fills', 'fill')[fillId];
    expect(fill).toContain('patternType="solid"');
    expect(fill).toMatch(/fgColor rgb="FF0F5132"/); // خلفية داكنة
    // freeze panes: الرأس يبقى ظاهراً عند التمرير
    expect(sheet).toContain(`<pane ySplit="${head}" topLeftCell="A${head + 1}" activePane="bottomLeft" state="frozen"/>`);
  });

  test('٣ تنسيق رقمي #,##0.00 لكل مبلغ والسالب أحمر بين قوسين', () => {
    const { sheet, styles } = built();
    expect(styles).toContain('<numFmt numFmtId="164" formatCode="#,##0.00;[Red](#,##0.00)"/>');
    const xfs = listOf(styles, 'cellXfs', 'xf');
    for (const v of ['1000.00', '-1050.27', '2500.00', '2449.73']) {
      const s = styleOfValue(sheet, v);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(xfs[s]).toContain('numFmtId="164"');
    }
  });

  test('٤ صيغ =SUM حيّة لصف المجموع حتى في قسم لم يطلبها، وsum:false يمنعها', () => {
    const { sheet } = built();
    // القسم لم يضع sum فالافتراضي يغطيه: مجموع عمود المبالغ صيغة لا قيمة ثابتة
    const total = rowXml(sheet, 'الإجمالي');
    expect(total).toMatch(/<f>SUM\(C\d+:C\d+\)<\/f>/);
    expect(total).not.toContain('<v>2449.73</v>'); // لا قيمة مثبَّتة في خلية الصيغة
    const off: ReportBlock = {
      heading: 'بلا مجموع', meta: [],
      sections: [{ title: 'بنود مستقلة', sum: false, header: ['البند', 'المبلغ'],
        rows: [['أ', { money: 100 }], ['ب', { money: 200 }]] }],
      totals: [],
    };
    const s2 = strFromU8(unzipSync(buildXlsx([{ name: 'بلا', blocks: [off] }]))['xl/worksheets/sheet1.xml']);
    expect(s2).not.toContain('<f>SUM(');
  });

  test('٥ عرض الأعمدة محسوب من أطول محتوى بحد أدنى وأقصى', () => {
    const { sheet } = built();
    const cols = sheet.match(/<col [^>]*\/>/g) ?? [];
    expect(cols).toHaveLength(3);
    const w = cols.map((c) => Number(/width="([\d.]+)"/.exec(c)![1]));
    // العمود الثاني فيه أطول نص فهو الأعرض، وكلها بين الحدين
    expect(w[1]).toBeGreaterThan(w[0]);
    expect(w[1]).toBeGreaterThan(w[2]);
    for (const x of w) { expect(x).toBeGreaterThanOrEqual(11); expect(x).toBeLessThanOrEqual(54); }
  });

  test('٦ اتجاه الورقة من اليمين في كل أوراق المصنّف', () => {
    const { sheet, criteria } = built();
    expect(sheet).toContain('rightToLeft="1"');
    expect(criteria).toContain('rightToLeft="1"');
  });

  test('٧ صف الإجمالي بخلفية وحد علوي', () => {
    const { sheet, styles } = built();
    const xfs = listOf(styles, 'cellXfs', 'xf');
    const s = styleOfText(sheet, 'الإجمالي');
    const xf = xfs[s];
    const fill = listOf(styles, 'fills', 'fill')[Number(/fillId="(\d+)"/.exec(xf)![1])];
    const border = listOf(styles, 'borders', 'border')[Number(/borderId="(\d+)"/.exec(xf)![1])];
    expect(fill).toContain('patternType="solid"');
    expect(border).toContain('<top style="medium">');
    // وصف الإجمالي العام في كتلة «الإجماليات» بالنمط نفسه
    expect(styleOfText(sheet, 'صافي الفترة')).toBe(s);
  });

  test('٨ مرشح تلقائي بنطاق رأس الجدول حتى آخر صف بيانات دون صف الإجمالي', () => {
    const { sheet } = built();
    const head = rowOf(sheet, 'التاريخ');
    expect(sheet).toContain(`<autoFilter ref="A${head}:C${head + 3}"/>`);
    expect(rowOf(sheet, '<f>SUM(')).toBe(head + 4); // صف الإجمالي خارج نطاق المرشح
  });

  test('٩ ورقة ثانية باسم «المعايير» فيها الفترة والمرشحات المطبقة', () => {
    const { criteria, wb, parts } = built();
    expect(CRITERIA_SHEET).toBe('المعايير');
    expect(wb).toContain('name="المعايير"');
    expect(Object.keys(parts)).toContain('xl/worksheets/sheet2.xml');
    expect(criteria).toContain('المعايير المطبقة');
    for (const t of ['الفترة', 'عن الفترة من 01/01/2026 إلى 31/12/2026', 'من تاريخ', '01/01/2026',
      'إلى تاريخ', '31/12/2026', 'مشمول في التقرير', 'وحدة A-1', 'الرقم الضريبي', '300000000000003']) {
      expect(criteria).toContain(t);
    }
    // بلا ترويسة لا ورقة معايير · التوافق مع النداء بوسيط واحد
    const plain = unzipSync(buildXlsx([{ name: 'وحدة A-1', blocks: [demo] }]));
    expect(Object.keys(plain)).not.toContain('xl/worksheets/sheet2.xml');
  });
});

describe('صلاحية المصنّف · إكسل يفتحه بلا تحذير', () => {
  test('الأجزاء الملزمة كلها في الأرشيف وموصوفة في content types والعلاقات', () => {
    const { parts, wb } = built();
    for (const name of ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml',
      'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml']) {
      expect(Object.keys(parts)).toContain(name);
    }
    const ct = strFromU8(parts['[Content_Types].xml']);
    const rels = strFromU8(parts['xl/_rels/workbook.xml.rels']);
    for (const p of ['/xl/workbook.xml', '/xl/styles.xml', '/xl/worksheets/sheet1.xml', '/xl/worksheets/sheet2.xml']) {
      expect(ct).toContain(`PartName="${p}"`);
    }
    // كل r:id في workbook له علاقة مقابلة، ولا شيء يشير إلى جزء غائب
    for (const id of wb.match(/r:id="([^"]+)"/g) ?? []) {
      expect(rels).toContain(id.replace('r:id=', 'Id='));
    }
    expect(rels).toContain('Target="styles.xml"');
    // لا sharedStrings في المخرَج فلا يُعلن عنه في content types
    expect(ct).not.toContain('sharedStrings');
    expect(Object.keys(parts)).not.toContain('xl/sharedStrings.xml');
  });

  test('ترتيب العناصر داخل worksheet وstyleSheet هو الترتيب الملزم في المخطط', () => {
    const { sheet, styles } = built();
    const ordered = (xml: string, tags: string[]) => {
      let last = -1;
      for (const t of tags) {
        const i = xml.indexOf('<' + t);
        expect(i).toBeGreaterThan(last);
        last = i;
      }
    };
    ordered(sheet, ['dimension', 'sheetViews', 'sheetFormatPr', 'cols', 'sheetData', 'autoFilter']);
    ordered(styles, ['numFmts', 'fonts', 'fills', 'borders', 'cellStyleXfs', 'cellXfs', 'cellStyles']);
    // العدّادات المعلنة تطابق العناصر فعلاً
    for (const [tag, item] of [['fonts', 'font'], ['fills', 'fill'], ['borders', 'border'], ['cellXfs', 'xf']] as const) {
      const declared = Number(new RegExp(`<${tag} count="(\\d+)"`).exec(styles)![1]);
      expect(listOf(styles, tag, item)).toHaveLength(declared);
    }
    // كل فهرس نمط مستعمل في الورقة موجود فعلاً في cellXfs
    const max = listOf(styles, 'cellXfs', 'xf').length - 1;
    for (const m of sheet.match(/ s="(\d+)"/g) ?? []) expect(Number(m.slice(4, -1))).toBeLessThanOrEqual(max);
  });

  test('نطاق الورقة ومراجع الخلايا متسقة: dimension يغطي آخر صف وكل صف مرتب الأعمدة', () => {
    const { sheet } = built();
    const rows = sheetRows(sheet);
    const lastRow = Number(/<row r="(\d+)"/.exec(rows[rows.length - 1])![1]);
    expect(sheet).toContain(`<dimension ref="A1:C${lastRow}"/>`);
    for (const row of rows) {
      const r = Number(/<row r="(\d+)"/.exec(row)![1]);
      const refs = (row.match(/<c r="([A-Z]+)(\d+)"/g) ?? []).map((x) => /<c r="([A-Z]+)(\d+)"/.exec(x)!);
      let prev = '';
      for (const ref of refs) {
        expect(Number(ref[2])).toBe(r);           // رقم الصف في المرجع يطابق الصف
        expect(ref[1] > prev).toBe(true);          // الأعمدة تصاعدية داخل الصف
        prev = ref[1];
      }
    }
  });

  test('أسماء الأوراق صالحة: بلا محارف ممنوعة، بحد ٣١ محرفاً، وبلا تكرار', () => {
    const long = 'وحدة طويلة الاسم جداً في برج الاختبار الكبير رقم واحد';
    const wb = strFromU8(unzipSync(buildXlsx([
      { name: long + ' أ', blocks: [demo] },
      { name: long + ' ب', blocks: [demo] },
      { name: 'ورقة/فيها:محارف*ممنوعة', blocks: [demo] },
    ]))['xl/workbook.xml']);
    const names = (wb.match(/<sheet name="([^"]+)"/g) ?? []).map((s) => /name="([^"]+)"/.exec(s)![1]);
    expect(names).toHaveLength(3);
    expect(new Set(names).size).toBe(3);              // بلا تكرار بعد القص
    for (const n of names) {
      expect(n.length).toBeLessThanOrEqual(31);
      expect(n).not.toMatch(/[\\/?*[\]:]/);
    }
  });
});
