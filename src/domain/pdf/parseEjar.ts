/**
 * قراءة عقد إيجار من نص PDF · منطق النموذج منقول كما هو:
 * - الاستخراج مبنيّ على التسميات الإنجليزية الثابتة.
 * - الهوية والجوال من مقطع المستأجر وحده بين Tenant Data و Tenant Representative Data.
 * - كشف الاتجاه يجري على النص الخام قبل أي تطبيع: أشكال العرض العربية دليلٌ قاطع
 *   والتطبيع NFKC يمحوها · وعند غيابها يحكم المرجّح الثاني بالكلمات المرجعية وأداة التعريف.
 * - العكس يجري قبل التطبيع NFKC · لأن ﻻ حرف واحد ينفكّ إلى حرفين.
 * - ثم تُلمّ المسافات المبعثرة في اللاتيني وحده: «M ain» تصير «Main».
 * - نزع تسمية «الاسم» الملتصقة دون قصّ أسماء تنتهي بـ«سم» مثل «قاسم» و«الاسمري».
 */

import { normalizePhone } from '../phone';

const AR_FWD = ['الهوية', 'المستأجر', 'العقد', 'تاريخ', 'الجوال', 'الوحدة', 'قيمة', 'المؤجر', 'السجل'];
const AR_REV = AR_FWD.map((w) => [...w].reverse().join(''));

export function arabicIsReversed(t: string): boolean {
  let f = 0, r = 0;
  AR_FWD.forEach((w) => { f += t.split(w).length - 1; });
  AR_REV.forEach((w) => { r += t.split(w).length - 1; });
  if (r !== f) return r > f;
  // التعادل: أداة التعريف · الكلمة السليمة تبدأ بـ«ال» ولا تنتهي بـ«لا»
  const words = t.match(/[؀-ۿ]{3,}/g) || [];
  let st = 0, en = 0;
  words.forEach((w) => {
    if (w.indexOf('ال') === 0) st++;
    if (w.slice(-2) === 'لا') en++;
  });
  return en > st;
}

/**
 * الدليل القاطع على النص البصري: أشكال العرض العربية U+FB50..U+FEFC.
 * لا يصحّ كشفها إلا على النص الخام: التطبيع NFKC يردّها حروفاً عادية فيمحو الدليل.
 * (U+FEFF مستثنى فهو علامة ترتيب البايتات لا حرفاً عربياً.)
 * فإن غلبت الأشكالُ الحروفَ العادية فالنص بصري · وإلا حكم المرجّح الثاني
 * `arabicIsReversed` بالكلمات المرجعية وأداة التعريف، وهو أدق حين لا أشكال أصلاً.
 */
export function arabicIsVisual(raw: string): boolean {
  const s = String(raw || '');
  const forms = (s.match(/[ﭐ-ﻼ]/g) || []).length;
  const plain = (s.match(/[ء-ي]/g) || []).length;
  if (forms > plain) return true;
  // نزع التشكيل والتطويل وحدهما · بلا تطبيع كي لا يضيع ما بقي من دليل
  return arabicIsReversed(s.replace(/[ً-ْـ]/g, ''));
}

/**
 * لمّ المسافات المبعثرة في النص اللاتيني وحده · العربي لا يُمسّ.
 * القاعدة الآمنة: حرف كبير مفرد ثم مسافة واحدة ثم صغيرٌ ملتصق بكلمة، فيُلمّان:
 * «M ain» تصير «Main» و«M obile» تصير «Mobile».
 * وكلمة مفردة حقيقية لا تُلصق: «Building A 5» و«a new» تبقيان كما هما.
 * ثم يُعاد الفصل عند حدّ الحرف الكبير: «ContractNo.» تصير «Contract No.».
 */
export function fixLatinSpaces(s: string): string {
  if (!s || !/[A-Za-z]/.test(s)) return s;
  return s
    .replace(/(^|[^A-Za-z])([A-Z]) (?=[a-z][A-Za-z])/g, '$1$2')
    .replace(/([a-z])([A-Z])/g, '$1 $2');
}

export function reverseArabicRuns(s: string): string {
  return s
    .split('\n')
    .map((line) =>
      line.replace(/[؀-ۿﭐ-﻿][؀-ۿﭐ-﻿\s]*/g, (m) =>
        [...m].reverse().join('')
      )
    )
    .join('\n');
}

