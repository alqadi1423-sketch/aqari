/**
 * عمليات الأصول (موجز الأصول §٣ و§٤ و§٧ · قرار المالك ٢٠٢٦-١٠-٠٤):
 *  - أصلٌ بلا فاتورة «بانتظار تكلفة» بلا قيد ولا إهلاك · وإثبات تكلفته يقيّد دائن 3100 ومعه إهلاك ما فات.
 *  - النقل بتاريخه: إهلاك الأيام قبله على القديمة، ثم قيدٌ ينقل التكلفة والمجمع إلى أبعاد الجديدة.
 *  - الاستبعاد: إهلاك حتى تاريخه، ثم مدين المجمع ومدين خسارة الاستبعاد بالقيمة الدفترية / دائن الفئة.
 *  - البيع: إهلاك حتى تاريخه، ثم مدين النقد أو البنك والمجمع / دائن الفئة، والفرق ربحٌ 4400 أو خسارة 5700.
 *  - كل تاريخ عملية بعد آخر شهرٍ رُحِّل إهلاكه، فلا تتغير أرقام شهرٍ مُقفل.
 */
import type { DB } from '../../db/adapter';
import { uid } from '../ids';
import { today as todayFn, addDays } from '../dates';
import { logAudit } from '../audit';
import { postEntry } from '../accounting/post';
import { t } from '../../i18n';
import {
  ACC_ACCUM, ACC_CAPITAL, ACC_CASH, ACC_DISPOSAL_LOSS, ACC_SALE_GAIN, ENDED, defaultLife, isAssetCategory,
  type AssetSource, type AssetStatus, type AssetEventKind,
} from './catalog';
import {
  assetDims, bookValue, catchUpLines, depreciateAssetTo, lastRunMonth, monthIndex, monthKey, postedAccum, runDepreciation,
} from './depreciation';

export interface AssetRow {
  id: string;
  name: string;
  category: string;
  property_id: string | null;
  unit_id: string | null;
  room: string;
  model: string;
  serial: string;
  purchase_date: string | null;
  cost_halalas: number | null;
  salvage_halalas: number;
  life_months: number;
  status: AssetStatus;
  source: AssetSource;
  purchase_id: string | null;
  purchase_line_id: string | null;
  warranty_end: string | null;
  notes: string;
  end_date: string | null;
  end_reason: string;
  sale_halalas: number | null;
  created_at: string;
}

const fail = (key: string, opts?: Record<string, unknown>): never => { throw new Error(t('assets.err.' + key, opts)); };
const memo = (key: string, opts: Record<string, unknown>) => t('assets.memo.' + key, { ...opts, lng: 'ar' });
// اسم القسم في سجل العمليات · يبقى بالعربية كسائر السجل حتى ترحيلة الرموز
const AUDIT = 'الأصول'; // i18n-exempt: وحدة سجل العمليات المخزّنة

export function getAsset(db: DB, id: string): AssetRow {
  const a = db.get<AssetRow>(`SELECT * FROM assets WHERE id = ? AND deleted_at IS NULL`, [id]);
  return a ?? fail('notFound');
}

const unitProperty = (db: DB, unitId: string | null): string | null =>
  unitId ? db.get<{ p: string }>(`SELECT property_id AS p FROM units WHERE id = ?`, [unitId])?.p ?? null : null;

