/**
 * تنبيهات المواعيد · الحساب هنا، والجدولة الفعلية عبر expo-notifications في الخدمة.
 * المهل من الإعدادات: الدفعة (١/٣/٧/١٤) · العقد (١٥/٣٠/٦٠/٩٠) · المستند (١٥/٣٠/٦٠).
 */
import type { DB } from '../db/adapter';
import { getSetting } from '../repos/settings';
import { expiryLabel } from './contracts/rules';
import { today, daysBetween, dfmt } from './dates';
import { INSTALLMENT_DISCOUNT_SQL, COLLECTIBLE_INSTALLMENT_SQL, installmentState } from './contracts/installments';
import { warrantyEnding } from './assets/service';
import { t } from '../i18n';

export interface Reminder {
  /** warranty: ضمان أصلٍ ينتهي (الهجرة ٢٩) · رمزٌ يُترجم عند العرض */
  kind: 'دفعة متأخرة' | 'دفعة تقترب' | 'عقد يقارب الانتهاء' | 'مستند ينتهي' | 'warranty';
  subject: string;
  /** أيام حتى الموعد (سالب = متأخر) */
  days: number;
  /** تاريخ الحدث */
  date: string;
  entityId: string;
}

/** التنبيهات المستحقة الآن وما سيستحق ضمن المهل · منطق dueReminders في النموذج */
/** أقساط قائمة للتحصيل بوقائعها · للتنبيهات والإشعارات */
function installmentFacts(db: DB) {
  return db.all<{
    id: string; dueDate: string; agreedDate: string | null; graceUntil: string | null; amount: number; paid: number;
    discount: number; status: string; tenant: string; unitNo: string | null; prop: string | null; contractNo: string | null;
  }>(
    `SELECT i.id, i.due_date AS dueDate, i.agreed_date AS agreedDate, i.grace_until AS graceUntil,
            i.amount_halalas AS amount, i.paid_halalas AS paid, ${INSTALLMENT_DISCOUNT_SQL} AS discount, i.status,
            c.tenant_name AS tenant, u.unit_no AS unitNo, p.name AS prop, c.contract_no AS contractNo
     FROM contract_installments i JOIN contracts c ON c.id = i.contract_id
     LEFT JOIN units u ON u.id = c.unit_id LEFT JOIN properties p ON p.id = u.property_id
     WHERE ${COLLECTIBLE_INSTALLMENT_SQL}
     ORDER BY COALESCE(i.agreed_date, i.due_date)`
  ).map((r) => ({ ...r, amount: Number(r.amount), paid: Number(r.paid), discount: Number(r.discount) }));
}

export function computeReminders(db: DB, T: string = today()): Reminder[] {
  const out: Reminder[] = [];
  if (!getSetting(db, 'remindersOn')) return out;
  const remindPayment = getSetting(db, 'remindPayment');
  const remindContract = getSetting(db, 'remindContract');
  const remindDoc = getSetting(db, 'remindDoc');

  // حالة القسط من الدالة الواحدة مع شاشة التحصيل: الخصم والموعد المتفق عليه والمهلة (المراجعة ٤.١٠ و٤.١١)،
  // ومتأخرات العقد الملغى دَينٌ يُنبَّه عنه (٤.٩)
  for (const i of installmentFacts(db)) {
    if (!i.dueDate) continue;
    const st = installmentState(i, T);
    if (st.remaining <= 0) continue;
    const subject = i.tenant + ' · ' + dfmt(st.effectiveDue);
    if (st.daysLate > 0) out.push({ kind: 'دفعة متأخرة', subject, days: -st.daysLate, date: st.effectiveDue, entityId: i.id });
    else {
      const d = daysBetween(st.effectiveDue, T);
      if (d >= 0 && d <= remindPayment) out.push({ kind: 'دفعة تقترب', subject, days: d, date: st.effectiveDue, entityId: i.id });
    }
  }

  const contracts = db.all<{ id: string; contract_no: string | null; end: string }>(
    `SELECT id, contract_no, end FROM contracts
     WHERE status NOT IN ('مسودة','ملغى') AND deleted_at IS NULL AND end IS NOT NULL
       AND COALESCE(renewed_to, '') = ''`
  );
  for (const c of contracts) {
    const d = daysBetween(c.end, T);
    if (d >= 0 && d <= remindContract)
      out.push({
        kind: 'عقد يقارب الانتهاء',
        subject: (c.contract_no || 'لا يوجد') + ' · ' + dfmt(c.end) + ' · ' + expiryLabel(d),
        days: d, date: c.end, entityId: c.id,
      });
  }

  const docs = db.all<{ id: string; name: string; expiry: string }>(
    `SELECT id, name, expiry FROM company_docs WHERE expiry IS NOT NULL AND deleted_at IS NULL`
  );
  for (const x of docs) {
    const d = daysBetween(x.expiry, T);
    if (d >= 0 && d <= remindDoc)
      out.push({ kind: 'مستند ينتهي', subject: x.name + ' · ' + dfmt(x.expiry), days: d, date: x.expiry, entityId: x.id });
  }
  // السجل التجاري للمنشأة
  const co = db.get<{ cr_exp: string | null }>(`SELECT cr_exp FROM company WHERE id = 1`);
  if (co?.cr_exp) {
    const d = daysBetween(co.cr_exp, T);
    if (d >= 0 && d <= remindDoc)
      out.push({ kind: 'مستند ينتهي', subject: 'السجل التجاري · ' + dfmt(co.cr_exp), days: d, date: co.cr_exp, entityId: 'company-cr' });
  }
  // ضمان الأصول · الاسم والوحدة وحدهما
  for (const w of warrantyEnding(db, T, getSetting(db, 'remindWarranty'))) {
    out.push({ kind: 'warranty', subject: w.name + (w.unit_no ? ' · ' + w.unit_no : '') + ' · ' + dfmt(w.warranty_end), days: daysBetween(w.warranty_end, T), date: w.warranty_end, entityId: w.id });
  }
  return out.sort((a, b) => a.days - b.days);
}

