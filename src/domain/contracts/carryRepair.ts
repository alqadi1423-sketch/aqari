/**
 * أداة البيانات القائمة لـ A1-1 (المراجعة الشاملة 2026-11-13): ترحيل تأمينٍ سُوّي قبل الإصلاح.
 *
 * renewContract القديم كان يرحّل تأمين العقد السابق ولو سُوّي (رُدّ أو خُصم): قيد deposit_carry 2400/2400 حيّ (التزام السابق سالب
 * والجديد موجب بالمبلغ نفسه)، وتأمين الجديد في صفّه = المرحَّل وزيادته · فيحمرّ الفحص الثالث وتعرض تسوية الجديد ردّ ما لم يُقبض.
 * الإصلاح اليوم يمنع ذلك (service.ts: settledNoCarry · deriveSources: carryAfterSettle) · وما بقي من قبله تسرده هذه الأداة في
 * «فحص المطابقة» ويصلحه المالك وحده بضغطة: عكس قيد الترحيل بقيدٍ عاكس (reverseEntryById: بأبعاد أصله، وبتاريخه إلا في ربعٍ قُدِّم
 * إقراره فتاريخ التصحيح) وإنزال تأمين الجديد بالمرحَّل، لا تحت ما قُبض له فعلاً (قيود contract_deposit الحيّة) · وسطرٌ في سجل العمليات.
 *
 * والجهات كالترحيل نفسه: depositCarryLines لا تفرّق بين الجهات (2400/2400 بأبعاد العقدين حتى لـ«طرف آخر»)، فالعكس واحد · والمقبوض
 * فعلاً من قيود contract_deposit وحدها (لدى المكتب والمنصة · ولا قيد لـ«طرف آخر» فمقبوضه في الدفتر صفر، وتأمينه بعد الإصلاح صفّه ناقصاً
 * المرحَّل كما يصحّحه جهاز المالك في الترحيل المرفوض: sync/engine.ts deadCarryDeposit).
 *
 * لا تُطبَّق على عقدٍ مجدَّد سُوّي تأمينه بعد الترحيل (خرجت تسويته فعلاً) ولا على عقدٍ رُحِّل تأمينه بعدُ إلى تجديده: عكس الترحيل
 * هناك لا يصلح ما بعده · فتظهر موقوفةً بسببها ولا زرّ لها.
 */
import type { DB } from '../../db/adapter';
import { t } from '../../i18n';
import { fmt } from '../money';
import { dfmt } from '../dates';
import { logAudit } from '../audit';
import { reverseEntryById } from '../accounting/post';
import { memberDevice } from '../accounting/orphans';
import { correctionDate } from '../vatFilings';
import { RuleViolation, depositSettlementDate } from './service';

export interface CarryAfterSettleItem {
  /** العقد المجدَّد الذي يحمل الترحيل */
  renewalId: string;
  renewalNo: string;
  /** العقد السابق الذي سُوّي تأمينه */
  prevId: string;
  prevNo: string;
  tenant: string;
  /** جهة قبض التأمين في المجدَّد (منسوخةٌ من السابق في التجديد) */
  holder: string;
  /** تاريخ تسوية السابق */
  settledOn: string;
  carryEntryId: string;
  carryNo: string;
  /** تاريخ القيد العاكس: تاريخ الترحيل، إلا في ربعٍ قُدِّم إقراره فتاريخ التصحيح (reverseEntryById) */
  reverseOn: string;
  /** المرحَّل: دائن 2400 في قيد الترحيل */
  carried: number;
  /** تأمين المجدَّد في صفّه الآن */
  deposit: number;
  /** ما قبضه الدفتر له فعلاً (قيود contract_deposit الحيّة) */
  received: number;
  /** تأمينه بعد الإصلاح: صفّه ناقصاً المرحَّل، ولا يقلّ عن المقبوض */
  target: number;
  /** سبب الإيقاف إن لم تصح الأداة عليه (لا زرّ له) */
  blocked?: string;
}

const POSTED = 'مرحّل'; // i18n-exempt: حالة القيد المخزّنة
const OFFICE = 'المكتب'; // i18n-exempt: جهة مخزّنة

/** ما قبضه الدفتر لتأمين العقد: دائن 2400 في قيود contract_deposit ناقصاً عواكسها */
function receivedFor(db: DB, contractId: string): number {
  return Math.max(0, Number(db.get<{ n: number }>(
    `SELECT COALESCE(SUM(l.credit_halalas - l.debit_halalas), 0) AS n FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id
     WHERE e.src_type IN ('contract_deposit', 'contract_deposit_rev') AND e.src_id = ? AND e.status = ? AND e.deleted_at IS NULL
       AND l.account_code = '2400'`, [contractId, POSTED])!.n));
}

