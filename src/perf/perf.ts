/**
 * قياس الأداء داخل التطبيق: زمن كل انتقال من لحظة اللمس حتى ظهور الشاشة،
 * ومجموع زمن SQL داخله، وأبطأ الاستعلامات · فالقياس يجري على جهاز المستخدم
 * ببياناته الفعلية لا على بيئة تطوير. الأرقام في الذاكرة وتُصفَّر عند إغلاق التطبيق.
 *
 * التسجيل مركزي على حالة الملاحة (perfRouteChanged من مستمع الجذر)، لا خطافات
 * داخل الشاشات: الشاشة الحية التي لا يعاد تركيبها كانت تفلت من خطاف التركيب،
 * فغابت انتقالاتها كلها من التقرير · كل تغيير مسار الآن صف، وكل زيارة ترفع «مرات».
 */

const now = (): number =>
  typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();

/** ساعة القياس نفسها لمن يمرر focusAt من خارج هذه الوحدة */
export const perfNow = now;

export type PerfSample = {
  label: string;
  ms: number;
  /** مجموع زمن SQL منذ اللمسة حتى الظهور */
  sqlMs: number;
  sqlN: number;
  /** تشريح الانتقال: الإصبع (ملامسة حتى رفع) · التوجيه (رفع حتى بدء تصيير
      الوجهة) · التركيب (تصيير الوجهة حتى إيداعها) · والباقي إطارا الرسم */
  finger?: number;
  disp?: number;
  mount?: number;
};

export type SlowQuery = { sql: string; ms: number };

const bootT0 = now();
let bootDone = false;
let pendingTouch = 0;
let pendingUp = 0;
let navRenderMark = 0;
let sqlWinMs = 0;
let sqlWinN = 0;
let lastRoute = '';

/** اسم المسار إلى تسمية عربية · غير المذكور يُعرض باسمه الخام */
const ROUTE_LABELS: Record<string, string> = {
  index: 'الرئيسية',
  properties: 'العقارات',
  contracts: 'العقود',
  collect: 'التحصيل',
  more: 'المزيد',
  accounts: 'دليل الحسابات',
  'audit-log': 'سجل العمليات',
  banks: 'الحسابات البنكية',
  claims: 'المطالبات',
  company: 'بيانات المنشأة',
  'form-templates': 'إنشاء النماذج',
  integrity: 'فحص المطابقة',
  invoices: 'الفواتير',
  journal: 'القيود اليومية',
  library: 'المكتبة',
  perf: 'قياس الأداء',
  propmap: 'خريطة العقارات',
  purchases: 'فواتير الشراء',
  reports: 'التقارير',
  scripts: 'قوالب الرسائل',
  settings: 'الإعدادات',
  suppliers: 'الموردون',
  tenants: 'المستأجرون',
  transactions: 'الحركات البنكية',
  units: 'الوحدات',
};

const samples: PerfSample[] = [];
const slowSql: SlowQuery[] = [];
let listeners: Array<() => void> = [];

function notify() { for (const l of listeners) l(); }

export function subscribePerf(l: () => void): () => void {
  listeners.push(l);
  return () => { listeners = listeners.filter((x) => x !== l); };
}

/** تُستدعى عند بدء كل لمسة (التقاط من الجذر) · لا تحجز اللمسة أبداً */
export function perfTouch(): void {
  pendingTouch = now();
  pendingUp = 0;
  sqlWinMs = 0;
  sqlWinN = 0;
}

/** رفع الإصبع · منه يبدأ الكمون الذي يحسه المستخدم لا من الملامسة */
export function perfTouchUp(): void {
  if (pendingTouch) pendingUp = now();
}

/** يستدعيها جسد تصيير الوجهة عند أول ملاحظة للتغيير · بداية التركيب */
export function perfMarkNavRender(): void {
  navRenderMark = now();
}