export interface ExportStatus {
  daysSinceExport: number | null;
  /** تحذير أحمر إن مضى أسبوع بلا تصدير */
  warn: boolean;
}

export function exportStatus(db: DB, T: string = today()): ExportStatus {
  const last = getSetting(db, 'lastExportAt');
  if (!last) return { daysSinceExport: null, warn: true };
  const d = daysBetween(T, String(last).slice(0, 10));
  return { daysSinceExport: d, warn: d > 7 };
}

/**
 * التنبيهات المستقبلية المطلوب جدولتها في النظام (لا المستحقة الآن):
 * دفعة قبل استحقاقها بالمهلة، عقد قبل نهايته، مستند قبل انتهائه، وتذكير أسبوعي بالتصدير.
 */
export interface ScheduledReminder {
  kind: string;
  entityId: string;
  fireDate: string; // yyyy-mm-dd
  title: string;
  body: string;
}

export function computeSchedule(db: DB, T: string = today()): ScheduledReminder[] {
  const out: ScheduledReminder[] = [];
  if (!getSetting(db, 'remindersOn')) return out;
  const remindPayment = getSetting(db, 'remindPayment');
  const remindContract = getSetting(db, 'remindContract');
  const remindDoc = getSetting(db, 'remindDoc');
  const shift = (iso: string, days: number) => {
    const d = new Date(iso + 'T09:00:00');
    d.setDate(d.getDate() - days);
    const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), dd = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${dd}`;
  };

  // التنبيه يظهر على شاشة القفل · فلا اسم مستأجر فيه (القرار ٧): الوحدة وعقارها يدلّان ولا يكشفان أحداً
  const place = (u: string | null, p: string | null, no: string | null) =>
    u ? 'وحدة ' + u + (p ? ' · ' + p : '') : (no || 'عقد');
  // الإشعار بالموعد المتفق عليه إن وُجد · والمتبقي بعد الخصم (المراجعة ٤.١٠ و٤.١١)
  for (const i of installmentFacts(db)) {
    const st = installmentState(i, T);
    if (st.remaining <= 0 || !st.effectiveDue || st.effectiveDue < T) continue;
    const fire = shift(st.effectiveDue, remindPayment);
    if (fire >= T)
      out.push({
        kind: 'payment', entityId: i.id, fireDate: fire,
        title: 'دفعة تقترب', body: place(i.unitNo, i.prop, i.contractNo) + ' · تستحق ' + dfmt(st.effectiveDue),
      });
  }
  const cs = db.all<{ id: string; contract_no: string | null; end: string; unit_no: string | null; prop: string | null }>(
    `SELECT c.id, c.contract_no, c.end, u.unit_no, p.name AS prop FROM contracts c
     LEFT JOIN units u ON u.id = c.unit_id LEFT JOIN properties p ON p.id = u.property_id
     WHERE c.status NOT IN ('مسودة','ملغى') AND c.deleted_at IS NULL AND c.end >= ?
       AND COALESCE(c.renewed_to, '') = ''`,
    [T]
  );
  for (const c of cs) {
    const fire = shift(c.end, remindContract);
    if (fire >= T)
      out.push({
        kind: 'contract', entityId: c.id, fireDate: fire,
        title: 'عقد يقارب الانتهاء', body: place(c.unit_no, c.prop, c.contract_no) + ' · ينتهي ' + dfmt(c.end),
      });
  }
  const docs = db.all<{ id: string; name: string; expiry: string }>(
    `SELECT id, name, expiry FROM company_docs
     WHERE expiry IS NOT NULL AND deleted_at IS NULL AND expiry >= ?`,
    [T]
  );
  for (const x of docs) {
    const fire = shift(x.expiry, remindDoc);
    if (fire >= T)
      out.push({
        kind: 'document', entityId: x.id, fireDate: fire,
        title: 'مستند ينتهي', body: x.name + ' · ينتهي ' + dfmt(x.expiry),
      });
  }
  const remindWarranty = getSetting(db, 'remindWarranty');
  for (const w of warrantyEnding(db, T, 3650)) {
    const fire = shift(w.warranty_end, remindWarranty);
    if (fire >= T)
      out.push({
        kind: 'warranty', entityId: w.id, fireDate: fire,
        title: t('assets.ui.warrantyHome'), body: t('assets.ui.warrantyRow', { name: w.name, unit: w.unit_no ?? '', date: dfmt(w.warranty_end) }),
      });
  }
  return out;
}
