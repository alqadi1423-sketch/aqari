/**
 * الإعدادات · تفضيلات لا أماكن (الأماكن في «المزيد») · صفحة واحدة بثماني بطاقات بترتيب المالك:
 * الحساب والمزامنة · النسخ الاحتياطي · المالية · التنبيهات · ودجت الشاشة · البيانات والمساحة ·
 * عن التطبيق · ومسح كل البيانات آخرها بطاقةً حمراء. كل صفٍّ: أيقونة واسم وقيمته الحالية وسهم،
 * وضغطه يفتح الخيارات في لوحة سفلية بدل أزرار الاختيار المتراصّة.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { View, Modal, Pressable } from 'react-native';
import Slider from '@react-native-community/slider';
import { useRouter } from 'expo-router';
import { Screen } from '../src/ui/Screen';
import {
  Card, CardTitle, T, Num, BtnPrimary, BtnGhost, Note, Row, Badge, EmptyState, Field,
} from '../src/ui/components';
import { Sheet, PickerSheet, SelectField } from '../src/ui/Sheet';
import { Icon, type IconName } from '../src/ui/icons';
import { DateField } from '../src/ui/DateField';
import { useDialog } from '../src/ui/AppDialog';
import { useApp } from '../src/ui/store';
import { useToast } from '../src/ui/Toast';
import { C, TYPE } from '../src/ui/theme';
import { exportStatus } from '../src/domain/reminders';
import { trashItems, restoreFromTrash, purgeFromTrash, restoreAllFromTrash, deleteAllFromTrash } from '../src/domain/trash';
import { createAndShareBackup, pickAndPrepareRestore, commitPreparedRestore, abortPreparedRestore, appBackupEnv } from '../src/services/backupService';
import { wipeAllData } from '../src/domain/wipe';
import { fingerprintData } from '../src/domain/backup/create';
import {
  planLedgerRepair, applyLedgerRepair, unbookedDiscounts, bookDiscount, contractSurpluses, settleSurplus,
  type UnbookedDiscount, type ContractSurplus,
} from '../src/domain/ledgerReview';
import { toHalalas } from '../src/domain/money';
import { DISCOUNT_AFTER_DUE, DISCOUNT_REDUCES_INSTALLMENT, type DiscountKind } from '../src/domain/contracts/installments';
import { fmt } from '../src/domain/money';
import { rescheduleAllNotifications } from '../src/services/notifications';
import { SCHEMA_VERSION } from '../src/db/schema';
import { storageBreakdown, sweepCache, reclaimStorage } from '../src/services/storageOps';
import { libSizeLabel } from '../src/domain/library';
import { reportFailure, arabicMessage } from '../src/ui/failureDialog';
import {
  cloudState, subscribeCloud, cloudSignIn, cloudSignOut, backupToDrive, listBackupsOnDrive, prepareRestoreFromDrive,
  pauseSync, resumeSync, syncNow, adoptForCloud, markRestoredUnadopted, clearRestoredUnadopted,
  restoreAwaitingAdoption, deleteMyAccount, readCloudSnapshot, planReplaceFromSnapshot, planAdoptPending, adoptPendingWithKeep,
  leaveOrgNow,
} from '../src/services/cloud';
import { TeamSheet } from '../src/ui/TeamSheet';
import { getSyncState } from '../src/sync/engine';
import type { CloudReplacePlan, CloudSnapshot } from '../src/sync/engine';
import type { PrepareOptions } from '../src/domain/backup/restore';
import type { KeptEntry } from '../src/domain/backup/keepPosted';
import { keptForReview, dismissKeptReview } from '../src/domain/accounting/orphans';
import { SourceCancelSheet } from '../src/ui/SourceCancelSheet';
import { entrySourceAction } from '../src/domain/accounting/sourceCancel';
import { EntrySheet } from '../src/ui/EntrySheet';
import { reviewData } from '../src/domain/backup/checks';
import { useAccess } from '../src/ui/access';
import { canView, isAdmin } from '../src/domain/access/access';
import { LEAFLET_VERSION, LEAFLET_LICENSE } from '../src/ui/leafletBundle';
import { getBackupPassword, setBackupPassword, clearBackupPassword, MIN_PASSWORD } from '../src/services/backupPassword';
import { PasswordRequiredError } from '../src/domain/backup/encryption';
import { pinWidget } from '../src/services/intents';
import type { DriveBackup } from '../src/cloud/drive';
import { dfmt, toLocalISODate, today } from '../src/domain/dates';

const APP_VERSION = '1.0.0';

/** خيارات مهل التنبيه · القيمة بالأيام */
const PAYMENT_LEADS = [[1, 'بيوم'], [3, 'بثلاثة أيام'], [7, 'بأسبوع'], [14, 'بأسبوعين']] as const;
const CONTRACT_LEADS = [[15, 'بخمسة عشر يوماً'], [30, 'بشهر'], [60, 'بشهرين'], [90, 'بثلاثة أشهر']] as const;
const DOC_LEADS = [[15, 'بخمسة عشر يوماً'], [30, 'بشهر'], [60, 'بشهرين']] as const;

/** صفّ إعداد: أيقونة واسم وقيمته الحالية وسهم · بلا ضغط لا سهم */
function ValueRow({ icon, title, value, onPress, tone }: {
  icon: IconName; title: string; value: string; onPress?: () => void; tone?: 'danger' | 'ok';
}) {
  return (
    <Pressable onPress={onPress} disabled={!onPress}
      style={({ pressed }) => [{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 11,
        borderBottomWidth: 1, borderBottomColor: C.paperLine }, pressed && onPress ? { backgroundColor: C.paper } : null]}>
      <Icon name={icon} size={18} color={C.emerald} />
      <T size={TYPE.body} med style={{ flexShrink: 1 }}>{title}</T>
      <View style={{ flex: 1 }} />
      <T size={TYPE.caption} bold color={tone === 'danger' ? C.rose : tone === 'ok' ? C.emerald : C.muted}
        style={{ flexShrink: 1 }} numberOfLines={2}>{value}</T>
      {onPress ? <View style={{ transform: [{ scaleX: -1 }] }}><Icon name="back" size={14} color={C.muted} /></View> : null}
    </Pressable>
  );
}

/** طيّة: صفٌّ يفتح ما تحته ويطويه · مطويّة ابتداءً */
function Fold({ icon, title, value, children }: { icon: IconName; title: string; value: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <View>
      <Pressable onPress={() => setOpen((o) => !o)}
        style={({ pressed }) => [{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 11,
          borderBottomWidth: 1, borderBottomColor: C.paperLine }, pressed ? { backgroundColor: C.paper } : null]}>
        <Icon name={icon} size={18} color={C.emerald} />
        <T size={TYPE.body} med style={{ flexShrink: 1 }}>{title}</T>
        <View style={{ flex: 1 }} />
        <T size={TYPE.caption} bold color={C.muted} style={{ flexShrink: 1 }}>{value}</T>
        <View style={{ transform: [{ rotate: open ? '-90deg' : '90deg' }] }}><Icon name="back" size={14} color={C.muted} /></View>
      </Pressable>
      {open ? <View style={{ paddingTop: 4, paddingBottom: 8 }}>{children}</View> : null}
    </View>
  );
}

