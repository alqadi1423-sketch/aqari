/**
 * تنبيهات المواعيد · الحساب هنا، والجدولة الفعلية عبر expo-notifications في الخدمة.
 * المهل من الإعدادات: الدفعة (١/٣/٧/١٤) · العقد (١٥/٣٠/٦٠/٩٠) · المستند (١٥/٣٠/٦٠).
 */
import type { DB } from '../db/adapter';
import { getSetting } from '../repos/settings';
import { expiryLabel } from './contracts/rules';
import { today, daysBetween, dfmt } from './dates';

export interface Reminder {
  kind: 'دفعة متأخرة' | 'دفعة تقترب' | 'عقد يقارب الانتهاء' | 'مستند ينتهي';
  subject: string;
  /** أيام حتى الموعد (سالب = متأخر) */
  days: number;
  /** تاريخ الحدث */
  date: string;
  entityId: string;
}

/** التنبيهات المستحقة الآن وما سيستحق ضمن المهل · منطق dueReminders في النموذج */
export function computeReminders(db: DB, T: string = today()): Reminder[] {
  const out: Reminder[] = [];
  if (!getSetting(db, 'remindersOn')) return out;
  const remindPayment = getSetting(db, 'remindPayment');
  const remindContract = getSetting(db, 'remindContract');
  const remindDoc = getSetting(db, 'remindDoc');

  const insts = db.all<{
    id: string; due_date: string; amount_halalas: number; paid_halalas: number;
    tenant_name: string; status: string;
  }>(
    `SELECT i.id, i.due_date, i.amount_halalas, i.paid_halalas, c.tenant_name, i.status
     FROM contract_installments i JOIN contracts c ON c.id = i.contract_id
     WHERE c.status NOT IN ('مسودة','ملغى') AND c.deleted_at IS NULL AND i.status != 'ملغية'`
  );
  for (const i of insts) {
    const rem = Number(i.amount_halalas) - Number(i.paid_halalas);
    if (rem <= 0 || !i.due_date) continue;
    const d = daysBetween(i.due_date, T);
    if (d < 0) out.push({ kind: 'دفعة متأخرة', subject: i.tenant_name + ' · ' + dfmt(i.due_date), days: d, date: i.due_date, entityId: i.id });
    else if (d <= remindPayment) out.push({ kind: 'دفعة تقترب', subject: i.tenant_name + ' · ' + dfmt(i.due_date), days: d, date: i.due_date, entityId: i.id });
  }

  const contracts = db.all<{ id: string; contract_no: string | null; end: string }>(
    `SELECT id, contract_no, end FROM contracts
     WHERE status NOT IN ('مسودة','ملغى') AND deleted_at IS NULL AND end IS NOT NULL`
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

  const insts = db.all<{ id: string; due_date: string; amount_halalas: number; paid_halalas: number; tenant_name: string }>(
    `SELECT i.id, i.due_date, i.amount_halalas, i.paid_halalas, c.tenant_name
     FROM contract_installments i JOIN contracts c ON c.id = i.contract_id
     WHERE c.status NOT IN ('مسودة','ملغى') AND c.deleted_at IS NULL AND i.status != 'ملغية'
       AND i.due_date >= ?`,
    [T]
  );
  for (const i of insts) {
    if (Number(i.amount_halalas) - Number(i.paid_halalas) <= 0) continue;
    const fire = shift(i.due_date, remindPayment);
    if (fire >= T)
      out.push({
        kind: 'payment', entityId: i.id, fireDate: fire,
        title: 'دفعة تقترب', body: i.tenant_name + ' · تستحق ' + dfmt(i.due_date),
      });
  }
  const cs = db.all<{ id: string; contract_no: string | null; end: string; tenant_name: string }>(
    `SELECT id, contract_no, end, tenant_name FROM contracts
     WHERE status NOT IN ('مسودة','ملغى') AND deleted_at IS NULL AND end >= ?`,
    [T]
  );
  for (const c of cs) {
    const fire = shift(c.end, remindContract);
    if (fire >= T)
      out.push({
        kind: 'contract', entityId: c.id, fireDate: fire,
        title: 'عقد يقارب الانتهاء', body: (c.contract_no || 'لا يوجد') + ' · ' + c.tenant_name + ' ينتهي ' + dfmt(c.end),
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
  return out;
}
