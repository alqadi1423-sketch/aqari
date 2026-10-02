/**
 * الإعدادات · خمس مجموعات بترتيب المالك: المنشأة ثم المالية ثم المراسلات
 * ثم البيانات ثم النظام · وكل إعداد في الشاشة يسكن مجموعته.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { View, Platform, Modal, Linking } from 'react-native';
import Slider from '@react-native-community/slider';
import { useRouter } from 'expo-router';
import { Screen } from '../src/ui/Screen';
import {
  Card, CardTitle, T, Num, SetRow, ChipGroup, BtnPrimary, BtnGhost, Note, Row, Badge, EmptyState, Field,
} from '../src/ui/components';
import { Sheet, PickerSheet } from '../src/ui/Sheet';
import { useDialog } from '../src/ui/AppDialog';
import { useApp } from '../src/ui/store';
import { useToast } from '../src/ui/Toast';
import { C, TYPE } from '../src/ui/theme';
import { computeReminders, exportStatus } from '../src/domain/reminders';
import { trashItems, restoreFromTrash, purgeFromTrash, restoreAllFromTrash, deleteAllFromTrash } from '../src/domain/trash';
import { createAndShareBackup, pickAndPrepareRestore, commitPreparedRestore, abortPreparedRestore, appBackupEnv } from '../src/services/backupService';
import { wipeAllData } from '../src/domain/wipe';
import { fingerprintData } from '../src/domain/backup/create';
import { rescheduleAllNotifications } from '../src/services/notifications';
import { getMeta } from '../src/repos/settings';
import { SCHEMA_VERSION } from '../src/db/schema';
import { storageBreakdown, sweepCache, reclaimStorage } from '../src/services/storageOps';
import { libSizeLabel } from '../src/domain/library';
import { reportFailure, arabicMessage } from '../src/ui/failureDialog';
import {
  cloudState, subscribeCloud, cloudSignIn, cloudSignOut, backupToDrive, listBackupsOnDrive, prepareRestoreFromDrive,
} from '../src/services/cloud';
import type { DriveBackup } from '../src/cloud/drive';
import { dfmt, toLocalISODate } from '../src/domain/dates';

const APP_VERSION = '1.0.0';

const PLATFORM_AR: Record<string, string> = { android: 'أندرويد', ios: 'آيفون', web: 'الويب' };

/** عنوان قسم داخل المجموعة · الفاصل فوقه يفصل ما قبله عمّا بعده */
function Sub({ children, first }: { children: React.ReactNode; first?: boolean }) {
  return (
    <View style={{
      marginTop: first ? 0 : 14, marginBottom: 8, paddingTop: first ? 0 : 12,
      borderTopWidth: first ? 0 : 1, borderTopColor: C.paperLine,
    }}>
      <T size={TYPE.cardTitle} bold color={C.ink}>{children}</T>
    </View>
  );
}

