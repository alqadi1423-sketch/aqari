/**
 * الأصول (قرار المالك ٢٠٢٦-١٠-٠٤ على موجز الأصول · الهجرة ٢٩) · بيانات مصطنعة.
 * الحسابات والبنود والإهلاك والنقل والاستبعاد والبيع والتحويل والمحتويات والتدفقات.
 */
import { memDb } from './helpers/testDb';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import type { DB } from '@/db/adapter';
import { confirmContract } from '@/domain/contracts/service';
import { savePurchase, deletePurchase, restorePurchase, type PurchaseInput } from '@/domain/purchases';
import { postEntry } from '@/domain/accounting/post';
import { today } from '@/domain/dates';
import {
  monthlyAmounts, expectedThrough, scheduleByYear, runDepreciation, monthIndex, monthEnd, duplicateDepreciation, postedAccum, bookValue,
} from '@/domain/assets/depreciation';
import {
  createPendingAsset, setAssetCost, transferAsset, disposeAsset, sellAsset, getAsset, listAssets, setAssetStatus, updateAssetInfo, warrantyEnding,
} from '@/domain/assets/service';
import { previewConversion, convertPurchase, undoConversion, convertibleInvoices } from '@/domain/assets/convert';
import { contentsCandidates, convertContents } from '@/domain/assets/contents';
import { suggestCategory, ASSET_CATEGORIES } from '@/domain/assets/catalog';
import { lineCosts, splitQty } from '@/domain/assets/purchaseLines';
import { accountMovement } from '@/domain/accounting/ledger';
import { cashFlowFigures } from '@/domain/finStatements';
import { initI18n } from '@/i18n';

beforeAll(() => { initI18n('ar'); });

const POSTED = 'مرحّل';
const bal = (db: DB, code: string, dims?: object) => { const m = accountMovement(db, code, null, null, dims as never); return m.debit - m.credit; };
const entriesOf = (db: DB, srcType: string) => db.all<{ id: string; date: string }>(
  `SELECT id, date FROM journal_entries WHERE src_type = ? AND status = ? AND deleted_at IS NULL ORDER BY date`, [srcType, POSTED]);

function world() {
  const db = memDb();
  const p = addProperty(db, { name: 'عقار أصول تجريبي' });
  const u1 = addUnit(db, p, { unit_no: 'A-1' });
  const u2 = addUnit(db, p, { unit_no: 'A-2' });
  return { db, p, u1, u2 };
}
const purchase = (o: Partial<PurchaseInput> = {}): PurchaseInput => ({
  supplier: 'مورد أصول تجريبي', date: '2026-03-15', due: '2026-04-15', category: 'صيانة', incorpItem: '', amortize: false, amortizeMonths: null,
  exempt: false, excludeFromVat: true, subtotalHalalas: 0, taxHalalas: 0, totalHalalas: 0, ...o,
});

test('الهجرة ٢٩: حسابات الفئات والمجمع والإهلاك والخسارة والأرباح · وجداول الأصول', () => {
  const { db } = world();
  for (const c of ['1410', '1420', '1430', '1440', '1450', '1460', '1470', '1490', '5600', '5700', '4400']) {
    expect(db.get(`SELECT code FROM accounts WHERE code = ?`, [c])).toBeTruthy();
  }
  for (const t of ['assets', 'asset_events', 'purchase_lines', 'depreciation_runs']) {
    expect(db.get(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, [t])).toBeTruthy();
  }
  expect(ASSET_CATEGORIES.map((c) => c.lifeMonths)).toEqual([84, 60, 60, 36, 36, 120, 60]);
});

