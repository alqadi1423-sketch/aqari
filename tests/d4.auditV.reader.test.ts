/**
 * المدقق الخارجي V · الجولة الحادية عشرة · كشف البنك (التوجيه الرابع ٦ · ٢) · القارئ العام (src/domain/bankStatement/read.ts
 * وnormalize.ts وdictionary.json) · كل اختبارٍ هنا يسقط على الشيفرة الحالية ويصف السلوك الصحيح · «ما لا يثبت لا يُقبل» و«قارئ عام
 * لا مبني على بنك أو شكل» · بياناتٌ مصطنعة كلها (أسماء وأرقام حسابات ومبالغ مخترعة).
 *   TZ=Asia/Riyadh npx jest tests/d4.auditV.reader.test.ts
 */
import { strToU8, zipSync } from 'fflate';
import { memDb } from './helpers/testDb';
import { addBank } from './helpers/fixtures';
import { readStatementGrid, readStatementFile, unverifiedResult, type StatementResult } from '@/domain/bankStatement/read';
import { saveStatement, reconciliation } from '@/domain/bankStatement/store';
import { gridFromPdfItems } from '@/domain/bankStatement/pdfTable';

const amounts = (r: StatementResult) => (r.ok ? r.lines.map((l) => l.amount) : r.error + ':' + (r.detail ?? ''));

describe('V٢ · [عالٍ] حركةٌ مؤرَّخة في بيانها كلمة ملخص («OPENING» أو «CLOSING») تُعامَل صفَّ ملخص فتسقط من الكشف بصمت (read.ts:215)', () => {
  // إصلاح U٧ («صفُّ ملخصٍ بتاريخه ليس حركة») يفحص كلمات الملخص في كل خلايا الصف ومنها البيان، ولا ينظر هل في الصف مبلغ حركة:
  // «ACCOUNT OPENING DEPOSIT» (أول إيداعٍ في حسابٍ جديد) يصير «الرصيد الافتتاحي» بقيمة الإيداع ويُحذف سطره، والتسلسل يثبت معه
  // لأن رصيد السطر المحذوف هو «الافتتاحي» الجديد · فيُقبل الكشف متحقَّقاً بسطرٍ ناقص وافتتاحيٍّ خاطئ، والختامي المطبوع يشهد له
  test('كشف حسابٍ جديد: الإيداع الافتتاحي 5,000 سطرٌ في الكشف، والافتتاحي صفر', () => {
    const r = readStatementGrid([
      ['Account Statement (synthetic)'],
      ['Date', 'Description', 'Debit', 'Credit', 'Balance'],
      ['01/10/2026', 'ACCOUNT OPENING DEPOSIT', '', '5,000.00', '5,000.00'],
      ['02/10/2026', 'POS PURCHASE (synthetic)', '200.00', '', '4,800.00'],
      ['05/10/2026', 'SALARY (synthetic)', '', '1,000.00', '5,800.00'],
      ['Closing Balance', '', '', '', '5,800.00'],
    ]);
    // الصحيح: الصف الذي فيه مبلغ حركة (مدين أو دائن) حركةٌ ولو حمل بيانُه كلمةً من قاموس الملخص
    expect(amounts(r)).toEqual([500000, -20000, 100000]);
    expect(r).toMatchObject({ ok: true, opening: 0, closing: 580000 });
  });
});

describe('V٧ · [متوسط] رقم الحساب في رأس الكشف يُبنى من كل أرقام الصف بعد كلمة «الحساب»، فكشفٌ صحيح لحسابه يُرفض «لحسابٍ آخر» (read.ts:342)', () => {
  // accountOf يضمّ أرقام كل الخلايا بعد خلية «رقم الحساب» في الصف نفسه: «رقم الحساب | 000012345678 | تاريخ الكشف | 31/10/2026»
  // (الرأس بزوجين في سطرٍ واحد كما تطبعه أغلب الكشوف) يصير «00001234567831102026» فلا يطابق آيبان البنك، ويرفضه saveStatement
  test('الرقم المطبوع 000012345678 وآيبان البنك ينتهي به: يُحفظ', () => {
    const db = memDb();
    const bank = addBank(db, 'بنك مصطنع للمدقق V', 0);
    db.run(`UPDATE banks SET iban = 'SA0300000000000012345678' WHERE id = ?`, [bank]);
    const r = readStatementGrid([
      ['رقم الحساب', '000012345678', 'تاريخ الكشف', '31/10/2026'],
      ['الرصيد الافتتاحي', '0.00'],
      ['التاريخ', 'البيان', 'مدين', 'دائن', 'الرصيد'],
      ['2026/10/02', 'حوالة واردة مصطنعة', '', '1,000.00', '1,000.00'],
      ['2026/10/05', 'رسوم مصطنعة', '15.00', '', '985.00'],
    ]);
    if (!r.ok) throw new Error(r.error);
    // الصحيح: رقم الحساب قيمة الخلية التالية لكلمته (لا ما بعدها من تواريخ)، فيطابق الآيبان ويُحفظ الكشف
    expect(r.account).toBe('000012345678');
    expect(() => saveStatement(db, bank, r, { name: 'oct.pdf', hash: 'v7' })).not.toThrow();
  });
});