function addEvent(db: DB, assetId: string, kind: AssetEventKind, date: string, extra: {
  fromUnit?: string | null; toUnit?: string | null; fromRoom?: string; toRoom?: string; note?: string; entryId?: string | null;
} = {}): string {
  const id = uid();
  db.run(
    `INSERT INTO asset_events (id, asset_id, kind, date, from_unit_id, to_unit_id, from_room, to_room, note, entry_id, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [id, assetId, kind, date, extra.fromUnit ?? null, extra.toUnit ?? null, extra.fromRoom ?? '', extra.toRoom ?? '',
     extra.note ?? '', extra.entryId ?? null, new Date().toISOString()]);
  return id;
}

/** تاريخ العملية بعد آخر شهرٍ رُحِّل إهلاكه، ولا قبل الشراء */
function requireOpenDate(db: DB, a: AssetRow, date: string): void {
  const last = lastRunMonth(db);
  if (last != null && monthIndex(date) <= last) fail('periodClosed', { month: monthKey(last) });
  if (a.purchase_date && date < a.purchase_date) fail('beforePurchase');
}
const requireLive = (a: AssetRow) => { if (ENDED.includes(a.status)) fail('ended'); };
const validLife = (n: number) => { if (!Number.isInteger(n) || n < 1 || n > 600) fail('life'); };

export interface NewAssetInput {
  name: string;
  category: string;
  unitId: string;
  room?: string;
  model?: string;
  serial?: string;
  purchaseDate?: string | null;
  lifeMonths?: number;
  warrantyEnd?: string | null;
  notes?: string;
  source?: AssetSource;
}

/** أصلٌ بلا تكلفة («بانتظار تكلفة») · بلا قيد ولا إهلاك (موجز الأصول §٤) */
export function createPendingAsset(db: DB, input: NewAssetInput): string {
  if (!input.name.trim()) fail('name');
  if (!isAssetCategory(input.category)) fail('category');
  if (!input.unitId) fail('unit');
  const life = input.lifeMonths ?? defaultLife(input.category);
  validLife(life);
  const id = uid();
  db.transaction(() => {
    db.run(
      `INSERT INTO assets (id, name, category, property_id, unit_id, room, model, serial, purchase_date, cost_halalas,
         salvage_halalas, life_months, status, source, warranty_end, notes, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,NULL,0,?,'in_service',?,?,?,?)`,
      [id, input.name.trim(), input.category, unitProperty(db, input.unitId), input.unitId, (input.room ?? '').trim(),
       (input.model ?? '').trim(), (input.serial ?? '').trim(), input.purchaseDate ?? null, life, input.source ?? 'manual',
       input.warrantyEnd ?? null, (input.notes ?? '').trim(), new Date().toISOString()]);
    logAudit(db, AUDIT, 'create', 'asset', input.name.trim());
  });
  return id;
}

/** بيانات الأصل الوصفية · والعمر والمتبقية قبل أول إهلاك وحده */
export function updateAssetInfo(db: DB, id: string, p: {
  name?: string; model?: string; serial?: string; room?: string; warrantyEnd?: string | null; notes?: string;
  lifeMonths?: number; salvageHalalas?: number; category?: string; purchaseDate?: string | null;
}): void {
  const a = getAsset(db, id);
  const lifeChange = (p.lifeMonths != null && p.lifeMonths !== a.life_months)
    || (p.salvageHalalas != null && p.salvageHalalas !== Number(a.salvage_halalas))
    || (p.category != null && p.category !== a.category)
    || (p.purchaseDate !== undefined && p.purchaseDate !== a.purchase_date && a.cost_halalas != null);
  if (lifeChange && (a.cost_halalas != null)) fail('lifeLocked');
  if (p.name != null && !p.name.trim()) fail('name');
  if (p.lifeMonths != null) validLife(p.lifeMonths);
  if (p.category != null && !isAssetCategory(p.category)) fail('category');
  db.transaction(() => {
    db.run(
      `UPDATE assets SET name = ?, model = ?, serial = ?, room = ?, warranty_end = ?, notes = ?, life_months = ?, salvage_halalas = ?,
         category = ?, purchase_date = ? WHERE id = ?`,
      [(p.name ?? a.name).trim(), (p.model ?? a.model).trim(), (p.serial ?? a.serial).trim(), (p.room ?? a.room).trim(),
       p.warrantyEnd !== undefined ? p.warrantyEnd : a.warranty_end, (p.notes ?? a.notes).trim(), p.lifeMonths ?? a.life_months,
       p.salvageHalalas ?? a.salvage_halalas, p.category ?? a.category, p.purchaseDate !== undefined ? p.purchaseDate : a.purchase_date, id]);
    logAudit(db, AUDIT, 'update', 'asset', a.name);
  });
}

/**
 * إثبات تكلفة قطعةٍ بلا فاتورة (قائمة قبل التطبيق أو أحضرها المالك · موجز الأصول §٤-٣):
 * مدين حساب الفئة / دائن 3100 بتاريخ اليوم، ومعه إهلاك ما فات منذ شرائها.
 */
export function setAssetCost(db: DB, id: string, input: { costHalalas: number; purchaseDate: string; salvageHalalas?: number; lifeMonths?: number; today?: string }): void {
  const a = getAsset(db, id);
  requireLive(a);
  if (a.cost_halalas != null) fail('notPending');
  if (!(input.costHalalas > 0)) fail('cost');
  if (!input.purchaseDate) fail('purchaseDate');
  const salvage = input.salvageHalalas ?? 0;
  if (salvage < 0 || salvage >= input.costHalalas) fail('salvage');
  const life = input.lifeMonths ?? a.life_months;
  validLife(life);
  const today = input.today ?? todayFn();
  db.transaction(() => {
    db.run(`UPDATE assets SET cost_halalas = ?, salvage_halalas = ?, life_months = ?, purchase_date = ? WHERE id = ?`,
      [input.costHalalas, salvage, life, input.purchaseDate, id]);
    const b = getAsset(db, id);
    const dims = assetDims(db, b, today);
    const catchUp = catchUpLines(db, { ...b, status: b.status }, today);
    const entry = postEntry(db, {
      date: today, memo: memo('cost', { name: b.name }),
      lines: [
        { account: b.category, descr: b.name, debit: input.costHalalas, credit: 0, dims },
        { account: ACC_CAPITAL, descr: b.name, debit: 0, credit: input.costHalalas, dims },
        ...catchUp,
      ],
      srcType: 'asset_cost', srcId: id,
    });
    addEvent(db, id, 'cost', today, { entryId: entry?.id ?? null });
    logAudit(db, AUDIT, 'update', 'asset', b.name, { cost: null }, { cost: input.costHalalas });
  });
}

/** نقل الأصل إلى وحدة أخرى بتاريخ (موجز الأصول §٣ج) */
export function transferAsset(db: DB, id: string, input: { unitId: string; room?: string; date: string; today?: string }): void {
  const a = getAsset(db, id);
  requireLive(a);
  if (!input.unitId) fail('unit');
  if (input.unitId === a.unit_id && (input.room ?? '') === a.room) fail('sameUnit');
  const today = input.today ?? todayFn();
  db.transaction(() => {
    if (a.cost_halalas != null) {
      requireOpenDate(db, a, input.date);
      runDepreciation(db, input.date < today ? input.date : today); // الأشهر التامة قبل شهر العملية
      depreciateAssetTo(db, { ...a }, input.date, id);
    }
    const toProp = unitProperty(db, input.unitId);
    let entryId: string | null = null;
    if (a.cost_halalas != null && a.unit_id !== input.unitId) {
      const cost = bookValue(db, a).cost;
      const accum = postedAccum(db, a.id);
      const from = assetDims(db, a, input.date);
      const to = assetDims(db, { ...a, unit_id: input.unitId, property_id: toProp }, input.date);
      const e = postEntry(db, {
        date: input.date, memo: memo('transfer', { name: a.name }),
        lines: [
          { account: a.category, descr: a.name, debit: cost, credit: 0, dims: to },
          { account: a.category, descr: a.name, debit: 0, credit: cost, dims: from },
          { account: ACC_ACCUM, descr: a.name, debit: accum, credit: 0, dims: from },
          { account: ACC_ACCUM, descr: a.name, debit: 0, credit: accum, dims: to },
        ],
        srcType: 'asset_transfer', srcId: id,
      });
      entryId = e?.id ?? null;
    }
    db.run(`UPDATE assets SET unit_id = ?, property_id = ?, room = ? WHERE id = ?`, [input.unitId, toProp, (input.room ?? '').trim(), id]);
    addEvent(db, id, 'transfer', input.date, { fromUnit: a.unit_id, toUnit: input.unitId, fromRoom: a.room, toRoom: (input.room ?? '').trim(), entryId });
    logAudit(db, AUDIT, 'update', 'asset', a.name, { unit: a.unit_id }, { unit: input.unitId });
  });
}

/** استبعاد الأصل بسببه وتاريخه (موجز الأصول §٣د) · ويبقى في السجل «مستبعداً» */
export function disposeAsset(db: DB, id: string, input: { date: string; reason: string; today?: string }): void {
  const a = getAsset(db, id);
  requireLive(a);
  if (!input.reason.trim()) fail('reason');
  const today = input.today ?? todayFn();
  db.transaction(() => {
    let entryId: string | null = null;
    if (a.cost_halalas != null) {
      requireOpenDate(db, a, input.date);
      runDepreciation(db, input.date < today ? input.date : today);
      depreciateAssetTo(db, { ...a }, input.date, id);
      const { cost, accum, nbv } = bookValue(db, a);
      const dims = assetDims(db, a, input.date);
      const e = postEntry(db, {
        date: input.date, memo: memo('dispose', { name: a.name, reason: input.reason.trim() }),
        lines: [
          { account: ACC_ACCUM, descr: a.name, debit: accum, credit: 0, dims },
          { account: ACC_DISPOSAL_LOSS, descr: a.name, debit: nbv, credit: 0, dims },
          { account: a.category, descr: a.name, debit: 0, credit: cost, dims },
        ],
        srcType: 'asset_dispose', srcId: id,
      });
      entryId = e?.id ?? null;
    }
    db.run(`UPDATE assets SET status = 'disposed', end_date = ?, end_reason = ?, end_entry_id = ? WHERE id = ?`,
      [input.date, input.reason.trim(), entryId, id]);
    addEvent(db, id, 'dispose', input.date, { note: input.reason.trim(), entryId });
    logAudit(db, AUDIT, 'update', 'asset', a.name, { status: a.status }, { status: 'disposed', reason: input.reason.trim() });
  });
}

/** بيع الأصل بمقابل (قرار المالك: حساب 4400 ومسار البيع) */
export function sellAsset(db: DB, id: string, input: {
  date: string; amountHalalas: number; method: 'cash' | 'bank'; bankId?: string | null; today?: string;
}): void {
  const a = getAsset(db, id);
  requireLive(a);
  if (a.cost_halalas == null) fail('pending');
  if (!(input.amountHalalas >= 0) || !Number.isFinite(input.amountHalalas)) fail('saleAmount');
  if (input.method === 'bank' && !input.bankId) fail('bank');
  const today = input.today ?? todayFn();
  db.transaction(() => {
    requireOpenDate(db, a, input.date);
    runDepreciation(db, input.date < today ? input.date : today);
    depreciateAssetTo(db, { ...a }, input.date, id);
    const { cost, accum, nbv } = bookValue(db, a);
    const diff = input.amountHalalas - nbv;
    const dims = assetDims(db, a, input.date);
    const e = postEntry(db, {
      date: input.date, memo: memo('sell', { name: a.name }),
      lines: [
        { account: ACC_CASH, descr: a.name, debit: input.amountHalalas, credit: 0, dims },
        { account: ACC_ACCUM, descr: a.name, debit: accum, credit: 0, dims },
        ...(diff < 0 ? [{ account: ACC_DISPOSAL_LOSS, descr: a.name, debit: -diff, credit: 0, dims }] : []),
        { account: a.category, descr: a.name, debit: 0, credit: cost, dims },
        ...(diff > 0 ? [{ account: ACC_SALE_GAIN, descr: a.name, debit: 0, credit: diff, dims }] : []),
      ],
      srcType: 'asset_sell', srcId: id,
    });
    if (input.method === 'bank' && input.bankId && input.amountHalalas > 0) {
      db.run(
        `INSERT INTO bank_tx (id, bank_id, date, descr, amount_halalas, matched, journal_no, source, created_at) VALUES (?,?,?,?,?,1,?,?,?)`,
        [uid(), input.bankId, input.date, memo('sell', { name: a.name }), input.amountHalalas, e?.no ?? '', memo('sell', { name: a.name }), new Date().toISOString()]);
    }
    db.run(`UPDATE assets SET status = 'sold', end_date = ?, sale_halalas = ?, end_entry_id = ? WHERE id = ?`,
      [input.date, input.amountHalalas, e?.id ?? null, id]);
    addEvent(db, id, 'sell', input.date, { entryId: e?.id ?? null });
    logAudit(db, AUDIT, 'update', 'asset', a.name, { status: a.status }, { status: 'sold', amount: input.amountHalalas });
  });
}

/** في الخدمة ↔ تحت الصيانة · لا قيد (الإهلاك لا يقف بالصيانة) */
export function setAssetStatus(db: DB, id: string, status: 'in_service' | 'maintenance', date: string = todayFn()): void {
  const a = getAsset(db, id);
  requireLive(a);
  if (a.status === status) return;
  db.transaction(() => {
    db.run(`UPDATE assets SET status = ? WHERE id = ?`, [status, id]);
    addEvent(db, id, 'status', date, { note: status });
    logAudit(db, AUDIT, 'update', 'asset', a.name, { status: a.status }, { status });
  });
}

export interface AssetListRow extends AssetRow { unit_no: string | null; property_name: string | null }

export function listAssets(db: DB, f: { propertyId?: string | null; unitId?: string | null; category?: string | null; status?: string | null; q?: string } = {}): AssetListRow[] {
  const w = ['a.deleted_at IS NULL'];
  const p: string[] = [];
  if (f.propertyId) { w.push('a.property_id = ?'); p.push(f.propertyId); }
  if (f.unitId) { w.push('a.unit_id = ?'); p.push(f.unitId); }
  if (f.category) { w.push('a.category = ?'); p.push(f.category); }
  if (f.status === 'pending') w.push('a.cost_halalas IS NULL');
  else if (f.status) { w.push('a.status = ?'); p.push(f.status); }
  if (f.q?.trim()) { w.push(`(a.name LIKE ? OR a.model LIKE ? OR a.serial LIKE ?)`); const q = '%' + f.q.trim() + '%'; p.push(q, q, q); }
  return db.all<AssetListRow>(
    `SELECT a.*, u.unit_no, pr.name AS property_name FROM assets a LEFT JOIN units u ON u.id = a.unit_id LEFT JOIN properties pr ON pr.id = a.property_id
     WHERE ${w.join(' AND ')} ORDER BY pr.name, u.unit_no, a.room, a.name`, p);
}

/** تاريخ الأصل: أحداثه وقيوده (الإهلاك وغيره) بأحدثها أولاً */
export function assetHistory(db: DB, id: string): Array<{ date: string; kind: string; note: string; entryNo: string | null; amount: number }> {
  const events = db.all<{ date: string; kind: string; note: string; no: string | null }>(
    `SELECT ev.date, ev.kind, ev.note, e.no FROM asset_events ev LEFT JOIN journal_entries e ON e.id = ev.entry_id WHERE ev.asset_id = ? ORDER BY ev.date DESC, ev.created_at DESC`, [id]);
  const dep = db.all<{ date: string; no: string; amt: number }>(
    `SELECT e.date, e.no, SUM(l.credit_halalas - l.debit_halalas) AS amt FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
     WHERE l.asset_id = ? AND l.account_code = ? AND e.src_type IN ('depreciation', 'asset_dep') AND e.deleted_at IS NULL
     GROUP BY e.id ORDER BY e.date DESC`, [id, ACC_ACCUM]);
  return [
    ...events.map((e) => ({ date: e.date, kind: e.kind, note: e.note, entryNo: e.no, amount: 0 })),
    ...dep.map((d) => ({ date: d.date, kind: 'depreciation', note: '', entryNo: d.no, amount: Number(d.amt) })),
  ].sort((x, y) => (x.date < y.date ? 1 : x.date > y.date ? -1 : 0));
}

/** أصولٌ ينتهي ضمانها خلال أيام · للتنبيه */
export function warrantyEnding(db: DB, today: string, days: number): Array<{ id: string; name: string; warranty_end: string; unit_no: string | null }> {
  const until = addDays(today, days);
  return db.all(
    `SELECT a.id, a.name, a.warranty_end, u.unit_no FROM assets a LEFT JOIN units u ON u.id = a.unit_id
     WHERE a.deleted_at IS NULL AND a.status NOT IN ('disposed', 'sold') AND a.warranty_end IS NOT NULL AND a.warranty_end >= ? AND a.warranty_end <= ?
     ORDER BY a.warranty_end`, [today, until]);
}
