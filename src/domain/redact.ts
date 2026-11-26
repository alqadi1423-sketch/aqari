/**
 * حجب البيانات من نصّ يخرج من الجهاز · دالة خالصة بلا وحدات الجهاز فتُختبر وحدها.
 */

/** سطر من أثر الاستثناء (موضع في الكود) لا من رسالته · Hermes يكتب «at …» وJSC «دالة@ملف» */
const FRAME = /^\s*(at\s|[\w$.<>]*@\S+:\d+)/;

/** كلمات بالحرف العربي متتالية (ومعها فاصل الوصل الصفري) · تُحجب كتلةً واحدة */
const ARABIC_RUN = /[؀-ۿݐ-ݿࢠ-ࣿ]+(?:[\s‌]+[؀-ۿݐ-ݿࢠ-ࣿ]+)*/g;
/**
 * كلمات بحروف الكتابات الأخرى (المدقق الخارجي F٤: اسم مستأجرٍ بالهندية أو البنغالية أو المليالمية كان يصل في الأثر): اللاتينية الموسّعة،
 * واليونانية والسيريلية والأرمنية والعبرية والسريانية والثانا، والهندية كلها وما بعدها حتى الخميرية، والجورجية والإثيوبية والهانغول،
 * والصينية واليابانية والكورية، وعلامات التشكيل الجامعة · تُحجب كتلةً كالعربية
 */
const OTHER_SCRIPT_RUN = /[\u00C0-\u024F\u0300-\u036F\u0370-\u058F\u0590-\u05FF\u0700-\u07BF\u0900-\u0FFF\u1000-\u109F\u10A0-\u10FF\u1100-\u11FF\u1200-\u139F\u1780-\u17FF\u2E80-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\uFF00-\uFFEF]+(?:[\s\u200C]+[\u00C0-\u024F\u0300-\u036F\u0370-\u058F\u0590-\u05FF\u0700-\u07BF\u0900-\u0FFF\u1000-\u109F\u10A0-\u10FF\u1100-\u11FF\u1200-\u139F\u1780-\u17FF\u2E80-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\uFF00-\uFFEF]+)*/g;

/** رقم بفواصله (مبلغ، جوال، هوية، تاريخ) · ولو رقماً واحداً */
const NUMBER = /[+]?\d[\d,.\s٫٬\-/]*\d|\d/g;
const EASTERN_DIGITS = /[٠-٩۰-۹]+/g;
/** كلمات لاتينية متتالية · في السطر العربي وحده */
const LATIN_RUN = /[A-Za-z][\w\-.]*(?:\s+[A-Za-z][\w\-.]*)*/g;
/** كلمةٌ لاتينية في السطر غير العربي · والنقطة داخلها لا في آخرها (آخر الجملة ليس معرّفاً) */
const LATIN_WORD = /[A-Za-z][\w\-]*(?:\.[\w\-]+)*/g;
/** البريد اسمٌ ولو بدا معرّفاً بنقطته (المدقق المستقل للمرحلة ٣ · C-10) */
const EMAIL = /[\w.+\-]+@[\w\-]+(?:\.[\w\-]+)*/g;
/** نوع الخطأ في أول السطر (TypeError: · java.io.IOException:) يبقى */
const ERROR_HEAD = /^\s*(?:[\w$]+\.)*[\w$]*(?:Error|Exception)\b:?\s*/;
/**
 * نصوصٌ تقنية معروفة تبقى في السطر غير العربي (المراجعة الشاملة 2026-11-13 · C-10): رسائل SQLite ورسائل المحرّك والقرص والشبكة ·
 * لا اسم فيها، وهي أنفع ما في الرسالة
 */