describe('V٨ · [متوسط] عمود مؤشر الإشارة «Cr/Dr» يأخذ دور «مدين» من القاموس، فقيمه «CR» و«DR» خلايا مبلغٍ لا تُقرأ ويُرفض الكشف (dictionary.json · read.ts:233)', () => {
  // شكلٌ شائع في الكشوف الإنجليزية: «المبلغ» بلا إشارة وعمودٌ بجانبه «Cr/Dr» · foldText يجعله «cr dr» فيطابق «dr» في كلمات المدين
  // (والمدين قبل الدائن في القاموس) · ثم unreadable(debitCol) يرى «CR» نصاً لا يُقرأ مبلغاً فيُرفض الكشف «format» بلا شاشة أعمدة
  test('«Amount | Cr/Dr | Balance»: الحركتان بإشارتيهما', () => {
    const r = readStatementGrid([
      ['Opening Balance', '1,000.00'],
      ['Date', 'Narrative', 'Amount', 'Cr/Dr', 'Balance'],
      ['02/10/2026', 'Transfer in (synthetic)', '500.00', 'CR', '1,500.00'],
      ['05/10/2026', 'POS purchase (synthetic)', '200.00', 'DR', '1,300.00'],
      ['Closing Balance', '1,300.00'],
    ]);
    // الصحيح: عمود المؤشر نوعٌ (CR دائن وDR مدين كما في signMode «type») أو يُترك والإشارة من الأرصدة · لا رفض
    expect(amounts(r)).toEqual([50000, -20000]);
  });
});

describe('V٩ · [متوسط] كشف Excel بتاريخٍ ووقت في الخلية (تسلسل إكسل بكسر) لا يُقرأ منه سطر (normalize.ts:78)', () => {
  // excelSerial يقبل خمسة أرقامٍ صحيحة فقط (/^\d{5}$/): خلية «2026-10-05 10:30» يخزّنها إكسل 46300.4375 فلا تُقرأ تاريخاً، فلا يبدأ
  // صفٌّ بتاريخ ويُرفض الملف كله «فارغاً» · وهو شكل تصدير «تاريخ ووقت العملية» في كشوف Excel
  const xlsx = (rows: Array<Array<string | number>>): Uint8Array => {
    const col = (i: number) => String.fromCharCode(65 + i);
    const cell = (v: string | number, ref: string) => (typeof v === 'number'
      ? `<c r="${ref}"><v>${v}</v></c>`
      : `<c r="${ref}" t="inlineStr"><is><t>${v}</t></is></c>`);
    const sheet = `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${
      rows.map((r, i) => `<row r="${i + 1}">${r.map((v, j) => (v === '' ? '' : cell(v, col(j) + (i + 1)))).join('')}</row>`).join('')}</sheetData></worksheet>`;
    return zipSync({
      'xl/workbook.xml': strToU8(`<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Statement" sheetId="1" r:id="rId1"/></sheets></workbook>`),
      'xl/_rels/workbook.xml.rels': strToU8(`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`),
      'xl/worksheets/sheet1.xml': strToU8(sheet),
    });
  };
  test('ثلاث حركاتٍ بتاريخ ووقت: تُقرأ بأيامها ومبالغها', () => {
    const bytes = xlsx([
      ['Opening Balance', 1000],
      ['Transaction Date', 'Description', 'Debit', 'Credit', 'Balance'],
      [46300.4375, 'Transfer in (synthetic)', '', 500, 1500],
      [46301.6041666667, 'POS purchase (synthetic)', 200, '', 1300],
      [46303.375, 'Fee (synthetic)', 15.5, '', 1284.5],
    ]);
    const r = readStatementFile({ name: 'statement.xlsx', bytes });
    // الصحيح: كسر التسلسل وقتٌ يُهمل كما يُهمل «10:30» بعد التاريخ النصي
    expect(r.ok && r.lines.map((l) => [l.date, l.amount])).toEqual([['2026-10-05', 50000], ['2026-10-06', -20000], ['2026-10-08', -1550]]);
  });
});