/**
 * الترتيب الملزم ثلاث خطوات: كشف الاتجاه على الخام (لا على مُطبَّع فيضيع دليل الأشكال)،
 * ثم العكس فالتطبيع NFKC ونزع التشكيل والتطويل، ثم لمّ المسافات اللاتينية.
 */
export function fixArabicOrder(s: string, force?: boolean): string {
  if (!s) return s;
  const rev = force !== undefined ? force : arabicIsVisual(s);
  const src = rev ? reverseArabicRuns(s) : s;
  return fixLatinSpaces(src.normalize('NFKC').replace(/[ً-ْـ]/g, ''));
}

/** نزع تسمية «الاسم» دون قصّ «قاسم» و«الاسمري» · مطابقة الرمز الكامل فقط */
export function cleanArabicName(s: string, force?: boolean): string {
  let v = fixArabicOrder(s, force);
  v = v.replace(/[:\-،]/g, ' ');
  v = v.replace(/[اإآ]?الاسم\s*$/, '').replace(/^\s*[اإآ]?الاسم/, '');
  const toks = v.split(/\s+/).filter(Boolean);
  const isLabel = (w: string) => /^[اإآ]*ل?[اإآ]*سم$/.test(w);
  // التسمية مقسومةً على كلمتين («الا سم») تُنزع معاً · ظهرت ملتصقة بآخر الاسم (أعطال قراءة العقد ٢٠٢٦-١٠-٠٧)
  const isLabel2 = (a?: string, b?: string) => !!a && !!b && isLabel(a + b);
  for (;;) {
    if (isLabel2(toks[0], toks[1])) toks.splice(0, 2);
    else if (toks.length && isLabel(toks[0])) toks.shift();
    else if (isLabel2(toks[toks.length - 2], toks[toks.length - 1])) toks.splice(-2, 2);
    else if (toks.length && isLabel(toks[toks.length - 1])) toks.pop();
    else break;
  }
  return toks.join(' ').trim();
}

export interface EjarParseResult {
  contractNo?: string;
  tenant?: string;
  idNumber?: string;
  phone?: string;
  start?: string;
  end?: string;
  /** بالهللات */
  valueHalalas?: number;
  /** بالهللات */
  depositHalalas?: number;
  cycle?: string;
  months?: number;
  durationSelect?: string;
  /** الاسم خرج بلا مسافات (مستخرج يبتلعها) · يجب مراجعته يدوياً قبل الحفظ */
  nameNeedsReview?: boolean;
  /** جدول الدفعات كما في الملف · غيابه = تعذّرت قراءته فتُحسب الأقساط وينبَّه عليها */
  schedule?: ScheduleRow[];
  found: string[];
}

/**
 * صفّ من جدول دفعات إيجار: تاريخ الاستحقاق الميلادي، وآخر مهلة السداد إن كانت في الصف، ومبلغه بالهللات ·
 * (أعطال قراءة العقد ٢٠٢٦-١٠-٠٧: كانت المهلة تُقرأ استحقاقاً)
 */
export interface ScheduleRow { dueDate: string; deadline?: string | null; amountHalalas: number }

const GREG = /(20\d{2})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])/g;
const HIJRI = /1[34]\d{2}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|30)/g;
const AMOUNT = /\d{1,3}(?:,\d{3})+\.\d{2}|\d+\.\d{2}/;
/** عنوان الجدول بالعربية أو الإنجليزية · بعد نزع المسافات، وبالترتيبين */
const SCHEDULE_ANCHORS = [/rentpayments?schedule/i, /payments?schedule/i, /جدولسدادالدفعات/, /جدولالدفعات/, /جدولسداد/];

/**
 * جدول الدفعات من نصّ ملف إيجار (قرار المالك ٢٠٢٦-١٠-٠٥) · يبدأ بعد عنوان الجدول، وكل صفّ سطرٌ فيه تاريخ ميلادي
 * ومبلغ عشري. في الصف تاريخان ميلاديان: الاستحقاق ونهاية مهلة السداد، وترتيب أعمدتهما في النص المستخرج يتبع
 * الرسم لا القراءة (ظهرت المهلة أولاً) · فالأبكر هو الاستحقاق والأبعد آخر المهلة، أياً كان ترتيبهما. وأول مبلغ بعد
 * نزع التواريخ (الميلادية والهجرية) هو قيمته، فلا يختلط يومٌ ملتصق بمبلغ. ينتهي الجدول بأول سطر نصّي بعد صفوفه. يُرفض كله إن خرج تاريخ عن مدة العقد أو لم يتصاعد،
 * فالجدول المقروء خطأً أسوأ من المحسوب.
 */
