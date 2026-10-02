/**
 * التقبيل (تنازل عن الموقع بمقابل مالي) · العمولة تُرحَّل مرة واحدة إلى 4300
 * (docs/DESIGN.md §٩ قرار 3)، وتُسجَّل حركة بنكية عند الاستلام بنكياً.
 */
import type { DB } from '../db/adapter';
import { uid } from './ids';
import { today } from './dates';
import { postKeyMoneyCommission } from './accounting/post';
import { keyMoneyBlockReason, getContract } from './contracts/rules';
import { logAudit } from './audit';

export interface KeyMoneyInput {
  unitId: string;
  contractId?: string | null;
  outgoing: string;
  incoming: string;
  amountHalalas: number;
  date: string;
  commissionHalalas: number;
  method: 'bank' | 'cash' | null;
  bankId?: string | null;
  notes: string;
}

export function recordKeyMoneyDeal(db: DB, input: KeyMoneyInput): string {
  if (!input.outgoing.trim() || !input.incoming.trim() || !input.amountHalalas)
    throw new Error('أدخل اسم الطرفين والمبلغ الإجمالي');
  if (input.contractId) {
    const c = getContract(db, input.contractId);
    const block = keyMoneyBlockReason(c ?? null);
    if (block) throw new Error(block);
  }
  if (input.commissionHalalas > 0 && input.method === 'bank' && !input.bankId)
    throw new Error('اختر حساباً بنكياً أو بدِّل لنقداً');
  return db.transaction(() => {
    const id = uid();
    const date = input.date || today();
    const u = db.get<{ unit_no: string }>(`SELECT unit_no FROM units WHERE id = ?`, [input.unitId]);
    let journalId: string | null = null;
    if (input.commissionHalalas > 0) {
      const entry = postKeyMoneyCommission(db, {
        id, unitLabel: u?.unit_no ?? '', outgoing: input.outgoing, incoming: input.incoming,
        commission: input.commissionHalalas, date,
      });
      journalId = entry ? entry.id : null;
      if (input.method === 'bank' && input.bankId && entry) {
        db.run(
          `INSERT INTO bank_tx (id, bank_id, date, descr, amount_halalas, matched, journal_no, source, created_at)
           VALUES (?,?,?,?,?,1,?,'تقبيل',?)`,
          [uid(), input.bankId, date,
           'عمولة تقبيل · ' + input.outgoing + ' ← ' + input.incoming,
           input.commissionHalalas, entry.no, new Date().toISOString()]
        );
      }
    }
    db.run(
      `INSERT INTO key_money_deals (id, unit_id, contract_id, outgoing, incoming, amount_halalas,
        date, commission_halalas, method, notes, journal_entry_id, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, input.unitId, input.contractId ?? null, input.outgoing.trim(), input.incoming.trim(),
       input.amountHalalas, date, input.commissionHalalas, input.method, input.notes.trim(),
       journalId, new Date().toISOString()]
    );
    logAudit(db, 'العقارات', 'create', 'تقبيل', input.outgoing + ' ← ' + input.incoming);
    return id;
  });
}
