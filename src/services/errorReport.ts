/**
 * تفاصيل الخطأ كاملةً في ملف يقرؤه صاحب الجهاز.
 *
 * ولمَ ملف: السجل الداخلي يحفظ ثلاثمئة حرف من الرسالة، وأثر الاستثناء وحده يتجاوزها
 * أضعافاً · فيضيع الموضع الذي وقع فيه العطل وهو أنفع ما في التقرير كلّه. فيُكتب
 * الأثر كاملاً في مجلد التنزيلات باسمٍ يحمل تاريخه، ويبقى نصّه في الحافظة بزرّ.
 */
import { Platform } from 'react-native';
import { saveErrorLogNative } from './intents';
import { appDataRoot, expoFs } from '../files/expoFs';
import { joinPath } from '../files/fsAdapter';
import { redactForReport } from '../domain/redact';
import { toLocalISODate } from '../domain/dates';

export { redactForReport };

const enc = new TextEncoder();

/** بادئة الاسم وشكله · تطابقهما الشاشة الأصلية حرفاً بحرف قبل أن تنقل الملف */
function reportName(at: Date): string {
  // بالساعة المحلية وبالشكل نفسه yyyy-mm-dd-hh-mm-ss (المراجعة ٤.١٤)
  const p2 = (n: number) => String(n).padStart(2, '0');
  const stamp = toLocalISODate(at) + '-' + p2(at.getHours()) + '-' + p2(at.getMinutes()) + '-' + p2(at.getSeconds());
  return `عقاري · خطأ · ${stamp}.txt`;
}

/** نصّ التقرير · عناوينه عربية ومتنه أثر الاستثناء محجوبةً بياناتُه */
export function errorReportText(where: string, e: unknown, at: Date = new Date()): string {
  const stack = e instanceof Error ? (e.stack ?? (e.name + ': ' + e.message)) : String(e);
  // في Hermes يبدأ الأثر بسطر الرسالة · وإن لم يحملها أُضيف نوع الخطأ وحده
  return [
    'تقرير خطأ · عقاري',
    'الموضع: ' + where,
    'الوقت: ' + at.toISOString(),
    'المنصّة: ' + Platform.OS,
    'النوع: ' + (e instanceof Error ? e.name : typeof e),
    '────────────────',
    redactForReport(stack),
  ].join('\n');
}

/**
 * يكتب التقرير في المؤقت ثم ينادي الشاشة الأصلية لتنقله إلى التنزيلات.
 * يعيد اسم الملف إن تمّ، وفارغاً إن تعذّر · ولا يرمي أبداً فهو مسار خطأ أصلاً.
 */
export async function saveErrorReport(where: string, e: unknown): Promise<string> {
  if (Platform.OS !== 'android') return '';
  // التنزيلات تُكتب عبر MediaStore بلا إذن من أندرويد ١٠ · وما دونه يحتاج إذن الكتابة المحذوف،
  // فلا يُحفظ تلقائياً ويبقى زرّ «أرسل تقرير الخطأ» في الحوار: نافذة المشاركة تحفظه حيث يختار المستخدم
  if (Number(Platform.Version) < 29) return '';
  try {
    const at = new Date();
    const name = reportName(at);
    const dir = joinPath(appDataRoot(), 'tmp');
    expoFs.mkdirp(dir);
    expoFs.write(joinPath(dir, name), enc.encode(errorReportText(where, e, at)));
    await saveErrorLogNative(name);
    return name;
  } catch {
    return '';
  }
}
