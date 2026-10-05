/**
 * مقارنة أقساط العقود القائمة بجدول ملف إيجار المرفق بها (قرار المالك ٢٠٢٦-١٠-٠٥) · معاينة تعرض الفروق،
 * ولا تُطبَّق على البيانات إلا بضغطة المالك. القراءة من الملف تُمرَّر دالةً (الجهاز يقرأ ملفاته) فتُختبر بنصوص مصطنعة.
 * المبالغ والمسدَّد لا تُمسّ · تُصحَّح تواريخ الاستحقاق وحدها، والعقد يُوسم «ملف».
 */
import type { DB } from '../db/adapter';
import { parseEjarSchedule } from './pdf/parseEjar';
import { recomputeInstallments } from './contracts/paid';
import { logAudit } from './audit';
import { dfmt } from './dates';

export interface EjarScheduleDiff {
  contractId: string;
  label: string;
  changes: Array<{ id: string; from: string; to: string }>;
  /** سبب عدم التطبيق إن وُجد */
  blocked?: string;
}

/** العقود الموثَّقة التي أُرفق بها ملف عقدها */
export function contractsWithLease(db: DB): Array<{ id: string; label: string }> {
  return db.all<{ id: string; label: string }>(
    `SELECT c.id, c.tenant_name || ' · عقد ' || COALESCE(c.contract_no, 'لا يوجد') AS label FROM contracts c
     WHERE c.deleted_at IS NULL AND c.status != 'مسودة'
       AND EXISTS (SELECT 1 FROM attachments a WHERE a.entity_type = 'contract' AND a.entity_id = c.id
                   AND a.kind = 'lease' AND a.deleted_at IS NULL)
     ORDER BY c.start`);
}

export async function previewEjarSchedules(
  db: DB, readLeaseText: (contractId: string) => Promise<string | null>,
): Promise<EjarScheduleDiff[]> {
  const out: EjarScheduleDiff[] = [];
  for (const c of contractsWithLease(db)) {
    let text: string | null = null;
    try { text = await readLeaseText(c.id); } catch { text = null; }
    if (!text) { out.push({ contractId: c.id, label: c.label, changes: [], blocked: 'تعذّر فتح ملف العقد' }); continue; }
    const sch = parseEjarSchedule(text);
    if (!sch) { out.push({ contractId: c.id, label: c.label, changes: [], blocked: 'تعذّرت قراءة جدول الدفعات من الملف' }); continue; }
    const insts = db.all<{ id: string; due_date: string }>(
      `SELECT id, due_date FROM contract_installments WHERE contract_id = ? ORDER BY sort, due_date`, [c.id]);
    if (insts.length !== sch.length) {
      out.push({ contractId: c.id, label: c.label, changes: [], blocked: 'أقساطه ' + insts.length + ' والجدول في الملف ' + sch.length + ' · يحتاج قراراً منك' });
      continue;
    }
    const changes = insts.map((x, i) => ({ id: x.id, from: x.due_date, to: sch[i].dueDate })).filter((x) => x.from !== x.to);
    if (changes.length) out.push({ contractId: c.id, label: c.label, changes });
  }
  return out;
}

/** يطبّق الفروق غير الموقوفة · ويعيد عدد العقود */
export function applyEjarSchedules(db: DB, diffs: EjarScheduleDiff[]): number {
  return db.transaction(() => {
    let n = 0;
    for (const d of diffs) {
      if (d.blocked || !d.changes.length) continue;
      for (const ch of d.changes) db.run(`UPDATE contract_installments SET due_date = ? WHERE id = ?`, [ch.to, ch.id]);
      recomputeInstallments(db, d.changes.map((c) => c.id));
      db.run(`UPDATE contracts SET installments_source = 'ملف' WHERE id = ?`, [d.contractId]);
      logAudit(db, 'العقود', 'update', 'تواريخ الأقساط من ملف إيجار', d.label,
        { due_dates: d.changes.map((c) => dfmt(c.from)) }, { due_dates: d.changes.map((c) => dfmt(c.to)) });
      n++;
    }
    return n;
  });
}
