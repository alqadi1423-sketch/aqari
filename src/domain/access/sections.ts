/**
 * صلاحيات الأقسام (docs/PERMISSIONS.md) · الأقسام من سلوك التطبيق لا من أسماء الشاشات،
 * ولكل قسم أربعة مستويات · والعقارات المسموحة قيدٌ فوقها.
 */

export type SectionKey =
  | 'props' | 'contracts' | 'tenants' | 'collect' | 'deposits' | 'reservations' | 'claims'
  | 'invoices' | 'purchases' | 'maintenance' | 'handover' | 'banks' | 'ledger' | 'reports'
  | 'library' | 'company' | 'audit' | 'assets' | 'admin';

/** 0 لا · 1 عرض · 2 إدخال · 3 كامل */
export type Level = 0 | 1 | 2 | 3;

export const LEVEL_LABEL: Record<Level, string> = { 0: 'لا', 1: 'عرض', 2: 'إدخال', 3: 'كامل' };

export interface SectionDef {
  key: SectionKey;
  label: string;
  /** ما يشمله · يُعرض في شاشة الصلاحيات */
  covers: string;
  /** أعلى مستوى له معنى (قسم القراءة وحدها لا إدخال فيه) */
  max: Level;
  /** للمالك وحده · لا يُمنح ولا يظهر في شاشة الصلاحيات */
  ownerOnly?: boolean;
}

export const SECTIONS: SectionDef[] = [
  { key: 'props', label: 'العقارات والوحدات', covers: 'العقار والوحدة والطوابق والغرف ومحتويات الوحدة والعدادات والخريطة', max: 3 },
  { key: 'contracts', label: 'العقود', covers: 'إنشاء العقد وتأكيده وتجديده وإنهاؤه وساكنو الوحدة', max: 3 },
  { key: 'tenants', label: 'المستأجرون', covers: 'بيانات المستأجر: الاسم والجوال والهوية والبريد', max: 3 },
  { key: 'collect', label: 'التحصيل', covers: 'الدفعة وسند القبض والخصم والتحصيل الجماعي وإلغاء الدفعة والتذكير', max: 3 },
  { key: 'deposits', label: 'التأمينات', covers: 'استلام التأمين ورده والخصم منه وترحيله وتسويته', max: 3 },
  { key: 'reservations', label: 'الحجوزات والتقبيل', covers: 'العربون وتحويله ومصادرته، وصفقات التقبيل وعمولتها', max: 3 },
  { key: 'claims', label: 'المطالبات', covers: 'مطالبة المستأجر وتحصيلها', max: 3 },
  { key: 'invoices', label: 'الفواتير', covers: 'فواتير المبيعات وإصدارها', max: 3 },
  { key: 'purchases', label: 'المشتريات والموردون', covers: 'فواتير الشراء وسدادها والموردون وفواتير الخدمات وقراءات العدادات واسترداد الضريبة', max: 3 },
  { key: 'maintenance', label: 'الصيانة', covers: 'طلبات الصيانة وحالتها', max: 3 },
  { key: 'handover', label: 'الاستلام والتسليم', covers: 'نماذج الاستلام والتسليم وصورها وتوقيعاتها', max: 3 },
  { key: 'banks', label: 'البنوك والنقد', covers: 'الحسابات البنكية وحركاتها والمطابقة والمحفظة وعمليات النقد', max: 3 },
  { key: 'ledger', label: 'الدفتر والقيود', covers: 'القيود اليدوية وعكسها والإلغاء من المصدر ودليل الحسابات ومراجعة الدفتر', max: 3 },
  { key: 'reports', label: 'التقارير', covers: 'القوائم المالية والإقرار الضريبي والتصدير والأرقام المالية في الرئيسية', max: 3 },
  { key: 'library', label: 'المكتبة', covers: 'الملفات والصور المرفوعة وتصنيفها', max: 3 },
  { key: 'company', label: 'المنشأة والقوالب', covers: 'بيانات المنشأة والشعار وقوالب الرسائل وقوالب النماذج', max: 3 },
  { key: 'audit', label: 'سجل العمليات', covers: 'قراءة السجل · لا يُعدَّل أبداً', max: 1 },
  { key: 'assets', label: 'الأصول', covers: 'سجل الأصول وتاريخها ونقلها واستبعادها', max: 3 },
  { key: 'admin', label: 'الأعضاء والإعدادات', covers: 'الأعضاء وصلاحياتهم والاشتراك والنسخ والاستعادة والمسح', max: 3, ownerOnly: true },
];

export const SECTION_KEYS: SectionKey[] = SECTIONS.map((s) => s.key);
export const GRANTABLE: SectionDef[] = SECTIONS.filter((s) => !s.ownerOnly);
export const sectionDef = (k: SectionKey): SectionDef => SECTIONS.find((s) => s.key === k)!;

export type Perms = Partial<Record<SectionKey, Level>>;

/** ما يتاح في كل مستوى · نصٌّ لشاشة الصلاحيات وللدراسة */
export const LEVEL_MEANING: Record<Level, string> = {
  0: 'القسم لا يظهر أبداً، ولا رابط يفتحه',
  1: 'يرى ولا يضيف ولا يعدّل',
  2: 'يضيف، ويعدّل مسودته هو وحده قبل ترحيلها',
  3: 'يضيف ويعدّل ويلغي',
};

export interface Template { key: string; label: string; perms: Perms }

const all = (lvl: Level): Perms => Object.fromEntries(GRANTABLE.map((s) => [s.key, Math.min(lvl, s.max)])) as Perms;

/** القوالب السريعة · تعبّئ الاختيارات ثم تُعدَّل */
export const TEMPLATES: Template[] = [
  { key: 'tech', label: 'فني صيانة', perms: { props: 1, maintenance: 2, handover: 1 } },
  { key: 'handover', label: 'مندوب استلام وتسليم', perms: { props: 1, handover: 2, contracts: 1, tenants: 1 } },
  { key: 'bills', label: 'مدخل فواتير', perms: { purchases: 2, invoices: 2, library: 2, props: 1 } },
  {
    key: 'accountant', label: 'محاسب', perms: {
      collect: 3, deposits: 3, claims: 3, invoices: 3, purchases: 3, banks: 3, ledger: 3, reports: 3,
      contracts: 1, tenants: 1, props: 1, audit: 1,
    },
  },
  { key: 'manager', label: 'مدير', perms: all(3) },
];

/** المستوى بعد قصّه على أقصى القسم · والقسم الغائب «لا» */
export function levelOf(perms: Perms, k: SectionKey): Level {
  const def = sectionDef(k);
  if (def.ownerOnly) return 0;
  const v = perms[k] ?? 0;
  return Math.max(0, Math.min(v, def.max)) as Level;
}