/** يسجّلها محوّل القاعدة حول كل استعلام · كتابة سجل القياس نفسه لا تُحسب */
export function perfSqlTick(sql: string, ms: number): void {
  if (sql.includes('perf_log')) return;
  sqlWinMs += ms;
  sqlWinN += 1;
  if (ms >= 8) {
    slowSql.unshift({ sql: sql.replace(/\s+/g, ' ').trim().slice(0, 110), ms: Math.round(ms * 10) / 10 });
    if (slowSql.length > 30) slowSql.pop();
  }
}

/**
 * مخزن دائم للعينات (جدول meta) · فالتقرير ينجو من إغلاق التطبيق وإعادة تشغيله،
 * ولا يضيع تنقّل المستخدم إن قتل النظام العملية قبل فتح شاشة القياس.
 */
type PerfStore = { save(json: string): void; load(): string | null };
let store: PerfStore | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function persist(immediate = false): void {
  if (!store) return;
  if (saveTimer) clearTimeout(saveTimer);
  const write = () => {
    try {
      store?.save(JSON.stringify({ samples: samples.slice(0, 300), slowSql: slowSql.slice(0, 30) }));
    } catch { /* الحفظ ترف · لا يعطل القياس */ }
  };
  if (immediate) write();
  else saveTimer = setTimeout(write, 1200);
}

export function perfAttachStorage(s: PerfStore): void {
  store = s;
  try {
    const raw = s.load();
    if (!raw) return;
    const d = JSON.parse(raw) as { samples?: PerfSample[]; slowSql?: SlowQuery[] };
    if (Array.isArray(d.samples)) samples.push(...d.samples.slice(0, 300));
    if (Array.isArray(d.slowSql)) slowSql.push(...d.slowSql.slice(0, 30));
    notify();
  } catch { /* سجل قديم تالف يُهمل */ }
}

function record(
  label: string, ms: number, sqlMs: number, sqlN: number,
  phases: { finger?: number; disp?: number; mount?: number } = {}
) {
  const r = (v?: number) => (v === undefined ? undefined : Math.round(v));
  samples.unshift({
    label, ms: Math.round(ms), sqlMs: Math.round(sqlMs * 10) / 10, sqlN,
    finger: r(phases.finger), disp: r(phases.disp), mount: r(phases.mount),
  });
  if (samples.length > 300) samples.pop();
  persist();
  notify();
}

/**
 * ظهور شاشة أو ورقة بعد انتقال (تُستدعى بعد إطارَي رسم) · تسجّل الصف دائماً:
 * إن وُجدت لمسة حديثة فالزمن من اللمسة (الكمون الحقيقي الذي يحسه المستخدم)،
 * وإلا (إيماءة نظام أو رجوع بزره) فمن لحظة تغيّر الحالة، فلا تغيب زيارة أبداً.
 */
export function perfScreenShown(label: string, focusAt?: number): void {
  const t = now();
  if (!bootDone) {
    bootDone = true;
    record('الإقلاع حتى «' + label + '»', t - bootT0, sqlWinMs, sqlWinN);
    pendingTouch = 0;
    navRenderMark = 0;
    return;
  }
  // لمسة أقدم من ٨ ثوانٍ (تمرير قديم) ليست لمسة هذا الانتقال
  const touch = pendingTouch && t - pendingTouch <= 8000 ? pendingTouch : 0;
  const up = touch && pendingUp >= touch ? pendingUp : 0;
  const mark = navRenderMark && (!touch || navRenderMark >= touch) ? navRenderMark : 0;
  pendingTouch = 0;
  pendingUp = 0;
  navRenderMark = 0;
  // الكمون المحسوس يبدأ من رفع الإصبع · فزمن الضغطة نفسها ليس تأخيراً من التطبيق
  const t0 = up || touch || focusAt || t;
  const phases = touch
    ? {
        finger: up ? up - touch : undefined,
        disp: up && mark ? mark - up : undefined,
        mount: mark && focusAt !== undefined ? focusAt - mark : undefined,
      }
    : {};
  record(label, t - t0, sqlWinMs, sqlWinN, phases);
}

