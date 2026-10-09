/**
 * قواعد المنشأة في firestore.rules تُولَّد من هنا (docs/PERMISSIONS.md §٣) · فجدول OP_WRITES
 * الذي يتحقق منه tests/opMatrix.test.ts هو نفسه ما يفرضه الخادم. tests/rulesGen.test.ts يُسقط الحزمة
 * إن اختلف الملف عن المولَّد، و UPDATE_RULES=1 يكتبه.
 */
import { OP_WRITES, OP_JOURNAL_SRC } from './opWrites';
import { SECTION_KEYS, type SectionKey } from './sections';
import { SELF_OP, SELF_AUDIT_ENTITY } from './opWrites';
import { ATTACHMENT_ENTITY_TABLE, CROSS_PROPERTY, MONEY_SECTIONS, READ_TABLE, readSectionsOf } from './readSections';
import { SYNC_TABLES } from '../../db/syncTables';

/** ما تحتاجه القواعد من المخطط: أعمدة المبالغ في كل جدول مُزامَن (يبنيه الاختبار من قاعدةٍ مُهاجَرة) */
export interface RulesSchema { money: Record<string, string[]> }

export const BEGIN = '    // <org:generated> · لا تُعدَّل باليد: src/domain/access/rulesGen.ts';
export const END = '    // </org:generated>';

/** أقصى عدد سطور لقيدٍ مرحّل تُملأ أبعاده في السحابة · قاعدةٌ لكل سطر فلا تبلغ حدّ ألف تعبير */
const DIM_LINES_MAX = 24;

const q = (xs: string[]) => '[' + xs.map((x) => `'${x}'`).join(', ') + ']';

function writesFns(): string {
  const entries = Object.entries(OP_WRITES) as Array<[SectionKey, NonNullable<(typeof OP_WRITES)[SectionKey]>]>;
  const create = entries.map(([s, w]) => `(op == '${s}' && t in ${q([...new Set([...w.create, ...w.own])])})`);
  const own = entries.filter(([, w]) => w.own.length).map(([s, w]) => `(op == '${s}' && t in ${q(w.own)})`);
  // الجدول والحقول نفسها في أكثر من قسم سطرٌ واحد بأقسامه · فالسلسلة قصيرة ولا تبلغ حدّ ألف تعبير في الطلب
  // (وجده المحاكي حين دخلت حقول المرفقات اثني عشر قسماً)
  const grouped = new Map<string, { t: string; cols: string[]; ops: string[] }>();
  for (const [s, w] of entries) {
    for (const [t, cols] of Object.entries(w.touch ?? {})) {
      const key = t + '|' + cols.join(',');
      const g = grouped.get(key) ?? { t, cols, ops: [] };
      g.ops.push(s);
      grouped.set(key, g);
    }
  }
  const touch = [...grouped.values()].map((g) => (g.ops.length === 1
    ? `(op == '${g.ops[0]}' && t == '${g.t}' && keys.hasOnly(${q(g.cols)}))`
    : `(t == '${g.t}' && op in ${q(g.ops)} && keys.hasOnly(${q(g.cols)}))`));
  const join = (xs: string[]) => xs.length ? xs.join('\n        || ') : 'false';
  return `
    // ما ينشئه كل قسم (create + own في OP_WRITES)
    function opCreates(op, t) {
      return ${join(create)};
    }
    // جداول القسم نفسه · تعديلها وحذفها بكامل
    function opOwns(op, t) {
      return ${join(own)};
    }
    // حقولٌ بعينها في جداول أقسام أخرى تمسّها العملية جانبياً بإدخال
    function opTouches(op, t, keys) {
      return ${join(touch)};
    }`;
}

/** أقسامٌ قد تقرأ الجدول · رموز الرؤية g لا تخرج عنها (المراجعة #18) */
function readersUnion(t: string): SectionKey[] {
  if (t === 'journal_entries') return [...SECTION_KEYS];
  if (t === 'attachments') return [...new Set<SectionKey>(['library', ...Object.values(ATTACHMENT_ENTITY_TABLE).flatMap((x) => READ_TABLE[x] ?? [])])];
  return readSectionsOf(t, null);
}

/**
 * ثغرات الأعضاء من مراجعة التثبيت (#17 و#18 و#20 و#21) · قرار المالك 2026-10-08
 */
