/**
 * المراجعة الشاملة 2026-11-13 · E-3 (الجزء الأصلي): الودجت تقرأ جدول الأيام · آخر يومٍ في `ahead` لم يتجاوز اليوم، وإلا أرقام اللقطة،
 * وبعد `validUntil` لا أرقام بل «آخر تحديث … · افتح التطبيق» · الاختيار في كوتلن (`pickAheadIndex`) ومثيلته هنا (`pickWidgetDay`)،
 * واختبارٌ يقرأ ملف كوتلن نصاً فلا يفترقان · بيانات مصطنعة، والمبالغ بالهللات.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { memDb } from './helpers/testDb';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { confirmContract } from '@/domain/contracts/service';
import { buildWidgetSnapshot } from '@/services/widgetSnapshot';
import { fmt } from '@/domain/money';
import { pickWidgetDay, widgetNumbersOn, widgetShortDay, type WidgetDaySource } from '@/domain/widgetAhead';

const row = (day: string, lateCount: number) => ({ day, lateCount, lateSum: `${lateCount}.00`, dueThisMonth: '9.00', paidThisMonth: '0.00', monthPct: 0 });
const snap: WidgetDaySource = {
  day: '2026-11-28', validUntil: '2027-01-27',
  lateCount: 1, lateSum: '1.00', dueThisMonth: '5.00', paidThisMonth: '4.00', monthPct: 80,
  ahead: [row('2026-12-01', 1), row('2026-12-02', 3), row('2026-12-20', 4)],
};
const days = snap.ahead!.map((a) => a.day);

describe('E-3 · pickWidgetDay', () => {
  test('قبل أول يومٍ في الجدول: أرقام اللقطة نفسها', () => {
    expect(pickWidgetDay('2026-11-28', snap.day, snap.validUntil!, days)).toBe(-1);
    expect(pickWidgetDay('2026-11-30', snap.day, snap.validUntil!, days)).toBe(-1);
    expect(widgetNumbersOn(snap, '2026-11-30')).toMatchObject({ stale: false, lateCount: 1, paidThisMonth: '4.00', monthPct: 80 });
  });
  test('اليوم نفسه في الجدول: يومه', () => {
    expect(pickWidgetDay('2026-12-01', snap.day, snap.validUntil!, days)).toBe(0);
    expect(pickWidgetDay('2026-12-02', snap.day, snap.validUntil!, days)).toBe(1);
    expect(widgetNumbersOn(snap, '2026-12-02')).toMatchObject({ stale: false, lateCount: 3, lateSum: '3.00', dueThisMonth: '9.00' });
  });
  test('بين يومين: آخرهما قبله', () => {
    expect(pickWidgetDay('2026-12-10', snap.day, snap.validUntil!, days)).toBe(1);
  });
  test('بعد آخر يومٍ وقبل validUntil: آخر يوم · وvalidUntil نفسه يصحّ', () => {
    expect(pickWidgetDay('2027-01-05', snap.day, snap.validUntil!, days)).toBe(2);
    expect(pickWidgetDay('2027-01-27', snap.day, snap.validUntil!, days)).toBe(2);
  });
  test('بعد validUntil: لا أرقام · «آخر تحديث» بيوم اللقطة', () => {
    expect(pickWidgetDay('2027-01-28', snap.day, snap.validUntil!, days)).toBeNull();
    expect(widgetNumbersOn(snap, '2027-01-28')).toEqual({ stale: true, day: '2026-11-28' });
    expect(widgetShortDay('2026-11-28')).toBe('28/11');
    expect(widgetShortDay('2026-12-03')).toBe('03/12');
  });
  test('لقطة إصدارٍ سابق بلا validUntil ولا ahead: تصحّ ليومها وحده', () => {
    const old: WidgetDaySource = { day: '2026-11-28', lateCount: 0, lateSum: '0.00', dueThisMonth: '5.00', paidThisMonth: '5.00', monthPct: 100 };
    expect(widgetNumbersOn(old, '2026-11-28')).toMatchObject({ stale: false, lateCount: 0 });
    expect(widgetNumbersOn(old, '2026-12-03')).toEqual({ stale: true, day: '2026-11-28' });
  });
  test('الجدول غير مرتّب لا يغيّر الاختيار', () => {
    expect(pickWidgetDay('2026-12-10', snap.day, snap.validUntil!, ['2026-12-20', '2026-12-02', '2026-12-01'])).toBe(1);
  });
});

describe('E-3 · من اللقطة المبنية فعلاً', () => {
  const T = '2026-11-28';
  function setup() {
    const db = memDb();
    const p = addProperty(db, { name: 'عقار مصطنع' });
    // ٥٠٠,٠٠٠ هللة شهرياً لكلٍّ: الأولى من أول نوفمبر (قسط نوفمبر متأخر)، والثانية من أول ديسمبر
    confirmContract(db, contractInput(addUnit(db, p, { unit_no: '12' }), { start: '2026-11-01', end: '2027-10-31', valueHalalas: 6_000_000, depositHalalas: 0 }));
    confirmContract(db, contractInput(addUnit(db, p, { unit_no: '14' }), { idNumber: '1000000019', start: '2026-12-01', end: '2027-11-30', valueHalalas: 6_000_000, depositHalalas: 0 }));
    return db;
  }

  test('يوم 3 ديسمبر بلا فتحٍ للتطبيق: ثلاث متأخرة بـ1,500,000 لا «لا دفعات متأخرة» ولا أرقام نوفمبر', () => {
    const db = setup();
    const s = buildWidgetSnapshot(db, T);
    expect(widgetNumbersOn(s, '2026-12-03')).toMatchObject({ stale: false, lateCount: 3, lateSum: fmt(1_500_000), dueThisMonth: fmt(1_000_000) });
    expect(widgetNumbersOn(s, '2027-02-01')).toEqual({ stale: true, day: T });
    db.close();
  });

  test('القفل مفعّل: أعداد اليوم وحدها بلا مبالغ', () => {
    const db = setup();
    const s = buildWidgetSnapshot(db, T, undefined, { locked: true });
    expect(widgetNumbersOn(s, '2026-11-29')).toEqual({ stale: false, lateCount: 1, lateSum: '', dueThisMonth: '', paidThisMonth: '', monthPct: 0 });
    expect(widgetNumbersOn(s, '2026-12-03')).toEqual({ stale: false, lateCount: 3, lateSum: '', dueThisMonth: '', paidThisMonth: '', monthPct: 0 });
    db.close();
  });
});

describe('E-3 · كوتلن ومثيلتها لا تفترقان (فحصٌ ثابت · لا يُبنى أندرويد هنا)', () => {
  const kt = fs.readFileSync(path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'java', 'com', 'aqari', 'app', 'AqariWidgets.kt'), 'utf8');
  const strings = fs.readFileSync(path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'res', 'values', 'strings.xml'), 'utf8');
  const blockAfter = (src: string, at: number): string => {
    const open = src.indexOf('{', at);
    let depth = 0;
    for (let i = open; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) return src.slice(open + 1, i);
    }
    return src.slice(open + 1);
  };
  const pickFn = blockAfter(kt, kt.indexOf('internal fun pickAheadIndex('));
  const read = blockAfter(kt, kt.indexOf('internal fun readSnapshot('));

  test('pickAheadIndex موجودة بمنطق pickWidgetDay نفسه', () => {
    expect(kt).toMatch(/internal fun pickAheadIndex\(today: String, day: String, validUntil: String, aheadDays: List<String>\): Int\?/);
    expect(pickFn).toMatch(/val until = if \(validUntil\.isNotBlank\(\)\) validUntil else day/);
    expect(pickFn).toMatch(/if \(until\.isNotBlank\(\) && today > until\) return null/);
    expect(pickFn).toMatch(/d\.isNotBlank\(\) && d <= today && \(best < 0 \|\| d >= aheadDays\[best\]\)/);
    expect(kt).toMatch(/SimpleDateFormat\("yyyy-MM-dd", Locale\.US\)/);
  });

  test('readSnapshot تقرأ أسماء الحقول التي يكتبها widgetSnapshot.ts', () => {
    const db = memDb();
    const p = addProperty(db, { name: 'عقار مصطنع' });
    confirmContract(db, contractInput(addUnit(db, p, { unit_no: '12' }), { start: '2026-11-01', end: '2027-10-31', valueHalalas: 6_000_000, depositHalalas: 0 }));
    const s = buildWidgetSnapshot(db, '2026-11-28');
    db.close();
    expect(Object.keys(s)).toEqual(expect.arrayContaining(['day', 'ahead', 'validUntil']));
    expect(s.ahead.length).toBeGreaterThan(0);
    expect(read).toContain('o.optString("day", "")');
    expect(read).toContain('o.optJSONArray("ahead")');
    expect(read).toContain('o.optString("validUntil", "")');
    expect(read).toMatch(/pickAheadIndex\(localToday\(\), day, o\.optString\("validUntil", ""\), aheadDays\)/);
    // مفتاح اليوم في كل مدخل، وكل حقلٍ في المدخل يُقرأ من المدخل المختار (src) لا من اللقطة
    expect(read).toContain('optJSONObject(i)?.optString("day", "")');
    for (const k of Object.keys(s.ahead[0]).filter((x) => x !== 'day')) {
      expect(read).toMatch(new RegExp(`src\\.opt(Int|String)\\("${k}"`));
    }
  });

  test('البائتة تسبق القفل والمبالغ في الودجتين، وسلسلتها معرَّفة بلا شرطة', () => {
    for (const cls of ['TodayStripWidget', 'CollectionPanelWidget']) {
      const body = blockAfter(kt, kt.indexOf('class ' + cls));
      const at = body.search(/if \(s\.stale\)/);
      expect(at).toBeGreaterThan(-1);
      expect(at).toBeLessThan(body.search(/if \(s\.locked\)/));
      const branch = blockAfter(body, at);
      expect(branch).toMatch(/R\.string\.widget_stale, shortDay\(s\.day\)/);
      expect(branch).not.toMatch(/s\.(lateSum|dueThisMonth|paidThisMonth|monthPct|lateCount)\b/);
    }
    expect(strings).toMatch(/<string name="widget_stale">آخر تحديث %1\$s · افتح التطبيق<\/string>/);
  });
});
