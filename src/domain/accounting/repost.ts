/**
 * إعادة ترحيل قيدٍ عُكس عند الحذف إلى السلة (المراجعة ٤.٦) · نسخةٌ من سطوره نفسها بتاريخه ومصدره،
 * ومعها حركات البنك التي كانت عليه · فلا تُعاد الحسبة من مدخلات المستند فتضيع القابلية للخصم أو فرق التقريب.
 * ما يمنع النسخة (حساب أو بنك محذوف) يُعرف قبل أي كتابة فتُرفض الاستعادة بسببه.
 */
import type { DB } from '../../db/adapter';
import { cashShortfall, entryCashEffect } from '../cashGuard';
import { fmt } from '../money';
import { uid } from '../ids';
import { postEntry, type PostedEntry } from './post';
import { hasDimColumns } from './dimensions';
import { correctionDate } from '../vatFilings';

interface Orig { id: string; no: string; date: string; memo: string; auto: number; src_type: string | null; src_id: string | null }

const orig = (db: DB, entryId: string) =>
  db.get<Orig>(`SELECT id, no, date, memo, auto, src_type, src_id FROM journal_entries WHERE id = ?`, [entryId]);

/** ما يمنع إعادة ترحيل القيد · فارغة إن أمكن */
export function repostBlockers(db: DB, entryId: string): string[] {
  const e = orig(db, entryId);
  if (!e) return ['القيد الأصلي غير موجود'];
  const out: string[] = [];
  for (const a of db.all<{ code: string; name: string | null; deleted_at: string | null }>(
    `SELECT DISTINCT l.account_code AS code, a.name, a.deleted_at FROM journal_lines l
     LEFT JOIN accounts a ON a.code = l.account_code WHERE l.entry_id = ?`, [entryId])) {
    if (!a.name || a.deleted_at) out.push('الحساب ' + a.code + (a.name ? ' «' + a.name + '»' : '') + ' محذوف · استرجعه أولاً');
  }
  for (const b of db.all<{ name: string | null; deleted_at: string | null }>(
    `SELECT DISTINCT b.name, b.deleted_at FROM bank_tx t LEFT JOIN banks b ON b.id = t.bank_id
     WHERE t.journal_no = ? AND t.deleted_at IS NULL`, [e.no])) {
    if (!b.name || b.deleted_at) out.push('البنك' + (b.name ? ' «' + b.name + '»' : '') + ' الذي كانت عليه الحركة محذوف · استرجعه أولاً');
  }
  // نسخة قيدٍ أخرج نقداً تخرجه ثانية · كفاية النقد (قرار المالك ٢٠٢٦-١٠-٠٥)
  const out0 = Math.max(0, -entryCashEffect(db, entryId));
  const short = cashShortfall(db, out0);
  if (short > 0) out.push('النقد في المحفظة لا يكفي لإعادة صرفٍ بمبلغ ' + fmt(out0) + ' · ينقصه ' + fmt(short) + '، سجّله «إيداع المالك» أولاً');
  return out;
}

/** يعيد ترحيل نسخة القيد وحركات بنكه · ويعيد القيد الجديد */
export function repostCopy(db: DB, entryId: string, note: string): PostedEntry | null {
  const e = orig(db, entryId);
  if (!e) return null;
  // أبعاد كل سطر تُنسخ معه (مركز التكلفة والأصل لا يُشتقان من المصدر) · وقاعدةٌ قبل الهجرة ٢٨ بلا أبعاد
  const dimSql = hasDimColumns(db) ? ', property_id, unit_id, contract_id, cost_center_id, asset_id' : '';
  const lines = db.all<{ account_code: string; descr: string; debit_halalas: number; credit_halalas: number;
    property_id?: string | null; unit_id?: string | null; contract_id?: string | null; cost_center_id?: string | null; asset_id?: string | null }>(
    `SELECT account_code, descr, debit_halalas, credit_halalas${dimSql} FROM journal_lines WHERE entry_id = ?`, [entryId]);
  // بتاريخ الأصل، إلا إن قُدِّم إقرار فترته فاليوم (قرار المالك على #29) · كعكسه عند الحذف فلا تتضاعف فترة وتنقص أخرى
  const date = correctionDate(db, e.date);
  const posted = postEntry(db, {
    date,
    memo: e.memo + ' · ' + note,
    lines: lines.map((l) => ({
      account: l.account_code, descr: l.descr, debit: Number(l.debit_halalas), credit: Number(l.credit_halalas),
      dims: dimSql ? { propertyId: l.property_id, unitId: l.unit_id, contractId: l.contract_id, costCenterId: l.cost_center_id, assetId: l.asset_id } : undefined,
    })),
    auto: Number(e.auto) === 1,
    srcType: e.src_type ?? undefined,
    srcId: e.src_id ?? undefined,
  });
  if (!posted) return null;
  for (const t of db.all<{ bank_id: string; date: string; descr: string; amount_halalas: number; source: string }>(
    `SELECT bank_id, date, descr, amount_halalas, source FROM bank_tx WHERE journal_no = ? AND deleted_at IS NULL`, [e.no])) {
    db.run(
      `INSERT INTO bank_tx (id, bank_id, date, descr, amount_halalas, matched, journal_no, source, created_at)
       VALUES (?,?,?,?,?,1,?,?,?)`,
      [uid(), t.bank_id, date === e.date ? t.date : date, t.descr, Number(t.amount_halalas), posted.no, t.source, new Date().toISOString()]);
  }
  return posted;
}

/** أحدث قيد معكوس لمصدر · ما عكسه الحذف إلى السلة */
export function lastReversedOf(db: DB, srcType: string, srcId: string): string | null {
  return db.get<{ id: string }>(
    `SELECT id FROM journal_entries WHERE src_type = ? AND src_id = ? AND status = 'مرحّل'
       AND deleted_at IS NULL AND reversed_by IS NOT NULL ORDER BY created_at DESC LIMIT 1`, [srcType, srcId])?.id ?? null;
}
