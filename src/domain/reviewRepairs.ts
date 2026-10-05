/**
 * أدوات البيانات السابقة لإصلاحات المراجعة (aqari-review.md) · كل أداة معاينةٌ لا تغيّر شيئاً، ثم تطبيقٌ
 * بضغطة المالك وحده (توجيهه ٢٠٢٦-١٠-٠٥: «ما يمسّ بياناته القائمة أداة معاينة لا تُطبَّق إلا بكلمته»).
 * التطبيق قيودٌ عاكسة وتعديلات مسجّلة في سجل العمليات · لا محو.
 */
import type { DB } from '../db/adapter';
import { addMonthsClamped, toLocalISODate, dfmt } from './dates';
import { fmt } from './money';
import { logAudit } from './audit';
import { reverseEntryById } from './accounting/post';
import { CYCLE_MONTHS } from './contracts/installments';
import { recomputeInstallments } from './contracts/paid';
import { allocateDeposit, depositRoom } from './contracts/service';

export interface RepairItem { id: string; label: string; detail: string; blocked?: string }
export interface RepairPreview { key: RepairKey; title: string; explain: string; items: RepairItem[] }
export type RepairKey = 'reservation_convert' | 'installment_drift';

/* ─── ٤.٤ تحويل عربون بالقيد السابق (مدين 2450 / دائن 1200) ─── */

interface LegacyConvert { rid: string; name: string; entryId: string; amount: number; contractId: string; contractNo: string; tenant: string; start: string }

function legacyConverts(db: DB): LegacyConvert[] {
  return db.all<LegacyConvert>(
    `SELECT r.id AS rid, r.name, e.id AS entryId,
            (SELECT SUM(l.credit_halalas - l.debit_halalas) FROM journal_lines l WHERE l.entry_id = e.id AND l.account_code = '1200') AS amount,
            c.id AS contractId, COALESCE(c.contract_no, '') AS contractNo, c.tenant_name AS tenant, c.start
     FROM reservations r
     JOIN journal_entries e ON e.src_type = 'reservation_convert' AND e.src_id = r.id
       AND e.status = 'مرحّل' AND e.deleted_at IS NULL AND e.reversed_by IS NULL
     JOIN contracts c ON c.id = r.converted_contract_id
     WHERE r.status = 'محوَّل لعقد' AND r.deleted_at IS NULL
       AND EXISTS (SELECT 1 FROM journal_lines l WHERE l.entry_id = e.id AND l.account_code = '1200')
     ORDER BY c.start`
  ).map((x) => ({ ...x, amount: Number(x.amount) }));
}

/* ─── ٤.١ أقساط ولّدتها الخوارزمية السابقة (كل قسط من سابقه بلا تثبيت آخر الشهر) ─── */

/** تواريخ الخوارزمية السابقة حرفياً · لتمييز الجدول الذي ولّدته ولم يُعدَّل بعدها */
function previousAlgorithm(start: string, count: number, step: number): string[] {
  const out: string[] = [];
  let cursor = new Date(start + 'T00:00:00');
  for (let i = 0; i < count; i++) {
    out.push(toLocalISODate(cursor));
    cursor = new Date(cursor.getFullYear(), cursor.getMonth() + step, cursor.getDate());
  }
  return out;
}

interface Drift { contractId: string; contractNo: string; tenant: string; changes: Array<{ id: string; from: string; to: string }> }

function drifted(db: DB): Drift[] {
  const out: Drift[] = [];
  // الانزلاق لا يقع إلا ليوم بداية بعد ٢٨
  const cs = db.all<{ id: string; contract_no: string | null; tenant_name: string; start: string; cycle: string }>(
    `SELECT id, contract_no, tenant_name, start, cycle FROM contracts
     WHERE deleted_at IS NULL AND start IS NOT NULL AND CAST(substr(start, 9, 2) AS INTEGER) > 28`);
  for (const c of cs) {
    const insts = db.all<{ id: string; due_date: string }>(
      `SELECT id, due_date FROM contract_installments WHERE contract_id = ? ORDER BY sort`, [c.id]);
    if (!insts.length) continue;
    const step = CYCLE_MONTHS[c.cycle] || 12;
    const prev = previousAlgorithm(c.start, insts.length, step);
    if (insts.some((x, i) => x.due_date !== prev[i])) continue; // عُدّل بعد التوليد · لا يُمسّ
    const changes = insts
      .map((x, i) => ({ id: x.id, from: x.due_date, to: addMonthsClamped(c.start, i * step) }))
      .filter((x) => x.from !== x.to);
    if (changes.length) out.push({ contractId: c.id, contractNo: c.contract_no || 'لا يوجد', tenant: c.tenant_name, changes });
  }
  return out;
}

