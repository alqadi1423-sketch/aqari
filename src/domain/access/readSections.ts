/**
 * من يقرأ كل جدول (docs/PERMISSIONS.md §٣) · رموز الرؤية g في مستند الصف تُبنى من هنا:
 * «قسم|عقار» لكل قسم يقرؤه ولكل عقار يخصه. والبيانات المرتبطة بالحد اللازم:
 * الجدول يُقرأ لقسمه ولما يحتاجه من الأقسام سياقاً، لا لكل قسم.
 */
import { SECTION_KEYS, type SectionKey } from './sections';

/** أقسام تحتاج اسم العقار والوحدة سياقاً لعملها */
const NEEDS_UNITS: SectionKey[] = [
  'props', 'contracts', 'tenants', 'collect', 'deposits', 'reservations', 'claims', 'invoices',
  'purchases', 'maintenance', 'handover', 'banks', 'ledger', 'reports', 'library', 'assets',
];
const MONEY_BOOKS: SectionKey[] = ['ledger', 'reports'];

export const READ_TABLE: Record<string, SectionKey[]> = {
  accounts: ['ledger', 'reports', 'banks', 'purchases', 'collect', 'invoices'],
  properties: NEEDS_UNITS,
  units: NEEDS_UNITS,
  property_floor_categories: ['props', 'contracts', 'reports'],
  property_areas: ['props', 'maintenance', 'handover', 'assets'],
  property_area_items: ['props', 'maintenance', 'handover', 'assets'],
  unit_rooms: ['props', 'maintenance', 'handover', 'assets', 'contracts'],
  unit_room_items: ['props', 'maintenance', 'handover', 'assets', 'contracts'],
  meters: ['props', 'purchases', 'maintenance', 'handover'],
  meter_readings: ['purchases', 'props', 'handover'],
  tenants: ['tenants', 'contracts', 'collect', 'deposits', 'reservations', 'claims', 'handover', 'invoices'],
  suppliers: ['purchases', 'ledger', 'reports', 'banks'],
  banks: ['banks', 'collect', 'purchases', 'reservations', 'deposits', 'claims', 'ledger', 'reports'],
  company: [...NEEDS_UNITS, 'company', 'audit'],
  company_docs: ['company'],
  message_scripts: ['company', 'collect', 'contracts'],
  form_templates: ['company', 'handover'],
  contracts: ['contracts', 'collect', 'deposits', 'reservations', 'claims', 'tenants', 'handover', 'reports', 'ledger', 'invoices'],
  contract_installments: ['contracts', 'collect', 'reports', 'ledger'],
  contract_occupants: ['contracts', 'handover'],
  occupants: ['contracts', 'handover'],
  reservations: ['reservations', 'contracts', 'props', 'reports', 'ledger'],
  key_money_deals: ['reservations', 'contracts', 'reports', 'ledger'],
  contract_payments: ['collect', 'contracts', 'reports', 'ledger'],
  payment_lines: ['collect', 'contracts', 'banks', 'reports', 'ledger'],
  payment_allocations: ['collect', 'contracts', 'reports', 'ledger'],
  deposit_settlements: ['deposits', 'contracts', 'reports', 'ledger'],
  tenant_ratings: ['contracts', 'tenants'],
  claims: ['claims', 'contracts', 'deposits', 'reports', 'ledger'],
  invoices: ['invoices', 'reports', 'ledger'],
  invoice_lines: ['invoices', 'reports', 'ledger'],
  purchases: ['purchases', 'reports', 'ledger', 'banks'],
  bank_tx: ['banks', 'reports', 'ledger'],
  handovers: ['handover', 'contracts'],
  audit_log: ['audit'],
  journal_entries: MONEY_BOOKS,
  // بصمة الملف وامتداده وحجمه · لا تكشف شيئاً، ويحتاجها كل من يرى مرفقاً
  blobs: SECTION_KEYS,
  // أسماء مراكز التكلفة · يحتاجها كل من يُنشئ قيداً أو يقرأ تقريراً (الهجرة ٢٨)
  cost_centers: SECTION_KEYS,
};

/** جدول الجهة التي يرتبط بها المرفق · فيقرؤه من يقرأ جهته (READ_TABLE)، والمكتبة دائماً */
export const ATTACHMENT_ENTITY_TABLE: Record<string, string> = {
  contract: 'contracts', unit: 'units', property: 'properties', tenant: 'tenants', occupant: 'occupants',
  purchase: 'purchases', supplier: 'suppliers', invoice: 'invoices', claim: 'claims', handover: 'handovers',
  payment: 'contract_payments', reservation: 'reservations', bank: 'banks', bank_tx: 'bank_tx',
  company: 'company_docs', company_doc: 'company_docs',
};

