/**
 * جذر ملفات الاختبارات المؤقتة (قرار المالك 2026-10-09: «اجعل الاختبارات تمسح ما تنشئه، وملفاتها المؤقتة على D دائماً»):
 * على ويندوز في D دائماً (القرص C امتلأ بها مرة)، وعلى غيره في مجلد النظام · ويُغيَّر بـ AQARI_TEST_TMP
 * ويُثبَّت الجذر في البيئة عند أول حساب (AQARI_TEST_TMP_ROOT) فيرثه العمّال والاختبارات: على لينكس كان يُحسب ثانيةً من
 * os.tmpdir() بعد أن صار مجلدَ التشغيل نفسه، فيتحرك الجذر ويسقط testTmp (المراجعة الخارجية ٧ · النتيجة ٣٣)
 */
const os = require('os');
const path = require('path');

const TEST_TMP_ROOT = process.env.AQARI_TEST_TMP
  || process.env.AQARI_TEST_TMP_ROOT
  || (process.platform === 'win32' ? 'D:/android-tools/tmp/jtmp' : path.join(os.tmpdir(), 'aqari-tests'));
process.env.AQARI_TEST_TMP_ROOT = TEST_TMP_ROOT;

module.exports = { TEST_TMP_ROOT };
