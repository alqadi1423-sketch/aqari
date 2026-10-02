/**
 * حوار الفشل الموحَّد · كل خطأ في التطبيق يمرّ من هنا.
 *
 * القواعد التي يحملها:
 *  ١) لا نصّ برمجي إنجليزي في وجه المستخدم: رسالة الاستثناء تُعرض إن كانت عربيةً كتبها
 *     الدومين له (قاعدة عمل رُفضت)، وإلا فجملة عربية عامة والنصّ الكامل في الملف والحافظة.
 *  ٢) لا طمأنة بلا فحص: «لم يتغيّر شيء» لا تُقال إلا إن سُلِّمت بصمةٌ قبل العملية وبيئتها،
 *     وطابقت أعدادُ الجداول وخلا مجلد المرفقات من يتيم · وإلا يُذكر ما بقي أو لا يُقال شيء.
 *  ٣) أثر الاستثناء كاملاً يُكتب في ملف في التنزيلات باسم يحمل التاريخ، ويُنسخ بزر.
 * ويعمل من داخل React وخارجها (الخدمات والمعالج العام) لأنه يمرّ بالجسر الأمري للحوار.
 */
import { Share } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { showDialog, type DialogAction } from './AppDialog';
import { showToast } from './Toast';
import { errorReportText, saveErrorReport } from '../services/errorReport';
import { logAudit } from '../domain/audit';
import { describeResidue, type DataFingerprint } from '../domain/backup/create';
import type { BackupEnv } from '../domain/backup/types';
import type { DB } from '../db/adapter';
import { RuleViolation } from '../domain/contracts/service';

export interface FailureArgs {
  /** عنوان الحوار · بالعربية */
  title: string;
  /** الموضع · يُسجَّل ويُكتب في التقرير */
  where?: string;
  e: unknown;
  /** جملة أولى تشرح ما لم يكتمل · إن غابت تُستخرج من الاستثناء إن كان عربياً */
  lead?: string;
  /** للتسجيل في سجل العمليات */
  db?: DB;
  auditModule?: string;
  auditAction?: 'create' | 'update' | 'delete';
  /** بصمة البيانات قبل العملية وبيئتها · بهما وحدهما تُقال «لم يتغيّر شيء» */
  before?: DataFingerprint;
  env?: BackupEnv;
  retry?: () => void;
}

/** الرسالة التي كُتبت للمستخدم عربيةً تُعرض · وما عداها نصّ برمجي لا يُعرض */
const AR = /[؀-ۿ]/;
export function arabicMessage(e: unknown): string {
  const m = e instanceof Error ? e.message : typeof e === 'string' ? e : '';
  return AR.test(m) ? m : '';
}

export async function reportFailure(args: FailureArgs): Promise<void> {
  const { title, e, db, before, env, retry } = args;
  const where = args.where ?? title;
  const full = errorReportText(where, e);
  const lead = args.lead ?? arabicMessage(e);

  // قاعدة عمل رُفضت برسالة عربية كتبها الدومين للمستخدم: تُعرض كما هي · لا تقرير ولا ملف ولا سجل أعطال
  if (e instanceof RuleViolation) {
    showDialog({ title, body: lead || 'رُفض الإجراء.', tone: 'normal', actions: [{ label: 'حسناً', variant: 'ghost' }] });
    return;
  }

  if (db) {
    try {
      logAudit(db, args.auditModule ?? 'الأعطال', args.auditAction ?? 'update', 'فشل ' + where,
        (e instanceof Error ? e.message : String(e)).slice(0, 300));
    } catch { /* السجل لا يعطّل */ }
  }

  let stateLine = '';
  if (before && env) {
    let residue = '';
    try { residue = describeResidue(env, before); } catch { residue = ''; }
    stateLine = residue ? 'وبقي أثر: ' + residue : 'بياناتك الحالية سليمة ولم يتغيّر شيء.';
  }

  const saved = await saveErrorReport(where, e);

  const body = [
    lead || 'لم يكتمل الإجراء.',
    stateLine,
    saved ? 'حُفظت التفاصيل كاملةً في التنزيلات باسم ' + saved : '',
  ].filter(Boolean).join('\n\n');

  const actions: DialogAction[] = [
    { label: 'حسناً', variant: 'ghost' },
    { label: 'نسخ تفاصيل الخطأ', variant: 'ghost', onPress: () => { Clipboard.setStringAsync(full).then(() => showToast('نُسخت التفاصيل')).catch(() => {}); } },
    { label: 'أرسل تقرير الخطأ', variant: 'primary', onPress: () => { Share.share({ message: full }).catch(() => {}); } },
  ];
  if (retry) actions.push({ label: 'أعِد المحاولة', variant: 'primary', onPress: retry });

  showDialog({ title, body, tone: 'normal', actions });
}
