/**
 * الارتباطات المكسورة بين الجداول (المفاتيح الأجنبية) · المراجعة الشاملة 2026-11-13 · C-8:
 * الهجرات تعطّل فحص المفاتيح الأجنبية فتعدّ ما بعدها في meta.fk_violations_after_migrate، ولم يكن يقرؤه أحد · فارتباطٌ مكسور من
 * بنيةٍ قديمة أو نسخةٍ مستعادة لا يظهر إلا لاحقاً بـ«FOREIGN KEY constraint failed» بالإنجليزية عند الحذف أو الكنس ·
 * فيُعرض عدده في «فحص المطابقة»، ويُكتب في تقرير العطل، ويُذكر ملاحظةً في تجهيز الاستعادة (قرار 2026-09-09 «لا تُخفِ الخطأ»).
 */
import type { DB } from '../db/adapter';
import type { IntegrityCheck } from './accounting/integrity';
import { t } from '../i18n';

export const FK_AFTER_MIGRATE_KEY = 'fk_violations_after_migrate';

/** عدد الصفوف التي تشير إلى أصلٍ لا وجود له الآن · وتعذّر الفحص صفر، فلا يُعطّل شاشة ولا استعادة */
export function fkViolationCount(db: DB): number {
  try { return db.all('PRAGMA foreign_key_check').length; } catch { return 0; }
}

/** ما عدّته آخر ترقية · null إن لم تُسجَّل (قاعدة لم تمرّ بهجرة) */
export function fkAfterMigrate(db: DB): number | null {
  try {
    const v = db.get<{ value: string }>(`SELECT value FROM meta WHERE key = ?`, [FK_AFTER_MIGRATE_KEY])?.value;
    return v == null || !/^\d+$/.test(v) ? null : Number(v);
  } catch { return null; }
}

/** سطرٌ في «فحص المطابقة» كأخواته · العدد الآن لا عند آخر ترقية، فما صُحّح بعدها لا يبقى ظاهراً */
export function fkIntegrityCheck(db: DB): IntegrityCheck {
  const n = fkViolationCount(db);
  return { name: t('fk.integrityName'), ok: n === 0, value: t('fk.integrityValue', { n }) };
}