export function parseEjarSchedule(raw: string): ScheduleRow[] | null {
  const t = String(raw || '');
  const tf = flatLatin(t);
  const st = tf.match(/TenancyStartDate:?(\d{4}-\d{2}-\d{2})/i)?.[1];
  const en = tf.match(/TenancyEndDate:?(\d{4}-\d{2}-\d{2})/i)?.[1];
  const lines = t.split('\n').map((l) => l.normalize('NFKC').replace(/\s+/g, ''));
  const isAnchor = (l: string) => SCHEDULE_ANCHORS.some((re) => re.test(l) || re.test([...l].reverse().join('')));
  const from = lines.findIndex(isAnchor);
  if (from < 0) return null;
  const rows: ScheduleRow[] = [];
  for (let i = from + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const gregs = [...line.matchAll(GREG)].map((m) => m[0]);
    const rest = line.replace(GREG, '|').replace(HIJRI, '|');
    const amt = rest.match(AMOUNT);
    if (gregs.length && amt) {
      const v = parseFloat(amt[0].replace(/,/g, ''));
      if (!(v > 0)) return null;
      const sorted = [...gregs].sort();
      const due = sorted[0];
      const deadline = sorted.length > 1 && sorted[sorted.length - 1] > due ? sorted[sorted.length - 1] : null;
      rows.push({ dueDate: due, deadline, amountHalalas: Math.round(v * 100) });
    } else if (rows.length && /[A-Za-z\u0600-\u06FF]{3,}/.test(line)) break; // نهاية الجدول: أول نصّ بعد صفوفه
  }
  if (!rows.length) return null;
  for (let i = 0; i < rows.length; i++) {
    const d = rows[i].dueDate;
    if ((st && d < st) || (en && d > en)) return null;
    if (i && d < rows[i - 1].dueDate) return null;
  }
  return rows;
}

/**
 * المبدأ الواحد الذي يقطع سلالة الأنماط:
 * المسافة في نصّ PDF المستخرَج ليست معلومة يُعتمد عليها · تُحذف كلها قبل المطابقة.
 * فسيّان أكانت سليمة (Tenant Data) أم مبتلعة (TenantData) أم مبعثرة (M obile · Nam e).
 * الاسم وحده يُؤخذ من النص الأصلي (مسافاته قد تعود من هندسة الملف)، وإن غاب
 * أُخذ من المسطّح ملتصقاً مع «راجع الاسم» · الاسم الناقص خير من فراغ.
 */
export const flatLatin = (x: string): string => x.normalize('NFKC').replace(/[ \t]+/g, '');

export interface AnchorCheck { label: string; ok: boolean; sample: string }

/** تشخيص الأنكرات على نصّ خام · لزرّ الفحص تحت «عرض النص المستخرج» */
export function anchorDiagnostics(raw: string): AnchorCheck[] {
  const tf = flatLatin(String(raw || ''));
  const probe = (label: string, re: RegExp): AnchorCheck => {
    const m = tf.match(re);
    return { label, ok: !!m, sample: m ? String(m[1] ?? m[0]).slice(0, 40) : '' };
  };
  return [
    probe('رقم العقد', /(?:^|[^A-Za-z])ContractNo\.?:?(\d+\/[\d-]+)/i),
    probe('مقطع المستأجر', /TenantData/i),
    probe('رقم الهوية', /IDNo\.?:?(\d{8,12})/i),
    probe('رقم الجوال', /MobileNo\.?:?\+?(\d{9,15})/i),
    probe('تاريخ البداية', /TenancyStartDate:?(\d{4}-\d{2}-\d{2})/i),
    probe('تاريخ النهاية', /TenancyEndDate:?(\d{4}-\d{2}-\d{2})/i),
    probe('قيمة العقد', /Total(?:Contract|rent)value:?([\d,\.]+)/i),
    probe('التأمين', /SecurityDeposit[\s\S]{0,200}?(?:([\d,]+\.\d{2})|(-):)/i),
    (() => {
      const sch = parseEjarSchedule(String(raw || ''));
      return { label: 'جدول الدفعات', ok: !!sch, sample: sch ? sch.length + ' قسطاً · أولها ' + sch[0].dueDate : '' };
    })(),
  ];
}