describe('V١١ · [منخفض] الكشف «غير المتحقَّق» يُحفظ بفترةٍ مطبوعة لم تُفحص (إصلاح U١٠ في المسار الناجح وحده · read.ts:279)', () => {
  // partialOf يعطي from وto من أول صفٍّ فيه تاريخان («تاريخ فتح الحساب … تاريخ الطباعة») بلا فحص U١٠ (الفترة تحوي السطور ولا تزيد
  // على مداها بأكثر من شهرين) · فيُحفظ كشف أكتوبر بفترة 2015–2026، ويقول تقرير المطابقة إن كل شهرٍ منذ 2015 «مغطى بكشفٍ غير متحقَّق»،
  // وحذف أي كشفٍ آخر في تلك السنين ينقل سطوره إليه بدل حذفها (deleteStatement)
  test('رأسٌ فيه تاريخ فتح الحساب وتاريخ الطباعة وسطرٌ يكسر التسلسل: الفترة مدى السطور كما في القراءة الناجحة', () => {
    const grid = (fee: string) => readStatementGrid([
      ['تاريخ فتح الحساب 15/03/2015', 'تاريخ الطباعة 07/11/2026'],
      ['الرصيد الافتتاحي', '0.00'],
      ['التاريخ', 'البيان', 'مدين', 'دائن', 'الرصيد'],
      ['2026/10/02', 'حوالة واردة مصطنعة', '', '1,000.00', '1,000.00'],
      ['2026/10/05', 'رسوم مصطنعة', fee, '', '942.00'],
    ]);
    const good = grid('58.00');
    expect(good.ok && [good.from, good.to]).toEqual(['2026-10-02', '2026-10-05']);
    const bad = grid('85.00');
    const u = bad.ok ? null : unverifiedResult(bad.partial);
    if (!u) throw new Error('لا قراءة غير متحقَّقة');
    const db = memDb();
    const bank = addBank(db, 'بنك مصطنع للمدقق V', 0);
    saveStatement(db, bank, u, { name: 'oct-unverified.pdf', hash: 'v11' });
    // الصحيح: الفترة المطبوعة التي لا تحوي السطور أو تزيد على مداها تُترك كما في القراءة الناجحة، فلا يغطي الكشف مارس 2020
    expect([u.from, u.to]).toEqual(['2026-10-02', '2026-10-05']);
    expect(reconciliation(db, bank, '2020-03').covered).toBe(false);
  });
});

describe('V١٣ · [متوسط] صفٌّ مؤرَّخ بلا أي مبلغ (ختم الطباعة أسفل الصفحة «07/11/2026 10:30 … Page 1 of 1») يصير حركةً صفرية بتاريخ الطباعة (read.ts:234)', () => {
  // في PDF يقع ختم الطباعة يسار التذييل تحت عمود التاريخ فيُقرأ صفَّ حركة: مع عمودي مدين ودائن فارغين تصير «0» (split: ‎?? 0) ·
  // في الكشف من الأقدم سطرٌ صفري بتاريخ 7 نوفمبر يُحفظ وتمتدّ الفترة إلى نوفمبر (فيبدو نوفمبر «مغطى» وكل حركاته «في الدفاتر وحدها»)،
  // وفي الكشف من الأحدث يمنع قلبَ الترتيب (آخر السطور أحدثها) فيُرفض كشفٌ صحيح «balance»
  const at = (str: string, x: number, y: number) => ({ str, x, y, size: 9 });
  const page = (rows: Array<[string, string, string, string, string]>) => [
    at('Statement Period: 01/10/2026 - 31/10/2026', 40, 760),
    at('Opening Balance', 40, 740), at('0.00', 200, 740),
    at('Date', 40, 700), at('Description', 120, 700), at('Debit', 300, 700), at('Credit', 380, 700), at('Balance', 460, 700),
    ...rows.flatMap(([d, descr, dr, cr, bal], i) => [at(d, 40, 680 - i * 15), at(descr, 120, 680 - i * 15),
      ...(dr ? [at(dr, 300, 680 - i * 15)] : []), ...(cr ? [at(cr, 380, 680 - i * 15)] : []), at(bal, 460, 680 - i * 15)]),
    at('Closing Balance', 40, 600), at('1,300.00', 460, 600),
    at('07/11/2026 10:30', 40, 40), at('Page 1 of 1', 460, 40),
  ];
  const rows: Array<[string, string, string, string, string]> = [
    ['01/10/2026', 'SALARY (synthetic)', '', '1,000.00', '1,000.00'],
    ['02/10/2026', 'TRANSFER IN (synthetic)', '', '500.00', '1,500.00'],
    ['05/10/2026', 'POS PURCHASE (synthetic)', '200.00', '', '1,300.00'],
  ];
  test('الكشف من الأقدم ومن الأحدث بتذييلٍ فيه ختم الطباعة: ثلاث حركاتٍ في أكتوبر وحده', () => {
    const oldest = readStatementGrid(gridFromPdfItems([page(rows)]));
    // الصحيح: صفٌّ لا مبلغ فيه ولا رصيد ليس حركة، والفترة المطبوعة (أكتوبر) تبقى
    expect(oldest.ok && [oldest.lines.map((l) => [l.date, l.amount]), oldest.from, oldest.to]).toEqual([
      [['2026-10-01', 100000], ['2026-10-02', 50000], ['2026-10-05', -20000]], '2026-10-01', '2026-10-31']);
    const newest = readStatementGrid(gridFromPdfItems([page([...rows].reverse())]));
    expect(amounts(newest)).toEqual([100000, 50000, -20000]);
  });
});