test('القسط الثابت: يبدأ الشهر التالي للشراء، والأخير يأخذ فرق الهللات، والمجموع يساوي التكلفة', () => {
  const a = { id: 'x', cost_halalas: 100000, salvage_halalas: 0, life_months: 7, purchase_date: '2026-01-20' };
  const m = monthlyAmounts(a)!;
  expect(m.per).toBe(14285);
  expect(m.last).toBe(100000 - 14285 * 6);
  expect(expectedThrough(a, '2026-01-31')).toBe(0);
  expect(expectedThrough(a, '2026-02-28')).toBe(14285);
  expect(expectedThrough(a, '2026-03-15')).toBe(14285 + Math.round(14285 * 15 / 31));
  expect(expectedThrough(a, '2026-08-31')).toBe(100000);
  expect(expectedThrough(a, '2030-01-01')).toBe(100000);
  expect(scheduleByYear(a).reduce((s, y) => s + y.amount, 0)).toBe(100000);
  expect(splitQty(1000, 3)).toEqual([334, 333, 333]);
  expect(lineCosts([{ descr: 'a', qty: 1, amountHalalas: 300, isAsset: true }, { descr: 'b', qty: 1, amountHalalas: 100, isAsset: false }], 61, false)).toEqual([345, 116]);
  expect(lineCosts([{ descr: 'a', qty: 1, amountHalalas: 300, isAsset: true }], 45, true)).toEqual([300]);
});

test('فاتورة ببنود: الأصل بتكلفته ونصيبه من الضريبة على حساب فئته، والكمية تُنشئ أصولاً، والباقي مصروف', () => {
  const { db, u1 } = world();
  const id = savePurchase(db, purchase({
    date: today(), subtotalHalalas: 400000, taxHalalas: 60000, totalHalalas: 460000,
    lines: [
      { descr: 'مكيف سبلت تجريبي', qty: 3, amountHalalas: 300000, isAsset: true, category: '1410', unitId: u1, room: 'الصالة' },
      { descr: 'رسوم تركيب', qty: 1, amountHalalas: 100000, isAsset: false },
    ],
  }));
  const assets = listAssets(db, { unitId: u1 });
  expect(assets).toHaveLength(3);
  expect(assets.map((a) => a.cost_halalas).sort()).toEqual([115000, 115000, 115000]);
  expect(bal(db, '1410')).toBe(345000);
  expect(bal(db, '2100')).toBe(-460000);
  expect(bal(db, '5300')).toBe(115000);
  for (const a of assets) expect(bookValue(db, a)).toEqual({ cost: 115000, accum: 0, nbv: 115000 });
  expect(assets.every((a) => a.purchase_id === id && a.source === 'purchase' && a.room === 'الصالة')).toBe(true);
  // القابلة للخصم: ضريبتها في 1270 والأصل بأساسه
  const { db: db2, u1: v1 } = world();
  db2.run(`INSERT INTO suppliers (id, name, vat, created_at) VALUES ('s1', 'مورد ضريبي تجريبي', '300000000000003', '2026-01-01')`);
  savePurchase(db2, purchase({
    supplier: 'مورد ضريبي تجريبي', date: today(), taxStatus: 'فاتورة ضريبية · قابلة للخصم', subtotalHalalas: 200000, taxHalalas: 30000, totalHalalas: 230000,
    lines: [{ descr: 'ثلاجة تجريبية', qty: 1, amountHalalas: 200000, isAsset: true, category: '1420', unitId: v1 }],
  }));
  expect(bal(db2, '1420')).toBe(200000);
  expect(bal(db2, '1270')).toBe(30000);
});

test('مجموع البنود يساوي المبلغ قبل الضريبة · وإلا لا تُحفظ الفاتورة', () => {
  const { db, u1 } = world();
  expect(() => savePurchase(db, purchase({
    subtotalHalalas: 1000, totalHalalas: 1000,
    lines: [{ descr: 'كرسي', qty: 1, amountHalalas: 900, isAsset: true, category: '1430', unitId: u1 }],
  }))).toThrow('لا يساوي');
});