function guardFns(schema: RulesSchema): string {
  const names = SYNC_TABLES.map((t) => t.name);
  // الجدول ونظيره «~pub» · المقارنة بالاسم كما هو بلا تقطيع: للطلب حدّ ألف تعبير، والدالة تعيد حساب وسائطها عند كل استعمال
  const both = (ts: string[]) => q(ts.flatMap((t) => [t, t + '~pub']));
  const special = SYNC_TABLES.filter((t) => !(t.pkCols.length === 1 && t.pkCols[0] === 'id'));
  const keyBranches = special.map((t) => `r.t in ${both([t.name])} ? ${t.pkCols.map((c) => 'r.d.' + c).join(" + '|' + ")} == r.k`);
  // المبالغ: العمليات غير المالية وحدها قد تكتب مبلغاً لا يقرؤه كاتبه، وفي جداولها أعمدتها هذه
  const nonMoneyOps = (Object.keys(OP_WRITES) as SectionKey[]).filter((x) => !MONEY_SECTIONS.has(x));
  const nonMoneyTables = new Set<string>();
  for (const op of nonMoneyOps) {
    const w = OP_WRITES[op]!;
    for (const t of [...w.create, ...w.own, ...Object.keys(w.touch ?? {})]) nonMoneyTables.add(t);
  }
  const nonMoneyCols = [...new Set([...nonMoneyTables].flatMap((t) => schema.money[t] ?? []))].sort();
  const moneyTables = [...nonMoneyTables].filter((t) => (schema.money[t] ?? []).length).sort();
  const readerBranches = moneyTables.map((t) => {
    const secs = readersUnion(t).filter((x) => MONEY_SECTIONS.has(x));
    const toks = q(secs.flatMap((x) => [x + '|*', x + '|@']));
    return `r.t == '${t}' ? ${CROSS_PROPERTY[t] ? 'm.all == true && ' : ''}${secs.length ? `m.tokens.hasAny(${toks})` : 'false'}`;
  });
  // الحقول الجامعة للعقارات في الصف المشترك (مبالغه وCROSS_PROPERTY): لا يكتبها المحصور، ولا تُكتب في إسقاطه (التحقق المستقل)
  const crossMoney = Object.keys(CROSS_PROPERTY).map((t) => ({ t, cols: [...(schema.money[t] ?? []), ...CROSS_PROPERTY[t]] })).filter((x) => x.cols.length);
  const allToks = SECTION_KEYS.flatMap((x) => [`'${x}|' + p`, `'${x}|@'`]);
  // i18n-exempt: نص القواعد المولَّدة وتعليقاتها، لا نصّ واجهة
  return `
    // حراسات كتابة العضو وحده (مراجعة التثبيت #17 و#18 و#20 و#21 · قرار المالك 2026-10-08): المالك لا يُنتحل، وجهازه
    // يرفض الوارد المخالف بنفسه (sync/engine.ts applyOne) · وللطلب حدّ ألف تعبير، فالمقارنة بالاسم كما هو ونظيره ~pub
    // مفتاح الصف داخل d هو مفتاح المستند (#20): فلا يستبدل مستندٌ بمفتاحٍ صفاً آخر عند كل جهاز
    function keyOk(r) {
      return r.del == true || (string(r.d.get('id', null)) == r.k && !(r.t in ${both(special.map((t) => t.name))})) || (
        ${keyBranches.join('\n        : ')}
        : false);
    }
    // مصدر القيد الجديد من قسم العملية (#40): لا ينشئ العضو قيداً لعملية قسمٍ ليس له · والدفتر يدويّه وكل عكس
    function srcOk(op, s) {
      return op == 'ledger' ? (s == null || (s is string && s.matches('.*_rev$')))
        : ${Object.entries(OP_JOURNAL_SRC).map(([op, list]) => `op == '${op}' ? s in ${q(list ?? [])}`).join('\n        : ')}
        : false;
    }
    // بصمة الملف وامتداده بشكلهما (#21): منهما يُبنى مسار الملف على كل جهاز · والمرفق بصمته وحدها (امتداده في blobs)
    function blobShapeOk(r) {
      return r.del == true || !(r.t in ['blobs', 'attachments'])
        || (r.d.sha256 is string && r.d.sha256.matches('^[0-9a-f]{64}$')
            && (r.t == 'attachments' || (r.d.ext is string && r.d.ext.matches('^[a-z0-9]{1,5}$'))));
    }
    // عقارات الصف من حقيقته لا من إعلان كاتبه (#18) · كما يحسبها rowPids في sync/acl.ts، وما يُشتق من صفٍّ آخر
    // يُقرأ من مستند ذلك الصف بعد الدفعة نفسها
    function linked(d, f) {
      return d.get(f, '') is string && d.get(f, '') != '';
    }
    function pidsAt(org, t, id) {
      return getAfter(/databases/$(database)/documents/orgs/$(org)/rows/$(t + '__' + id)).data.pids;
    }
    function pidsBound(org, r) {
      return r.del == true || r.t in ${both(['tenants', 'journal_entries', 'attachments'])} || (
        r.t in ${both(['properties'])} ? r.pids == [r.d.id]
        : r.t in ${both(['meters'])} ? r.pids == (r.d.owner_type == 'property' ? [r.d.owner_id] : pidsAt(org, 'units', r.d.owner_id))
        : r.t in ${both(['asset_events'])} ? r.pids == pidsAt(org, 'assets', r.d.asset_id)
        : r.t in ${both(['purchase_lines'])} ? r.pids == pidsAt(org, 'purchases', r.d.purchase_id)
        : linked(r.d, 'property_id') ? r.pids == [r.d.property_id]
        : linked(r.d, 'unit_id') ? r.pids == pidsAt(org, 'units', r.d.unit_id)
        : linked(r.d, 'contract_id') ? r.pids == pidsAt(org, 'contracts', r.d.contract_id)
        : linked(r.d, 'room_id') ? r.pids == pidsAt(org, 'unit_rooms', r.d.room_id)
        : linked(r.d, 'area_id') ? r.pids == pidsAt(org, 'property_areas', r.d.area_id)
        : linked(r.d, 'payment_id') ? r.pids == pidsAt(org, 'contract_payments', r.d.payment_id)
        : linked(r.d, 'meter_id') ? r.pids == pidsAt(org, 'meters', r.d.meter_id)
        : r.pids == ['*']);
    }
    // روابط الصف التي تحدد عقاره (كما في rowPids): تغيّرها في التعديل يُفحص بحقيقة الصف
    function linksChanged(before, after) {
      return after.d.diff(before.d).affectedKeys().hasAny(['property_id', 'unit_id', 'contract_id', 'room_id', 'area_id', 'payment_id',
        'meter_id', 'owner_id', 'owner_type', 'asset_id', 'purchase_id']);
    }
    // رموز الرؤية لا تخرج عن عقار الصف (#18): «قسم|عقاره» أو «قسم|@» · والمستأجر المشترك بعقاراته
    function gOk(g, p) {
      return g.hasOnly([${allToks.join(', ')}]);
    }
    function gBound(r) {
      return r.t in ${both(['tenants'])} || (r.pids.size() == 1 && gOk(r.g, r.pids[0]));
    }
    // المستأجر المشترك (التحقق المستقل، R1): رؤية مستنده الكامل ثابتة (رموز «قسم|@» لقرّائه الماليين)، ورؤية إسقاطه
    // تزيد برموز عقاره الجديد وحده · فلا يقرأ المحصور رصيده بتغيير رؤيته، ولا يُخفيه عن عقار آخر
    function tenantGOk(before, after) {
      let added = after.pids.removeAll(before.pids);
      // بلا عقار جديد: رؤيته كما هي (لا تُنقص فيُخفى عن غيره) · وبعقاراتٍ جديدة (حتى ثلاثة في رفعٍ واحد) تزيد برموزها وحدها
      return after.t == 'tenants' ? after.g == before.g
        : added.size() == 0 ? after.g == before.g
        : added.size() <= 3 && after.g.hasAll(before.g.removeAll([${readSectionsOf('tenants', null).map((x) => `'${x}|*'`).join(', ')}]))
          && after.g.removeAll(before.g).hasOnly([${readSectionsOf('tenants', null).map((x) => `'${x}|' + added[0]`).join(', ')}]
            .concat(added.size() > 1 ? [${readSectionsOf('tenants', null).map((x) => `'${x}|' + added[1]`).join(', ')}] : [])
            .concat(added.size() > 2 ? [${readSectionsOf('tenants', null).map((x) => `'${x}|' + added[2]`).join(', ')}] : []));
    }
    // المبالغ لا يكتبها ولا يغيّرها عضوٌ لا يقرؤها (#17): يقرأ الإسقاط، فقيمتها عنده افتراضها · keys: ما يكتبه في الإنشاء
    // وما تغيّر في التعديل · ولا يكتب مبلغاً لا يقرؤه إلا قسمٌ غير مالي، أو المحصور في رصيد المستأجر المشترك ·
    // وقارئ المبالغ من رموزه (قسم|* للمحصور، قسم|@ لذي كل العقارات)
    function moneyReaderOf(m, r) {
      return ${readerBranches.length ? readerBranches.join('\n        : ') + '\n        : false' : 'false'};
    }
    function moneyKeysOk(m, r, keys) {
      return (!(r.op in ${q(nonMoneyOps)}) || !keys.hasAny(${q(nonMoneyCols)}) || moneyReaderOf(m, r))
${crossMoney.map((x) => `        && (r.t != '${x.t}' || m.all == true || !keys.hasAny(${q(x.cols)}))`).join('\n')};
    }
    function moneyKept(m, before, after) {
      return after.del == true || (${crossMoney.map((x) => `(after.t != '${x.t}~pub' || !after.d.keys().hasAny(${q(x.cols)}))`).join(' && ') || 'true'}) && (false
        // قسمٌ مالي في غير الصف المشترك: يقرأ ما يكتبه، فلا حاجة إلى حساب الفرق
        || (!(after.op in ${q(nonMoneyOps)}) && !(after.t in ${q(crossMoney.map((x) => x.t))}))
        || moneyKeysOk(m, after, before == null || before.d == null ? after.d.keys() : after.d.diff(before.d).affectedKeys()));
    }`;
}

