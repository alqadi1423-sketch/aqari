import type { DB } from './adapter';
import { uid } from '../domain/ids';

/** الحسابات التسعة عشر · منقولة بأكوادها وأسمائها من النموذج دون تغيير */
export const SEED_ACCOUNTS: Array<{ code: string; name: string; type: string; grp: string | null }> = [
  { code: '1100', name: 'النقدية والبنوك', type: 'أصل', grp: 'النقدية وما في حكمها' },
  { code: '1200', name: 'الذمم المدينة (عملاء)', type: 'أصل', grp: null },
  { code: '1250', name: 'ذمم المطالبات', type: 'أصل', grp: null },
  { code: '1400', name: 'أصول ثابتة', type: 'أصل', grp: null },
  { code: '2100', name: 'الذمم الدائنة (موردون)', type: 'خصم', grp: null },
  { code: '2200', name: 'ضريبة القيمة المضافة المستحقة', type: 'خصم', grp: null },
  { code: '2300', name: 'قروض', type: 'خصم', grp: null },
  { code: '2400', name: 'تأمينات المستأجرين', type: 'خصم', grp: null },
  { code: '2450', name: 'عرابين الحجز', type: 'خصم', grp: null },
  { code: '3100', name: 'رأس المال', type: 'حقوق ملكية', grp: null },
  { code: '3200', name: 'الأرباح المرحّلة', type: 'حقوق ملكية', grp: null },
  { code: '4100', name: 'إيرادات المبيعات', type: 'إيراد', grp: null },
  { code: '4200', name: 'إيرادات الإيجار', type: 'إيراد', grp: null },
  { code: '4300', name: 'إيرادات أخرى', type: 'إيراد', grp: null },
  { code: '5100', name: 'تكلفة المبيعات', type: 'مصروف', grp: null },
  { code: '5200', name: 'الرواتب والأجور', type: 'مصروف', grp: null },
  { code: '5300', name: 'مصروفات إدارية وعمومية', type: 'مصروف', grp: null },
  { code: '5400', name: 'مصروفات أخرى', type: 'مصروف', grp: null },
  { code: '5500', name: 'مصروفات تأسيس', type: 'مصروف', grp: null },
];

/**
 * حسابات نظام تضيفها الهجرات لا الزرع · بقيمها نفسها هناك (واختبار يربط القائمتين).
 * تُضمن عند الزرع أيضاً لقاعدة تحمل رقم إصدار لم تمرّ بهجراته فعلاً (نسخة مولَّدة خارج التطبيق)،
 * وإلا رمى أول تحصيل بفائض (2410) أو أول مشتريات بفرق تقريب (5900) لغياب حسابه.
 */
export const MIGRATED_SYSTEM_ACCOUNTS: Array<{ code: string; name: string; type: string; grp: string | null }> = [
  { code: '1260', name: 'تأمينات محتجزة لدى الغير', type: 'أصل', grp: 'أصول متداولة' },
  { code: '1265', name: 'محفظة إيجار', type: 'أصل', grp: null },
  { code: '1270', name: 'ضريبة مدخلات قابلة للاسترداد', type: 'أصل', grp: null },
  { code: '2410', name: 'أرصدة مستأجرين دائنة', type: 'خصم', grp: null },
  { code: '5900', name: 'فروق تقريب', type: 'مصروف', grp: null },
];

/** قالب نموذج الاستلام والتسليم الافتراضي · منقول حرفياً */
export const HANDOVER_TEMPLATE = [
  { section: 'المدخل / الصالة الرئيسية', items: ['أريكة · عدد المقاعد','طاولة صالة ','طاولات جانبية','تلفزيون','حامل / وحدة تلفزيون','وحدة تحكم تلفاز','مكيف سبلت / شباك','وحدة تحكم مكيف','ستائر','سجاد / موكيت','إضاءة ','لوحات / ديكورات حائطية','مقابس كهرباء وإنترنت ','مفاتيح','أخرى'] },
  { section: 'المطبخ / بوفيه', items: ['ثلاجة','بوتاجاز / موقد','مايكروويف','غسالة أطباق ','خلاط / عصارة','غلاية كهربائية','أواني طبخ ','أطباق وصحون','أكواب وكاسات','أدوات مائدة ','خزائن المطبخ ','حوض المطبخ والخلاط ','شفاط / مروحة تهوية','سلة مهملات','مكيف سبلت / شباك','وحدة تحكم مكيف','مفاتيح','أخرى'] },
  { section: 'غرفة النوم الرئيسية', items: ['سرير ','مرتبة ','دولاب / خزانة ملابس','تسريحة مع مرآة','طاولات جانبية للسرير','تلفزيون ','وحدة تحكم تلفاز','مكيف سبلت / شباك','وحدة تحكم مكيف','ستائر','سجادة','إضاءة','مفروشات السرير ','مفاتيح','أخرى'] },
  { section: 'غرف النوم الإضافية', items: ['سرير ','مرتبة','دولاب ملابس','مكتب / طاولة دراسة ','تلفزيون ','وحدة تحكم تلفاز','مكيف سبلت / شباك','وحدة تحكم مكيف','ستائر','إضاءة','مفاتيح','أخرى'] },
  { section: 'الحمامات', items: ['مرآة','خزانة حمام','سخان مياه','دش / خلاط الاستحمام','مروحة شفط','إكسسوارات ','الحالة العامة للسيراميك والأرضيات','مفاتيح','أخرى'] },
  { section: 'الأجهزة والخدمات العامة', items: ['عداد الكهرباء ','عداد المياه ','مفاتيح الوحدة ','ريموتات التكييف','جهاز إنذار حريق ','خط إنترنت / واي فاي','صندوق كهرباء رئيسي ','أخرى'] },
  { section: 'الحالة العامة للشقة', items: ['الجدران والدهانات','الأبواب والشبابيك','الأرضيات','النظافة العامة','ملاحظات وأضرار سابقة','أخرى'] },
];

