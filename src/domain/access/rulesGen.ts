/**
 * قواعد المنشأة في firestore.rules تُولَّد من هنا (docs/PERMISSIONS.md §٣) · فجدول OP_WRITES
 * الذي يتحقق منه tests/opMatrix.test.ts هو نفسه ما يفرضه الخادم. tests/rulesGen.test.ts يُسقط الحزمة
 * إن اختلف الملف عن المولَّد، و UPDATE_RULES=1 يكتبه.
 */
import { OP_WRITES } from './opWrites';
import type { SectionKey } from './sections';
import { SELF_OP, SELF_AUDIT_ENTITY } from './opWrites';

export const BEGIN = '    // <org:generated> · لا تُعدَّل باليد: src/domain/access/rulesGen.ts';
export const END = '    // </org:generated>';

const q = (xs: string[]) => '[' + xs.map((x) => `'${x}'`).join(', ') + ']';

function writesFns(): string {
  const entries = Object.entries(OP_WRITES) as Array<[SectionKey, NonNullable<(typeof OP_WRITES)[SectionKey]>]>;
  const create = entries.map(([s, w]) => `(op == '${s}' && t in ${q([...new Set([...w.create, ...w.own])])})`);
  const own = entries.filter(([, w]) => w.own.length).map(([s, w]) => `(op == '${s}' && t in ${q(w.own)})`);
  const touch: string[] = [];
  for (const [s, w] of entries) {
    for (const [t, cols] of Object.entries(w.touch ?? {})) touch.push(`(op == '${s}' && t == '${t}' && keys.hasOnly(${q(cols)}))`);
  }
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

export function generateOrgRules(): string {
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
    function propsOk(org, r) {
      return mem(org).all == true || r.pids.hasOnly(mem(org).props.concat(['*']));
    }
    // الحقل الجانبي في صفٍّ مشترك (رصيد مستأجرٍ له عقد في عقار آخر): يكفي أن يمسّ الصف عقاراً للعضو
    // وألا تتغيّر عقاراته
    function propsTouch(org, before, after) {
      return mem(org).all == true
        || (after.pids == before.pids && after.pids.hasAny(mem(org).props.concat(['*'])));
    }
${writesFns()}

    function validOrgRow(rowId) {
      let r = request.resource.data;
      return r.keys().hasOnly(['t', 'k', 'd', 'lines', 'u', 'dev', 'del', 'ts', 'op', 'g', 'pids', 'by'])
        && r.t is string && syncedOrPub(r.t) && (!('lines' in r) || (r.t == 'journal_entries' && r.lines is list))
        && r.k is string && rowId == r.t + '__' + r.k
        && r.u is string && r.dev is string && r.del is bool
        && r.ts == request.time
        && (r.del == true || r.d is map)
        && r.g is list && r.pids is list && r.pids.size() > 0
        && (!('by' in r) || r.by is string)
        && amountsAreIntegers(r);
    }

    function memberCreates(org) {
      let r = request.resource.data;
      return isMember(org) && r.op is string && (
        (lvl(org, r.op) >= 2 && opCreates(r.op, baseT(r.t)) && propsOk(org, r) && (!('by' in r) || r.by == request.auth.uid))
        // تعديل العضو بياناته يُسجَّل في سجل العمليات باسمه ولو لم يُجز له قسمٌ إدخالاً (توجيه المالك ٢٠٢٦-١٠-٠٥)
        || (r.op == '${SELF_OP}' && r.t == 'audit_log' && r.d != null && r.d.entity_type == '${SELF_AUDIT_ENTITY}' && r.pids == ['*']));
    }

    // كامل في جدول القسم · أو مسودةُ كاتبها بإدخال (قرار المالك) · أو حقولٌ مجازة جانبياً بإدخال
    function memberUpdates(org) {
      let before = resource.data;
      let after = request.resource.data;
      let op = after.op;
      return isMember(org) && op is string
        && after.get('by', null) == before.get('by', null)
        && (
          (opOwns(op, baseT(after.t)) && lvl(org, op) >= 3 && propsOk(org, after))
          || (opOwns(op, baseT(after.t)) && lvl(org, op) >= 2 && isDraft(before)
              && before.get('by', '') == request.auth.uid && propsOk(org, after))
          || (lvl(org, op) >= 2 && after.del == false && before.d != null && propsTouch(org, before, after)
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

    // «حذف حسابي» للمالك: نافذة ساعة بطلبٍ بوقت الخادم كما في users/{uid}
    function orgDeletionOpen(org) {
      let p = /databases/$(database)/documents/orgs/$(org)/meta/deletion;
      return exists(p) && request.time < get(p).data.at + duration.value(1, 'h');
    }

    match /orgs/{org} {
      allow read, write: if orgOwner(org);

      match /rows/{rowId} {
        allow read: if orgOwner(org) || (isMember(org) && resource.data.g.hasAny(mem(org).tokens));
        allow create: if validOrgRow(rowId) && (orgOwner(org) || memberCreates(org));
        allow update: if validOrgRow(rowId)
          && resource.data.t != 'audit_log'
          && (!isPostedEntry(resource.data) || orgOnlyLinksReversal())
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
          && request.resource.data == get(/databases/$(database)/documents/orgs/$(org)/invites/$(request.auth.token.email)).data);
        allow update: if (orgOwner(org) && profileShape(request.resource.data)) || (
          request.auth != null && request.auth.uid == uid
          && request.resource.data.diff(resource.data).affectedKeys().hasOnly(['name', 'phone', 'nid', 'title'])
          && profileComplete(request.resource.data));
        allow delete: if orgOwner(org) || (request.auth != null && request.auth.uid == uid);
      }

      match /invites/{email} {
        allow read: if orgOwner(org) || (request.auth != null && request.auth.token.email == email);
        // لا دعوة لإيميل المالك نفسه
        allow create, update: if orgOwner(org) && request.resource.data.email == email
          && email != request.auth.token.email && profileShape(request.resource.data);
        allow delete: if orgOwner(org) || (request.auth != null && request.auth.token.email == email);
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

      match /meta/deletion {
        allow read, delete: if orgOwner(org);
        allow create, update: if orgOwner(org)
          && request.resource.data.keys().hasOnly(['at']) && request.resource.data.at == request.time;
      }
    }

    // العضو يجد دعوته بإيميله بين المنشآت
    match /{path=**}/invites/{email} {
      allow read: if request.auth != null && resource.data.email == request.auth.token.email;
    }
${END}`;
}

/** يستبدل الكتلة المولَّدة في نص القواعد · وإن غابت أُدرجت قبل إغلاق documents */
export function spliceRules(rules: string): string {
  const gen = generateOrgRules();
  const a = rules.indexOf(BEGIN);
  const b = rules.indexOf(END);
  if (a >= 0 && b > a) return rules.slice(0, a) + gen + rules.slice(b + END.length);
  const anchor = rules.lastIndexOf('  }\n}');
  if (anchor < 0) throw new Error('لم يُعثر على نهاية documents في firestore.rules');
  return rules.slice(0, anchor) + '\n' + gen + '\n' + rules.slice(anchor);
}