/** خلفٌ قائم رُحِّل إليه تأمين العقد بقيدٍ حيّ (منطق depositCarried) · برقمه */
function carriedOnTo(db: DB, contractId: string): string | null {
  const r = db.get<{ no: string | null }>(
    `SELECT n.contract_no AS no FROM contracts n JOIN journal_entries e ON e.src_type = 'deposit_carry' AND e.src_id = n.id
     WHERE n.renewed_from = ? AND n.deleted_at IS NULL AND e.reversed_by IS NULL AND e.deleted_at IS NULL AND e.status = ? LIMIT 1`,
    [contractId, POSTED]);
  return r ? r.no ?? '' : null;
}

/**
 * كل عقدٍ مجدَّد له قيد ترحيل تأمينٍ حيّ وسابقه له صفّ تسوية · للمالك وحده (جهاز العضو قد لا يرى التسويات ولا يطبّق، فلا قائمة له) ·
 * قراءة فقط
 */
export function carryAfterSettleItems(db: DB): CarryAfterSettleItem[] {
  if (memberDevice(db)) return [];
  const rows = db.all<{
    renewalId: string; renewalNo: string | null; prevId: string; prevNo: string | null; tenant: string; holder: string | null;
    settledOn: string; carryEntryId: string; carryNo: string; carryDate: string; deposit: number; carried: number;
  }>(
    `SELECT n.id AS renewalId, n.contract_no AS renewalNo, p.id AS prevId, p.contract_no AS prevNo, n.tenant_name AS tenant,
            n.deposit_holder AS holder, ds.date AS settledOn, e.id AS carryEntryId, e.no AS carryNo, e.date AS carryDate,
            n.deposit_halalas AS deposit,
            (SELECT COALESCE(SUM(l.credit_halalas), 0) FROM journal_lines l WHERE l.entry_id = e.id AND l.account_code = '2400') AS carried
     FROM contracts n
     JOIN contracts p ON p.id = n.renewed_from
     JOIN deposit_settlements ds ON ds.contract_id = p.id
     JOIN journal_entries e ON e.src_type = 'deposit_carry' AND e.src_id = n.id AND e.status = ? AND e.deleted_at IS NULL AND e.reversed_by IS NULL
     WHERE n.deleted_at IS NULL
     ORDER BY e.date, e.no`, [POSTED]);
  return rows.map((r) => {
    const carried = Number(r.carried) || 0;
    const deposit = Number(r.deposit) || 0;
    const received = receivedFor(db, r.renewalId);
    const item: CarryAfterSettleItem = {
      renewalId: r.renewalId, renewalNo: r.renewalNo ?? '', prevId: r.prevId, prevNo: r.prevNo ?? '', tenant: r.tenant,
      holder: r.holder || OFFICE, settledOn: r.settledOn, carryEntryId: r.carryEntryId, carryNo: r.carryNo,
      reverseOn: correctionDate(db, r.carryDate),
      carried, deposit, received, target: Math.max(received, deposit - carried),
    };
    const settled = depositSettlementDate(db, r.renewalId);
    const next = carriedOnTo(db, r.renewalId);
    if (settled) {
      item.blocked = t('carryRepair.renewalSettled', { to: item.renewalNo, date: dfmt(settled), amount: fmt(carried) });
    } else if (next !== null) {
      item.blocked = t('carryRepair.carriedOn', { to: item.renewalNo, next });
    }
    return item;
  });
}

/**
 * «عكس الترحيل وتصفير تأمين الجديد» للعقد المجدَّد · المالك وحده · true إن أصلح، وfalse إن لم يبقَ ما يُصلح (مكررةٌ لا تغيّر شيئاً) ·
 * ويرمي سبب الإيقاف إن كان موقوفاً، فلا يتغير شيء
 */
export function reverseCarryAfterSettle(db: DB, renewalId: string): boolean {
  if (memberDevice(db)) throw new RuleViolation(t('carryRepair.ownerOnly'));
  const item = carryAfterSettleItems(db).find((x) => x.renewalId === renewalId);
  if (!item) return false;
  if (item.blocked) throw new RuleViolation(item.blocked);
  return db.transaction(() => {
    const rev = reverseEntryById(db, item.carryEntryId,
      t('carryRepair.memo', { from: item.prevNo, to: item.renewalNo, date: dfmt(item.settledOn), lng: 'ar' }));
    if (!rev) throw new RuleViolation(t('carryRepair.gone'));
    db.run(`UPDATE contracts SET deposit_halalas = ? WHERE id = ?`, [item.target, item.renewalId]);
    logAudit(db, 'العقود', 'update', t('carryRepair.auditEntity', { lng: 'ar' }), // i18n-exempt: وحدة السجل المخزّنة
      t('carryRepair.auditName', { from: item.prevNo, to: item.renewalNo, tenant: item.tenant, lng: 'ar' }),
      { deposit_halalas: item.deposit, carry_entry: item.carryNo, carried_halalas: item.carried, prev_settled: item.settledOn },
      { deposit_halalas: item.target, reversal_entry: rev.no, received_halalas: item.received });
    return true;
  });
}