export function previewRepairs(db: DB): RepairPreview[] {
  return [
    {
      key: 'reservation_convert',
      title: 'عرابين حُوّلت لعقود بالقيد السابق',
      explain: 'قُيّد العربون دائناً لذمم العملاء والإيجار لا يمر عليها، فبقي رصيدها سالباً والقسط لم ينقص. '
        + 'التطبيق يعكس ذلك القيد ويسدّد بالعربون المتبقي على أقساط العقد بالترتيب بتاريخ بدايته.',
      items: legacyConverts(db).map((x) => {
        const room = depositRoom(db, x.contractId);
        return {
          id: x.rid,
          label: x.name + ' · عقد ' + (x.contractNo || 'لا يوجد'),
          detail: 'عربون ' + fmt(x.amount) + ' · بتاريخ ' + dfmt(x.start),
          blocked: room < x.amount ? 'المتبقي على أقساط العقد (' + fmt(room) + ') أقل من العربون · يحتاج قراراً منك' : undefined,
        };
      }),
    },
    {
      key: 'installment_drift',
      title: 'أقساط انزلقت عن آخر الشهر',
      explain: 'عقود تبدأ بعد يوم ٢٨ ولّدت النسخة السابقة أقساطها كلاً من سابقه، فانزلقت أيامها وقد يسقط شهر. '
        + 'التطبيق يعيد تواريخها من تاريخ البداية بتثبيت آخر الشهر، ولا يمسّ جدولاً عُدّل يدوياً، ولا يغيّر مبلغاً.',
      items: drifted(db).map((d) => ({
        id: d.contractId,
        label: d.tenant + ' · عقد ' + d.contractNo,
        detail: d.changes.length + ' قسط · مثل ' + dfmt(d.changes[0].from) + ' ← ' + dfmt(d.changes[0].to),
      })),
    },
  ];
}

/** يطبّق أداةً على عناصرها غير الموقوفة · ويعيد عدد ما طُبّق */
export function applyRepair(db: DB, key: RepairKey): number {
  return db.transaction(() => {
    let n = 0;
    if (key === 'reservation_convert') {
      for (const x of legacyConverts(db)) {
        if (depositRoom(db, x.contractId) < x.amount) continue;
        reverseEntryById(db, x.entryId, 'تصحيح تحويل العربون (المراجعة ٤.٤) · ' + x.name);
        allocateDeposit(db, { rsvId: x.rid, amount: x.amount, contractId: x.contractId, contractNo: x.contractNo, tenant: x.tenant, date: x.start });
        db.run(`UPDATE reservations SET deposit_outcome = 'محوَّل', deposit_settled_date = ? WHERE id = ?`, [x.start, x.rid]);
        logAudit(db, 'العقود', 'update', 'تصحيح تحويل عربون', x.name, { entry: x.entryId }, { amount: x.amount, date: x.start });
        n++;
      }
    } else if (key === 'installment_drift') {
      for (const d of drifted(db)) {
        for (const ch of d.changes) db.run(`UPDATE contract_installments SET due_date = ? WHERE id = ?`, [ch.to, ch.id]);
        recomputeInstallments(db, d.changes.map((c) => c.id));
        logAudit(db, 'العقود', 'update', 'تصحيح تواريخ الأقساط', d.tenant + ' · عقد ' + d.contractNo,
          { due_dates: d.changes.map((c) => c.from) }, { due_dates: d.changes.map((c) => c.to) });
        n++;
      }
    }
    return n;
  });
}