/**
 * أقسام المال · وحدها تقرأ أعمدة المبالغ (…_halalas). فالصف الذي فيه مبلغٌ ويقرؤه قسمٌ غير مالي
 * (فني الصيانة يرى الوحدة، ومندوب الاستلام يرى مدة العقد) يُكتب مستندين: كاملاً لأقسام المال،
 * وإسقاطاً بلا مبالغه (t~pub__k) للبقية (moneySplit).
 */
export const MONEY_SECTIONS: ReadonlySet<SectionKey> = new Set<SectionKey>([
  'contracts', 'collect', 'deposits', 'reservations', 'claims', 'invoices', 'purchases', 'banks', 'ledger', 'reports', 'assets',
]);

export const isMoneyColumn = (col: string): boolean => col.endsWith('_halalas');

/** يُسقط كل عمود مبلغ · وما سواه من الصف كما هو */
export function publicFields<T extends Record<string, unknown>>(row: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) if (!isMoneyColumn(k)) out[k] = v;
  return out as Partial<T>;
}

/** قرّاء المستند الكامل وقرّاء الإسقاط · الصف بلا مبالغ لا إسقاط له */
export function moneySplit(row: Record<string, unknown> | null, readers: SectionKey[]): { full: SectionKey[]; pub: SectionKey[] } {
  const hasMoney = !!row && Object.keys(row).some(isMoneyColumn);
  if (!hasMoney) return { full: readers, pub: [] };
  return { full: readers.filter((r) => MONEY_SECTIONS.has(r)), pub: readers.filter((r) => !MONEY_SECTIONS.has(r)) };
}

/**
 * صفٌّ مشترك بين العقارات (المستأجر بعقود في أكثر من عقار) وفيه ما يجمع العقارات كلها: رصيده الدائن
 * وملاحظاته. مستنده الكامل لا يقرؤه إلا العضو ذو كل العقارات، والمحصور بعقارات يقرأ إسقاطه بلا هذه
 * الحقول · فلا يرى من نشاطه في عقار آخر شيئاً ولا أن له عقداً هناك (الدراسة ب).
 */
export const CROSS_PROPERTY: Record<string, string[]> = { tenants: ['notes'] };

/** إسقاط الصف المشترك: بلا مبالغ ولا الحقول الجامعة */
export function crossPublicFields(table: string, row: Record<string, unknown>): Record<string, unknown> {
  const drop = new Set(CROSS_PROPERTY[table] ?? []);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) if (!isMoneyColumn(k) && !drop.has(k)) out[k] = v;
  return out;
}

/** قسم القيد من مصدره · القيد يقرؤه الدفتر والتقارير وقسمُ مصدره */
export function journalSection(srcType: string | null | undefined): SectionKey {
  const s = (srcType || '').replace(/_rev$/, '');
  if (!s) return 'ledger';
  if (s === 'rent' || s.startsWith('rent_') || s.startsWith('discount') || s.startsWith('surplus')) return 'collect';
  if (s === 'contract_deposit' || s.startsWith('deposit')) return 'deposits';
  if (s.startsWith('reservation') || s === 'key_money') return 'reservations';
  if (s.startsWith('claim')) return 'claims';
  if (s.startsWith('invoice')) return 'invoices';
  if (s.startsWith('purchase') || s === 'vat_refund') return 'purchases';
  if (s === 'cash_op') return 'banks';
  return 'ledger';
}

/** الأقسام التي تقرأ صفاً بعينه */
/** جدول المستند الذي يُنشئ قيود كل قسم · قارئ المستند المالي يقرأ قيده */
const JOURNAL_SOURCE: Partial<Record<SectionKey, string>> = {
  collect: 'contract_payments', deposits: 'deposit_settlements', reservations: 'reservations', claims: 'claims',
  invoices: 'invoices', purchases: 'purchases', banks: 'bank_tx',
};

export function readSectionsOf(table: string, row: Record<string, unknown> | null): SectionKey[] {
  if (table === 'attachments') {
    const src = ATTACHMENT_ENTITY_TABLE[String(row?.entity_type ?? '')];
    return [...new Set<SectionKey>(['library', ...(src ? READ_TABLE[src] ?? [] : [])])];
  }
  if (table === 'journal_entries') {
    // القيد يقرؤه الدفتر والتقارير وقسم مصدره، وكل قسم مالي يقرأ مستنده (أعطال ٢٠٢٦-١٠-٠٥: عضو العقود
    // يقرأ الدفعة ولا يصله قيدها، فتنتظر الدفعة أباها بلا نهاية ويظهر القسط غير مسدَّد والخصم متبقياً)
    const own = journalSection(row?.src_type as string | null);
    const src = JOURNAL_SOURCE[own];
    const viaSource = src ? (READ_TABLE[src] ?? []).filter((x) => MONEY_SECTIONS.has(x)) : [];
    return [...new Set<SectionKey>([...MONEY_BOOKS, own, ...viaSource])];
  }
  return READ_TABLE[table] ?? [];
}
