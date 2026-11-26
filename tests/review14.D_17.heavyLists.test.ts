/**
 * المراجعة الشاملة 2026-11-13 · D-17 · منخفض · قوائم ثقيلة.
 * السيناريو أ: تبويب العقود حيٌّ دائماً، وكل بطاقة عقد تستعلم rowBy وattachmentsFor مع كل رسم ← استعلامان لكل صف مع كل تحديث.
 * السيناريو ب: العقارات rows.map داخل ScrollView بحجم صفحة حتى ٥٠٠، والعدّاد فوق القائمة لا أسفلها (قرار المالك 2026-08-22).
 * الصحيح: ما تحتاجه البطاقات يُحسب مرةً للصفحة باستعلامٍ واحد، والعقارات FlatList افتراضية والعدّاد في ذيلها.
 */
import fs from 'fs';
import path from 'path';
import ts from 'typescript';

const read = (...p: string[]) => fs.readFileSync(path.resolve(__dirname, '..', ...p), 'utf8');

/** جسد دالةٍ مسمّاة داخل الملف */
function fnBody(src: string, file: string, name: string): string {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let out = '';
  const visit = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && n.name.getText(sf) === name && n.initializer) out = n.initializer.getText(sf);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

test('D-17 بطاقة العقد لا تستعلم لكل صف: rowBy والمرفقات محسوبةٌ للصفحة', () => {
  const src = read('app', '(tabs)', 'contracts.tsx');
  const body = fnBody(src, 'contracts.tsx', 'renderContract');
  expect(body).not.toBe('');
  expect(body).not.toMatch(/rowBy\(/);
  expect(body).not.toMatch(/attachmentsFor\(/);
});

test('D-17 العقارات قائمة افتراضية والعدّاد في ذيلها', () => {
  const src = read('app', '(tabs)', 'properties.tsx');
  expect(src).not.toMatch(/rows\.map\(\(p\)/);
  expect(src).toMatch(/<FlatList/);
  expect(src).toMatch(/ListFooterComponent=\{<Pager pager=\{pager\} total=\{totalRows\} \/>\}/);
});

/*
 * السيناريو ج (السلة · settings.tsx:1405): السلة data.trash.map كاملةً داخل تمرير الورقة، وكل صفٍّ يستدعي مع كل رسم restoreCashOut
 * مرتين وcashShortfall وrestoreIntoFiledPeriod ← أربع قراءاتٍ فأكثر لكل صف.
 * الصحيح: FlatList افتراضية بصفحات والعدّاد في ذيلها، والورقة لا تلفّها في ScrollView، والصفّ بذاكرة لا يستعلم، وأحكامه محسوبةٌ
 * للصفحة بعددٍ ثابت من العبارات أيّاً كان عدد صفوفها، ومساويةٌ لأحكام الدوال الثلاث على كل عنصر.
 */
test('D-17 السلة قائمة افتراضية بصفحات والعدّاد في ذيلها · والصفّ بذاكرة بلا استعلام', () => {
  const src = read('app', 'settings.tsx');
  const from = src.indexOf('<Sheet visible={trashOpen}');
  expect(from).toBeGreaterThan(-1);
  const sheet = src.slice(from, src.indexOf('</Sheet>', from));
  expect(sheet).not.toMatch(/data\.trash\.map\(/);
  expect(sheet).toMatch(/title="سلة المحذوفات" tall list>/);
  expect(sheet).toMatch(/<FlatList/);
  expect(sheet).toMatch(/keyExtractor=\{trashKey\}/);
  expect(sheet).toMatch(/ListFooterComponent=\{<View><Pager pager=\{trashPager\} total=\{data\.trash\.length\} \/>/);
  expect(sheet).toMatch(/ListEmptyComponent=\{<EmptyState>سجل الحذف فارغ/);

  const row = fnBody(src, 'settings.tsx', 'TrashRow');
  expect(row).toMatch(/^React\.memo\(/);
  for (const q of [/\bdb\b/, /useApp\(/, /restoreCashOut\(/, /cashShortfall\(/, /restoreIntoFiledPeriod\(/, /trashRestoreGates\(/]) {
    expect(row).not.toMatch(q);
  }
  const render = fnBody(src, 'settings.tsx', 'renderTrashRow');
  expect(render).not.toBe('');
  expect(render).not.toMatch(/\bdb\b/);
  expect(fnBody(src, 'settings.tsx', 'trashGates')).toMatch(/trashRestoreGates\(db, trashPage\)/);

  // الورقة في وضع القائمة لا تلفّ محتواها في ScrollView (افتراضيةٌ داخل تمريرٍ عادي تُرسم كلها)
  const sh = read('src', 'ui', 'Sheet.tsx');
  expect(sh).toMatch(/\{list \? \(\s*<View style=\{\{ flexGrow: 1, flexShrink: 1/);
});

test('D-17 أحكام الاستعادة للصفحة دفعةً: مساويةٌ للدوال لكل عنصر، وعدد العبارات لا يكبر بعدد الصفوف', async () => {
  const { memDb } = await import('./helpers/testDb');
  const { addProperty, addUnit } = await import('./helpers/fixtures');
  const { savePurchase, payPurchase, deletePurchase } = await import('@/domain/purchases');
  const { ownerCashIn, ownerCashOut } = await import('@/domain/cashOps');
  const { walletCashBalance } = await import('@/domain/accounting/ledger');
  const { cashShortfall } = await import('@/domain/cashGuard');
  const { recordKeyMoneyDeal } = await import('@/domain/keymoney');
  const { entrySourceAction } = await import('@/domain/accounting/sourceCancel');
  const { fileVatReturn } = await import('@/domain/vatFilings');
  const trash = await import('@/domain/trash');
  type DB = import('@/db/adapter').DB;

  const T = '2026-05-10';
  const purchase = (db: DB, total: number) => savePurchase(db, {
    supplier: 'مورد مصطنع', date: '2026-05-01', due: '2026-05-31', category: 'صيانة', incorpItem: '',
    amortize: false, amortizeMonths: null, exempt: false, excludeFromVat: false,
    subtotalHalalas: total, taxHalalas: 0, totalHalalas: total,
  });
  const deal = (db: DB, date: string) => recordKeyMoneyDeal(db, {
    unitId: addUnit(db, addProperty(db, { name: 'عقار تقبيل مصطنع' })), outgoing: 'متنازل مصطنع', incoming: 'متنازل له مصطنع',
    amountHalalas: 3000000, date, commissionHalalas: 23000, method: 'cash', bankId: null, notes: '',
  });
  const cancelDeal = (db: DB, dealId: string, date: string) => {
    const e = db.get<{ id: string }>(`SELECT id FROM journal_entries WHERE src_type = 'key_money' AND src_id = ? ORDER BY rowid LIMIT 1`, [dealId])!;
    const a = entrySourceAction(db, e.id);
    if (a?.kind !== 'op') throw new Error('op');
    a.run(date, 'سبب إلغاء مصطنع');
  };
  /** سلةٌ مصطنعة فيها n فاتورة شراء مسدَّدة نقداً، وغير مسدَّدة، وصفقتا تقبيل (إحداهما إلى فترةٍ مقدَّم إقرارها)، ومستأجر */
  const seed = (n: number) => {
    const db = memDb();
    db.run(`UPDATE company SET vat_enabled = 1 WHERE id = 1`);
    const filedDeal = deal(db, '2026-02-10');
    cancelDeal(db, filedDeal, '2026-03-01');
    fileVatReturn(db, 2026, 1, '2026-04-20');
    const openDeal = deal(db, '2026-04-25');
    cancelDeal(db, openDeal, '2026-05-02');
    for (let k = 0; k < n; k++) {
      ownerCashIn(db, { amountHalalas: 8000 + k, date: T });
      const id = purchase(db, 8000 + k);
      payPurchase(db, id, 'cash', null, T);
      deletePurchase(db, id);
    }
    deletePurchase(db, purchase(db, 1000));
    db.run(`INSERT INTO tenants (id, name, created_at, deleted_at) VALUES ('TX', 'مستأجر مصطنع', datetime('now'), datetime('now'))`);
    // جزءٌ من النقد يُسحب فتنقص المحفظة عن بعض الاستعادات
    ownerCashOut(db, { amountHalalas: walletCashBalance(db) - 4000, date: '2026-05-20' });
    return db;
  };

  const db = seed(3);
  const items = trash.trashItems(db);
  const gates = trash.trashRestoreGates(db, items);
  for (const it of items) {
    const cashOut = trash.restoreCashOut(db, it.table, it.id);
    // والنقص من تاريخ إعادة الصرف فما بعده كما يفحصه الصف وحده (A2.8)
    const date = cashOut > 0 ? trash.restoreCashDate(db, it.table, it.id) : null;
    expect([it.table, gates.get(trash.trashKey(it))]).toEqual([it.table, {
      cashOut, short: cashShortfall(db, cashOut, date), filed: trash.restoreIntoFiledPeriod(db, it.table, it.id), date,
    }]);
  }
  const all = [...gates.values()];
  expect(all.some((g) => g.cashOut > 0 && g.short > 0)).toBe(true);
  expect(all.some((g) => g.filed)).toBe(true);
  expect(all.filter((g) => !g.filed && !g.short).length).toBeGreaterThan(0);

  // عدد العبارات للصفحة ثابت: صفحةٌ بفاتورةٍ واحدة مسدَّدة كصفحةٍ بست
  const counted = (d: DB) => {
    let n = 0;
    const wrap = new Proxy(d, {
      get(target, key, recv) {
        const v = Reflect.get(target, key, recv);
        if (key === 'all' || key === 'get' || key === 'run') {
          return (...a: unknown[]) => { n++; return (v as (...x: unknown[]) => unknown).apply(target, a); };
        }
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    return { wrap, n: () => n };
  };
  const queriesFor = (n: number) => {
    const d = seed(n);
    const page = trash.trashItems(d);
    const c = counted(d);
    trash.trashRestoreGates(c.wrap, page);
    return c.n();
  };
  expect(queriesFor(6)).toBe(queriesFor(1));
});
