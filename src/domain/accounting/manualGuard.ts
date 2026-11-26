/**
 * القيد اليدوي على الحسابات المساندة (المراجعة الشاملة 2026-11-13 · A2.10 · قرار المالك س٢٠: «يُمنع للعضو، ويُقبل لك بتنبيه»).
 *
 * حسابٌ مساند له سجلٌّ في شاشته يطابقه فحص المطابقة: الذمم المدينة (الفواتير)، وذمم المطالبات، وضريبة المدخلات (فواتير الشراء)،
 * والتأمينات وما يحتجزه الغير منها ومحفظة إيجار (العقود)، وأرصدة المستأجرين الدائنة (التحصيل)، وعرابين الحجز (الحجوزات)، وحسابات
 * فئات الأصول ومجمع إهلاكها (الأصول) · فقيدٌ يدوي عليها يغيّر الدفتر ولا يغيّر السجل، فيحمرّ الفحص ولا يصلحه إلا عكسه.
 * العضو يُمنع برسالةٍ تسمّي الشاشة الصحيحة (على جهازه، وجهاز المالك يرفض مسودته إن وصلت)، والمالك يُقبل منه بتنبيهٍ صريح يؤكده.
 */
import type { DB } from '../../db/adapter';
import { t } from '../../i18n';
import { ASSET_CATEGORIES, ACC_ACCUM } from '../assets/catalog';

/** الحساب المساند ← مفتاح شاشته في journal.supportScreen */
const SUPPORT_SCREEN: Record<string, string> = {
  '1200': 'invoices',
  '1250': 'claims',
  '1270': 'purchases',
  '2400': 'contracts', '1260': 'contracts', '1265': 'contracts',
  '2410': 'collect',
  '2450': 'reservations',
  [ACC_ACCUM]: 'assets',
  ...Object.fromEntries(ASSET_CATEGORIES.map((c) => [c.code, 'assets'])),
};

export interface SupportHit { code: string; name: string; screen: string }

/** حسابات القيد المساندة بترتيب ورودها، كلٌّ مرة · بأسمائها وشاشاتها */
export function supportingAccountsIn(db: DB, lines: Array<{ account: string }>): SupportHit[] {
  const out: SupportHit[] = [];
  for (const l of lines) {
    const key = SUPPORT_SCREEN[l.account];
    if (!key || out.some((h) => h.code === l.account)) continue;
    const name = db.get<{ name: string }>(`SELECT name FROM accounts WHERE code = ?`, [l.account])?.name ?? '';
    out.push({ code: l.account, name, screen: t('journal.supportScreen.' + key) });
  }
  return out;
}

/** نص الحسابات المساندة وشاشاتها في سطرٍ واحد */
export const supportList = (hits: SupportHit[]): string =>
  hits.map((h) => t('journal.supportItem', { code: h.code, name: h.name, screen: h.screen })).join(' · ');

/** قيدٌ يدوي على حسابٍ مساند بلا تأكيد التنبيه (المالك) · رسالته التنبيه نفسه */
export class SupportingAccountsError extends Error {
  constructor(public hits: SupportHit[]) {
    super(t('journal.supportWarn', { list: supportList(hits) }));
    this.name = 'SupportingAccountsError';
  }
}

/** يمنع العضو من قيدٍ يدوي على حسابٍ مساند برسالةٍ تسمّي الشاشة الصحيحة */
export function requireNoSupportForMember(db: DB, lines: Array<{ account: string }>): void {
  const hits = supportingAccountsIn(db, lines);
  if (hits.length) throw new Error(t('journal.supportMember', { list: supportList(hits) }));
}

/** قيد المالك على حسابٍ مساند لا يُرحَّل إلا بتأكيد تنبيهه (ack) */
export function requireSupportAck(db: DB, lines: Array<{ account: string }>, ack?: boolean): void {
  if (ack) return;
  const hits = supportingAccountsIn(db, lines);
  if (hits.length) throw new SupportingAccountsError(hits);
}