test('الإهلاك الشهري: قيدٌ لكل شهر حتى آخر شهرٍ انتهى، بأبعاد الأصل ووحدته وعقده، ولا يتكرر', () => {
  const { db, u1 } = world();
  const c = confirmContract(db, contractInput(u1, { tenant: 'مستأجر أصول تجريبي', idNumber: '1000009001', phone: '0500009001', depositHalalas: 0, start: '2026-01-01', end: '2026-12-31' } as never));
  const a = createPendingAsset(db, { name: 'غسالة تجريبية', category: '1420', unitId: u1 });
  setAssetCost(db, a, { costHalalas: 60000, purchaseDate: '2026-01-10', today: '2026-02-05' });
  expect(postedAccum(db, a)).toBe(0); // لم ينتهِ شهر إهلاكٍ بعد
  expect(runDepreciation(db, '2026-05-02')).toBe(3); // فبراير ومارس وأبريل
  expect(runDepreciation(db, '2026-05-20')).toBe(0);
  expect(postedAccum(db, a)).toBe(3000);
  const lines = db.all<{ asset_id: string; unit_id: string; contract_id: string | null; cost_center_id: string }>(
    `SELECT l.asset_id, l.unit_id, l.contract_id, l.cost_center_id FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id WHERE e.src_type = 'depreciation'`);
  expect(lines.every((l) => l.asset_id === a && l.unit_id === u1 && l.contract_id === c && l.cost_center_id === 'cc-general')).toBe(true);
  expect(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM depreciation_runs`)!.n).toBe(3);
  // حتى نهاية العمر: المجموع يساوي التكلفة تماماً
  runDepreciation(db, '2031-03-01');
  expect(postedAccum(db, a)).toBe(60000);
});

test('أصلٌ بلا فاتورة: «بانتظار تكلفة» بلا قيد · وإثبات تكلفته دائن 3100 ومعه إهلاك ما فات (السنة الجارية 5600 وما قبلها 3200)', () => {
  const { db, u1 } = world();
  const a = createPendingAsset(db, { name: 'سرير تجريبي', category: '1430', unitId: u1, room: 'غرفة النوم' });
  expect(getAsset(db, a).cost_halalas).toBeNull();
  expect(db.get(`SELECT 1 FROM journal_lines WHERE asset_id = ?`, [a])).toBeUndefined();
  setAssetCost(db, a, { costHalalas: 120000, purchaseDate: '2024-06-15', today: '2026-03-10' });
  expect(bal(db, '1430')).toBe(120000);
  expect(bal(db, '3100')).toBe(-120000);
  // من يوليو ٢٠٢٤ إلى فبراير ٢٠٢٦ = ٢٠ شهراً بـ ٢٠٠٠ · منها ١٨ قبل ٢٠٢٦
  expect(bal(db, '1490')).toBe(-40000);
  expect(bal(db, '3200')).toBe(36000);
  expect(bal(db, '5600')).toBe(4000);
  expect(() => setAssetCost(db, a, { costHalalas: 1, purchaseDate: '2024-01-01' })).toThrow('مثبتة');
});

test('النقل بتاريخه: أيام الشهر قبل النقل على القديمة، والتكلفة والمجمع ينتقلان إلى الجديدة', () => {
  const { db, u1, u2 } = world();
  const a = createPendingAsset(db, { name: 'تلفزيون تجريبي', category: '1450', unitId: u1 });
  setAssetCost(db, a, { costHalalas: 36000, purchaseDate: '2026-01-05', today: '2026-02-01' });
  runDepreciation(db, '2026-04-01'); // فبراير ومارس
  transferAsset(db, a, { unitId: u2, room: 'المجلس', date: '2026-04-16', today: '2026-04-20' });
  const asset = getAsset(db, a);
  expect(asset.unit_id).toBe(u2);
  // ١٠٠٠ شهرياً · ٢٠٠٠ قبل أبريل و١٦ يوماً من أبريل على القديمة
  const partial = Math.round(1000 * 16 / 30);
  expect(bal(db, '5600', { unitId: u1 })).toBe(2000 + partial);
  expect(bal(db, '1450', { unitId: u1 })).toBe(0);
  expect(bal(db, '1490', { unitId: u1 })).toBe(0);
  expect(bal(db, '1450', { unitId: u2 })).toBe(36000);
  expect(bal(db, '1490', { unitId: u2 })).toBe(-(2000 + partial));
  runDepreciation(db, '2026-05-03');
  expect(bal(db, '5600', { unitId: u2 })).toBe(1000 - partial);
  expect(postedAccum(db, a)).toBe(3000);
  expect(() => transferAsset(db, a, { unitId: u1, date: '2026-03-01', today: '2026-05-03' })).toThrow('رُحِّل إهلاك شهر');
});

test('الاستبعاد: إهلاك حتى تاريخه ثم المجمع وخسارة الاستبعاد بالقيمة الدفترية · ويبقى في السجل', () => {
  const { db, u1 } = world();
  const a = createPendingAsset(db, { name: 'ستارة تجريبية', category: '1440', unitId: u1 });
  setAssetCost(db, a, { costHalalas: 36000, purchaseDate: '2026-01-05', today: '2026-02-01' });
  disposeAsset(db, a, { date: '2026-03-31', reason: 'تلف', today: '2026-04-05' });
  expect(getAsset(db, a).status).toBe('disposed');
  expect(bal(db, '1440')).toBe(0);
  expect(bal(db, '1490')).toBe(0);
  expect(bal(db, '5600')).toBe(2000);
  expect(bal(db, '5700')).toBe(34000);
  expect(() => setAssetStatus(db, a, 'maintenance')).toThrow('مستبعد');
  runDepreciation(db, '2026-09-01');
  expect(bal(db, '5600')).toBe(2000);
});

test('البيع: النقد والمجمع مدين، والفئة دائن، والفرق ربحٌ 4400 أو خسارة 5700 · وحركة البنك للتحويل', () => {
  const { db, u1 } = world();
  const a = createPendingAsset(db, { name: 'مكيف للبيع', category: '1410', unitId: u1 });
  setAssetCost(db, a, { costHalalas: 84000, purchaseDate: '2026-01-05', today: '2026-02-01' });
  sellAsset(db, a, { date: '2026-03-31', amountHalalas: 90000, method: 'cash', today: '2026-04-02' });
  expect(getAsset(db, a).status).toBe('sold');
  expect(bal(db, '4400')).toBe(-(90000 - (84000 - 2000)));
  expect(bal(db, '1410')).toBe(0);
  const b = createPendingAsset(db, { name: 'ثلاجة للبيع', category: '1420', unitId: u1 });
  setAssetCost(db, b, { costHalalas: 60000, purchaseDate: '2026-01-05', today: '2026-02-01' });
  db.run(`INSERT INTO banks (id, name, created_at) VALUES ('bk1', 'بنك تجريبي', '2026-01-01')`);
  sellAsset(db, b, { date: '2026-03-31', amountHalalas: 10000, method: 'bank', bankId: 'bk1', today: '2026-04-02' });
  expect(bal(db, '5700')).toBe(60000 - 2000 - 10000);
  expect(db.get<{ s: number }>(`SELECT SUM(amount_halalas) AS s FROM bank_tx WHERE bank_id = 'bk1'`)!.s).toBe(10000);
});

test('تحويل فاتورة قديمة: المعاينة لا تكتب · والتنفيذ بتاريخ التحويل · والتراجع يعيد الدفتر كما كان', () => {
  const { db, u1 } = world();
  const pid = savePurchase(db, purchase({ date: '2025-01-10', category: 'صيانة', subtotalHalalas: 240000, taxHalalas: 0, totalHalalas: 240000 }));
  expect(convertibleInvoices(db).map((p) => p.id)).toContain(pid);
  const lines = [
    { descr: 'مكيف شباك تجريبي', qty: 2, amountHalalas: 168000, isAsset: true, category: '1410', unitId: u1 },
    { descr: 'أجور تركيب', qty: 1, amountHalalas: 72000, isAsset: false },
  ];
  const before = bal(db, '5300');
  const pv = previewConversion(db, pid, lines, '2026-03-10');
  expect(pv.assets).toHaveLength(2);
  expect(pv.reclass.credit).toEqual({ account: '5300', amount: 168000 });
  // ١٠٠٠ شهرياً لكل مكيف من فبراير ٢٠٢٥ إلى فبراير ٢٠٢٦ = ١٣ شهراً · ١١ منها في ٢٠٢٥
  expect(pv.catchUp).toEqual({ current: 4000, prior: 22000, total: 26000 });
  expect(pv.bookValueToday).toBe(168000 - 26000);
  expect(pv.byYear.reduce((s, y) => s + y.amount, 0)).toBe(168000);
  expect(listAssets(db)).toHaveLength(0);
  expect(bal(db, '5300')).toBe(before);
  convertPurchase(db, pid, lines, '2026-03-10');
  expect(bal(db, '1410')).toBe(168000);
  expect(bal(db, '5300')).toBe(before - 168000 + 4000 * 0);
  expect(bal(db, '5600')).toBe(4000);
  expect(bal(db, '3200')).toBe(22000);
  expect(entriesOf(db, 'asset_convert')[0].date).toBe('2026-03-10');
  expect(() => convertPurchase(db, pid, lines, '2026-03-10')).toThrow('محوّلة');
  expect(() => deletePurchase(db, pid)).toThrow('اعكس التحويل');
  runDepreciation(db, '2026-05-01');
  undoConversion(db, pid, '2026-05-02');
  for (const c of ['1410', '1490', '5600', '3200']) expect(bal(db, c)).toBe(0);
  expect(bal(db, '5300')).toBe(before);
  expect(listAssets(db)).toHaveLength(0);
});

test('فاتورةٌ لأصولها إهلاك لا تُعدَّل ولا تُحذف · وقبل الإهلاك تُعدَّل وتُحذف وتُستعاد بأصولها', () => {
  const { db, u1 } = world();
  const input = purchase({
    date: today(), subtotalHalalas: 50000, totalHalalas: 50000,
    lines: [{ descr: 'مرآة تجريبية', qty: 1, amountHalalas: 50000, isAsset: true, category: '1460', unitId: u1 }],
  });
  const pid = savePurchase(db, input);
  savePurchase(db, { ...input, subtotalHalalas: 60000, totalHalalas: 60000, lines: [{ ...input.lines![0], amountHalalas: 60000 }] }, pid);
  expect(listAssets(db).map((a) => a.cost_halalas)).toEqual([60000]);
  expect(bal(db, '1460')).toBe(60000);
  deletePurchase(db, pid);
  expect(listAssets(db)).toHaveLength(0);
  expect(bal(db, '1460')).toBe(0);
  restorePurchase(db, pid);
  expect(listAssets(db).map((a) => a.cost_halalas)).toEqual([60000]);
  expect(bal(db, '1460')).toBe(60000);
  // سطر الأصل في القيد المستعاد يحمل الأصل نفسه (repostCopy ينسخ الأبعاد)
  expect(bal(db, '1460', { assetId: listAssets(db)[0].id })).toBe(60000);
  deletePurchase(db, pid);
  const pid2 = savePurchase(db, purchase({
    date: '2025-11-03', subtotalHalalas: 12000, totalHalalas: 12000,
    lines: [{ descr: 'خلاط تجريبي', qty: 1, amountHalalas: 12000, isAsset: true, category: '1460', unitId: u1 }],
  }));
  expect(postedAccum(db, listAssets(db)[0].id)).toBeGreaterThan(0); // إهلاك ما فات لفاتورةٍ بتاريخٍ مضى
  expect(() => deletePurchase(db, pid2)).toThrow('إهلاك');
});

test('المحتويات إلى أصول: الفئة مقترحة من الاسم، وكل بندٍ «بانتظار تكلفة» بلا قيد، ولا يُحوَّل مرتين', () => {
  const { db, u1 } = world();
  db.run(`INSERT INTO unit_rooms (id, unit_id, room_name, sort) VALUES ('r1', ?, 'المطبخ', 0)`, [u1]);
  db.run(`INSERT INTO unit_room_items (id, room_id, name, descr, sort) VALUES ('i1', 'r1', 'ثلاجة', 'بابين', 0), ('i2', 'r1', 'مفاتيح', '', 1)`);
  const c = contentsCandidates(db, u1);
  expect(c.map((x) => [x.name, x.suggested])).toEqual([['ثلاجة', '1420'], ['مفاتيح', null]]);
  expect(convertContents(db, [{ unitId: u1, room: 'المطبخ', name: 'ثلاجة', descr: 'بابين', category: '1420' }])).toBe(1);
  expect(contentsCandidates(db, u1)[0].converted).toBe(true);
  expect(convertContents(db, [{ unitId: u1, room: 'المطبخ', name: 'ثلاجة', descr: 'بابين', category: '1420' }])).toBe(0);
  const a = listAssets(db)[0];
  expect([a.cost_halalas, a.source, a.notes]).toEqual([null, 'contents', 'بابين']);
  expect(suggestCategory('مكيف سبلت')).toBe('1410');
  expect(suggestCategory('Split air conditioner')).toBe('1410');
  expect(suggestCategory('الجدران')).toBeNull();
});

test('التدفقات النقدية: الإهلاك لا ينقص التشغيلي، والشراء استثماري، ومتحصّل البيع استثماري', () => {
  const { db, u1 } = world();
  const a = createPendingAsset(db, { name: 'أثاث تدفقات', category: '1430', unitId: u1 });
  setAssetCost(db, a, { costHalalas: 60000, purchaseDate: '2026-01-05', today: '2026-02-01' });
  runDepreciation(db, '2026-04-01');
  const net = -bal(db, '5600');
  const cf = cashFlowFigures(db, '2026-01-01', '2026-12-31', net);
  expect(cf.opCash).toBe(0);
  expect(cf.nonCash).toBe(2000);
  expect(cf.investing).toBe(0); // مساهمة عينية · لا نقد
  sellAsset(db, a, { date: '2026-04-10', amountHalalas: 5000, method: 'cash', today: '2026-04-11' });
  expect(cashFlowFigures(db, '2026-01-01', '2026-12-31', 0).investing).toBe(5000);
});

test('تكرار إهلاك الشهر من جهازين يظهر للمراجعة · والضمان المقترب يُعرض', () => {
  const { db, u1 } = world();
  const a = createPendingAsset(db, { name: 'سخان تجريبي', category: '1420', unitId: u1, warrantyEnd: '2026-10-20' });
  setAssetCost(db, a, { costHalalas: 6000, purchaseDate: '2026-01-05', today: '2026-02-01' });
  runDepreciation(db, '2026-03-01');
  db.run(`DELETE FROM depreciation_runs`);
  runDepreciation(db, '2026-03-01');
  // الثاني بلا شيء يرحّله لأن المرحَّل يغطي المستحق · فلا تكرار
  expect(duplicateDepreciation(db)).toEqual([]);
  // جهازٌ آخر رحّل الشهر نفسه قبل أن يصله الأول
  postEntry(db, { date: '2026-02-28', memo: 'جهاز آخر', lines: [{ account: '5600', debit: 100, credit: 0 }, { account: '1490', debit: 0, credit: 100 }], srcType: 'depreciation', srcId: '2026-02' });
  expect(duplicateDepreciation(db).map((d) => [d.month, d.entries.length])).toEqual([['2026-02', 2]]);
  expect(warrantyEnding(db, '2026-10-07', 30).map((x) => x.name)).toEqual(['سخان تجريبي']);
  expect(warrantyEnding(db, '2026-10-07', 5)).toEqual([]);
  expect(() => updateAssetInfo(db, a, { lifeMonths: 12 })).toThrow('بدأ إهلاك');
  updateAssetInfo(db, a, { model: 'طراز تجريبي', serial: 'SN-0001' });
  expect(getAsset(db, a).model).toBe('طراز تجريبي');
  void monthIndex; void monthEnd;
});