export function parseEjarContract(raw: string): EjarParseResult {
  // الخام كما هو · التطبيع يؤجَّل إلى ما بعد الكشف والعكس، فأشكال العرض دليل الاتجاه
  // ولو طُبّع هنا لانفكّ ﻻ إلى حرفين قبل العكس فانقلب ترتيبهما في «الامير» و أمثالها
  const t = String(raw || '');
  // النسخة المسطّحة للمطابقة · flatLatin يطبّع بنفسه · الأسطر تبقى حدوداً
  const tf = flatLatin(t);
  const found: string[] = [];
  const out: EjarParseResult = { found };
  const pick = <K extends keyof EjarParseResult>(k: K, v: EjarParseResult[K] | null | undefined) => {
    if (v != null && v !== '') {
      (out as unknown as Record<string, unknown>)[k as string] = v;
      found.push(k as string);
    }
  };
  const num = (x: string | undefined) =>
    x ? parseFloat(String(x).replace(/[,،\s]/g, '')) : null;

  // مقطع من المسطّح بحدود مسطّحة
  const segFlat = (a: string, b?: string): string => {
    const fa = flatLatin(a).toLowerCase();
    const low = tf.toLowerCase();
    const i = low.indexOf(fa);
    if (i < 0) return '';
    const j = b ? low.indexOf(flatLatin(b).toLowerCase(), i + 1) : -1;
    return tf.slice(i, j > i ? j : i + 900);
  };
  // ومقطع من الأصل (للاسم · مسافاته قد تكون سليمة من هندسة الملف)
  const segRaw = (a: string, b?: string): string => {
    const re = (x: string) => new RegExp(x.replace(/ /g, '\\s*'), 'i');
    const i = t.search(re(a));
    if (i < 0) return '';
    const rest = b ? t.slice(i + 1).search(re(b)) : -1;
    const j = rest >= 0 ? rest + i + 1 : -1;
    return t.slice(i, j > i ? j : i + 900);
  };

  // رقم العقد · الحارس [^A-Za-z] يمنع مطابقة MainContractNo الملتصقة
  let m = tf.match(/(?:^|[^A-Za-z])ContractNo\.?:?(\d+\/[\d-]+)/i);
  if (!m) {
    const all = [...tf.matchAll(/ContractNo\.?:?([\d\/-]{6,})/gi)].map((x) => x[1]);
    const ws = all.find((x) => x.includes('/'));
    if (ws) m = [null as unknown as string, ws] as unknown as RegExpMatchArray;
  }
  pick('contractNo', m ? m[1] : null);

  // مقطع المستأجر وحده · فلا يختلط بممثل المؤجر أو الوسيط
  const tn = segFlat('Tenant Data', 'Tenant Representative Data');
  const tnRaw = segRaw('Tenant Data', 'Tenant Representative Data');
  const revDoc = arabicIsVisual(t);

  // الاسم: من الأصل أولاً (مسافاته قد تعود من الهندسة) · وإلا فمن المسطّح ملتصقاً مع مراجعة
  let tenantName = '';
  const nmRaw = tnRaw.match(/Nam?\s*e([^\n]+)/i);
  if (nmRaw) tenantName = cleanArabicName(nmRaw[1], revDoc);
  if (!tenantName) {
    const nmFlat = tn.match(/Name([^\n]+)/i);
    if (nmFlat) tenantName = cleanArabicName(nmFlat[1], revDoc);
  }
  if (tenantName) {
    pick('tenant', tenantName);
    if (tenantName.split(/\s+/).length < 2 && tenantName.length > 8) out.nameNeedsReview = true;
  }

  const idm = tn.match(/IDNo\.?:?(\d{8,12})/i);
  pick('idNumber', idm ? idm[1] : null);
  const mob = tn.match(/MobileNo\.?:?\+?(\d{9,15})/i);
  if (mob) pick('phone', normalizePhone(mob[1]) ?? undefined);

  const st = tf.match(/TenancyStartDate:?(\d{4}-\d{2}-\d{2})/i);
  pick('start', st ? st[1] : null);
  const en = tf.match(/TenancyEndDate:?(\d{4}-\d{2}-\d{2})/i);
  pick('end', en ? en[1] : null);

  // قيمة العقد «كامل قيمة الإيجار» لا «إجمالي قيمة العقد» (قرار المالك ٢٠٢٦-١٠-٠٧) · والخدمات والمواقف فوقها
  const v = tf.match(/Totalrentvalue:?([\d,\.]+)/i) || tf.match(/TotalContractvalue:?([\d,\.]+)/i);
  const vNum = v ? num(v[1]) : null;
  // المبالغ أعداد موجبة · غير ذلك رقم مكسور لا يُلتقط
  pick('valueHalalas', vNum != null && vNum > 0 ? Math.round(vNum * 100) : null);

  // التأمين: رقم عشري، أو «-» تعني صفراً لا فراغاً
  const dep = tf.match(/SecurityDeposit[\s\S]{0,200}?(?:([\d,]+\.\d{2})|(-):)/i);
  if (dep) {
    if (dep[1] != null) {
      const dNum = num(dep[1]);
      if (dNum != null && dNum >= 0) { out.depositHalalas = Math.round(dNum * 100); found.push('depositHalalas'); }
    } else if (dep[2] != null) {
      out.depositHalalas = 0;
      found.push('depositHalalas');
    }
  }

  const cy = tf.match(/Rentpaymentcycle:?([^\n]{0,60})/i);
  if (cy) {
    // الدورية قد تخرج معكوسة مستقلة عن اتجاه بقية النص · والمسافات منزوعة أصلاً
    const candidates = [fixArabicOrder(cy[1], revDoc), fixArabicOrder(cy[1], !revDoc)]
      .map((c) => c.replace(/\s+/g, ''));
    const map: Array<[RegExp, string]> = [
      [/نصفسنوي/, 'نصف سنوية'],
      [/ربعسنوي/, 'ربع سنوية'],
      [/شهري/, 'شهرية'],
      [/سنوي/, 'سنوية'],
    ];
    outer:
    for (const c of candidates) {
      for (const [re, val] of map) if (re.test(c)) { pick('cycle', val); break outer; }
    }
  }

  const sch = parseEjarSchedule(t);
  if (sch) { out.schedule = sch; found.push('schedule'); }

  if (out.start && out.end) {
    const months = Math.round(
      (new Date(out.end).getTime() - new Date(out.start).getTime()) / 2629800000
    );
    out.months = months;
    found.push('months');
    out.durationSelect = [3, 6, 12, 24, 36].includes(months) ? String(months) : '';
  }
  return out;
}