export default function Settings() {
  const { db, version, bump, settings, updateSetting, uiPct, fontPct, previewScale, commitScale } = useApp();
  const toast = useToast();
  const dialog = useDialog();
  const router = useRouter();
  const [trashOpen, setTrashOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [wipeConfirm, setWipeConfirm] = useState<string | null>(null);
  // شريط تقدم بالمراحل · «جاري نسخ المرفقات · ٢٢ من ١١٨» فلا يُظن التطبيق متجمداً
  const [progress, setProgress] = useState<string | null>(null);
  // الحساب والمزامنة · حالة حيّة من طبقة الربط
  const [cloud, setCloud] = useState(cloudState());
  useEffect(() => subscribeCloud(() => setCloud(cloudState())), []);
  const [driveList, setDriveList] = useState<DriveBackup[] | null>(null);

  const data = useMemo(() => {
    const reminders = computeReminders(db);
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
    return { reminders, exp, trash, counts, total };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, version]);

  const doBackup = async () => {
    setBusy(true);
    const before = fingerprintData(appBackupEnv(db));
    try {
      await createAndShareBackup(db, setProgress);
      bump();
      // لا نسخة «ناقصة» · ما لم يجتز كل تحقق فلم يُنشأ أصلاً
      toast('أُنشئت النسخة وتُحقّق منها بنجاح');
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

  // الاستعادة لا تنهار أبداً · كل المسار ملفوف، والفشل رسالة عربية مبنيّة على فحص
  const doRestore = () => runRestore(() => pickAndPrepareRestore(db, setProgress));

  // المسار الواحد للاستعادة من أي مصدر: التجهيز (فك وبصمات وفحص دلالي) ثم الملخص ثم التنفيذ
  const runRestore = async (prepare: () => Promise<Awaited<ReturnType<typeof pickAndPrepareRestore>>>) => {
    setBusy(true);
    const before = fingerprintData(appBackupEnv(db));
    let prepared: Awaited<ReturnType<typeof pickAndPrepareRestore>> = null;
    try {
      prepared = await prepare();
      setProgress(null);
      if (!prepared) { setBusy(false); return; }
      const { env, plan, archiveTmp } = prepared;
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
          + ' (' + (plan.currentAttachments.bytes / (1024 * 1024)).toFixed(1) + ' ميغا)',
        tone: 'normal',
        locked: true,
        actions: [
          {
            label: 'إلغاء', variant: 'ghost',
            onPress: () => { try { abortPreparedRestore(env, plan, archiveTmp); } catch { /* يكنسه الإقلاع */ } },
          },
          {
            label: 'متابعة الاستعادة', variant: 'primary',
            onPress: async () => {
              setBusy(true);
              try {
                await commitPreparedRestore(env, plan, archiveTmp, setProgress);
                bump();
                rescheduleAllNotifications(db).catch(() => {});
                toast('اكتملت الاستعادة والتُحقق منها');
              } catch (e) {
                await reportFailure({
                  title: 'تعذّرت الاستعادة', where: 'استعادة', db, auditModule: 'النسخ الاحتياطي', auditAction: 'update',
                  before, env: appBackupEnv(db), e,
                });
              }
              setProgress(null);
              setBusy(false);
            },
          },
        ],
      });
    } catch (e) {
      // لا يُترك مجلد تجهيز وراءنا إن فشل شيء بعد نجاح التجهيز
      if (prepared) { try { abortPreparedRestore(prepared.env, prepared.plan, prepared.archiveTmp); } catch { /* يكنسه الإقلاع */ } }
      await reportFailure({
        title: 'تعذّرت الاستعادة', where: 'تجهيز استعادة', db, auditModule: 'النسخ الاحتياطي', auditAction: 'update',
        before, env: appBackupEnv(db), e,
      });
    }
    setProgress(null);
    setBusy(false);
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
  const doSignOut = () => dialog({
    title: 'تسجيل الخروج',
    body: 'تتوقف المزامنة والنسخ على Google Drive · بياناتك على هذا الجهاز تبقى كما هي، وما تغيّر بعد الخروج يُرسل حين تعود.',
    tone: 'normal',
    actions: [
      { label: 'تراجع', variant: 'ghost' },
      { label: 'تسجيل الخروج', variant: 'primary', onPress: async () => {
        try { await cloudSignOut(); toast('خرجت من الحساب · بياناتك على الجهاز كما هي'); }
        catch (e) { await reportFailure({ title: 'تعذّر تسجيل الخروج', where: 'تسجيل الخروج', db, e }); }
      } },
    ],
  });
  const doDriveBackup = async () => {
    setBusy(true);
    try {
      const b = await backupToDrive(db, setProgress);
      bump();
      toast('رُفعت النسخة إلى Google Drive وطابقت بصمتها · ' + libSizeLabel(b.size));
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

  return (
    <Screen title="الإعدادات" icon="settings">
      {/* ١ · المنشأة */}
      <Card>
        <CardTitle>المنشأة</CardTitle>
        <SetRow icon="building" title="الاسم والرقم الضريبي · الشعار والترويسة"
          onPress={() => router.push('/company')} />
      </Card>

      {/* ٢ · المالية */}
      <Card>
        <CardTitle>المالية</CardTitle>
        <SetRow icon="wallet" title="العملة ودليل الحسابات" onPress={() => router.push('/accounts')} />
        <Sub>ضريبة القيمة المضافة</Sub>
        <VatChips />
      </Card>

      {/* ٣ · المراسلات */}
      <Card>
        <CardTitle>المراسلات</CardTitle>
        <SetRow icon="message" title="قوالب الرسائل" onPress={() => router.push('/scripts')} />
        <Sub>تنبيهات المواعيد</Sub>
        <T size={TYPE.caption} color={C.muted} style={{ marginBottom: 5 }}>الحالة</T>
        <ChipGroup options={[[1, 'مفعّلة'], [0, 'مطفأة']]} value={settings.remindersOn ? 1 : 0}
          onChange={(v) => { updateSetting('remindersOn', !!v); rescheduleAllNotifications(db).catch(() => {}); }} />
        <T size={TYPE.caption} color={C.muted} style={{ marginVertical: 5 }}>تنبيه قبل استحقاق الدفعة</T>
        <ChipGroup options={[[1, 'بيوم'], [3, 'بثلاثة أيام'], [7, 'بأسبوع'], [14, 'بأسبوعين']]}
          value={settings.remindPayment}
          onChange={(v) => { updateSetting('remindPayment', v as never); rescheduleAllNotifications(db).catch(() => {}); }} />
        <T size={TYPE.caption} color={C.muted} style={{ marginVertical: 5 }}>تنبيه قبل انتهاء العقد</T>
        <ChipGroup options={[[15, 'بخمسة عشر يوماً'], [30, 'بشهر'], [60, 'بشهرين'], [90, 'بثلاثة أشهر']]}
          value={settings.remindContract}
          onChange={(v) => { updateSetting('remindContract', v as never); rescheduleAllNotifications(db).catch(() => {}); }} />
        <T size={TYPE.caption} color={C.muted} style={{ marginVertical: 5 }}>تنبيه قبل انتهاء المستند</T>
        <ChipGroup options={[[15, 'بخمسة عشر يوماً'], [30, 'بشهر'], [60, 'بشهرين']]}
          value={settings.remindDoc}
          onChange={(v) => { updateSetting('remindDoc', v as never); rescheduleAllNotifications(db).catch(() => {}); }} />
        <Row style={{ justifyContent: 'space-between', marginTop: 10 }}>
          <T size={TYPE.body}>تنبيهات مستحقة الآن</T>
          <Num size={TYPE.body} bold>{data.reminders.length}</Num>
        </Row>
        {data.reminders.slice(0, 6).map((r, i) => (
          <Row key={i} style={{ justifyContent: 'space-between', paddingVertical: 4 }}>
            <T size={TYPE.caption}>{r.kind} · {r.subject}</T>
            <T size={TYPE.caption} bold color={r.days < 0 ? C.rose : C.muted}>
              {r.days < 0 ? 'متأخر ' + Math.abs(r.days) + ' يوماً' : 'بعد ' + r.days + ' يوماً'}
            </T>
          </Row>
        ))}
      </Card>

      {/* ٤ · البيانات */}
      <Card>
        <CardTitle>البيانات</CardTitle>

        <Sub first>الحساب والمزامنة</Sub>
        {!cloud.configured ? (
          <T size={TYPE.body} color={C.muted}>الربط بحساب قوقل غير مهيّأ في هذا البناء · التطبيق يعمل كاملاً بلا إنترنت وبلا حساب</T>
        ) : !cloud.user ? (
          <>
            <T size={TYPE.caption} color={C.muted} style={{ marginBottom: 8 }}>
              اختياري · الدخول يضيف المزامنة والنسخ على Google Drive، والقاعدة على هذا الجهاز تبقى الأصل
            </T>
            <Row style={{ justifyContent: 'space-between', paddingVertical: 5 }}>
              <T size={TYPE.body}>الاتصال</T>
              <T size={TYPE.body} bold color={cloud.online ? C.emerald : C.muted}>{cloud.online ? 'متصل' : 'غير متصل'}</T>
            </Row>
            {cloud.online ? <BtnPrimary icon="lock" title="تسجيل الدخول بحساب قوقل" onPress={doSignIn} loading={busy} /> : null}
          </>
        ) : (
          <>
            {([
              ['الحساب', cloud.user.email, C.ink],
              ['الاتصال', cloud.online ? 'متصل' : 'غير متصل · التغييرات محفوظة في الطابور', cloud.online ? C.emerald : C.muted],
              ['المزامنة', cloud.syncing ? (cloud.progress ?? 'جارية') : 'آخر مزامنة ' + lastSync(cloud.sync?.lastSyncAt ?? null), C.ink],
              ['في الطابور', String(cloud.sync?.pending ?? 0), C.ink],
              ['بانتظار سجل أب', String(cloud.sync?.waiting ?? 0), C.ink],
              ['مرفوض عند الوصول', String(cloud.sync?.rejected ?? 0), (cloud.sync?.rejected ?? 0) > 0 ? C.rose : C.ink],
            ] as Array<[string, string, string]>).map(([k, v, color]) => (
              <Row key={k} style={{ justifyContent: 'space-between', paddingVertical: 5 }}>
                <T size={TYPE.body}>{k}</T>
                <T size={TYPE.body} bold color={color}>{v}</T>
              </Row>
            ))}
            {cloud.lastError ? <Note tone="danger">{cloud.lastError}</Note> : null}
            {cloud.online ? (
              <Row style={{ marginTop: 6 }}>
                <View style={{ flex: 1 }}><BtnPrimary icon="export" title="نسخ إلى Google Drive" onPress={doDriveBackup} loading={busy} /></View>
                <View style={{ flex: 1 }}><BtnGhost icon="undo" title="استعادة من Google Drive" onPress={openDriveRestore} /></View>
              </Row>
            ) : null}
            <View style={{ marginTop: 6 }}><BtnGhost title="تسجيل الخروج" onPress={doSignOut} /></View>
          </>
        )}

        <Sub>نسخة احتياطية واستعادة</Sub>
        <Row style={{ justifyContent: 'space-between', paddingVertical: 5 }}>
          <T size={TYPE.body}>آخر تصدير خارج الجهاز</T>
          <T size={TYPE.body} bold color={data.exp.warn ? C.rose : C.emerald}>
            {data.exp.daysSinceExport === null ? 'لم يحدث بعد'
              : data.exp.daysSinceExport === 0 ? 'اليوم' : 'قبل ' + data.exp.daysSinceExport + ' يوماً'}
          </T>
        </Row>
        <Row style={{ justifyContent: 'space-between', paddingVertical: 5, marginBottom: 8 }}>
          <T size={TYPE.body}>حالة الحماية</T>
          <T size={TYPE.body} bold color={data.exp.warn ? C.rose : C.emerald}>{data.exp.warn ? 'تحتاج انتباهك' : 'محمية'}</T>
        </Row>
        {settings.backupWeekly && data.exp.warn ? (
          <Note tone="danger">
            مضى {data.exp.daysSinceExport === null ? 'وقت طويل' : data.exp.daysSinceExport + ' يوماً'} بلا تصدير خارج الجهاز.
          </Note>
        ) : null}
        <Row>
          <View style={{ flex: 1 }}><BtnPrimary title="النسخ الاحتياطي" onPress={doBackup} loading={busy} /></View>
          <View style={{ flex: 1 }}><BtnGhost title="استعادة من نسخة" onPress={doRestore} disabled={busy} /></View>
        </Row>
        <T size={TYPE.caption} color={C.muted} style={{ marginTop: 10, marginBottom: 5 }}>تذكير أسبوعي بالتصدير خارج الجهاز</T>
        <ChipGroup options={[[1, 'مفعّل'], [0, 'مطفأ']]} value={settings.backupWeekly ? 1 : 0}
          onChange={(v) => { updateSetting('backupWeekly', !!v); rescheduleAllNotifications(db).catch(() => {}); }} />

        <Sub>المساحة</Sub>
        <Row style={{ justifyContent: 'space-between', marginBottom: 6 }}>
          <T size={TYPE.cardTitle} bold>المساحة المستهلكة</T>
          <Num size={TYPE.number} bold color={C.emerald}>{libSizeLabel(storageTotal)}</Num>
        </Row>
        {storageRow('الملفات الأصلية', storage.originalsBytes, storage.originalsCount + ' ملف')}
        {storageRow('المصغّرات', storage.thumbsBytes)}
        {storageRow('قاعدة البيانات', storage.dbBytes)}
        {/* بلا مؤقتات لا تفريغ · الزر الذي لا يصحّ فعله لا يُعرض */}
        {storageRow('ملفات مؤقتة', storage.cacheBytes, undefined,
          storage.cacheBytes > 0 ? (
            <BtnGhost small title="تفريغ" onPress={() => {
              const freed = sweepCache();
              bump(); toast('حُرّر ' + libSizeLabel(freed) + ' من المؤقتات');
            }} />
          ) : undefined)}
        {storageRow('سلة المحذوفات', storage.trashBytes, storage.trashCount + ' ملف')}
        {storageRow('نسخة الأمان قبل آخر استيراد أو مسح', storage.safetyBytes,
          storage.safetyCount + ' ملف')}
        <T size={TYPE.caption} color={C.muted} style={{ marginTop: 10, marginBottom: 5 }}>نزع بيانات الصور الوصفية عند الرفع</T>
        <ChipGroup options={[[0, 'مطفأ'], [1, 'مفعّل']]} value={settings.stripExif ? 1 : 0}
          onChange={(v) => updateSetting('stripExif', !!v)} />

        <Sub>سلة المحذوفات</Sub>
        <Row style={{ justifyContent: 'space-between', marginBottom: 8 }}>
          <T size={TYPE.body}>سجلات في السلة</T>
          <Row gap={10}>
            <Num size={TYPE.body} bold>{data.trash.length}</Num>
            <BtnGhost small title="افتح" onPress={() => setTrashOpen(true)} />
          </Row>
        </Row>
        <T size={TYPE.caption} color={C.muted} style={{ marginBottom: 5 }}>مدة الاحتفاظ قبل الحذف النهائي</T>
        <ChipGroup options={[[30, '٣٠ يوماً'], [60, '٦٠ يوماً'], [90, '٩٠ يوماً']]}
          value={settings.trashRetention}
          onChange={(v) => updateSetting('trashRetention', v as never)} />

        <Sub>بياناتك بالأرقام</Sub>
        <Row style={{ justifyContent: 'space-between', paddingVertical: 5 }}>
          <T size={TYPE.body}>إجمالي السجلات</T>
          <Num size={TYPE.body} bold>{data.total}</Num>
        </Row>
        {data.counts.map(([k, n]) => (
          <Row key={k} style={{ justifyContent: 'space-between', paddingVertical: 5, borderTopWidth: 1, borderTopColor: C.line }}>
            <T size={TYPE.body}>{k}</T>
            <Num size={TYPE.body} bold>{n}</Num>
          </Row>
        ))}

        <Sub>حذف كل البيانات</Sub>
        <Note tone="danger">
          المسح ينقل كل شيء إلى سلة المحذوفات ويبقى قابلاً للاسترجاع طوال مدة الاحتفاظ أعلاه.
        </Note>
        <BtnGhost danger icon="trash" title="امسح كل البيانات" onPress={() => setWipeConfirm('')} />
      </Card>

      {/* ٥ · النظام */}
      <Card>
        <CardTitle>النظام</CardTitle>

        <Sub first>العرض</Sub>
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
        <Row style={{ justifyContent: 'flex-start', marginBottom: 10 }}>
          <BtnGhost small icon="undo" title="إعادة للافتراضي" onPress={() => commitScale('displayScale', 100)} />
        </Row>
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
        <Row style={{ justifyContent: 'flex-start' }}>
          <BtnGhost small icon="undo" title="إعادة للافتراضي" onPress={() => commitScale('fontScale', 100)} />
        </Row>
        {/* معاينة حية: سطر نص وسطر رقم يتغيّران أثناء السحب */}
        <View style={{ backgroundColor: C.paper, borderRadius: 9, padding: 11, marginTop: 8 }}>
          <T size={TYPE.cardTitle}>عقد إيجار وحدة B-14</T>
          <Num size={TYPE.cardTitle} bold>36,000.00 · 2026-08-18</Num>
        </View>

        <Sub>ودجت الشاشة</Sub>
        {/* أندرويد وحده يسمح بتثبيت الودجت من داخل التطبيق · وغيره لا يعرض الصفّ */}
        <Note>ضع رقمك على شاشة جوالك · الودجت تقرأ لقطةً يكتبها التطبيق ولا تفتح بياناتك.</Note>
        <SetRow icon="collect" title="شريط اليوم · كم متأخرة وبكم"
          onPress={() => { Linking.openURL('aqariwidget://pin/strip').catch(() => toast('المشغّل لا يدعم التثبيت · أضفها بالضغط المطوّل على الشاشة')); }} />
        <SetRow icon="chart" title="لوحة التحصيل · المحصَّل من المستحق"
          onPress={() => { Linking.openURL('aqariwidget://pin/panel').catch(() => toast('المشغّل لا يدعم التثبيت · أضفها بالضغط المطوّل على الشاشة')); }} />
        <SetRow icon="menu" title="أزرار سريعة · تحصيل وفاتورة ومطالبة"
          onPress={() => { Linking.openURL('aqariwidget://pin/actions').catch(() => toast('المشغّل لا يدعم التثبيت · أضفها بالضغط المطوّل على الشاشة')); }} />

        <Sub>قياس الأداء</Sub>
        <SetRow icon="chart" title="أزمنة التنقل والاستعلامات على جهازك" onPress={() => router.push('/perf' as never)} />

        <Sub>عن التطبيق</Sub>
        <T size={TYPE.number} bold style={{ marginBottom: 2 }}>عقاري · أحد حلول منصة رِكز</T>
        <T size={TYPE.caption} color={C.muted} style={{ marginBottom: 8 }}>تطبيق إدارة الأملاك العقارية من منصة رِكز</T>
        {([['الإصدار', APP_VERSION], ['إصدار قاعدة البيانات', String(SCHEMA_VERSION)],
          ['المنصّة', PLATFORM_AR[Platform.OS] ?? 'غير معروفة'],
          ['معرّف الجهاز', getMeta(db, 'device_id') ?? '']] as Array<[string, string]>)
          .filter(([, v]) => v !== '').map(([k, v]) => (
          <Row key={k} style={{ justifyContent: 'space-between', paddingVertical: 5 }}>
            <T size={TYPE.body}>{k}</T>
            <Num size={TYPE.body} bold>{v}</Num>
          </Row>
        ))}
        {cloud.user ? (
          <Note tone="ok">بياناتك على هذا الجهاز أولاً وتُزامَن مع حسابك ({cloud.user.email}) · لا يقرؤها ولا يكتبها غيرك.</Note>
        ) : (
          <Note tone="ok">لا خادم · لا حساب · لا إنترنت. بياناتك على هذا الجهاز وحده، ولا تغادره إلا حين تُصدّرها أنت.</Note>
        )}
      </Card>

      {/* نسخ Google Drive · اختيار نسخة ثم مسار الاستعادة نفسه */}
      <PickerSheet
        visible={!!driveList}
        onClose={() => setDriveList(null)}
        title="استعادة من Google Drive"
        options={(driveList ?? []).map((b) => ({
          value: b.id,
          label: dfmt(toLocalISODate(new Date(b.createdTime))) + ' · ' + libSizeLabel(b.size),
          sub: b.name,
        }))}
        value={''}
        onPick={(id) => {
          const b = (driveList ?? []).find((x) => x.id === id);
          setDriveList(null);
          if (b) runRestore(() => prepareRestoreFromDrive(db, b, setProgress));
        }}
      />

      {/* لوحة السلة */}
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

function VatChips() {
  const { db, version, bump } = useApp();
  const vat = useMemo(
    () => Number(db.get<{ vat_enabled: number }>(`SELECT vat_enabled FROM company WHERE id = 1`)?.vat_enabled ?? 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [db, version]
  );
  return (
    <ChipGroup options={[[0, 'مطفأة · لا تُحتسب'], [1, 'مفعّلة']]} value={vat}
      onChange={(v) => {
        db.transaction(() => db.run(`UPDATE company SET vat_enabled = ? WHERE id = 1`, [v]));
        bump();
      }} />
  );
}