export function generateOrgRules(schema: RulesSchema = { money: {} }): string {
  return `${BEGIN}
    // صلاحيات الأقسام: المالك (uid == org) يقرأ ويكتب كل شيء بقيود الصف نفسها، والعضو بمستند عضويته
    function orgOwner(org) {
      return request.auth != null && request.auth.uid == org;
    }
    function memberPath(org) {
      return /databases/$(database)/documents/orgs/$(org)/members/$(request.auth.uid);
    }
    function isMember(org) {
      return request.auth != null && exists(memberPath(org));
    }
    function mem(org) {
      return get(memberPath(org)).data;
    }
    function lvl(org, s) {
      return s is string && s in mem(org).perm ? mem(org).perm[s] : 0;
    }
    // بمستند العضو مقروءاً مرة (m = mem(org)) · كتابة العضو تقرؤه مرة وتمرّره، فللطلب حدّ ألف تعبير
    function lvlOf(m, s) {
      return s is string && s in m.perm ? m.perm[s] : 0;
    }
    // الجدول الأصل لمستند الإسقاط (contracts~pub ← contracts)
    function baseT(t) {
      return t.split('~')[0];
    }
    function syncedOrPub(t) {
      return syncedTable(baseT(t)) && (t == baseT(t) || t == baseT(t) + '~pub');
    }
    function isDraft(data) {
      return data.d != null && (
        (baseT(data.t) == 'contracts' && data.d.status == 'مسودة')
        || (data.t == 'invoices' && data.d.status == 'مسودة')
        || (data.t == 'journal_entries' && data.d.status == 'قيد الإنشاء'));
    }
    // عقارات الصف ضمن عقارات العضو · والصف العام '*' مسموح لمن له القسم
    function propsOk(m, r) {
      return m.all == true || r.pids.hasOnly(m.props.concat(['*']));
    }
    // الحقل الجانبي في صفٍّ مشترك (رصيد مستأجرٍ له عقد في عقار آخر): يكفي أن يمسّ الصف عقاراً للعضو
    // وألا تتغيّر عقاراته
    function propsTouch(m, before, after) {
      return m.all == true
        || (after.pids == before.pids && after.pids.hasAny(m.props.concat(['*'])));
    }
${writesFns()}
${guardFns(schema)}

    function validOrgRow(rowId) {
      let r = request.resource.data;
      return r.keys().hasOnly(['t', 'k', 'd', 'lines', 'u', 'dev', 'del', 'ts', 'op', 'g', 'pids', 'by', 'sv'])
        && r.t is string && syncedOrPub(r.t) && (!('lines' in r) || (r.t == 'journal_entries' && r.lines is list))
        && r.k is string && rowId == r.t + '__' + r.k
        && r.u is string && r.dev is string && r.del is bool
        && r.ts == request.time
        && (r.del == true || r.d is map)
        && r.g is list && r.pids is list && r.pids.size() > 0
        && (!('by' in r) || r.by is string)
        && amountsAreIntegers(r);
    }

    // الحد الأدنى لإصدار التطبيق (#36 · قرار المالك 2026-10-09): من يكتب بإصدارٍ أقدم من حدّ المنشأة يُرفض، المالك والعضو
    function svOk(org) {
      let c = /databases/$(database)/documents/orgs/$(org)/meta/compat;
      return !exists(c) || request.resource.data.get('sv', 0) >= get(c).data.min;
    }

    function memberCreates(org) {
      let r = request.resource.data;
      let m = mem(org);
      return isMember(org) && r.op is string && (
        // الحراسات أولاً: المزوَّر يُرفض بها رخيصاً قبل أن يبلغ الطلب حدّ ألف تعبير (المراجعة #17 و#18 و#20 و#21) ·
        // ورموز رؤية الصف الجديد لا تُفحص: كلفتها فوق الحد، وصفوف العضو الجديدة من كتابته هو
        (keyOk(r) && blobShapeOk(r) && pidsBound(org, r) && moneyKept(m, null, r)
          && lvlOf(m, r.op) >= 2 && opCreates(r.op, baseT(r.t)) && propsOk(m, r) && (!('by' in r) || r.by == request.auth.uid)
          // الإقرار المقدَّم للمنشأة كلها: يكتبه ذو كل العقارات وحده (التحقق المستقل)
          && (baseT(r.t) != 'vat_filings' || m.all == true)
          && (r.del == true || baseT(r.t) != 'journal_entries' || srcOk(r.op, r.d.get('src_type', null))))
        // تعديل العضو بياناته يُسجَّل في سجل العمليات باسمه ولو لم يُجز له قسمٌ إدخالاً (توجيه المالك ٢٠٢٦-١٠-٠٥)
        || (r.op == '${SELF_OP}' && r.t == 'audit_log' && r.d != null && r.d.entity_type == '${SELF_AUDIT_ENTITY}' && r.pids == ['*'] && keyOk(r)));
    }

    // كامل في جدول القسم · أو مسودةُ كاتبها بإدخال (قرار المالك) · أو حقولٌ مجازة جانبياً بإدخال
    function memberUpdates(org) {
      let before = resource.data;
      let after = request.resource.data;
      let op = after.op;
      // يُحسبان مرة · سلسلة الجداول والمستوى تُعدّ في حدّ الألف تعبير للطلب
      let m = mem(org);
      let owns = op is string && opOwns(op, baseT(after.t));
      let level = op is string ? lvlOf(m, op) : 0;
      // عقارات الصف ورؤيته كما هي، فلا حاجة إلى فحصهما · ويغيّرهما ذو كل العقارات بحقيقة الصف، والرؤية في المرفق
      // (جهته تحدد قرّاءه) · والمبالغ لقارئها (المراجعة #17 و#18) · الحراسات أولاً، فللطلب حدّ ألف تعبير
      return (before.del == true || after.del == true
          // إحياء شاهد الحذف كالإنشاء: عقاراته بحقيقته · وشاهد الحذف فارغٌ (بلا d، فلا يكشف شيئاً برموز رؤيته) لصفٍّ كان
          // في عقاراته (التحقق المستقل: شاهدٌ يُبقي d برؤية أوسع كان يكشف المبالغ)
          ? (before.del != true || pidsBound(org, after)) && (after.del != true || (after.d == null && propsOk(m, before)))
          : (after.pids == before.pids
              // عقاراته كما هي: روابطه كما هي، أو تغيّرت بحقيقته (وحدةٌ أخرى في عقاره)
              ? (!linksChanged(before, after) || pidsBound(org, after))
              // وتتغيّر بحقيقة الصف لذي كل العقارات وحده (رؤيته لا تُفحص بعدها، فحدّ الألف تعبير لا يسعها: فلا للمحصور) ·
              // والمستأجر المشترك تتبع عقاراته عقوده: كان في متناول العضو، وعقاراته الجديدة من عقاراته السابقة وعقارات العضو
              : ((m.all == true && pidsBound(org, after))
                  || (after.t in ['tenants', 'tenants~pub'] && (m.all == true
                      || (before.pids.hasAny(m.props.concat(['*'])) && after.pids.hasOnly(before.pids.concat(m.props).concat(['*']))
                          // ولا يُسقط عقاراً ليس له (العام '*' يزول بأول عقد)
                          && after.pids.hasAll(before.pids.removeAll(m.props.concat(['*']))))))))
            // ورؤيته كما هي، أو تبعت عقاراته إذ تغيّرت، أو رؤية المرفق (جهته تحدد قرّاءه) في حدود عقاره
            && (after.t in ['tenants', 'tenants~pub'] ? tenantGOk(before, after)
                : (after.g == before.g || after.pids != before.pids || (after.t == 'attachments' && gBound(after)))))
        && keyOk(after) && blobShapeOk(after) && moneyKept(m, before, after)
        && isMember(org) && op is string
        && after.get('by', null) == before.get('by', null)
        && (baseT(after.t) != 'vat_filings' || m.all == true)
        && (
          (owns && level >= 3 && (propsOk(m, after)
              // والمستأجر المشترك بين عقاراته وعقار غيره: عقاراته كما هي وفيها عقارٌ له (التحقق المستقل: تعديله كان يُرفض صامتاً)
              || (after.t in ['tenants', 'tenants~pub'] && after.pids == before.pids && after.pids.hasAny(m.props.concat(['*']))
                  // ولا يحذفه أو يؤرشفه عن عقارٍ ليس له (التحقق المستقل)
                  && !after.d.diff(before.d).affectedKeys().hasAny(['deleted_at', 'archived']))))
          || (owns && level >= 2 && isDraft(before)
              && before.get('by', '') == request.auth.uid && propsOk(m, after))
          // اللمس الجانبي: حقوله وحدها في d، ولا يغيّر من المستند غير d والرؤية وحقول الكتابة (المراجعة #39)
          || (!owns && level >= 2 && after.del == false && before.d != null && propsTouch(m, before, after)
              && after.diff(before).affectedKeys().hasOnly(['d', 'u', 'dev', 'ts', 'op', 'g'])
              && opTouches(op, baseT(after.t), after.d.diff(before.d).affectedKeys()))
        );
    }

    // التعديل الوحيد على قيد مرحّل: ربطه بعاكسه مرة · وحقول الرؤية تُكتب مع كل كتابة
    function orgOnlyLinksReversal() {
      let before = resource.data;
      let after = request.resource.data;
      return after.diff(before).affectedKeys().hasOnly(['d', 'u', 'dev', 'ts', 'op', 'g', 'pids'])
        && after.d.diff(before.d).affectedKeys().hasOnly(['reversed_by'])
        && (!('reversed_by' in before.d) || before.d.reversed_by == null)
        && after.d.reversed_by is string;
    }

    // وجهاز المالك يعيد كتابة حقول الرؤية وحدها على قيد مرحّل حين يتسع قرّاؤه (engine.requeueForAcl) · ومحتواه كما هو
    function orgOnlyVisibility() {
      return request.resource.data.diff(resource.data).affectedKeys().hasOnly(['u', 'dev', 'ts', 'op', 'g', 'pids']);
    }

    // وجهاز المالك يملأ أبعاد سطور القيد المرحّل القديم (الهجرة ٢٨) · السطور بعددها وبكل حقولها كما هي إلا أبعادها
    function lineDimsOnly(a, b) {
      return a.diff(b).affectedKeys().hasOnly(['property_id', 'unit_id', 'contract_id', 'cost_center_id', 'asset_id']);
    }
    function orgOnlyLineDims() {
      let a = request.resource.data.lines;
      let b = resource.data.lines;
      return request.resource.data.diff(resource.data).affectedKeys().hasOnly(['lines', 'u', 'dev', 'ts', 'op', 'g', 'pids'])
        && a.size() == b.size() && b.size() <= ${DIM_LINES_MAX}
${Array.from({ length: DIM_LINES_MAX }, (_, i) => `        && (b.size() <= ${i} || lineDimsOnly(a[${i}], b[${i}]))`).join('\n')};
    }

    // «حذف حسابي» للمالك: نافذة ساعة بطلبٍ بوقت الخادم كما في users/{uid}
    function orgDeletionOpen(org) {
      let p = /databases/$(database)/documents/orgs/$(org)/meta/deletion;
      return exists(p) && request.time < get(p).data.at + duration.value(1, 'h');
    }

    match /orgs/{org} {
      allow read, write: if orgOwner(org);

      match /rows/{rowId} {
        allow read: if orgOwner(org) || (isMember(org) && resource.data.g.hasAny(mem(org).tokens));
        allow create: if validOrgRow(rowId) && svOk(org) && (orgOwner(org) || memberCreates(org));
        allow update: if validOrgRow(rowId) && svOk(org)
          && resource.data.t != 'audit_log'
          && (!isPostedEntry(resource.data) || orgOnlyLinksReversal() || (orgOwner(org) && (orgOnlyVisibility() || orgOnlyLineDims())))
          && (orgOwner(org) || memberUpdates(org));
        allow delete: if orgOwner(org) && orgDeletionOpen(org);
      }

      // بيانات العضو (توجيه المالك ٢٠٢٦-١٠-٠٥): الجوال سعودي موحَّد والهوية عشرة أرقام أولها ١ أو ٢،
      // ويجوز تركها فارغة عند الدعوة ليكملها العضو · والهوية لا تُقرأ إلا من مستند العضوية (المالك والعضو وحدهما)
      function profileShape(d) {
        return (!('name' in d) || (d.name is string && d.name.size() <= 80))
          && (!('phone' in d) || (d.phone is string && (d.phone == '' || d.phone.matches('^05[0-9]{8}$'))))
          && (!('nid' in d) || (d.nid is string && (d.nid == '' || d.nid.matches('^[12][0-9]{9}$'))))
          && (!('title' in d) || (d.title is string && d.title.size() <= 60));
      }
      // ما يكمله العضو بنفسه: الاسم والجوال إلزاميان
      function profileComplete(d) {
        return profileShape(d) && d.name is string && d.name.size() >= 2 && d.phone is string && d.phone.matches('^05[0-9]{8}$');
      }

      // العضوية: يكتبها المالك · والعضو ينشئ عضويته مرة من دعوةٍ بإيميله وبنصّها حرفياً، ويعدّل بياناته وحدها،
      // ويغادر بحذفها
      match /members/{uid} {
        allow read: if orgOwner(org) || (request.auth != null && request.auth.uid == uid);
        allow create: if (orgOwner(org) && profileShape(request.resource.data)) || (
          request.auth != null && request.auth.uid == uid && request.auth.token.email_verified == true
          && exists(/databases/$(database)/documents/orgs/$(org)/invites/$(request.auth.token.email))
          && request.resource.data == get(/databases/$(database)/documents/orgs/$(org)/invites/$(request.auth.token.email)).data
          // والدعوة تُحذف في الالتزام نفسه: لا تبقى فتُعيد العضو بعد إزالته (مراجعة التثبيت #36)
          && !existsAfter(/databases/$(database)/documents/orgs/$(org)/invites/$(request.auth.token.email)));
        allow update: if (orgOwner(org) && profileShape(request.resource.data)) || (
          request.auth != null && request.auth.uid == uid
          && request.resource.data.diff(resource.data).affectedKeys().hasOnly(['name', 'phone', 'nid', 'title'])
          && profileComplete(request.resource.data));
        allow delete: if orgOwner(org) || (request.auth != null && request.auth.uid == uid);
      }

      match /invites/{email} {
        // بإيميلٍ متحقَّق وحده (مراجعة التثبيت #41: لو فُعّل مزوّدٌ يقبل غير المتحقق)
        allow read: if orgOwner(org) || (request.auth != null && request.auth.token.email_verified == true && request.auth.token.email == email);
        // لا دعوة لإيميل المالك نفسه
        allow create, update: if orgOwner(org) && request.resource.data.email == email
          && email != request.auth.token.email && profileShape(request.resource.data);
        allow delete: if orgOwner(org) || (request.auth != null && request.auth.token.email_verified == true && request.auth.token.email == email);
      }

      // حروف الأجهزة في ترقيم المنشأة · العضو يضيف حرف جهازه ولا يغيّر حرفاً قائماً
      match /meta/devices {
        allow read: if orgOwner(org) || isMember(org);
        allow create: if orgOwner(org);
        allow update: if orgOwner(org) || (isMember(org)
          && request.resource.data.keys().hasOnly(['letters'])
          && request.resource.data.letters.diff(resource.data.letters).changedKeys().size() == 0
          && request.resource.data.letters.diff(resource.data.letters).removedKeys().size() == 0);
      }

      // عهد المسح: يرفعه المالك عند «مسح كل البيانات» فيفرّغ كل جهاز نسخته عند أول مزامنة
      match /meta/epoch {
        allow read: if orgOwner(org) || isMember(org);
        allow write: if orgOwner(org) && request.resource.data.keys().hasOnly(['n', 'at']) && request.resource.data.n is int;
      }

      // الحد الأدنى لإصدار التطبيق (#36): يرفعه جهاز المالك ولا يُخفَض، ويقرؤه العضو قبل المزامنة
      match /meta/compat {
        allow read: if orgOwner(org) || isMember(org);
        allow create, update: if orgOwner(org) && request.resource.data.keys().hasOnly(['min']) && request.resource.data.min is int
          && (resource == null || request.resource.data.min >= resource.data.min);
        allow delete: if orgOwner(org);
      }

      // سجل نقل الوحدات بين العقارات · العضو يقرؤه ليعرف هل خرجت وحدةٌ من عقاراته
      match /meta/moves {
        allow read: if orgOwner(org) || isMember(org);
        allow write: if orgOwner(org) && request.resource.data.keys().hasOnly(['moves']) && request.resource.data.moves is list;
      }

      // عدّاد الترقيم (numbering.ts): آخر رقمٍ محجوز لكل سلسلة · يحجز منه المالك والعضو كتلاً، وتأخذ منه الفاتورة
      // الضريبية رقمها · ولا ينقص عددٌ ولا يُحذف أبداً، فلا يُعطى رقمٌ مرتين
      function counterOk(d, b, k) {
        return !(k in d) || (d[k] is int && d[k] >= 0 && (b == null || !(k in b) || d[k] >= b[k]));
      }
      function countersOk(d, b) {
        return d.keys().hasOnly(['JE', 'EJ', 'PUR', 'INV'])
          && counterOk(d, b, 'JE') && counterOk(d, b, 'EJ') && counterOk(d, b, 'PUR') && counterOk(d, b, 'INV')
          && (b == null || d.keys().hasAll(b.keys()));
      }
      match /meta/counters {
        allow read: if orgOwner(org) || isMember(org);
        allow create: if (orgOwner(org) || isMember(org)) && countersOk(request.resource.data, null);
        allow update: if (orgOwner(org) || isMember(org)) && countersOk(request.resource.data, resource.data);
      }

      match /meta/deletion {
        allow read, delete: if orgOwner(org);
        allow create, update: if orgOwner(org)
          && request.resource.data.keys().hasOnly(['at']) && request.resource.data.at == request.time;
      }
    }

    // العضو يجد دعوته بإيميله بين المنشآت
    match /{path=**}/invites/{email} {
      allow read: if request.auth != null && request.auth.token.email_verified == true && resource.data.email == request.auth.token.email;
    }
${END}`;
}

/** يستبدل الكتلة المولَّدة في نص القواعد · وإن غابت أُدرجت قبل إغلاق documents */
export function spliceRules(rules: string, schema: RulesSchema = { money: {} }): string {
  const gen = generateOrgRules(schema);
  const a = rules.indexOf(BEGIN);
  const b = rules.indexOf(END);
  if (a >= 0 && b > a) return rules.slice(0, a) + gen + rules.slice(b + END.length);
  const anchor = rules.lastIndexOf('  }\n}');
  if (anchor < 0) throw new Error('لم يُعثر على نهاية documents في firestore.rules');
  return rules.slice(0, anchor) + '\n' + gen + '\n' + rules.slice(anchor);
}