const KNOWN_TEXTS = [
  'UNIQUE constraint failed', 'NOT NULL constraint failed', 'FOREIGN KEY constraint failed', 'CHECK constraint failed',
  'PRIMARY KEY must be unique', 'constraint failed', 'no such table', 'no such column', 'no such index', 'no such trigger',
  'has no column named', 'already exists', 'database is locked', 'database table is locked', 'database disk image is malformed',
  'database or disk is full', 'disk I/O error', 'file is not a database', 'attempt to write a readonly database',
  'cannot start a transaction within a transaction', 'cannot commit', 'no transaction is active', 'syntax error', 'near',
  'out of memory', 'interrupted', 'unable to open database file', 'SQL logic error',
  'is not a function', 'is not an object', 'is not a constructor', 'is not defined', 'is undefined', 'is null',
  'Cannot read property', 'Cannot read properties of', 'of undefined', 'of null', 'undefined', 'null',
  'Maximum call stack size exceeded', 'Network request failed', 'Aborted', 'timeout', 'timed out',
  'no space left on device', 'ENOSPC', 'ENOENT', 'EACCES', 'EPERM', 'EEXIST', 'Permission denied', 'write', 'read', 'open',
  'Caused by', 'Unexpected token', 'JSON Parse error', 'in JSON at position',
].sort((a, b) => b.length - a.length);
const KNOWN_RE = new RegExp('\\b(?:' + KNOWN_TEXTS.map((s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')).join('|') + ')\\b', 'g');

/**
 * السطر بلا حرف عربي (واجهة إنجليزية أو رسالة مكتبة · C-10): قد يحمل اسماً لاتينياً بلا علامات · فيُحجب كل ما بعد نوع الخطأ إلا
 * المعرّفات التقنية (فيها «_» أو «.» داخلها) والنصوص المعروفة أعلاه
 */
function maskLatinLine(line: string): string {
  const head = ERROR_HEAD.exec(line)?.[0] ?? '';
  const kept: string[] = [];
  const body = line.slice(head.length)
    .replace(KNOWN_RE, (m) => { kept.push(m); return '\u0000' + (kept.length - 1) + '\u0000'; })
    .replace(LATIN_WORD, (w) => (/[_.]/.test(w) ? w : '…'))
    .replace(/…(?:[\s,'’]+…)+/g, '…')
    .replace(/\u0000(\d+)\u0000/g, (_m, i: string) => kept[Number(i)]);
  return head + body;
}

/**
 * التقرير يخرج من الجهاز (التنزيلات والحافظة ونافذة المشاركة) · فلا يحمل اسماً ولا جوالاً ولا هوية
 * ولا مبلغاً. ورسائل الدومين تُسمّي المستأجر والقسط والمبلغ، فتُحجب من الرسالة:
 * كل كلمة بالحرف العربي، وكل ما بين «» أو علامتي التنصيص، وكل رقم · ويبقى شكل الرسالة الإنجليزية
 * التقنية ونوع الخطأ. وسطور الأثر (مواضع في الكود بأرقام سطورها) تبقى كما هي، فهي أنفع ما في
 * التقرير ولا بيانات فيها.
 */
/**
 * تفاصيل العطل في سجل العمليات المزامَن (المراجعة الخارجية ٧ · النتيجة ٣١): يقرؤه كل من له قسم السجل، ورسالة الدومين تسمّي
 * المستأجر والمبلغ (ولو من عقارٍ محجوب عن القارئ) · فتُحجب كتقرير الملف
 */
export function failureAuditDetail(e: unknown): string {
  return redactForReport(e instanceof Error ? (e.name && e.name !== 'Error' ? e.name + ': ' : '') + e.message : String(e)).slice(0, 300);
}

export function redactForReport(text: string): string {
  return text.split('\n').map((line) => {
    if (FRAME.test(line)) return line;
    // سطرٌ عربي رسالةُ دومين كُتبت للمستخدم · كل كلمة فيه قد تكون اسماً (ولو بحرف لاتيني) فتُحجب كلها
    const domain = /[؀-ۿ]/.test(line);
    let out = line
      .replace(EMAIL, '…')
      .replace(/«[^»]*»/g, '«…»')
      .replace(/"[^"\n]*"/g, '"…"')
      // والتنصيص المنحني كما في نصوص en.json (C-10)
      .replace(/“[^”\n]*”/g, '“…”')
      .replace(/‘[^’\n]*’/g, '‘…’')
      .replace(ARABIC_RUN, '…')
      .replace(OTHER_SCRIPT_RUN, '…')
      .replace(EASTERN_DIGITS, '#')
      .replace(NUMBER, '#');
    if (domain) {
      // نوع الخطأ في أول السطر يبقى (RestoreError:) وما بعده يُحجب
      const head = /^\s*\w*Error:\s*/.exec(out)?.[0] ?? '';
      out = head + out.slice(head.length).replace(LATIN_RUN, '…');
    } else {
      out = maskLatinLine(out);
    }
    return out;
  }).join('\n');
}