/**
 * يستدعيها مستمع حالة الملاحة في الجذر عند كل تغيّر ·
 * مسار جديد = انتقال يُقاس، والمسار نفسه (تغيّر معاملات) لا يُكرر.
 */
export function perfRouteChanged(route: string): void {
  // «__root» اسم داخلي يظهر قبل تركيب الملاحة الفعلية · ليس شاشة
  if (!route || route.startsWith('__') || route === lastRoute) return;
  lastRoute = route;
  const label = ROUTE_LABELS[route] ?? route;
  const focusAt = now();
  requestAnimationFrame(() => requestAnimationFrame(() => perfScreenShown(label, focusAt)));
}

/** عينة مسبار يدوية (قياس أقسام شاشة على حدة) · تُسجَّل باسمها وزمنها فقط */
export function perfProbe(label: string, ms: number): void {
  record(label, ms, 0, 0);
}

export function perfData(): { samples: PerfSample[]; slowSql: SlowQuery[] } {
  return { samples: [...samples], slowSql: [...slowSql] };
}

export function perfReset(): void {
  samples.length = 0;
  slowSql.length = 0;
  persist(true);
  notify();
}

export type PerfAgg = {
  label: string; count: number; last: number; avg: number; max: number;
  lastSqlMs: number; lastSqlN: number;
  lastFinger?: number; lastDisp?: number; lastMount?: number;
};

export function perfAggregate(list: PerfSample[]): PerfAgg[] {
  const by = new Map<string, PerfSample[]>();
  for (const s of list) {
    const arr = by.get(s.label) ?? [];
    arr.push(s);
    by.set(s.label, arr);
  }
  const out: PerfAgg[] = [];
  for (const [label, arr] of by) {
    // العينات مخزنة أحدثها أولاً
    const last = arr[0];
    out.push({
      label,
      count: arr.length,
      last: last.ms,
      avg: Math.round(arr.reduce((a, b) => a + b.ms, 0) / arr.length),
      max: Math.max(...arr.map((x) => x.ms)),
      lastSqlMs: last.sqlMs,
      lastSqlN: last.sqlN,
      lastFinger: last.finger,
      lastDisp: last.disp,
      lastMount: last.mount,
    });
  }
  out.sort((a, b) => b.last - a.last);
  return out;
}

/** نص التقرير الذي يُنسخ ويُرسل · كل ما يلزم للتشخيص عن بُعد */
export function perfReport(deviceLine: string): string {
  const { samples: ss, slowSql: qq } = perfData();
  const agg = perfAggregate(ss);
  const L: string[] = ['تقرير أداء عقاري', deviceLine, ''];
  L.push('الانتقالات (م.ث · الهدف أقل من 300):');
  for (const a of agg) {
    const mark = a.last < 300 ? '✓' : '✗';
    const prep = (a.lastDisp ?? 0) + (a.lastMount ?? 0);
    const split = a.lastDisp !== undefined || a.lastMount !== undefined
      ? ` · تجهيز ${prep}`
      : '';
    L.push(`${mark} ${a.label}: آخر ${a.last} · متوسط ${a.avg} · أعلى ${a.max} · مرات ${a.count} · SQL بآخرها ${a.lastSqlMs} م.ث في ${a.lastSqlN} استعلاماً${split}`);
  }
  if (!agg.length) L.push('لا عينات بعد · تنقّل بين الشاشات ثم عد هنا');
  L.push('');
  L.push('أبطأ الاستعلامات (8 م.ث فأكثر):');
  for (const q of qq.slice(0, 12)) L.push(`${q.ms} م.ث · ${q.sql}`);
  if (!qq.length) L.push('لا استعلامات بطيئة');
  return L.join('\n');
}

