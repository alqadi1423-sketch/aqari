/**
 * القاعدة ١٢: تفاصيل الوحدة والعقار تُدخَل عند الإنشاء فقط،
 * ونماذج الاستلام تُبنى منها آلياً · منطق buildSectionsFromUnit في النموذج.
 */
import type { DB } from '../../db/adapter';

export interface HandoverItem {
  name: string;
  count: string;
  receiveCondition: string;
  deliverCondition: string;
  notes: string;
}
export interface HandoverSection {
  section: string;
  items: HandoverItem[];
}

const blank = (name: string): HandoverItem => ({
  name, count: '', receiveCondition: '', deliverCondition: '', notes: '',
});

/** بناء أقسام النموذج من غرف الوحدة وأقسام عقارها · وإلا null (فيُستخدم القالب) */
export function buildSectionsFromUnit(db: DB, unitId: string): HandoverSection[] | null {
  const u = db.get<{ id: string; property_id: string }>(
    `SELECT id, property_id FROM units WHERE id = ? AND deleted_at IS NULL`, [unitId]
  );
  if (!u) return null;
  const secs: HandoverSection[] = [];

  const rooms = db.all<{ id: string; room_name: string }>(
    `SELECT id, room_name FROM unit_rooms WHERE unit_id = ? ORDER BY sort`, [unitId]
  );
  for (const r of rooms) {
    const items = db.all<{ name: string; descr: string }>(
      `SELECT name, descr FROM unit_room_items WHERE room_id = ? ORDER BY sort`, [r.id]
    );
    // بنود الغرفة كما أدخلها المستخدم وحدها · ولا تُزرع بنود لم يكتبها
    const names = items.map((it) => (it.descr ? it.name + ' · ' + it.descr : it.name));
    if (names.length) secs.push({ section: r.room_name, items: names.map(blank) });
  }

  const areas = db.all<{ id: string; area_name: string }>(
    `SELECT id, area_name FROM property_areas WHERE property_id = ? ORDER BY sort`, [u.property_id]
  );
  for (const a of areas) {
    const items = db.all<{ name: string; descr: string }>(
      `SELECT name, descr FROM property_area_items WHERE area_id = ? ORDER BY sort`, [a.id]
    );
    const names = items.map((it) => (it.descr ? it.name + ' · ' + it.descr : it.name));
    if (names.length) secs.push({ section: 'مشترك: ' + a.area_name, items: names.map(blank) });
  }

  if (!secs.length) return null;
  secs.push({
    section: 'العدادات والمفاتيح',
    items: ['عداد الكهرباء ', 'عداد المياه ', 'مفاتيح الوحدة ', 'ريموتات التكييف'].map(blank),
  });
  secs.push({ section: 'الحالة العامة', items: ['النظافة العامة', 'ملاحظات وأضرار سابقة'].map(blank) });
  return secs;
}

/**
 * القالب الذي يكمّل النموذج الآلي · لا قالب يُزرع (قرار المالك ٢٠٢٦-١٠-٠٥): قالب الإصدارات السابقة إن عدّله
 * المستخدم فبقي، وإلا أقدم قوالب المستخدم · وإلا لا قالب.
 */
export function defaultHandoverTemplate(db: DB): string | null {
  return db.get<{ id: string }>(
    `SELECT id FROM form_templates WHERE deleted_at IS NULL ORDER BY (id = 'FT-HANDOVER') DESC, created_at, id LIMIT 1`
  )?.id ?? null;
}

/** سبب تعذّر نموذج الاستلام والتسليم لعقدٍ لا نموذج له ولا ما يُبنى منه */
export const NO_HANDOVER_SOURCE = 'لا يُنشأ نموذج الاستلام والتسليم: لا قالب له، ولا غرف ولا بنود في تفاصيل الوحدة';

/** أقسام القالب (المختار أو الأول) كبنود فارغة للتعبئة · بلا قالب: لا أقسام */
export function sectionsFromTemplate(db: DB, templateId: string | null): HandoverSection[] {
  const pick = (id: string | null) => id ? db.get<{ sections_json: string }>(
    `SELECT sections_json FROM form_templates WHERE id = ? AND deleted_at IS NULL`, [id]) : undefined;
  const row = pick(templateId) ?? pick(defaultHandoverTemplate(db));
  const raw = row ? (JSON.parse(row.sections_json) as Array<{ section: string; items: string[] }>) : [];
  return raw.map((s) => ({ section: s.section, items: s.items.map(blank) }));
}

/**
 * أقسام نموذج جديد: يُبنى من غرف الوحدة المُدخلة ويُكمَّل بالقالب المرجعي ·
 * أقسام القالب التي لا يقابلها قسم من الوحدة تُلحق بعده، فلا يسقط بند من الفحص المتبادل.
 */
export function buildHandoverSections(db: DB, unitId: string | null, templateId: string | null): HandoverSection[] {
  const template = sectionsFromTemplate(db, templateId);
  const auto = unitId ? buildSectionsFromUnit(db, unitId) : null;
  if (!auto) return template;
  const covered = new Set(auto.map((s) => s.section.replace(/\s+/g, '')));
  const missing = template.filter((t) => {
    const key = t.section.replace(/\s+/g, '');
    // قسم القالب مغطى إن طابق اسمُه قسماً من الوحدة أو احتواه
    return ![...covered].some((c) => c.includes(key) || key.includes(c));
  });
  return [...auto, ...missing];
}

/** التذييل النظامي · يُطبع في كل نموذج ولا يُحذف */
export const HANDOVER_LEGAL_FOOTER =
  'يُقرّ الطرفان بأنهما قد فحصا جميع المحتويات المذكورة أعلاه فحصاً متبادلاً دقيقاً، ' +
  'وأن كل نقص أو تلف قد أُثبت في خانة الملاحظات الخاصة بكل بند.';
