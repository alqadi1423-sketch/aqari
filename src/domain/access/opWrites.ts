/**
 * ما تكتبه عمليات كل قسم (docs/PERMISSIONS.md §٣) · منه تُولَّد قواعد الكتابة في firestore.rules،
 * ويُسقط tests/opMatrix.test.ts أي عملية تكتب ما ليس هنا.
 *
 * create: الجداول التي تنشئ فيها العملية صفوفاً (بمستوى «إدخال» فأعلى).
 * own:    جداول القسم نفسه · تعديلها وحذفها بمستوى «كامل».
 * touch:  حقولٌ بعينها في جداول أخرى تمسّها العملية جانبياً (بمستوى «إدخال» فأعلى).
 */
import type { SectionKey } from './sections';

export interface OpWrites {
  create: string[];
  own: string[];
  touch?: Record<string, string[]>;
}

/** كل عملية ترحّل قيداً تنشئه وتربط القيد المعكوس بعاكسه (القواعد تحصر تعديل المرحّل في reversed_by) */
const POSTS = ['journal_entries', 'audit_log'];
const LINKS_REVERSAL = { journal_entries: ['reversed_by'] };

export const OP_WRITES: Partial<Record<SectionKey, OpWrites>> = {
  props: {
    own: ['properties', 'property_areas', 'property_area_items', 'property_floor_categories', 'units', 'unit_rooms', 'unit_room_items', 'meters'],
    create: ['audit_log'],
  },
  maintenance: { own: [], create: ['audit_log'], touch: { units: ['under_maintenance'] } },
  contracts: {
    own: ['contracts', 'contract_installments', 'contract_occupants', 'occupants', 'tenant_ratings'],
    // توثيق العقد ينشئ مستأجره ونموذج استلامه، وإلغاؤه بخصم يتجاوز التأمين ينشئ مطالبته
    create: [...POSTS, 'tenants', 'handovers', 'claims', 'bank_tx'],
    touch: { ...LINKS_REVERSAL, reservations: ['status', 'converted_contract_id'] },
  },
  tenants: {
    own: ['tenants'],
    create: ['audit_log'],
    // تغيير الاسم ودمج المكرر يحملان الاسم والربط إلى عقوده
    touch: { contracts: ['tenant_id', 'tenant_name'] },
  },
  collect: {
    own: ['contract_payments', 'payment_lines', 'payment_allocations'],
    create: [...POSTS, 'bank_tx'],
    touch: { ...LINKS_REVERSAL, contract_installments: ['paid_halalas', 'status'], tenants: ['credit_halalas'] },
  },
  deposits: { own: ['deposit_settlements'], create: [...POSTS, 'bank_tx', 'claims'], touch: LINKS_REVERSAL },
  reservations: { own: ['reservations', 'key_money_deals'], create: [...POSTS, 'bank_tx'], touch: LINKS_REVERSAL },
  claims: { own: ['claims'], create: [...POSTS, 'bank_tx'], touch: LINKS_REVERSAL },
  invoices: { own: ['invoices', 'invoice_lines'], create: POSTS, touch: LINKS_REVERSAL },
  purchases: {
    own: ['suppliers', 'purchases', 'meter_readings'],
    create: [...POSTS, 'bank_tx'],
    touch: { ...LINKS_REVERSAL, meters: ['supplier_id'] },
  },
  handover: { own: ['handovers'], create: ['audit_log'] },
  banks: { own: ['banks', 'bank_tx'], create: POSTS, touch: LINKS_REVERSAL },
  ledger: { own: ['journal_entries', 'accounts'], create: ['audit_log'] },
  library: { own: [], create: ['audit_log'] },
  company: { own: ['company', 'company_docs', 'message_scripts', 'form_templates'], create: ['audit_log'] },
  reports: { own: [], create: ['audit_log'] },
};

export function opAllows(op: SectionKey, table: string, kind: 'create' | 'update' | 'delete', cols: string[] = []): boolean {
  const w = OP_WRITES[op];
  if (!w) return false;
  if (kind === 'create') return w.create.includes(table) || w.own.includes(table);
  if (w.own.includes(table)) return true;
  if (kind === 'delete') return false;
  const fields = w.touch?.[table];
  return !!fields && cols.every((c) => fields.includes(c));
}
