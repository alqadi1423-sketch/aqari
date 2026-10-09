/**
 * قوالب الرسائل · الرموز الخمسة عشر وسياقها وحلّها، منقولة من النموذج.
 */
import type { DB } from '../db/adapter';
import { today, dfmt } from './dates';
import { fmt } from './money';
import { INSTALLMENT_DISCOUNT_SQL, installmentState } from './contracts/installments';
import { contractTotalSql } from './accounting/rentSplit';
import { t } from '../i18n';

export const TEMPLATE_TOKENS: Array<{ k: string; d: string }> = [
  { k: '{المستأجر}', d: 'اسم المستأجر' },
  { k: '{الجوال}', d: 'جوال المستأجر' },
  { k: '{العقار}', d: 'اسم العقار' },
  { k: '{الوحدة}', d: 'رقم الوحدة' },
  { k: '{رقم_العقد}', d: 'رقم العقد' },
  { k: '{بداية_العقد}', d: 'تاريخ بداية العقد' },
  { k: '{نهاية_العقد}', d: 'تاريخ نهاية العقد' },
  { k: '{قيمة_العقد}', d: 'القيمة السنوية للعقد' },
  { k: '{التأمين}', d: 'مبلغ التأمين' },
  { k: '{المبلغ}', d: 'مبلغ الدفعة المستحقة' },
  { k: '{المتبقي}', d: 'المتبقي غير المسدَّد' },
  { k: '{التاريخ}', d: 'تاريخ استحقاق الدفعة' },
  { k: '{أيام_التأخير}', d: 'عدد أيام التأخير' },
  { k: '{المنشأة}', d: 'اسم المنشأة' },
  { k: '{اليوم}', d: 'تاريخ اليوم' },
  // إجمالي العقد وتفصيله (المراجعة #6) · الرمز مخزَّن في القوالب، ووصفه من ملفات الترجمة
  { k: '{إجمالي_العقد}', get d() { return t('templates.tok.total'); } }, // i18n-exempt: رمز قالب مخزَّن
  { k: '{الخدمات}', get d() { return t('templates.tok.services'); } }, // i18n-exempt: رمز قالب مخزَّن
  { k: '{المواقف}', get d() { return t('templates.tok.parking'); } }, // i18n-exempt: رمز قالب مخزَّن
];

export const SCRIPT_CATEGORIES = ['تذكير بالسداد', 'تأخر السداد', 'تجديد العقد', 'إخلاء', 'صيانة', 'عام'];
export const SCRIPT_AUDIENCES = ['مستأجرون', 'عملاء', 'موظفون'];

export function templateContext(db: DB, contractId: string | null, name?: string): Record<string, string> {
  const company = db.get<{ name: string }>(`SELECT name FROM company WHERE id = 1`);
  const ctx: Record<string, string> = {
    '{المنشأة}': company?.name || 'إدارة العقارات',
    '{اليوم}': dfmt(today()),
    '{المستأجر}': name || '',
  };
  if (!contractId) return ctx;
  const c = db.get<{
    id: string; contract_no: string | null; tenant_name: string; phone: string;
    unit_id: string; unit_label: string; start: string | null; end: string | null;
    value_halalas: number; deposit_halalas: number; total_halalas: number; services_halalas: number; parking_halalas: number;
  }>(`SELECT id, contract_no, tenant_name, phone, unit_id, unit_label, start, end, value_halalas, deposit_halalas,
      ${contractTotalSql(db)} AS total_halalas,
      ${contractTotalSql(db) === 'value_halalas' ? '0' : 'services_halalas'} AS services_halalas,
      ${contractTotalSql(db) === 'value_halalas' ? '0' : 'parking_halalas'} AS parking_halalas
      FROM contracts WHERE id = ?`, [contractId]);
  if (!c) return ctx;
  const u = db.get<{ unit_no: string; property_id: string }>(
    `SELECT unit_no, property_id FROM units WHERE id = ?`, [c.unit_id]
  );
  const p = u ? db.get<{ name: string }>(`SELECT name FROM properties WHERE id = ?`, [u.property_id]) : undefined;
  // القسط التالي هو أول قسط بقي عليه شيء بعد المسدَّد والخصم · لا ما حالته المخزَّنة تقول
  const due = db.get<{ due_date: string; agreed_date: string | null; grace_until: string | null; amount_halalas: number; paid_halalas: number; discount: number; status: string }>(
    `SELECT i.due_date, i.agreed_date, i.grace_until, i.amount_halalas, i.paid_halalas, ${INSTALLMENT_DISCOUNT_SQL} AS discount, i.status
     FROM contract_installments i
     WHERE i.contract_id = ? AND i.status != 'ملغية'
       AND i.amount_halalas - i.paid_halalas - ${INSTALLMENT_DISCOUNT_SQL} > 0
     ORDER BY COALESCE(i.agreed_date, i.due_date) LIMIT 1`,
    [contractId]
  );
  const remain = db.get<{ s: number }>(
    `SELECT COALESCE(SUM(MAX(0, i.amount_halalas - i.paid_halalas - ${INSTALLMENT_DISCOUNT_SQL})),0) AS s
     FROM contract_installments i WHERE i.contract_id = ? AND i.status != 'ملغية'`,
    [contractId]
  );
  const T = today();
  // المبلغ والموعد والتأخير من الدالة الواحدة مع شاشة التحصيل (المراجعة ٤.١٠ و٤.١١)
  const st = due ? installmentState({
    dueDate: due.due_date, agreedDate: due.agreed_date, graceUntil: due.grace_until,
    amount: Number(due.amount_halalas), paid: Number(due.paid_halalas), discount: Number(due.discount), status: due.status,
  }, T) : null;
  Object.assign(ctx, {
    '{المستأجر}': c.tenant_name || name || '',
    '{الجوال}': c.phone || '',
    '{العقار}': p?.name || '',
    '{الوحدة}': u?.unit_no || c.unit_label || '',
    '{رقم_العقد}': c.contract_no || '',
    '{بداية_العقد}': c.start ? dfmt(c.start) : '',
    '{نهاية_العقد}': c.end ? dfmt(c.end) : '',
    '{قيمة_العقد}': fmt(Number(c.value_halalas)),
    '{التأمين}': fmt(Number(c.deposit_halalas)),
    // لا قسط مفتوح: لا مبلغ مستحق (المراجعة #6) · والمتبقي من الأقساط الحيّة
    '{المبلغ}': st ? fmt(st.remaining) : fmt(0),
    '{المتبقي}': fmt(remain ? Number(remain.s) : Number(c.total_halalas)),
    '{إجمالي_العقد}': fmt(Number(c.total_halalas)), // i18n-exempt: رمز قالب
    '{الخدمات}': fmt(Number(c.services_halalas)), // i18n-exempt: رمز قالب
    '{المواقف}': fmt(Number(c.parking_halalas)), // i18n-exempt: رمز قالب
    '{التاريخ}': st ? dfmt(st.effectiveDue) : c.end ? dfmt(c.end) : 'لا يوجد',
    '{أيام_التأخير}': st ? String(Math.max(0, st.daysLate)) : '0',
  });
  return ctx;
}

