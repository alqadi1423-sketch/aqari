/**
 * التقبيل (تنازل عن الموقع بمقابل مالي) · العمولة تُرحَّل مرة واحدة إلى 4300
 * (docs/DESIGN.md §٩ قرار 3)، وتُسجَّل حركة بنكية عند الاستلام بنكياً بالمقبوض كاملاً.
 * والمنشأة المسجّلة في الضريبة تفصل من المقبوض ضريبته إلى 2200 (المراجعة الشاملة ٨ · البند ١١ · postKeyMoneyCommission)،
 * فالعمولة بتاريخٍ في فترةٍ قُدِّم إقرارها مرفوضة كالدفعة والعملية النقدية (قرار المالك 2026-10-15 «٦»).
 * والرفض للمنشأة غير المسجّلة أيضاً، قرارٌ صريح (التحقق المستقل على البند ١١): «كما كانت» في الخيار (أ) لقيدها (العمولة كلها
 * في 4300) لا لقاعدة الفترة · فالعمولة قبضٌ نقدي، والقرار «٦» عامٌّ للعملية النقدية ولو لم تمسّ الإقرار (كالإيداع في البنك) ·
 * والتسجيل يُقرأ يوم الصفقة، والفترة المقدَّمة قد تكون من زمنٍ كانت فيه مسجّلة، فربط الرفض بالتسجيل الحالي يفتح فترتها.
 * والإلغاء لا يسبق تاريخ الصفقة، ولا تُستعاد إلى فترةٍ قُدِّم إقرارها (sourceCancel.ts · trash.ts).
 */
import type { DB } from '../db/adapter';
import { uid } from './ids';
import { today } from './dates';
import { postKeyMoneyCommission } from './accounting/post';
import { keyMoneyBlockReason, getContract } from './contracts/rules';
import { logAudit } from './audit';
import { requireOpenPeriod } from './vatFilings';

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
  const date = input.date || today();
  if (input.commissionHalalas > 0) requireOpenPeriod(db, date); // المراجعة الشاملة · البند ٩: لا ترحيل ولا نقد في ربعٍ قُدِّم إقراره
  return db.transaction(() => {
    const id = uid();
    const u = db.get<{ unit_no: string }>(`SELECT unit_no FROM units WHERE id = ?`, [input.unitId]);
    // صفّ الصفقة أولاً ثم قيد عمولتها (قرار المالك 2026-11-07 «قيد عمولة التقبيل يُرحّل بعد صف الصفقة»): يشتق postEntry أبعاد
    // سطوره من مستنده (dimsFromSource: عقد الصفقة ووحدته وعقاره، أو وحدتها وعقارها)، ولم يكن يجده حين يُرحَّل قبله فتُكتب بلا أبعاد ·
    // ثم يُربط القيد بصفّه في المعاملة نفسها، فيُرفع الصف بحاله الأخير
    db.run(
      `INSERT INTO key_money_deals (id, unit_id, contract_id, outgoing, incoming, amount_halalas,
        date, commission_halalas, method, notes, journal_entry_id, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,NULL,?)`,
      [id, input.unitId, input.contractId ?? null, input.outgoing.trim(), input.incoming.trim(),
       input.amountHalalas, date, input.commissionHalalas, input.method, input.notes.trim(),
       new Date().toISOString()]
    );
    if (input.commissionHalalas > 0) {
      const entry = postKeyMoneyCommission(db, {
        id, unitLabel: u?.unit_no ?? '', outgoing: input.outgoing, incoming: input.incoming,
        commission: input.commissionHalalas, date,
      });
      if (entry) db.run(`UPDATE key_money_deals SET journal_entry_id = ? WHERE id = ?`, [entry.id, id]);
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
    logAudit(db, 'العقارات', 'create', 'تقبيل', input.outgoing + ' ← ' + input.incoming);
    return id;
  });
}