/**
 * اقتراح تقسيم اسم التصق بلا مسافات · اقتراح لا فرض · يُعرض على المستخدم فيقبله أو يرفضه.
 * الأنماط: «بن/بنت/عبد» كلمات مستقلة، و«ال» في آخر مقطع تبدأ اسم القبيلة،
 * والاسم الأول عادة ٣-٦ أحرف. يعيد null إن لم يجد تقسيماً معقولاً.
 */
export function suggestNameSplit(raw: string): string | null {
  const t = raw.trim();
  if (!t || /\s/.test(t) || t.length < 8 || !/^[\u0600-\u06FF]+$/.test(t)) return null;

  // بن/بنت/عبد كلمات مستقلة (بنت قبل بن كي لا تبتلعها)
  let parts: string[] = [t];
  for (const marker of ['بنت', 'بن', 'عبد']) {
    const next: string[] = [];
    for (const seg of parts) {
      if (seg === 'بن' || seg === 'بنت' || seg === 'عبد') { next.push(seg); continue; }
      let rest = seg;
      let idx = rest.indexOf(marker, 2);
      while (idx > -1 && rest.length - idx - marker.length >= 2) {
        next.push(rest.slice(0, idx), marker);
        rest = rest.slice(idx + marker.length);
        idx = rest.indexOf(marker, 2);
      }
      next.push(rest);
    }
    parts = next.filter(Boolean);
  }

  // آخر مقطع طويل: «ال» الأخيرة تبدأ اسم القبيلة
  const lastIdx = parts.length - 1;
  const last = parts[lastIdx];
  if (last.length >= 8 && !['بن', 'بنت', 'عبد'].includes(last)) {
    const cut = last.lastIndexOf('ال');
    if (cut >= 3 && last.length - cut >= 4) {
      parts.splice(lastIdx, 1, last.slice(0, cut), last.slice(cut));
    }
  }

  // أول مقطع طويل بلا علامة: اسمان أول (٣-٦ أحرف لكلٍّ)
  if (parts[0].length >= 6 && parts[0].length <= 12) {
    const len = parts[0].length;
    const first = Math.min(6, Math.max(3, Math.ceil(len / 2)));
    if (len - first >= 3) parts.splice(0, 1, parts[0].slice(0, first), parts[0].slice(first));
  }

  const suggestion = parts.join(' ');
  return suggestion !== t && parts.length >= 2 ? suggestion : null;
}
