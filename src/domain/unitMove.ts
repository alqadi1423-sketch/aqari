/**
 * نقل وحدة إلى عقار آخر (المراجعة ٤.١٢) · كل صفٍّ يُرفع موسوماً بعقاره المشتق من سلسلة
 * «الدفعة ← العقد ← الوحدة ← العقار» (sync/acl.ts)، فتغيير عقار الوحدة يعيد رفع كل ما تحتها بوسمه الجديد،
 * وما يحمل العقار نصاً بجانب الوحدة (المشتريات والفواتير) يُحدَّث. فيراها عضو العقار الجديد كاملة،
 * ويُسجَّل النقل (الوحدة ومن أي عقار إلى أي عقار) فيُنشر في المنشأة: العضو الذي لم يعد له حقٌّ فيها يُفرَّغ جهازه
 * ويُعاد سحبه بصلاحيته عند أول اتصال (ملاحظة المالك ٢٠٢٦-١٠-٠٥).
 */
import type { DB } from '../db/adapter';

/** الطابور يلتقط الكتابات بعد تفعيل المزامنة وحده · وقبله يُبذر كل شيء عند التفعيل */
function capturing(db: DB): boolean {
  return Number(db.get<{ v: number }>(`SELECT v FROM sync_ctl WHERE k = 'capture'`)?.v ?? 0) === 1;
}

const ids = (db: DB, sql: string, p: unknown[]): string[] => db.all<{ id: string }>(sql, p as never).map((r) => r.id);
const marks = (n: number) => Array(n).fill('?').join(',');

/** نقل وحدة بانتظار النشر في المنشأة · يقرؤه services/org.publishUnitMoves */
export interface UnitMove { unit: string; from: string; to: string; at: string }
export const PENDING_MOVES_KEY = 'unit_moves_pending';

export function pendingUnitMoves(db: DB): UnitMove[] {
  try { return JSON.parse(db.get<{ v: string | null }>(`SELECT v FROM sync_state WHERE k = ?`, [PENDING_MOVES_KEY])?.v || '[]') as UnitMove[]; }
  catch { return []; }
}

export function retagUnitTree(db: DB, unitId: string, oldPropertyId: string, newPropertyId: string): void {
  db.run(`UPDATE purchases SET property_id = ? WHERE unit_id = ?`, [newPropertyId, unitId]);
  db.run(`UPDATE invoices SET property_id = ? WHERE unit_id = ?`, [newPropertyId, unitId]);
  if (!capturing(db)) return;
  const moves = [...pendingUnitMoves(db), { unit: unitId, from: oldPropertyId, to: newPropertyId, at: new Date().toISOString() }];
  db.run(`INSERT INTO sync_state (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`, [PENDING_MOVES_KEY, JSON.stringify(moves)]);

  const at = new Date().toISOString();
  const queue = (table: string, keys: string[]) => {
    for (const k of keys) {
      db.run(`INSERT INTO sync_outbox (tbl, pk, op, changed_at) VALUES (?,?, 'upsert', ?)
              ON CONFLICT(tbl, pk) DO UPDATE SET changed_at = excluded.changed_at`, [table, k, at]);
    }
  };
  const inList = (table: string, col: string, keys: string[], pk = 'id') =>
    keys.length ? ids(db, `SELECT ${pk} AS id FROM "${table}" WHERE ${col} IN (${marks(keys.length)})`, keys) : [];

  const contracts = ids(db, `SELECT id FROM contracts WHERE unit_id = ?`, [unitId]);
  const rooms = ids(db, `SELECT id FROM unit_rooms WHERE unit_id = ?`, [unitId]);
  const meters = ids(db, `SELECT id FROM meters WHERE owner_type = 'unit' AND owner_id = ?`, [unitId]);
  const installments = inList('contract_installments', 'contract_id', contracts);
  const payments = inList('contract_payments', 'contract_id', contracts);
  const claims = inList('claims', 'contract_id', contracts);
  const reservations = ids(db, `SELECT id FROM reservations WHERE unit_id = ?`, [unitId]);
  const keyMoney = ids(db, `SELECT id FROM key_money_deals WHERE unit_id = ? OR contract_id IN (SELECT id FROM contracts WHERE unit_id = ?)`, [unitId, unitId]);
  const purchases = ids(db, `SELECT id FROM purchases WHERE unit_id = ?`, [unitId]);
  const invoices = ids(db, `SELECT id FROM invoices WHERE unit_id = ?`, [unitId]);

  queue('units', [unitId]);
  queue('unit_rooms', rooms);
  queue('unit_room_items', inList('unit_room_items', 'room_id', rooms));
  queue('meters', meters);
  queue('meter_readings', inList('meter_readings', 'meter_id', meters));
  queue('contracts', contracts);
  queue('contract_installments', installments);
  queue('contract_payments', payments);
  queue('payment_lines', inList('payment_lines', 'payment_id', payments));
  queue('payment_allocations', inList('payment_allocations', 'payment_id', payments));
  queue('contract_occupants', inList('contract_occupants', 'contract_id', contracts));
  queue('deposit_settlements', inList('deposit_settlements', 'contract_id', contracts, 'contract_id'));
  queue('tenant_ratings', inList('tenant_ratings', 'contract_id', contracts, 'contract_id'));
  queue('claims', claims);
  queue('reservations', reservations);
  queue('key_money_deals', keyMoney);
  queue('purchases', purchases);
  queue('invoices', invoices);
  queue('handovers', ids(db, `SELECT id FROM handovers WHERE unit_id = ? OR contract_id IN (SELECT id FROM contracts WHERE unit_id = ?)`, [unitId, unitId]));
  queue('occupants', ids(db, `SELECT id FROM occupants WHERE unit_id = ? OR contract_id IN (SELECT id FROM contracts WHERE unit_id = ?)`, [unitId, unitId]));
  // المستأجر يُرى في عقارات عقوده
  queue('tenants', ids(db, `SELECT DISTINCT tenant_id AS id FROM contracts WHERE unit_id = ? AND tenant_id IS NOT NULL`, [unitId]));
  // القيود تُوسم بمصدرها
  const sources = [...payments, ...contracts, ...claims, ...reservations, ...keyMoney, ...purchases, ...invoices, ...installments];
  queue('journal_entries', inList('journal_entries', 'src_id', sources));
}