export function resolveTemplateTokens(text: string, ctx: Record<string, string>): string {
  let out = String(text || '');
  for (const k of Object.keys(ctx)) {
    const v = ctx[k] == null || ctx[k] === '' ? 'لا يوجد' : ctx[k];
    out = out.split(k).join(v);
    out = out.split(k.replace('{', '[').replace('}', ']')).join(v);
  }
  return out.replace(/\{الاسم\}|\[الاسم\]/g, ctx['{المستأجر}'] || '');
}

/**
 * رسالة التحصيل لقسطٍ بعينه (دراسة القائم 2026-10-09): قالبٌ يُملأ بسياق عقده كله كالمعاينة، والمبلغ والموعد والتأخير من
 * القسط نفسه بالدالة الواحدة مع شاشة التحصيل (قرار المالك ٤.١٠) · ورمزا {الاسم} و{تاريخ الاستحقاق} القديمان يُملآن أيضاً
 */
export function collectionMessage(
  db: DB, body: string, row: { installmentId: string; contractId: string; tenant: string; unitNo?: string | null },
): string {
  const ctx = templateContext(db, row.contractId, row.tenant);
  const i = db.get<{ due_date: string; agreed_date: string | null; grace_until: string | null; amount_halalas: number; paid_halalas: number; discount: number; status: string }>(
    `SELECT i.due_date, i.agreed_date, i.grace_until, i.amount_halalas, i.paid_halalas, ${INSTALLMENT_DISCOUNT_SQL} AS discount, i.status
     FROM contract_installments i WHERE i.id = ?`, [row.installmentId]);
  if (i) {
    const st = installmentState({
      dueDate: i.due_date, agreedDate: i.agreed_date, graceUntil: i.grace_until,
      amount: Number(i.amount_halalas), paid: Number(i.paid_halalas), discount: Number(i.discount), status: i.status,
    }, today());
    ctx['{المبلغ}'] = fmt(st.remaining); // i18n-exempt: رمز قالب مخزَّن
    ctx['{التاريخ}'] = dfmt(st.effectiveDue); // i18n-exempt: رمز قالب مخزَّن
    ctx['{أيام_التأخير}'] = String(Math.max(0, st.daysLate)); // i18n-exempt: رمز قالب مخزَّن
  }
  if (row.unitNo) ctx['{الوحدة}'] = row.unitNo; // i18n-exempt: رمز قالب مخزَّن
  ctx['{تاريخ الاستحقاق}'] = ctx['{التاريخ}'] ?? ''; // i18n-exempt: رمز قالب قديم مخزَّن
  return resolveTemplateTokens(body, ctx);
}