export default function Settings() {
  const { db, version, bump, settings, updateSetting, uiPct, fontPct, previewScale, commitScale } = useApp();
  const access = useAccess();
  const toast = useToast();
  const dialog = useDialog();
  const router = useRouter();
  const [trashOpen, setTrashOpen] = useState(false);
  // لوحات الإعدادات · الاختيار الواحد، وتفصيل المزامنة، والنسخ على Drive، وحجم العرض
  const [choice, setChoice] = useState<{ title: string; options: Array<[number, string]>; value: number; onPick: (v: number) => void } | null>(null);
  const openChoice = (title: string, options: ReadonlyArray<readonly [number, string]>, value: number, onPick: (v: number) => void) =>
    setChoice({ title, options: options.map(([v, l]) => [v, l] as [number, string]), value, onPick });
  const [syncOpen, setSyncOpen] = useState(false);
  const [driveOpen, setDriveOpen] = useState(false);
  const [displayOpen, setDisplayOpen] = useState(false);
  const [delOpen, setDelOpen] = useState(false);
  const [teamOpen, setTeamOpen] = useState(false);
  const [delTyped, setDelTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [wipeConfirm, setWipeConfirm] = useState<string | null>(null);
  // شريط تقدم بالمراحل · «جاري نسخ المرفقات · ٢٢ من ١١٨» فلا يُظن التطبيق متجمداً
  const [progress, setProgress] = useState<string | null>(null);
  // مراجعة الأقساط من الدفتر · قراءة عند كل تغيير، ولا يُطبَّق شيء إلا بموافقة المستخدم
  const [reviewOpen, setReviewOpen] = useState(false);
  const review = useMemo(() => ({ plan: planLedgerRepair(db), unbooked: unbookedDiscounts(db), surpluses: contractSurpluses(db), kept: keptForReview(db), checks: reviewData(db).notes }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [db, version]);
  // تسوية فائض: ردّ للمستأجر بتاريخه وطريقته، أو تحويله رصيداً دائناً
  const [settle, setSettle] = useState<{ s: ContractSurplus; action: 'refund' | 'credit' } | null>(null);
  const [settleAmount, setSettleAmount] = useState('');
  const [settleDate, setSettleDate] = useState(today());
  const [settleMethod, setSettleMethod] = useState<'cash' | 'bank' | ''>('');
  const [settleBank, setSettleBank] = useState('');
  const banks = useMemo(() => db.all<{ id: string; name: string }>(
    `SELECT id, name FROM banks WHERE deleted_at IS NULL AND archived = 0 ORDER BY name`),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [db, version]);
  const openSettle = (s: ContractSurplus, action: 'refund' | 'credit') => {
    setSettle({ s, action });
    setSettleAmount(fmt(s.amount).replace(/,/g, ''));
    setSettleDate(today());
    setSettleMethod('');
    setSettleBank('');
  };
  const vatOn = useMemo(
    () => Number(db.get<{ vat_enabled: number }>(`SELECT vat_enabled FROM company WHERE id = 1`)?.vat_enabled ?? 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [db, version]);
  const reviewCount = review.surpluses.length + review.plan.changes.length + review.plan.issues.length
    + review.unbooked.items.length + review.unbooked.ambiguous.length + review.kept.length + review.checks.length;
  // قيدٌ من قائمة المراجعة مفتوحٌ بتفاصيله
  const [keptEntry, setKeptEntry] = useState<string | null>(null);
  const [keptCancel, setKeptCancel] = useState<{ id: string; no: string } | null>(null);
  // كلمة مرور النسخ · مفعّلة أم لا (القيمة نفسها لا تُقرأ إلى الواجهة)
  const [pwOn, setPwOn] = useState(false);
  useEffect(() => { getBackupPassword().then((p) => setPwOn(!!p)).catch(() => {}); }, []);
  const [pwEdit, setPwEdit] = useState(false);
  const [pw1, setPw1] = useState('');
  const [pw2, setPw2] = useState('');
  // سؤال كلمة مرور نسخةٍ مشفّرة أثناء الاستعادة · يُجاب بوعد
  const [pwAsk, setPwAsk] = useState<{ note: string; resolve: (v: string | null) => void } | null>(null);
  const [pwTyped, setPwTyped] = useState('');
  const askPassword = (note: string) => new Promise<string | null>((resolve) => { setPwTyped(''); setPwAsk({ note, resolve }); });
  /** كلمة المحفوظة أولاً بلا سؤال، ثم السؤال · ورسالة الخطأ بحسب من أخطأ */
  const restorePassword = () => {
    let last: 'stored' | 'typed' | null = null;
    return async (wrong: boolean) => {
      if (!last) {
        const stored = await getBackupPassword();
        if (stored) { last = 'stored'; return stored; }
      }
      const note = !wrong ? 'هذه النسخة مشفّرة · اكتب كلمة المرور التي شُفّرت بها.'
        : last === 'stored' ? 'هذه النسخة مشفّرة بكلمة مرور غير المحفوظة على هذا الجهاز · اكتب كلمتها.'
        : 'كلمة المرور غير صحيحة · حاول مرة أخرى.';
      last = 'typed';
      return askPassword(note);
    };
  };
  // الحساب والمزامنة · حالة حيّة من طبقة الربط
  const [cloud, setCloud] = useState(cloudState());
  useEffect(() => subscribeCloud(() => setCloud(cloudState())), []);
  const [driveList, setDriveList] = useState<DriveBackup[] | null>(null);

  const data = useMemo(() => {
    const exp = exportStatus(db);
    const trash = trashItems(db);
    const counts: Array<[string, number]> = [
      ['عقارات', Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM properties WHERE deleted_at IS NULL`)!.n)],
      ['وحدات', Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM units WHERE deleted_at IS NULL`)!.n)],
      ['مستأجرون', Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM tenants WHERE deleted_at IS NULL`)!.n)],
      ['عقود', Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM contracts WHERE deleted_at IS NULL`)!.n)],
      ['فواتير', Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM invoices WHERE deleted_at IS NULL`)!.n)],
      ['فواتير شراء', Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM purchases WHERE deleted_at IS NULL`)!.n)],
      ['مطالبات', Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM claims WHERE deleted_at IS NULL`)!.n)],
      ['قيود', Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM journal_entries WHERE deleted_at IS NULL`)!.n)],
      ['حسابات', Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM accounts WHERE deleted_at IS NULL`)!.n)],
      ['حركات بنكية', Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM bank_tx WHERE deleted_at IS NULL`)!.n)],
      ['مرفقات', Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM attachments WHERE deleted_at IS NULL`)!.n)],
      ['عمليات في السجل', Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM audit_log`)!.n)],
    ];
    const total = counts.slice(0, 8).reduce((s, [, n]) => s + n, 0);
    return { exp, trash, counts, total };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, version]);

  /** نسخةٌ فيها فروق محاسبية · تُسمّى ويُشار إلى أداة المراجعة */
  const notesDialog = (title: string, notes: string[]) => dialog({
    title,
    body: 'حُفظت بياناتك كاملة، وفيها فروق محاسبية تحتاج مراجعتك:\n· ' + notes.join('\n· ')
      + '\n\nتجدها في «مراجعة الدفتر» في البيانات والمساحة.',
    tone: 'normal',
    actions: [{ label: 'حسناً', variant: 'ghost' }],
  });
  const doBackup = async () => {
    setBusy(true);
    const before = fingerprintData(appBackupEnv(db));
    try {
      const m = await createAndShareBackup(db, setProgress);
      bump();
      // الفرق المحاسبي لا يمنع حفظ البيانات (checks.ts) · تُنشأ النسخة وتُوسم «فيها ملاحظات» وتُسمّى
      if (m.notes?.length) notesDialog('أُنشئت النسخة وفيها ملاحظات', m.notes);
      else toast(pwOn ? 'أُنشئت النسخة مشفّرة وتُحقّق منها بنجاح' : 'أُنشئت النسخة وتُحقّق منها بنجاح');
    } catch (e) {
      await reportFailure({
        title: 'تعذّر إنشاء النسخة الاحتياطية', where: 'إنشاء نسخة', db, auditModule: 'النسخ الاحتياطي', auditAction: 'create',
        // سبب الرفض كما كتبه التحقق: اسم الملف أو الفحص الذي فشل · والجملة العامة لما لم يُسمَّ
        lead: arabicMessage(e) || 'لم يكتمل تجهيز النسخة.', before, env: appBackupEnv(db), e, retry: () => { doBackup(); },
      });
    }
    setProgress(null);
    setBusy(false);
  };

  /** التصحيح من دفتر النسخة كما يُعرض في حوار الاستعادة · كل قسط بما كان وما يصير وقيد خصمه */
  const repairSummary = (r: NonNullable<Awaited<ReturnType<typeof pickAndPrepareRestore>>>['plan']['ledgerRepair']) => {
    if (!r) return '';
    const shown = r.changes.slice(0, 8).map((c) =>
      c.tenant + ' · ' + c.due + ': ' + fmt(c.fromPaid) + ' ← ' + fmt(c.toPaid)
        + (c.discountEntries.length ? ' (خصم ' + fmt(c.ledgerDiscount) + ' · ' + c.discountEntries.join('، ') + ')' : ''));
    return '\n\nتصحيح من دفتر النسخة قبل الاستعادة (' + r.changes.length + ' قسط):\n' + shown.join('\n')
      + (r.changes.length > shown.length ? '\nو' + (r.changes.length - shown.length) + ' غيرها' : '')
      + (r.issues.length ? '\n\nما لا يحسمه الدفتر ويبقى قرارُه لك:\n' + r.issues.map((x) => x.tenant + ' · ' + x.contractNo + ': ' + x.reason).join('\n') : '');
  };

  // الاستعادة لا تنهار أبداً · كل المسار ملفوف، والفشل رسالة عربية مبنيّة على فحص
  const doRestore = () => runRestore((opts) => pickAndPrepareRestore(db, setProgress, opts));

  /** ما في السحابة وما يصير إليه · سطور الحوار قبل الاعتماد */
  const cloudReplaceText = (p: CloudReplacePlan) =>
    'في حسابك على السحابة ' + p.cloudRows + ' سجل · تُستبدل بما في النسخة'
    + (p.tombstones.length ? '، ويُحذف منها ' + p.tombstones.length + ' سجل ليس في النسخة' : '') + '.'
    + (p.immutable.entries || p.immutable.audit
      ? '\nويبقى في السحابة ' + (p.immutable.entries ? p.immutable.entries + ' قيد مرحّل' : '')
        + (p.immutable.entries && p.immutable.audit ? ' و' : '') + (p.immutable.audit ? p.immutable.audit + ' سطر من سجل العمليات' : '')
        + ' ليست في النسخة: قواعد الأمان لا تحذفها من السحابة، فلا تنزل إلى هذا الجهاز وتبقى على أي جهاز آخر نزلت عليه.'
      : '');

  /** القيود المرحّلة بعد تاريخ النسخة · تبقى وتُضمّ إليها · سطور الحوار قبل التأكيد */
  const fromLabel = (k: KeptEntry) => (k.from === 'device' ? 'من هذا الجهاز' : k.from === 'cloud' ? 'من السحابة' : 'من الجهاز والسحابة');
  const keptText = (kept: KeptEntry[]) => {
    if (!kept.length) return '';
    const shown = kept.slice(0, 8).map((k) => '· ' + (k.newNo ? k.newNo + ' (كان ' + k.no + ')' : k.no) + ' · ' + k.date + ' · ' + fmt(k.amount)
      + ' · ' + fromLabel(k) + (k.carried.length ? ' · ومعه ' + k.carried.join(' و') : '') + (k.review ? ' · للمراجعة' : ''));
    const toReview = kept.filter((k) => k.review).length;
    const renamed = kept.filter((k) => k.newNo).length;
    return '\n\nقيود مرحّلة بعد تاريخ النسخة تبقى (' + kept.length + '):\n' + shown.join('\n')
      + (kept.length > shown.length ? '\nو' + (kept.length - shown.length) + ' غيرها' : '')
      + '\nالقيد المرحّل لا يُحذف بالاستعادة · يُضمّ إلى النسخة برقمه وسطوره، ومعه دفعته وتوزيعها وحركة بنكه متى كان عقدها وبنكها في النسخة.'
      + (renamed ? '\n' + renamed + ' منها رقمه مستعمل في النسخة لقيد آخر فيأخذ رقماً جديداً، ويُذكر القديم في بيانه.' : '')
      + (toReview ? '\n' + toReview + ' منها مستنده لم يُحمل · تجدها في «مراجعة الدفتر» لتراجعها.' : '');
  };
  const paidText = (n: number) => (n ? '\n\nمسدَّد ' + n + ' قسط حُسب من دفعات النسخة وتوزيعها بدل الرقم المخزّن فيها.' : '');

  // المسار الواحد للاستعادة من أي مصدر: التجهيز (فك وبصمات وفحص دلالي) ثم الملخص ثم التنفيذ ·
  // ومع الدخول بحساب: المزامنة تتوقف قبل كل شيء، ولا يُكتب إلى السحابة إلا بالاعتماد صراحةً
  const runRestore = async (prepare: (opts: PrepareOptions) => Promise<Awaited<ReturnType<typeof pickAndPrepareRestore>>>) => {
    setBusy(true);
    const before = fingerprintData(appBackupEnv(db));
    const signedIn = !!cloudState().user;
    let prepared: Awaited<ReturnType<typeof pickAndPrepareRestore>> = null;
    // يُستأنف كل مسار انتهى بلا اعتماد · والاعتماد يستأنف بنفسه بعد أن يرفع
    let resumeOnExit = signedIn;
    try {
      if (signedIn) { setProgress('جاري إيقاف المزامنة'); await pauseSync(); }
      // لقطة السحابة تُقرأ مرة بعد فحص النسخة · قيودها المرحّلة تُضمّ، ومنها خطة الاستبدال
      let snap: CloudSnapshot | null = null;
      const loadCloud = async () => (snap ??= await readCloudSnapshot(setProgress));
      prepared = await prepare({ ...(signedIn ? { cloud: async () => (await loadCloud()).docs } : {}), password: restorePassword() });
      setProgress(null);
      if (!prepared) { setBusy(false); if (resumeOnExit) resumeSync(); return; }
      const { env, plan, archiveTmp } = prepared;
      let cloudPlan: CloudReplacePlan | null = null;
      if (signedIn) {
        const staged = env.openDb(plan.stagedDbPath);
        try { cloudPlan = planReplaceFromSnapshot(staged, await loadCloud()); }
        finally { try { staged.close(); } catch { /* أُغلقت */ } }
        setProgress(null);
      }
      const n = (t: string) => plan.incoming[t] ?? 0;
      const cN = (t: string) => plan.current[t] ?? 0;
      const mb = (plan.attachmentsBytes / (1024 * 1024)).toFixed(1);
      // أظهر ما سيحدث قبل أن يحدث · فيُرى ما سيُخسر قبل خسارته
      dialog({
        title: 'النسخة صالحة',
        body: 'تاريخها: ' + (plan.manifest.created_at || '').slice(0, 10) + '\n' +
        'عقارات ' + n('properties') + ' · وحدات ' + n('units') + ' · عقود ' + n('contracts') + '\n' +
        'قيود ' + n('journal_entries') + ' · مرفقات ' + plan.manifest.files.length + ' (' + mb + ' ميغا)\n\n' +
        'ستحلّ محلّ بياناتك الحالية:\n' +
        'عقارات ' + cN('properties') + ' · وحدات ' + cN('units') + ' · عقود ' + cN('contracts') + '\n' +
        'قيود ' + cN('journal_entries') + ' · مرفقات ' + plan.currentAttachments.count
          + ' (' + (plan.currentAttachments.bytes / (1024 * 1024)).toFixed(1) + ' ميغا)'
          + (plan.ledgerRepair ? repairSummary(plan.ledgerRepair) : '')
          + paidText(plan.paidRecomputed.length)
          + (plan.notes.length ? '\n\nفي النسخة فروق محاسبية لا تمنع استعادتها، وتظهر بعدها في «مراجعة الدفتر»:\n· ' + plan.notes.join('\n· ') : '')
          + keptText(plan.kept)
          + (cloudPlan ? '\n\nأنت داخل بحساب ' + (cloudState().user?.email ?? '') + ' · المزامنة متوقفة الآن.\n' + cloudReplaceText(cloudPlan) : ''),
        tone: 'normal',
        locked: true,
        actions: [
          {
            label: 'إلغاء', variant: 'ghost',
            onPress: () => {
              try { abortPreparedRestore(env, plan, archiveTmp); } catch { /* يكنسه الإقلاع */ }
              if (signedIn) resumeSync();
            },
          },
          {
            label: cloudPlan ? 'اعتماد هذه النسخة واستبدال بيانات السحابة بها'
              : plan.ledgerRepair ? 'متابعة الاستعادة مع التصحيح' : 'متابعة الاستعادة',
            variant: 'primary',
            onPress: async () => {
              setBusy(true);
              let restored = false;
              try {
                await commitPreparedRestore(env, plan, archiveTmp, setProgress);
                restored = true;
                if (cloudPlan) {
                  setProgress('جاري اعتماد النسخة للسحابة');
                  const { queued } = await adoptForCloud(db, cloudPlan);
                  resumeSync();
                  syncNow();
                  toast('اكتملت الاستعادة · ' + queued + ' سجل في طريقه إلى السحابة');
                } else {
                  // بلا دخول: لا تُدمج النسخة مع السحابة عند الدخول التالي إلا بقرار
                  if (cloudState().configured) markRestoredUnadopted(db);
                  toast('اكتملت الاستعادة والتُحقق منها');
                }
                bump();
                rescheduleAllNotifications(db).catch(() => {});
              } catch (e) {
                // الاستعادة تمّت والاعتماد لم يتمّ: المزامنة تبقى منتظرة القرار ولا تدمج صامتةً
                if (restored && cloudPlan) { try { markRestoredUnadopted(db); } catch { /* القاعدة مشغولة */ } resumeSync(); bump(); }
                else if (signedIn) resumeSync();
                await reportFailure({
                  title: restored ? 'تمّت الاستعادة ولم تُعتمد للسحابة' : 'تعذّرت الاستعادة',
                  where: restored ? 'اعتماد النسخة للسحابة' : 'استعادة', db, auditModule: 'النسخ الاحتياطي', auditAction: 'update',
                  before: restored ? undefined : before, env: appBackupEnv(db), e,
                  lead: restored ? 'بياناتك الآن من النسخة، ولم يُكتب شيء إلى السحابة · اعتمدها من «الحساب والمزامنة» حين يعود الاتصال.' : undefined,
                });
              }
              setProgress(null);
              setBusy(false);
            },
          },
        ],
      });
      resumeOnExit = false; // الحوار مفتوح · زرّاه يستأنفان
    } catch (e) {
      // لا يُترك مجلد تجهيز وراءنا إن فشل شيء بعد نجاح التجهيز
      if (prepared) { try { abortPreparedRestore(prepared.env, prepared.plan, prepared.archiveTmp); } catch { /* يكنسه الإقلاع */ } }
      // ألغى المستخدم سؤال كلمة المرور · لا عطل يُبلَّغ
      if (e instanceof PasswordRequiredError) { if (resumeOnExit) resumeSync(); setProgress(null); setBusy(false); return; }
      await reportFailure({
        title: 'تعذّرت الاستعادة', where: 'تجهيز استعادة', db, auditModule: 'النسخ الاحتياطي', auditAction: 'update',
        before, env: appBackupEnv(db), e,
      });
    }
    if (resumeOnExit) resumeSync();
    setProgress(null);
    setBusy(false);
  };

  /** نسخة استُعيدت خارج الحساب · تُعتمد للسحابة أو تُدمج معها بقرار صريح */
  const doAdoptPending = async () => {
    setBusy(true);
    try {
      await pauseSync();
      const ready = await planAdoptPending(db, setProgress);
      const p = ready.plan;
      setProgress(null);
      dialog({
        title: 'اعتماد بيانات هذا الجهاز',
        body: 'استُعيدت على هذا الجهاز نسخة ولم يُكتب منها شيء إلى السحابة.\n' + cloudReplaceText({ ...p, immutable: { ...p.immutable, entries: 0 } })
          + keptText(ready.keep.entries)
          + '\n\nأو «دمج مع السحابة»: يغلب في كل سجل الأحدثُ تعديلاً بين الجهاز والسحابة.',
        tone: 'normal',
        locked: true,
        actions: [
          { label: 'إلغاء', variant: 'ghost', onPress: () => resumeSync() },
          { label: 'دمج مع السحابة', variant: 'ghost', onPress: () => {
            const uid = cloudState().user?.uid;
            if (uid) { clearRestoredUnadopted(db, uid); resumeSync(); syncNow(); bump(); }
          } },
          { label: 'اعتماد بيانات هذا الجهاز واستبدال بيانات السحابة بها', variant: 'primary', onPress: async () => {
            try {
              const { queued, kept } = await adoptPendingWithKeep(db, ready);
              toast(queued + ' سجل في طريقه إلى السحابة' + (kept ? ' · وضُمّ ' + kept + ' قيد مرحّل من السحابة' : ''));
            } catch (e) {
              await reportFailure({ title: 'تعذّر الاعتماد', where: 'اعتماد النسخة للسحابة', db, e });
            }
            resumeSync(); syncNow(); bump();
          } },
        ],
      });
    } catch (e) {
      resumeSync();
      await reportFailure({ title: 'تعذّرت قراءة ما في السحابة', where: 'اعتماد النسخة للسحابة', db, e });
    }
    setProgress(null);
    setBusy(false);
  };

  /** خصمٌ بلا قيد في الدفتر وزرّا نوعه · كلٌّ بتأكيد يبيّن ما سيحدث */
  const unbookedRow = (u: UnbookedDiscount) => {
    const choose = (kind: DiscountKind) => dialog({
      title: kind === DISCOUNT_AFTER_DUE ? 'خصم بعد الاستحقاق' : 'تنزيل من قيمة القسط',
      body: (kind === DISCOUNT_AFTER_DUE
        ? 'يُنشأ قيد جديد بتاريخ الدفعة: مدين الخصومات الممنوحة ' + fmt(u.discount) + ' · دائن الإيراد بالمبلغ نفسه. قيد الدفعة لا يُعدَّل.'
        : 'يُخفَّض القسط ' + (u.due ?? '') + ' بمبلغ ' + fmt(u.discount) + ' ولا يُنشأ قيد.\nتنبيه: تخفيض القسط يخالف قيمة العقد الموثّقة في منصة إيجار.')
        + '\n\n' + u.tenant + ' · عقد ' + u.contractNo + ' · دفعة ' + u.date,
      tone: 'normal',
      actions: [
        { label: 'تراجع', variant: 'ghost' },
        { label: 'سجّل', variant: 'primary', onPress: () => {
          try {
            bookDiscount(db, u.paymentId, kind);
            toast('سُجّل نوع الخصم');
          } catch (e2) {
            reportFailure({ title: 'تعذّر تسجيل نوع الخصم', e: e2 });
          }
          bump();
        } },
      ],
    });
    return (
      <View key={u.paymentId} style={{ paddingVertical: 7, borderBottomWidth: 1, borderBottomColor: C.line }}>
        <T size={TYPE.body} med>{u.tenant + ' · عقد ' + u.contractNo + ' · دفعة ' + u.date + (u.due ? ' · قسط ' + u.due : '')}</T>
        <T size={TYPE.caption} color={C.muted}>
          {'المقبوض ' + fmt(u.received) + ' · الخصم ' + fmt(u.discount) + (u.entryNo ? ' · قيد الدفعة ' + u.entryNo : '')}
        </T>
        <Row gap={8} style={{ marginTop: 6 }}>
          <BtnGhost small title="خصم بعد الاستحقاق" onPress={() => choose(DISCOUNT_AFTER_DUE)} />
          {u.installmentId ? <BtnGhost small title="تنزيل من قيمة القسط" onPress={() => choose(DISCOUNT_REDUCES_INSTALLMENT)} /> : null}
        </Row>
      </View>
    );
  };

  /* ── الحساب والمزامنة ── */
  const lastSync = (iso: string | null) => {
    if (!iso) return 'لم تجرِ بعد';
    const d = new Date(iso);
    return dfmt(toLocalISODate(d)) + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  };
  const doSignIn = async () => {
    setBusy(true);
    try {
      const u = await cloudSignIn();
      if (u) toast('دخلت بحساب ' + u.email + ' · بدأت المزامنة');
    } catch (e) {
      await reportFailure({ title: 'تعذّر الدخول بحساب قوقل', where: 'تسجيل الدخول', db, e });
    }
    setBusy(false);
  };
  // الخروج لا يترك تغييراً لم يُرفع: ما في الطابور يُرفع أولاً، وإلا لا يظهر زرّ الخروج ويظهر العدد
  const doSignOut = () => (cloud.sync?.pending ?? 0) > 0 ? dialog({
    title: 'تسجيل الخروج',
    body: (cloud.sync?.pending ?? 0) + ' تغييراً لم يُرفع إلى حسابك بعد · اتصل بالإنترنت وانتظر المزامنة ثم اخرج، فلا يضيع منها شيء.',
    tone: 'normal',
    actions: [{ label: 'حسناً', variant: 'ghost' }],
  }) : dialog({
    title: 'تسجيل الخروج',
    body: 'تعود إلى شاشة الدخول، وبيانات هذا الجهاز تبقى عليه مقفلة لا تُفتح إلا بدخول هذا الحساب نفسه.',
    tone: 'normal',
    actions: [
      { label: 'تراجع', variant: 'ghost' },
      { label: 'تسجيل الخروج', variant: 'primary', onPress: async () => {
        try { await cloudSignOut(); }
        catch (e) { await reportFailure({ title: 'تعذّر تسجيل الخروج', where: 'تسجيل الخروج', db, e }); }
      } },
    ],
  });
  const doDriveBackup = async () => {
    setBusy(true);
    try {
      const b = await backupToDrive(db, setProgress);
      bump();
      if (b.notes) notesDialog('رُفعت النسخة إلى Google Drive وفيها ملاحظات', reviewData(db).notes);
      else toast('رُفعت النسخة' + (pwOn ? ' مشفّرة' : '') + ' إلى Google Drive وطابقت بصمتها · ' + libSizeLabel(b.size));
    } catch (e) {
      await reportFailure({
        title: 'تعذّر النسخ على Google Drive', where: 'نسخ على Drive', db, auditModule: 'النسخ الاحتياطي', auditAction: 'create',
        lead: arabicMessage(e) || 'لم يكتمل رفع النسخة.', e,
      });
    }
    setProgress(null);
    setBusy(false);
  };
  const openDriveRestore = async () => {
    setBusy(true);
    try {
      const list = await listBackupsOnDrive();
      if (!list.length) toast('لا نسخ على Google Drive بعد');
      else setDriveList(list);
    } catch (e) {
      await reportFailure({ title: 'تعذّرت قراءة النسخ على Google Drive', where: 'قائمة نسخ Drive', db, e });
    }
    setBusy(false);
  };

  const doWipe = async () => {
    if ((wipeConfirm ?? '').trim() !== 'مسح') {
      toast('الكلمة غير مطابقة · تم إلغاء المسح لحمايتك');
      return;
    }
    // نسخة أمان إلزامية قبل المسح · فشلُها يلغي المسح كله وبياناتك كما هي
    setBusy(true);
    const before = fingerprintData(appBackupEnv(db));
    try {
      await wipeAllData(appBackupEnv(db), setProgress);
    } catch (e) {
      setBusy(false);
      setProgress(null);
      await reportFailure({
        title: 'أُلغي المسح', where: 'مسح كل البيانات', db, auditModule: 'النسخ الاحتياطي', auditAction: 'delete',
        lead: ['لم يكتمل المسح فأُلغي كله.', arabicMessage(e)].filter(Boolean).join(' '),
        before, env: appBackupEnv(db), e,
      });
      return;
    }
    setWipeConfirm(null);
    setProgress(null);
    setBusy(false);
    bump();
    toast('أُنشئت نسخة أمان ثم تم المسح · كل شيء في سلة المحذوفات طوال مدة الاحتفاظ');
  };

  const storage = storageBreakdown(db);
  const storageTotal = storage.originalsBytes + storage.thumbsBytes + storage.dbBytes
    + storage.cacheBytes + storage.trashBytes + storage.safetyBytes;
  const storageRow = (label: string, v: number, extra?: string, action?: React.ReactNode) => (
    <Row key={label} style={{ justifyContent: 'space-between', paddingVertical: 5, borderBottomWidth: 1, borderBottomColor: C.paperLine }}>
      <T size={TYPE.body}>{label}{extra ? ' (' + extra + ')' : ''}</T>
      <Row gap={8}>
        <Num size={TYPE.body} bold>{libSizeLabel(v)}</Num>
        {action}
      </Row>
    </Row>
  );

  // العضو يرى إعداداته الشخصية وحدها · «الأعضاء والإعدادات» للمالك وحده (docs/PERMISSIONS.md)
  const admin = isAdmin(access);
  return (
    <Screen title="الإعدادات" icon="settings">
      {/* ١ · الحساب والمزامنة */}
      <Card>
        <CardTitle>الحساب والمزامنة</CardTitle>
        {!cloud.configured ? (
          <ValueRow icon="lock" title="حساب قوقل" value="غير مهيّأ في هذا البناء" />
        ) : !cloud.user ? (
          <ValueRow icon="lock" title="حساب قوقل" value={cloud.online ? 'لم تسجّل الدخول' : 'غير متصل'}
            onPress={cloud.online && !busy ? doSignIn : undefined} />
        ) : (
          <>
            <ValueRow icon="lock" title="حساب قوقل" value={cloud.user.email} onPress={doSignOut} />
            <ValueRow icon="reload" title="حالة المزامنة"
              value={cloud.syncing ? (cloud.progress ?? 'جارية')
                : (cloud.sync?.rejected ?? 0) > 0 ? (cloud.sync?.rejected ?? 0) + ' مرفوض عند الوصول'
                : !cloud.online ? 'غير متصل · التغييرات محفوظة'
                : 'آخر مزامنة ' + lastSync(cloud.sync?.lastSyncAt ?? null)}
              tone={(cloud.sync?.rejected ?? 0) > 0 || cloud.lastError ? 'danger' : undefined}
              onPress={() => setSyncOpen(true)} />
            {/* الأعضاء والصلاحيات للمالك · والعضو يرى منشأته ويغادرها (docs/PERMISSIONS.md) */}
            {admin && cloud.online ? (
              <ValueRow icon="collect" title="الأعضاء والصلاحيات" value="الدعوة والأقسام والعقارات" onPress={() => setTeamOpen(true)} />
            ) : null}
            {!admin ? (
              <ValueRow icon="building" title="المنشأة" value={(getSyncState(db, 'org_name') || 'منشأة عقاري') + ' · عضو'} />
            ) : null}
            {!admin && cloud.online ? (
              <ValueRow icon="trash" title="مغادرة المنشأة" value="تُمسح بياناتها من الجهاز" tone="danger" onPress={() => dialog({
                title: 'مغادرة المنشأة',
                body: 'تُلغى عضويتك، ويُفرَّغ هذا الجهاز من بيانات المنشأة، وتخرج من حسابك. لا رجعة إلا بدعوة جديدة.',
                tone: 'danger',
                actions: [
                  { label: 'تراجع', variant: 'ghost' },
                  { label: 'غادِر', variant: 'danger', onPress: async () => {
                    try { await leaveOrgNow(db); bump(); }
                    catch (e) { await reportFailure({ title: 'تعذّرت المغادرة', where: 'الإعدادات', db, e }); }
                  } },
                ],
              })} />
            ) : null}
            {admin && cloud.online ? (
              <ValueRow icon="export" title="النسخ على Drive" value="نسخ أو استعادة" onPress={() => setDriveOpen(true)} />
            ) : null}
            {admin && cloud.online ? (
              <ValueRow icon="trash" title="حذف حسابي" value="الحساب وبياناته" tone="danger" onPress={() => { setDelTyped(''); setDelOpen(true); }} />
            ) : null}
            {admin && restoreAwaitingAdoption(db) ? (
              <View style={{ marginTop: 6 }}>
                <Note tone="danger">استُعيدت على هذا الجهاز نسخة ولم تُعتمد للسحابة · المزامنة متوقفة حتى تقرّر</Note>
                {cloud.online ? <BtnPrimary title="اعتماد النسخة أو دمجها" onPress={doAdoptPending} loading={busy} /> : null}
              </View>
            ) : null}
          </>
        )}
      </Card>

      {/* ٢ · النسخ الاحتياطي */}
      {admin ? <Card>
        <CardTitle>النسخ الاحتياطي</CardTitle>
        <ValueRow icon="shield" title="آخر نسخة خارج الجهاز"
          value={(data.exp.daysSinceExport === null ? 'لم تحدث بعد'
            : data.exp.daysSinceExport === 0 ? 'اليوم' : 'قبل ' + data.exp.daysSinceExport + ' يوماً')
            + ' · ' + (data.exp.warn ? 'تحتاج انتباهك' : 'محمية')}
          tone={data.exp.warn ? 'danger' : 'ok'} />
        <Row style={{ marginTop: 8 }}>
          <View style={{ flex: 1 }}><BtnPrimary title="النسخ الاحتياطي" onPress={doBackup} loading={busy} /></View>
          <View style={{ flex: 1 }}><BtnGhost title="استعادة من نسخة" onPress={doRestore} disabled={busy} /></View>
        </Row>
        <ValueRow icon="lock" title="كلمة مرور النسخ" value={pwOn ? 'مفعّلة' : 'غير مفعّلة'}
          onPress={() => { setPw1(''); setPw2(''); setPwEdit(true); }} />
        <ValueRow icon="bell" title="التذكير الأسبوعي" value={settings.backupWeekly ? 'مفعّل' : 'مطفأ'}
          onPress={() => openChoice('التذكير الأسبوعي بالتصدير', [[1, 'مفعّل'], [0, 'مطفأ']], settings.backupWeekly ? 1 : 0,
            (v) => { updateSetting('backupWeekly', !!v); rescheduleAllNotifications(db).catch(() => {}); })} />
      </Card> : null}

      {/* ٣ · المالية */}
      {admin ? <Card>
        <CardTitle>المالية</CardTitle>
        <ValueRow icon="wallet" title="العملة ودليل الحسابات" value={(data.counts.find(([k]) => k === 'حسابات')?.[1] ?? 0) + ' حساباً'} onPress={() => router.push('/accounts')} />
        <ValueRow icon="invoice" title="ضريبة القيمة المضافة" value={vatOn ? 'مفعّلة' : 'مطفأة · لا تُحتسب'}
          onPress={() => openChoice('ضريبة القيمة المضافة', [[0, 'مطفأة · لا تُحتسب'], [1, 'مفعّلة']], vatOn,
            (v) => { db.transaction(() => db.run(`UPDATE company SET vat_enabled = ? WHERE id = 1`, [v])); bump(); })} />
      </Card> : null}

      {/* ٤ · التنبيهات */}
      <Card>
        <CardTitle>التنبيهات</CardTitle>
        <ValueRow icon="bell" title="الحالة" value={settings.remindersOn ? 'مفعّلة' : 'مطفأة'}
          onPress={() => openChoice('التنبيهات', [[1, 'مفعّلة'], [0, 'مطفأة']], settings.remindersOn ? 1 : 0,
            (v) => { updateSetting('remindersOn', !!v); rescheduleAllNotifications(db).catch(() => {}); })} />
        {([
          ['remindPayment', 'قبل استحقاق الدفعة', 'collect', PAYMENT_LEADS],
          ['remindContract', 'قبل انتهاء العقد', 'contract', CONTRACT_LEADS],
          ['remindDoc', 'قبل انتهاء المستند', 'claim', DOC_LEADS],
        ] as const).map(([key, title, icon, opts]) => (
          <ValueRow key={key} icon={icon} title={title}
            value={opts.find(([n]) => n === settings[key])?.[1] ?? String(settings[key])}
            onPress={() => openChoice('تنبيه ' + title, opts as unknown as Array<[number, string]>, settings[key] as number,
              (v) => { updateSetting(key, v as never); rescheduleAllNotifications(db).catch(() => {}); })} />
        ))}
      </Card>

      {/* ٥ · ودجت الشاشة · أندرويد وحده يثبّتها من داخل التطبيق · أرقامها من التحصيل */}
      {canView(access, 'collect') ? <Card>
        <CardTitle>ودجت الشاشة</CardTitle>
        {([
          ['strip', 'collect', 'شريط اليوم · كم متأخرة وبكم'],
          ['panel', 'chart', 'لوحة التحصيل · المحصَّل من المستحق'],
          ['actions', 'menu', 'أزرار سريعة · تحصيل وفاتورة ومطالبة'],
        ] as const).map(([kind, icon, title]) => (
          <ValueRow key={kind} icon={icon} title={title} value="أضف"
            onPress={() => { pinWidget(kind).catch(() => toast('المشغّل لا يدعم التثبيت · أضفها بالضغط المطوّل على الشاشة')); }} />
        ))}
      </Card> : null}

      {/* العرض · لم يرد في ترتيب المالك فبقي بطاقةً مستقلة حتى يحدّد مكانه */}
      <Card>
        <CardTitle>العرض</CardTitle>
        <ValueRow icon="eye" title="حجم الواجهة والخط" value={uiPct + '٪ · ' + fontPct + '٪'} onPress={() => setDisplayOpen(true)} />
      </Card>

      {/* ٦ · البيانات والمساحة */}
      <Card>
        <CardTitle>البيانات والمساحة</CardTitle>
        <Fold icon="library" title="المساحة" value={libSizeLabel(storageTotal)}>
          {storageRow('الملفات الأصلية', storage.originalsBytes, storage.originalsCount + ' ملف')}
          {storageRow('المصغّرات', storage.thumbsBytes)}
          {storageRow('قاعدة البيانات', storage.dbBytes)}
          {storageRow('سلة المحذوفات', storage.trashBytes, storage.trashCount + ' ملف')}
          {storageRow('نسخة الأمان قبل آخر استيراد أو مسح', storage.safetyBytes, storage.safetyCount + ' ملف')}
        </Fold>
        <Fold icon="chart" title="بياناتك بالأرقام" value={String(data.total) + ' سجل'}>
          {data.counts.map(([k, n]) => (
            <Row key={k} style={{ justifyContent: 'space-between', paddingVertical: 5, borderBottomWidth: 1, borderBottomColor: C.paperLine }}>
              <T size={TYPE.body}>{k}</T>
              <Num size={TYPE.body} bold>{n}</Num>
            </Row>
          ))}
        </Fold>
        {/* بلا مؤقتات لا تفريغ · الصف بلا ضغط */}
        <ValueRow icon="reload" title="الملفات المؤقتة" value={storage.cacheBytes > 0 ? libSizeLabel(storage.cacheBytes) + ' · تفريغ' : 'لا شيء'}
          onPress={storage.cacheBytes > 0 ? () => { const freed = sweepCache(); bump(); toast('حُرّر ' + libSizeLabel(freed) + ' من المؤقتات'); } : undefined} />
        {admin ? <>
        <ValueRow icon="trash" title="سلة المحذوفات" value={data.trash.length + ' سجل'} onPress={() => setTrashOpen(true)} />
        <ValueRow icon="calendar" title="مدة الاحتفاظ قبل الحذف النهائي" value={settings.trashRetention + ' يوماً'}
          onPress={() => openChoice('مدة الاحتفاظ', [[30, '٣٠ يوماً'], [60, '٦٠ يوماً'], [90, '٩٠ يوماً']], settings.trashRetention,
            (v) => updateSetting('trashRetention', v as never))} />
        <ValueRow icon="eye" title="نزع بيانات الصور الوصفية عند الرفع" value={settings.stripExif ? 'مفعّل' : 'مطفأ'}
          onPress={() => openChoice('نزع بيانات الصور الوصفية', [[0, 'مطفأ'], [1, 'مفعّل']], settings.stripExif ? 1 : 0,
            (v) => updateSetting('stripExif', !!v))} />
        {reviewCount ? (
          <ValueRow icon="shield" title="مراجعة الدفتر" value={reviewCount + ' للمراجعة'} tone="danger" onPress={() => setReviewOpen(true)} />
        ) : null}
        </> : null}
      </Card>

      {/* ٧ · عن التطبيق */}
      <Card>
        <CardTitle>عن التطبيق</CardTitle>
        <Fold icon="home" title="عقاري · أحد حلول منصة رِكز" value={'الإصدار ' + APP_VERSION}>
          {([['الإصدار', APP_VERSION], ['إصدار قاعدة البيانات', String(SCHEMA_VERSION)]] as Array<[string, string]>).map(([k, v]) => (
            <Row key={k} style={{ justifyContent: 'space-between', paddingVertical: 5 }}>
              <T size={TYPE.body}>{k}</T>
              <Num size={TYPE.body} bold>{v}</Num>
            </Row>
          ))}
          <T size={TYPE.caption} color={C.muted} style={{ marginTop: 6 }}>
            {'مكتبات مفتوحة المصدر مضمّنة: الخريطة Leaflet ' + LEAFLET_VERSION + ' · ' + LEAFLET_LICENSE + ' · صور الخريطة © مساهمو OpenStreetMap'}
          </T>
        </Fold>
      </Card>

      {/* ٨ · مسح كل البيانات · آخر الصفحة، بطاقة مستقلة حمراء */}
      {admin ? <Card style={{ borderColor: C.rose, borderWidth: 1.4, backgroundColor: C.roseSoft }}>
        <CardTitle>مسح كل البيانات</CardTitle>
        <T size={TYPE.body} color={C.rose} style={{ marginBottom: 10 }}>
          المسح ينقل كل شيء إلى سلة المحذوفات ويبقى قابلاً للاسترجاع طوال مدة الاحتفاظ، وتسبقه نسخة أمان.
        </T>
        <BtnGhost danger icon="trash" title="امسح كل البيانات" onPress={() => setWipeConfirm('')} />
      </Card> : null}

      {teamOpen ? <TeamSheet visible onClose={() => setTeamOpen(false)} /> : null}

      {/* اختيار القيمة · لوحة سفلية واحدة لكل صفوف القيم */}
      <PickerSheet
        visible={!!choice}
        onClose={() => setChoice(null)}
        title={choice?.title ?? ''}
        options={(choice?.options ?? []).map(([v, label]) => ({ value: String(v), label }))}
        value={choice ? String(choice.value) : null}
        onPick={(v) => { choice?.onPick(Number(v)); }}
      />

      {/* حالة المزامنة بتفصيلها */}
      <Sheet visible={syncOpen && !!cloud.user} onClose={() => setSyncOpen(false)} title="حالة المزامنة">
        {([
          ['الاتصال', cloud.online ? 'متصل' : 'غير متصل · التغييرات محفوظة في الطابور'],
          ['المزامنة', cloud.syncing ? (cloud.progress ?? 'جارية') : 'آخر مزامنة ' + lastSync(cloud.sync?.lastSyncAt ?? null)],
          ['في الطابور', String(cloud.sync?.pending ?? 0)],
          ['بانتظار سجل أب', String(cloud.sync?.waiting ?? 0)],
          ['مرفوض عند الوصول', String(cloud.sync?.rejected ?? 0)],
        ] as Array<[string, string]>).map(([k, v]) => (
          <Row key={k} style={{ justifyContent: 'space-between', paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: C.paperLine }}>
            <T size={TYPE.body}>{k}</T>
            <T size={TYPE.body} bold>{v}</T>
          </Row>
        ))}
        {cloud.lastError ? <Note tone="danger">{cloud.lastError}</Note> : null}
        {cloud.online && !cloud.syncing ? (
          <View style={{ marginTop: 10 }}><BtnPrimary icon="reload" title="زامِن الآن" onPress={() => { syncNow(); setSyncOpen(false); }} /></View>
        ) : null}
      </Sheet>

      {/* النسخ على Drive */}
      <Sheet visible={driveOpen && !!cloud.user && cloud.online} onClose={() => setDriveOpen(false)} title="النسخ على Google Drive">
        <T size={TYPE.caption} color={C.muted} style={{ marginBottom: 10 }}>
          {pwOn ? 'النسخة تُشفَّر بكلمة مرور النسخ قبل رفعها.' : 'النسخة تُرفع كما هي · ضع كلمة مرور النسخ من «النسخ الاحتياطي» لتُشفَّر.'}
        </T>
        <BtnPrimary icon="export" title="نسخ إلى Google Drive" onPress={() => { setDriveOpen(false); doDriveBackup(); }} loading={busy} />
        <View style={{ marginTop: 8 }}>
          <BtnGhost icon="undo" title="استعادة من Google Drive" onPress={() => { setDriveOpen(false); openDriveRestore(); }} />
        </View>
      </Sheet>

      {/* حذف الحساب · كلمة التأكيد تُكتب حرفياً فيظهر الزر */}
      <Sheet visible={delOpen && !!cloud.user} onClose={() => setDelOpen(false)} title="حذف حسابي">
        <Note tone="danger">
          {'يُحذف نهائياً ولا يُستعاد: حسابك ' + (cloud.user?.email ?? '') + '، وكل بياناته في السحابة، ونسخ التطبيق على Google Drive، '
            + 'وكل البيانات على هذا الجهاز. وأي جهاز آخر على الحساب يتوقف عن المزامنة.'}
        </Note>
        <T size={TYPE.caption} color={C.muted} style={{ marginVertical: 8 }}>
          إن أردت الاحتفاظ بنسخة فصدّرها من «النسخ الاحتياطي» قبل الحذف. ويُطلب منك الدخول بقوقل مرة أخرى لتأكيد هويتك.
        </T>
        <Field label="اكتب: احذف حسابي" value={delTyped} onChange={setDelTyped} />
        {delTyped.trim() === 'احذف حسابي' ? (
          <BtnPrimary danger icon="trash" title="احذف حسابي نهائياً" loading={busy} onPress={async () => {
            setBusy(true);
            try {
              await deleteMyAccount(db, setProgress);
              setDelOpen(false);
              bump();
            } catch (e) {
              await reportFailure({ title: 'تعذّر حذف الحساب', where: 'حذف الحساب', db, e,
                lead: arabicMessage(e) || 'توقف الحذف عند خطوة لم تكتمل · ما حُذف قبلها لا يعود، وأعد المحاولة لإكمال الباقي.' });
            }
            setProgress(null);
            setBusy(false);
          }} />
        ) : null}
      </Sheet>

      {/* حجم الواجهة والخط */}
      <Sheet visible={displayOpen} onClose={() => setDisplayOpen(false)} title="حجم الواجهة والخط">
        <Row style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <T size={TYPE.body} med>حجم عرض الواجهة</T>
          <Num size={TYPE.number} bold color={C.emerald}>{uiPct}٪</Num>
        </Row>
        <Slider
          style={{ width: '100%', height: 40 }}
          minimumValue={70} maximumValue={150} step={1}
          value={settings.displayScale}
          onValueChange={(v) => previewScale('displayScale', v)}
          onSlidingComplete={(v) => commitScale('displayScale', v)}
          minimumTrackTintColor={C.emerald} maximumTrackTintColor={C.line} thumbTintColor={C.emerald}
        />
        {settings.displayScale !== 100 ? (
          <Row style={{ justifyContent: 'flex-start', marginBottom: 10 }}>
            <BtnGhost small icon="undo" title="إعادة للافتراضي" onPress={() => commitScale('displayScale', 100)} />
          </Row>
        ) : null}
        <Row style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <T size={TYPE.body} med>حجم الخط</T>
          <Num size={TYPE.number} bold color={C.emerald}>{fontPct}٪</Num>
        </Row>
        <Slider
          style={{ width: '100%', height: 40 }}
          minimumValue={70} maximumValue={150} step={1}
          value={settings.fontScale}
          onValueChange={(v) => previewScale('fontScale', v)}
          onSlidingComplete={(v) => commitScale('fontScale', v)}
          minimumTrackTintColor={C.emerald} maximumTrackTintColor={C.line} thumbTintColor={C.emerald}
        />
        {settings.fontScale !== 100 ? (
          <Row style={{ justifyContent: 'flex-start' }}>
            <BtnGhost small icon="undo" title="إعادة للافتراضي" onPress={() => commitScale('fontScale', 100)} />
          </Row>
        ) : null}
        {/* معاينة حية: سطر نص وسطر رقم يتغيّران أثناء السحب */}
        <View style={{ backgroundColor: C.paper, borderRadius: 9, padding: 11, marginTop: 8 }}>
          <T size={TYPE.cardTitle}>عقد إيجار وحدة B-14</T>
          <Num size={TYPE.cardTitle} bold>36,000.00 · 2026-08-18</Num>
        </View>
      </Sheet>

      {/* نسخ Google Drive · اختيار نسخة ثم مسار الاستعادة نفسه */}
      <PickerSheet
        visible={!!driveList}
        onClose={() => setDriveList(null)}
        title="استعادة من Google Drive"
        options={(driveList ?? []).map((b) => ({
          value: b.id,
          label: dfmt(toLocalISODate(new Date(b.createdTime))) + ' · ' + libSizeLabel(b.size),
          sub: b.name + (b.encrypted ? ' · مشفّرة' : '') + (b.notes ? ' · فيها ملاحظات' : ''),
        }))}
        value={''}
        onPick={(id) => {
          const b = (driveList ?? []).find((x) => x.id === id);
          setDriveList(null);
          if (b) runRestore((opts) => prepareRestoreFromDrive(db, b, setProgress, opts));
        }}
      />

      <Sheet visible={pwEdit} onClose={() => setPwEdit(false)} title={pwOn ? 'تغيير كلمة مرور النسخ' : 'كلمة مرور النسخ'}>
        <Note tone="danger">
          إن نسيت كلمة المرور فلا تُفتح النسخ المشفّرة بها أبداً · لا منّا ولا من غيرنا، فلا مفتاح خلفي. اكتبها في مكان آمن خارج الهاتف.
        </Note>
        <T size={TYPE.caption} color={C.muted} style={{ marginVertical: 6 }}>
          تُحفظ في المخزن الآمن على هذا الجهاز وحده، وتُشفَّر بها النسخ بمعيار AES-256-GCM.{pwOn ? ' والنسخ السابقة تبقى بكلمتها القديمة.' : ''}
        </T>
        <Field label={'كلمة المرور (' + MIN_PASSWORD + ' أحرف على الأقل)'} value={pw1} onChange={setPw1} secure ltr />
        <Field label="أعد كتابتها" value={pw2} onChange={setPw2} secure ltr error={!!pw2 && pw2 !== pw1} />
        {pw1.length >= MIN_PASSWORD && pw1 === pw2 ? (
          <BtnPrimary title="احفظ كلمة المرور" onPress={async () => {
            try { await setBackupPassword(pw1); setPwOn(true); setPwEdit(false); toast('حُفظت · النسخ القادمة مشفّرة'); }
            catch (e) { reportFailure({ title: 'تعذّر حفظ كلمة المرور', e }); }
          }} />
        ) : null}
        {pwOn ? (
          <View style={{ marginTop: 10 }}>
            <BtnGhost danger title="إزالة كلمة المرور" onPress={() => dialog({
              title: 'إزالة كلمة مرور النسخ',
              body: 'النسخ القادمة لا تُشفَّر. والنسخ المشفّرة من قبل تبقى تحتاج كلمتها نفسها لتُفتح، فاحتفظ بها.',
              tone: 'danger',
              actions: [
                { label: 'تراجع', variant: 'ghost' },
                { label: 'أزل', variant: 'primary', onPress: async () => { await clearBackupPassword(); setPwOn(false); setPwEdit(false); toast('أُزيلت كلمة مرور النسخ'); } },
              ],
            })} />
          </View>
        ) : null}
      </Sheet>

      <Sheet visible={!!pwAsk} onClose={() => { pwAsk?.resolve(null); setPwAsk(null); }} title="نسخة مشفّرة">
        <T size={TYPE.body} style={{ marginBottom: 8 }}>{pwAsk?.note ?? ''}</T>
        <Field label="كلمة المرور" value={pwTyped} onChange={setPwTyped} secure ltr />
        <Row>
          <View style={{ flex: 1 }}><BtnGhost title="إلغاء" onPress={() => { pwAsk?.resolve(null); setPwAsk(null); }} /></View>
          {pwTyped ? (
            <View style={{ flex: 1 }}><BtnPrimary title="فتح النسخة" onPress={() => { pwAsk?.resolve(pwTyped); setPwAsk(null); }} /></View>
          ) : null}
        </Row>
      </Sheet>

      {keptCancel ? <SourceCancelSheet entryId={keptCancel.id} entryNo={keptCancel.no} onClose={() => setKeptCancel(null)} /> : null}
      {keptEntry ? <EntrySheet entryId={keptEntry} onClose={() => setKeptEntry(null)} onLeave={() => { setKeptEntry(null); setReviewOpen(false); }} /> : null}

      {/* لوحة السلة */}
      <Sheet visible={reviewOpen && !!reviewCount} onClose={() => setReviewOpen(false)} title="مراجعة الأقساط من الدفتر" tall>
        <Note>
          الدفتر هو المرجع: خصم كل قسط من قيود الخصومات الممنوحة، ونقد كل عقد من قيود دفعاته.
          لا يتغيّر شيء إلا بموافقتك، وكل تغيير يُسجَّل في سجل العمليات بقيمه قبل وبعد.
        </Note>
        {review.plan.changes.length ? (
          <>
            <T size={TYPE.cardTitle} bold style={{ marginTop: 6, marginBottom: 4 }}>تصحيح مقترح من الدفتر</T>
            {review.plan.changes.map((c) => (
              <View key={c.installmentId} style={{ paddingVertical: 7, borderBottomWidth: 1, borderBottomColor: C.line }}>
                <T size={TYPE.body} med>{c.tenant + ' · عقد ' + c.contractNo + ' · قسط ' + c.due}</T>
                <T size={TYPE.caption} color={C.muted}>
                  {'المسدَّد ' + fmt(c.fromPaid) + ' ← ' + fmt(c.toPaid) + ' · خصمه في الدفتر ' + fmt(c.ledgerDiscount)
                    + (c.discountEntries.length ? ' (' + c.discountEntries.join('، ') + ')' : '')}
                </T>
              </View>
            ))}
            <View style={{ marginTop: 8 }}>
              <BtnPrimary title={'طبّق التصحيح (' + review.plan.changes.length + ' قسط)'}
                onPress={() => dialog({
                  title: 'تطبيق التصحيح من الدفتر',
                  body: 'سيُعدَّل مسدَّد ' + review.plan.changes.length + ' قسط ليطابق الدفتر · لا يُمسّ قيد ولا دفعة. متابعة؟',
                  tone: 'normal',
                  actions: [
                    { label: 'تراجع', variant: 'ghost' },
                    { label: 'طبّق', variant: 'primary', onPress: () => {
                      try {
                        const n = applyLedgerRepair(db, review.plan);
                        toast('صُحّح ' + n + ' قسط من الدفتر');
                      } catch (e2) {
                        reportFailure({ title: 'تعذّر التصحيح', e: e2 });
                      }
                      bump();
                    } },
                  ],
                })} />
            </View>
          </>
        ) : null}
        {review.surpluses.length ? (
          <>
            <T size={TYPE.cardTitle} bold style={{ marginTop: 14, marginBottom: 4 }}>فائض عن الأقساط</T>
            <T size={TYPE.caption} color={C.muted} style={{ marginBottom: 6 }}>
              نقد قُبض فوق أقساط العقد ولم يُنسب لقسط · يبقى هنا حتى يُردّ للمستأجر أو يُحوَّل رصيداً دائناً له.
            </T>
            {review.surpluses.map((s) => (
              <View key={s.contractId} style={{ paddingVertical: 7, borderBottomWidth: 1, borderBottomColor: C.line }}>
                <T size={TYPE.body} med>{s.tenant + ' · عقد ' + s.contractNo}</T>
                <T size={TYPE.caption} color={C.muted}>
                  {'الفائض ' + fmt(s.amount) + ' · نقد الدفعات في الدفتر ' + fmt(s.cash) + ' · مسدَّد الأقساط ' + fmt(s.paid)
                    + (s.settled ? ' · سُوّي منه ' + fmt(s.settled) : '')}
                </T>
                <Row gap={8} style={{ marginTop: 6 }}>
                  <BtnGhost small title="ردّ الفائض للمستأجر" onPress={() => openSettle(s, 'refund')} />
                  <BtnGhost small title="تحويله رصيداً دائناً" onPress={() => openSettle(s, 'credit')} />
                </Row>
              </View>
            ))}
          </>
        ) : null}
        {review.checks.length ? (
          <>
            <T size={TYPE.cardTitle} bold style={{ marginTop: 14, marginBottom: 4 }}>فحوص الدفتر</T>
            <T size={TYPE.caption} color={C.muted} style={{ marginBottom: 6 }}>
              فروق بين الدفتر والمستندات · لا تمنع النسخ ولا الاستعادة، وتحتاج مراجعتك.
            </T>
            {review.checks.map((x, i) => (
              <View key={i} style={{ paddingVertical: 7, borderBottomWidth: 1, borderBottomColor: C.line }}>
                <T size={TYPE.body}>{x}</T>
              </View>
            ))}
          </>
        ) : null}
        {review.kept.length ? (
          <>
            <T size={TYPE.cardTitle} bold style={{ marginTop: 14, marginBottom: 4 }}>قيود بلا مستند بعد الاستعادة</T>
            <T size={TYPE.caption} color={C.muted} style={{ marginBottom: 6 }}>
              قيود مرحّلة غاب مستندها أو لم يُحمل حالُه (بعد استعادة نسخة هنا أو على جهاز آخر) · القيد المرحّل لا يُحذف، فراجع كلاً منها: اعكسه إن لم يعد له أصل، أو اتركه وعلّمه «تمّت مراجعته».
            </T>
            {review.kept.map((k) => (
              <View key={k.id} style={{ paddingVertical: 7, borderBottomWidth: 1, borderBottomColor: C.line }}>
                <T size={TYPE.body} med>{k.no}</T>
                <T size={TYPE.caption} color={C.muted}>{k.reason}</T>
                <Row gap={8} style={{ marginTop: 6 }}>
                  <BtnGhost small title="افتح القيد" onPress={() => setKeptEntry(k.id)} />
                  {entrySourceAction(db, k.id) ? <BtnGhost small title="عكس القيد" onPress={() => setKeptCancel({ id: k.id, no: k.no })} /> : null}
                  <BtnGhost small title="تمّت مراجعته" onPress={() => { dismissKeptReview(db, k.id); bump(); }} />
                </Row>
              </View>
            ))}
          </>
        ) : null}
        {review.plan.issues.length ? (
          <>
            <T size={TYPE.cardTitle} bold style={{ marginTop: 14, marginBottom: 4 }}>ما لا يحسمه الدفتر ويبقى قرارُه لك</T>
            {review.plan.issues.map((x, i) => (
              <View key={x.contractId + i} style={{ paddingVertical: 7, borderBottomWidth: 1, borderBottomColor: C.line }}>
                <T size={TYPE.body} med>{x.tenant + ' · عقد ' + x.contractNo}</T>
                <T size={TYPE.caption} color={C.muted}>{x.reason}</T>
              </View>
            ))}
          </>
        ) : null}
        {review.unbooked.items.length + review.unbooked.ambiguous.length ? (
          <>
            <T size={TYPE.cardTitle} bold style={{ marginTop: 14, marginBottom: 4 }}>خصومات بلا قيد في الدفتر</T>
            <T size={TYPE.caption} color={C.muted} style={{ marginBottom: 6 }}>
              حدّد نوع كل خصم: «بعد الاستحقاق» يُنشئ قيداً جديداً بالخصم مربوطاً بالدفعة، و«تنزيل من قيمة القسط» يُخفّض القسط بلا قيد.
            </T>
            {review.unbooked.items.map((u) => unbookedRow(u))}
            {review.unbooked.ambiguous.map((a) => (
              <View key={a.contractId} style={{ marginTop: 8 }}>
                <Note tone="danger">
                  {a.tenant + ' · عقد ' + a.contractNo + ': في دفتره خصم يغطي بعض هذه الدفعات ويبقى ' + fmt(a.gap)
                    + ' بلا قيد، ولا يحدد الدفتر أي الدفعات · حدّد ما تعرفه أنت.'}
                </Note>
                {a.candidates.map((u) => unbookedRow(u))}
              </View>
            ))}
          </>
        ) : null}
      </Sheet>

      <Sheet visible={!!settle} onClose={() => setSettle(null)}
        title={settle?.action === 'credit' ? 'تحويل الفائض رصيداً دائناً' : 'ردّ الفائض للمستأجر'}
        footer={settle && toHalalas(settleAmount) > 0 && toHalalas(settleAmount) <= settle.s.amount && !!settleDate
          && (settle.action === 'credit' || settleMethod === 'cash' || (settleMethod === 'bank' && !!settleBank)) ? (
          <View style={{ flex: 1 }}>
            <BtnPrimary title={settle.action === 'credit' ? 'سجّل التحويل' : 'سجّل الردّ'} onPress={() => {
              const cur = settle;
              setSettle(null);
              try {
                const e = settleSurplus(db, cur.s.contractId, {
                  action: cur.action, amountHalalas: toHalalas(settleAmount), date: settleDate,
                  method: cur.action === 'refund' ? (settleMethod || undefined) : undefined,
                  bankId: settleMethod === 'bank' ? settleBank : undefined,
                });
                toast((cur.action === 'credit' ? 'حُوّل الفائض رصيداً دائناً · قيد ' : 'سُجّل ردّ الفائض · قيد ') + e.no);
              } catch (e2) {
                reportFailure({ title: 'تعذّرت تسوية الفائض', e: e2 });
              }
              bump();
            }} />
          </View>
        ) : null}>
        {settle ? (
          <>
            <T size={TYPE.body} med style={{ marginBottom: 6 }}>{settle.s.tenant + ' · عقد ' + settle.s.contractNo}</T>
            <T size={TYPE.caption} color={C.muted} style={{ marginBottom: 10 }}>
              {settle.action === 'credit'
                ? 'قيد جديد: مدين إيرادات الإيجار (ما قُبض فوق الأقساط) · دائن أرصدة مستأجرين دائنة، ويزيد رصيد المستأجر الدائن.'
                : 'قيد جديد بتاريخ الردّ: مدين إيرادات الإيجار (ما قُبض فوق الأقساط) · دائن النقدية والبنوك بما خرج للمستأجر.'}
            </T>
            <Field label={'المبلغ (الفائض ' + fmt(settle.s.amount) + ')'} value={settleAmount} onChange={setSettleAmount} keyboard="numeric" ltr />
            <DateField label={settle.action === 'credit' ? 'تاريخ التحويل' : 'تاريخ الردّ'} value={settleDate} onChange={setSettleDate} />
            {settle.action === 'refund' ? (
              <>
                <SelectField<'cash' | 'bank'>
                  label="طريقة الردّ"
                  value={settleMethod || null}
                  placeholder="اختر طريقة الردّ"
                  options={[{ value: 'cash', label: 'نقداً' }, { value: 'bank', label: 'تحويل بنكي' }]}
                  onPick={setSettleMethod}
                />
                {settleMethod === 'bank' ? (
                  <SelectField
                    label="الحساب الذي خرج منه التحويل"
                    value={settleBank || null}
                    options={banks.map((b) => ({ value: b.id, label: b.name }))}
                    onPick={setSettleBank}
                    placeholder="اختر الحساب"
                    emptyText="أضف حساباً بنكياً أولاً من شاشة البنوك"
                  />
                ) : null}
              </>
            ) : null}
            {toHalalas(settleAmount) > settle.s.amount ? (
              <T size={11.5} color={C.rose}>المبلغ أكبر من الفائض</T>
            ) : settle.action === 'refund' && !settleMethod ? (
              <T size={11.5} color={C.rose}>اختر طريقة الردّ ليظهر زر التسجيل</T>
            ) : settleMethod === 'bank' && !settleBank ? (
              <T size={11.5} color={C.rose}>اختر الحساب ليظهر زر التسجيل</T>
            ) : null}
          </>
        ) : null}
      </Sheet>

      <Sheet visible={trashOpen} onClose={() => setTrashOpen(false)} title="سلة المحذوفات" tall>
        {data.trash.length ? (
          <>
            <Row style={{ marginBottom: 10 }}>
              <View style={{ flex: 1 }}>
                <BtnGhost small icon="undo" title={`استعادة الكل (${data.trash.length})`}
                  onPress={() => dialog({
                    title: 'استعادة الكل',
                    body: `استعادة جميع العناصر المحذوفة (${data.trash.length})؟ سيُعاد كل عنصر إلى قسمه الأصلي.`,
                    tone: 'normal',
                    actions: [
                      { label: 'تراجع', variant: 'ghost' },
                      { label: 'استعادة الكل', variant: 'primary', onPress: async () => {
                        try {
                          await restoreAllFromTrash(db, (d2, t2) => setProgress('جاري الاستعادة · ' + d2 + ' من ' + t2));
                          toast('تمت استعادة جميع العناصر بنجاح');
                        } catch (e2) {
                          reportFailure({ title: 'تعذّرت الاستعادة', e: e2 });
                        }
                        setProgress(null); bump();
                      } },
                    ],
                  })} />
              </View>
              <View style={{ flex: 1 }}>
                <BtnGhost small danger icon="trash" title="حذف الكل نهائياً"
                  onPress={() => dialog({
                    title: 'حذف الكل نهائياً',
                    body: `سيُحذف نهائياً ${data.trash.length} عنصراً بلا رجعة أبداً. متابعة؟`,
                    tone: 'danger',
                    actions: [
                      { label: 'تراجع', variant: 'ghost' },
                      { label: 'حذف نهائي', variant: 'danger', onPress: async () => {
                        try {
                          await deleteAllFromTrash(db, (d2, t2) => setProgress('جاري الحذف النهائي · ' + d2 + ' من ' + t2));
                          setProgress('جاري تحرير المساحة');
                          await reclaimStorage(db);
                          toast('تم الحذف النهائي وتحرير المساحة');
                        } catch (e2) {
                          reportFailure({ title: 'تعذّر الحذف النهائي', e: e2 });
                        }
                        setProgress(null); bump();
                      } },
                    ],
                  })} />
              </View>
            </Row>
            {data.trash.map((t) => (
              <View key={t.table + t.id} style={{ paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: C.line }}>
                <Row style={{ justifyContent: 'space-between' }}>
                  <T size={TYPE.cardTitle} med style={{ flex: 1 }}>{t.entityLabel}: {t.label}</T>
                  <Badge kind={t.daysLeft <= 5 ? 'overdue' : 'due'} label={t.daysLeft + ' يوم متبقٍ'} />
                </Row>
                <Row style={{ justifyContent: 'flex-end', marginTop: 6 }}>
                  <BtnGhost small icon="undo" title="استعادة"
                    onPress={() => {
                      try { restoreFromTrash(db, t.table, t.id); toast('تمت الاستعادة بنجاح'); }
                      catch (e2) {
                        reportFailure({ title: 'تعذّرت الاستعادة', e: e2 });
                      }
                      bump();
                    }} />
                  <BtnGhost small danger title="حذف نهائي"
                    onPress={() => dialog({
                      title: 'حذف نهائي',
                      body: 'حذف نهائي · لا يمكن التراجع عن هذا أبداً. متابعة؟',
                      tone: 'danger',
                      actions: [
                        { label: 'تراجع', variant: 'ghost' },
                        { label: 'حذف نهائي', variant: 'danger', onPress: async () => {
                          try {
                            purgeFromTrash(db, t.table, t.id);
                            setProgress('جاري تحرير المساحة');
                            await reclaimStorage(db);
                            toast('تم الحذف النهائي وتحرير المساحة');
                          } catch (e2) {
                            reportFailure({ title: 'تعذّر الحذف النهائي', e: e2 });
                          }
                          setProgress(null); bump();
                        } },
                      ],
                    })} />
                </Row>
              </View>
            ))}
          </>
        ) : (
          <EmptyState>سجل الحذف فارغ · أي عنصر تحذفه سيظهر هنا طوال مدة الاحتفاظ قبل حذفه نهائياً</EmptyState>
        )}
        <View style={{ height: 12 }} />
      </Sheet>

      {/* تأكيد المسح */}
      {wipeConfirm !== null && (
        <Sheet visible onClose={() => setWipeConfirm(null)} title="مسح كل البيانات"
          footer={
            <>
              <View style={{ flex: 1 }}><BtnPrimary danger title="تنفيذ المسح" onPress={doWipe} /></View>
            </>
          }>
          <Note tone="danger">هذا الإجراء سيمسح كل البيانات. للتأكيد، اكتب كلمة «مسح» بالضبط ثم اضغط تنفيذ.</Note>
          <Field label="اكتب «مسح» للتأكيد" value={wipeConfirm} onChange={setWipeConfirm} />
        </Sheet>
      )}
      {progress !== null && (() => {
        // «... · N من M» → شريط تقدم محدد النسبة · وبلا أعداد يظهر الشريط بهيئة غير محددة
        const m = progress.match(/·\s*(\d+)\s*من\s*(\d+)\s*$/);
        const pct = m ? Math.min(100, Math.round((Number(m[1]) / Math.max(1, Number(m[2]))) * 100)) : null;
        const fillW: `${number}%` = pct !== null ? `${pct}%` : '100%';
        return (
          <Modal visible transparent animationType="fade">
            <View style={{ flex: 1, backgroundColor: 'rgba(20,23,29,0.55)', alignItems: 'center', justifyContent: 'center', padding: 32 }}>
              <View style={{ backgroundColor: '#fff', borderRadius: 14, padding: 22, minWidth: 260, alignItems: 'center', gap: 12 }}>
                <View style={{ alignSelf: 'stretch', height: 8, borderRadius: 4, backgroundColor: C.paperLine, overflow: 'hidden' }}>
                  <View style={{ height: 8, borderRadius: 4, backgroundColor: C.emerald, width: fillW, opacity: pct !== null ? 1 : 0.3 }} />
                </View>
                <T size={TYPE.number} med center>{progress}</T>
              </View>
            </View>
          </Modal>
        );
      })()}
    </Screen>
  );
}