/** قوالب الرسائل الافتراضية · منقولة حرفياً */
export const SEED_SCRIPTS = [
  { audience: 'مستأجرون', title: 'ترحيب بمستأجر جديد', body: 'مرحباً بكم مستأجراً جديداً معنا! نتشرف بتعاملكم. للتواصل بخصوص أي استفسار متعلق بالوحدة أو العقد، نحن بخدمتكم على هذا الرقم في أي وقت.' },
  { audience: 'مستأجرون', title: 'تذكير موعد تسليم شيك/دفعة', body: 'نود تذكيركم بأن موعد استحقاق الدفعة القادمة يقترب. يرجى التكرم بترتيب السداد في الموعد المحدد، وشاكرين تعاونكم المستمر.' },
  { audience: 'عملاء', title: 'متابعة عرض سعر', body: 'نأمل إفادتنا بملاحظاتكم على العرض المرسل، ويسعدنا الإجابة عن أي استفسار أو تعديل قد تحتاجونه.' },
  { audience: 'موظفون', title: 'توجيه إجراءات إقفال الشهر', body: 'يرجى التأكد من: 1) مطابقة جميع الحركات البنكية 2) تحديث حالات دفعات الإيجار 3) مراجعة الفواتير المعلّقة 4) تصدير نسخة Excel شاملة وأرشفتها قبل نهاية الشهر.' },
];

/** الإعدادات الافتراضية · مطابقة لـ appSettings في النموذج */
export const DEFAULT_SETTINGS: Record<string, unknown> = {
  remindersOn: true,
  remindPayment: 3,
  remindContract: 30,
  remindDoc: 30,
  backupWeekly: true,
  trashRetention: 30,
  lastExportAt: null,
  lastBackupAt: null,
  displayScale: 100,
  fontScale: 100,
  stripExif: false,
};

export const seedScriptId = (i: number) => 'MS-SEED-' + (i + 1);

export function isSeeded(db: DB): boolean {
  return !!db.get(`SELECT value FROM meta WHERE key = 'seeded'`);
}

/**
 * زرع بيانات أول تشغيل · التطبيق يبدأ فارغاً من السجلات، لا بيانات تجريبية.
 * كل إدراج «إن لم يوجد»: فقاعدة فيها بيانات بلا علامة الزرع (نسخة مولَّدة خارج التطبيق مثلاً)
 * تأخذ ما ينقصها من حسابات النظام والإعدادات ولا يُمسّ ما فيها · وكان الإدراج الصريح يرمي
 * UNIQUE على accounts.code فلا يفتح التطبيق بعد استعادتها.
 */
export function seed(db: DB, now: () => string = () => new Date().toISOString()): void {
  if (isSeeded(db)) return;
  db.transaction(() => {
    const t = now();
    for (const a of [...SEED_ACCOUNTS, ...MIGRATED_SYSTEM_ACCOUNTS]) {
      db.run(
        `INSERT OR IGNORE INTO accounts (code, name, type, grp, opening_halalas, is_system, created_at)
         VALUES (?,?,?,?,0,1,?)`,
        [a.code, a.name, a.type, a.grp, t]
      );
    }
    db.run(
      `INSERT OR IGNORE INTO form_templates (id, name, is_system, sections_json, created_at)
       VALUES ('FT-HANDOVER','نموذج استلام وتسليم',1,?,?)`,
      [JSON.stringify(HANDOVER_TEMPLATE), t]
    );
    // معرّف ثابت لكل قالب افتراضي · فلا يتكرر القالب حين يلتقي جهازان في حساب واحد
    SEED_SCRIPTS.forEach((s, i) => {
      db.run(
        `INSERT OR IGNORE INTO message_scripts (id, audience, category, title, body, created_at)
         VALUES (?,?,?,?,?,?)`,
        [seedScriptId(i), s.audience, 'عام', s.title, s.body, t]
      );
    });
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
      db.run(`INSERT OR IGNORE INTO settings (key, value_json) VALUES (?,?)`, [k, JSON.stringify(v)]);
    }
    db.run(`INSERT OR IGNORE INTO company (id) VALUES (1)`);
    db.run(`INSERT OR IGNORE INTO meta (key, value) VALUES ('seeded','1')`);
    ensureDeviceId(db);
  });
}

/**
 * هوية هذا الجهاز في المزامنة · تخصّ التثبيت لا البيانات: لا تأتي مع نسخة مستعادة (انظر commitRestore)،
 * وتُنشأ إن غابت. جهازان بهوية واحدة يحسب كلٌّ منهما كتابة الآخر صدى نفسه فيتركها.
 */
export function ensureDeviceId(db: DB, keep?: string | null): string {
  if (keep) {
    db.run(`INSERT OR REPLACE INTO meta (key, value) VALUES ('device_id', ?)`, [keep]);
    return keep;
  }
  const cur = db.get<{ value: string }>(`SELECT value FROM meta WHERE key = 'device_id'`);
  if (cur?.value) return cur.value;
  const id = 'b' + uid().slice(0, 7);
  db.run(`INSERT OR REPLACE INTO meta (key, value) VALUES ('device_id', ?)`, [id]);
  return id;
}
