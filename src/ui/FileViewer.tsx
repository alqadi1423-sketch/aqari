/**
 * عارض الملفات داخل التطبيق · الملف الذي لا أستطيع رؤيته كأنه غير محفوظ:
 * صورة بتكبير الإصبعين وتدوير، PDF بتصفح صفحات ورقمها من الإجمالي، فيديو وصوت
 * بمشغّل أصلي، وسائر الأنواع ببطاقة وفتح بتطبيق آخر · سحب أفقي بين ملفات المجموعة،
 * وبطاقة معلومات، ومشاركة وطباعة وحفظ في المعرض وإعادة تسمية ونقل وحذف.
 */
import type { SectionKey } from '../domain/access/sections';
import { usePerm } from './access';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Modal, View, FlatList, Pressable, useWindowDimensions,
  ActivityIndicator, Image, PanResponder, Text, Platform, I18nManager,
} from 'react-native';
import { DirView } from './DirView';
import { useAppLocked } from './lockState';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import { useVideoPlayer, VideoView } from 'expo-video';
// الواجهة القديمة صراحةً · SDK 57 يرمي «deprecated» على الاستدعاء من المسار الرئيسي فكان الحفظ في المعرض يفشل
import * as MediaLibrary from 'expo-media-library/legacy';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import { File, Paths } from 'expo-file-system';
import { T, Num, BtnGhost, BtnPrimary, Row, Field } from './components';
import { PickerSheet, Sheet } from './Sheet';
import { useSaveAttempt } from './formAttempt';
import { Icon, type IconName } from './icons';
import { useApp } from './store';
import { useToast } from './Toast';
import { useDialog } from './AppDialog';
import { C, FONT_BOLD } from './theme';
import { LIB_CATS, libCat, libSizeLabel, updateLibraryFile } from '../domain/library';
import { softDeleteAttachment, unlinkAttachment, isSafeBlobName } from '../files/store';
import { dfmt } from '../domain/dates';
import { joinPath } from '../files/fsAdapter';
import { appDataRoot } from '../files/expoFs';
import { thumbUri, existingThumbUri, isImageFile } from '../services/thumbs';
import { filesCloudOn, openFileNow } from '../services/cloud';
import { cancelSource, isCancelled, progressView, progressLabel, progressLine, type ProgressInfo } from '../domain/progress';
import Pdf from 'react-native-pdf';
import { logAudit } from '../domain/audit';
import { reportFailure, recordFailure, copyFailureDetails, shareFailureDetails } from './failureDialog';

export interface ViewerFile {
  attId: string;
  sha256: string;
  ext: string;
  name: string;
  mime: string;
  sizeBytes: number;
  createdAt: string;
  cat: string;
  /** الجهة المرتبط بها (نص جاهز للعرض) */
  linked: string;
}

const norm = (p: string): string => (p.startsWith('file://') ? p : 'file://' + p);
const fileUriOf = (f: ViewerFile): string => norm(joinPath(appDataRoot(), 'attachments', f.sha256 + '.' + f.ext));

type FileKind = 'image' | 'pdf' | 'video' | 'audio' | 'other';
function kindOf(f: ViewerFile): FileKind {
  if (isImageFile(f.ext, f.mime)) return 'image';
  if (f.ext === 'pdf' || f.mime === 'application/pdf') return 'pdf';
  if (f.mime.startsWith('video/') || ['mp4', 'mov', 'webm', '3gp', 'mkv'].includes(f.ext)) return 'video';
  if (f.mime.startsWith('audio/') || ['mp3', 'm4a', 'aac', 'wav', 'ogg', 'opus'].includes(f.ext)) return 'audio';
  return 'other';
}

/* ═══════════ ملفٌ في الخادم لم يُنزَّل (النموذج المختلط · قرار المالك ٢٠٢٦-١٠-٠٧) ═══════════ */
/**
 * يُنزَّل عند فتحه بنسبته وحجمه وزر إلغاء، وتظهر مصغّرته الخفيفة أثناء التنزيل · ثم يُطابَق ببصمته ويبقى في
 * الذاكرة المؤقتة · وبلا اتصال يظهر السبب مع «إعادة المحاولة».
 */
function RemoteFilePage({ file, onReady }: { file: ViewerFile; onReady: () => void }) {
  const { db } = useApp();
  const [msg, setMsg] = useState('جاري تنزيل الملف');
  const [info, setInfo] = useState<ProgressInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const cancelRef = useRef<(() => void) | null>(null);
  const light = useMemo(() => db.get<{ t: string | null }>(
    `SELECT thumb AS t FROM attachments WHERE sha256 = ? AND thumb IS NOT NULL LIMIT 1`, [file.sha256])?.t ?? null,
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [db, file.sha256]);
  useEffect(() => {
    const src = cancelSource();
    cancelRef.current = src.cancel;
    setError(null); setInfo(null); setMsg('جاري تنزيل الملف');
    openFileNow(db, file.sha256, file.ext, (m, i) => { setMsg(m); setInfo(i ?? null); }, src.signal)
      .then(() => onReady())
      .catch((e) => { if (!isCancelled(e)) setError(e instanceof Error ? e.message : 'تعذّر تنزيل الملف'); });
    return () => src.cancel();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.sha256, attempt]);
  const v = progressView(msg, info);
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 12 }}>
      {light ? <Image source={{ uri: light }} style={{ width: 180, height: 180, opacity: 0.6 }} resizeMode="contain" /> : null}
      {error ? (
        <>
          <T size={14} color="#fff" style={{ textAlign: 'center' }}>{error}</T>
          <BtnGhost title="إعادة المحاولة" onPress={() => setAttempt((n) => n + 1)} />
        </>
      ) : (
        <>
          <View style={{ alignSelf: 'stretch', height: 6, borderRadius: 3, backgroundColor: 'rgba(255,255,255,0.2)', overflow: 'hidden' }}>
            <View style={{ height: 6, borderRadius: 3, backgroundColor: '#fff', width: v.pct !== null ? `${v.pct}%` : '100%', opacity: v.pct !== null ? 1 : 0.3 }} />
          </View>
          <T size={13} color="#fff" style={{ textAlign: 'center' }}>{progressLabel(msg)}</T>
          {v.pct !== null ? <T size={12} color="#ddd" style={{ textAlign: 'center' }}>{progressLine(v)}</T> : null}
          <BtnGhost title="إلغاء" onPress={() => cancelRef.current?.()} />
        </>
      )}
    </View>
  );
}

/* ═══════════ صفحة صورة · تكبير بالإصبعين وتدوير عبر WebView ═══════════ */
function ImagePage({ file, width }: { file: ViewerFile; width: number }) {
  const [loaded, setLoaded] = useState(false);
  const [thumb, setThumb] = useState<string | null>(existingThumbUri(file.sha256));
  const webRef = useRef<WebView>(null);
  useEffect(() => {
    if (!thumb) thumbUri(file.sha256, file.ext, file.mime).then(setThumb).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.sha256]);
  // مسار الصورة يُبنى من بصمة المرفق وامتداده · لا يدخل الصفحة نصّاً في وسم، بل قيمةً مُرمَّزة
  // في السكربت (JSON مع تهريب «<») · وسياسة المحتوى تمنع الشبكة وأي مصدر غير ملف محلي، فلو
  // تسلّل نص إلى الصفحة لم يجد طريقاً يرسل منه شيئاً
  const src = isSafeBlobName(file.sha256, file.ext) ? fileUriOf(file) : '';
  const html = `<!DOCTYPE html><html><head>
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src file:; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
    <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=8">
    <style>body{margin:0;background:#14171D;min-height:100vh;display:flex;align-items:center;justify-content:center}
    img{max-width:100vw;max-height:100vh;transition:transform .2s}</style></head>
    <body><img id="im"><script>
    document.getElementById('im').src = ${JSON.stringify(src).replace(/</g, '\\u003c')};
    let rot=0; function rotate(){rot=(rot+90)%360; document.getElementById('im').style.transform='rotate('+rot+'deg)';}
    document.getElementById('im').addEventListener('dblclick',()=>{});
    </script></body></html>`;
  return (
    <View style={{ width, flex: 1, backgroundColor: '#14171D' }}>
      {/* المصغّرة تظهر فوراً ريثما يجهز الأصل */}
      {!loaded && thumb ? (
        <Image source={{ uri: thumb }} resizeMode="contain"
          style={{ position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, opacity: 0.6 }} />
      ) : null}
      {!loaded ? (
        <ActivityIndicator color={C.gold} size="large"
          style={{ position: 'absolute', top: 0, bottom: 0, left: 0, right: 0 }} />
      ) : null}
      <WebView
        ref={webRef}
        source={{ html, baseUrl: 'file:///' }}
        style={{ flex: 1, backgroundColor: '#14171D' }}
        originWhitelist={['file://*', 'about:*']}
        allowFileAccess
        allowFileAccessFromFileURLs={false}
        allowUniversalAccessFromFileURLs={false}
        setBuiltInZoomControls
        setDisplayZoomControls={false}
        onLoadEnd={() => setLoaded(true)}
      />
      <Pressable
        onPress={() => webRef.current?.injectJavaScript('rotate(); true;')}
        style={{ position: 'absolute', top: 10, left: 12, backgroundColor: 'rgba(0,0,0,.45)', borderRadius: 999, padding: 9 }}>
        <Icon name="reload" size={18} color="#fff" />
      </Pressable>
    </View>
  );
}

/*
 * ═══════════ صفحة PDF · محرك النظام (PdfRenderer) فالتشكيل العربي عليه لا علينا ═══════════
 * عارض PDF الأصلي لا يتبع قصّ الصفحات ولا قلبها في الشريط الأفقي، فكان يبقى على الشاشة بعد السحب
 * إلى صورة · فلا يُركَّب إلا والصفحةُ هي المعروضة، ومكانه في الجيران بطاقةٌ باسمه.
 * وخطؤه يُعرض في بطاقته بأزرار التقرير لا في حوارٍ ثانٍ يتسابق مع نافذة العارض فيُخفى خلفها.
 */
function PdfPage({ file, width, active }: { file: ViewerFile; width: number; active: boolean }) {
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [err, setErr] = useState('');
  const [report, setReport] = useState<{ full: string; saved: string | null } | null>(null);
  const openExternal = () => {
    Sharing.isAvailableAsync().then((ok) => {
      if (ok) Sharing.shareAsync(fileUriOf(file), { mimeType: 'application/pdf', dialogTitle: file.name });
    });
  };
  if (err) {
    return (
      <View style={{ width, flex: 1, backgroundColor: '#14171D', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
        <Icon name="claim" size={44} color={C.rose} />
        <T size={13} color="#fff" style={{ marginTop: 12, textAlign: 'center' }}>{err}</T>
        {report?.saved ? (
          <T size={11.5} color="#C9CFDA" style={{ marginTop: 6, textAlign: 'center' }}>{'حُفظت التفاصيل في التنزيلات باسم ' + report.saved}</T>
        ) : null}
        <View style={{ marginTop: 14, minWidth: 220, gap: 8 }}>
          <BtnPrimary title="فتح بتطبيق آخر" onPress={openExternal} />
          {report ? <BtnGhost title="نسخ تفاصيل الخطأ" onPress={() => copyFailureDetails(report.full)} /> : null}
          {report ? <BtnGhost title="أرسل تقرير الخطأ" onPress={() => shareFailureDetails(report.full)} /> : null}
        </View>
      </View>
    );
  }
  if (!active) {
    return (
      <View style={{ width, flex: 1, backgroundColor: '#14171D', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
        <Icon name="library" size={40} color="#C9CFDA" />
        <T size={13} color="#C9CFDA" style={{ marginTop: 10, textAlign: 'center' }} numberOfLines={2}>{file.name}</T>
      </View>
    );
  }
  return (
    <View style={{ width, flex: 1, backgroundColor: '#14171D' }}>
      <Pdf
        source={{ uri: fileUriOf(file) }}
        style={{ flex: 1, backgroundColor: '#14171D' }}
        onLoadComplete={(n) => setTotal(n)}
        onPageChanged={(pg, n) => { setPage(pg); setTotal(n); }}
        onError={(e) => {
          setErr('تعذّر عرض الملف داخلياً');
          recordFailure({ title: 'تعذّر عرض الملف داخلياً', where: 'عرض الملف', e }).then(setReport).catch(() => {});
        }}
        trustAllCerts={false}
      />
      <View style={{
        position: 'absolute', top: 10, alignSelf: 'center',
        backgroundColor: 'rgba(0,0,0,.55)', borderRadius: 999, paddingHorizontal: 14, paddingVertical: 5,
      }}>
        <Num size={12} color="#fff">صفحة {page} من {total || '…'}</Num>
      </View>
      <Pressable onPress={openExternal}
        style={{ position: 'absolute', top: 8, left: 12, backgroundColor: 'rgba(0,0,0,.45)', borderRadius: 999, padding: 9 }}>
        <Icon name="export" size={17} color="#fff" />
      </Pressable>
    </View>
  );
}

/* ═══════════ صفحة فيديو / صوت ═══════════ */
function MediaPage({ file, width, active, audio }: { file: ViewerFile; width: number; active: boolean; audio: boolean }) {
  const player = useVideoPlayer(fileUriOf(file), (p) => { p.loop = false; });
  useEffect(() => { if (!active) player.pause(); }, [active, player]);
  return (
    <View style={{ width, flex: 1, backgroundColor: '#14171D', justifyContent: 'center' }}>
      {audio ? (
        <View style={{ alignItems: 'center', marginBottom: 12 }}>
          <Icon name="bell" size={48} color={C.gold} />
          <T size={13} color="#fff" style={{ marginTop: 10 }}>{file.name}</T>
        </View>
      ) : null}
      <VideoView player={player} style={{ width: '100%', height: audio ? 90 : '70%' }}
        nativeControls contentFit="contain" />
    </View>
  );
}

/* ═══════════ سائر الأنواع · بطاقة وفتح بتطبيق آخر ═══════════ */
function OtherPage({ file, width }: { file: ViewerFile; width: number }) {
  return (
    <View style={{ width, flex: 1, backgroundColor: '#14171D', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <Icon name={(libCat(file.cat).icon as IconName) || 'attach'} size={52} color={C.gold} />
      <T size={15} bold color="#fff" style={{ marginTop: 14, textAlign: 'center' }}>{file.name}</T>
      <Num size={12} color="#9AA1AD" style={{ marginTop: 6 }}>{file.ext.toUpperCase()} · {libSizeLabel(file.sizeBytes)}</Num>
      <T size={12} color="#9AA1AD" style={{ marginTop: 4 }}>المعاينة الداخلية غير متاحة لهذا النوع</T>
      <View style={{ marginTop: 16, minWidth: 200 }}>
        <BtnPrimary title="فتح بتطبيق آخر" onPress={() => {
          Sharing.isAvailableAsync().then((ok) => {
            if (ok) Sharing.shareAsync(fileUriOf(file), { mimeType: file.mime || undefined, dialogTitle: file.name });
          });
        }} />
      </View>
    </View>
  );
}

/* ═══════════ العارض ═══════════ */
export function FileViewer({ files, startIndex, onClose, onMutated, onEditMeta, canManage: canManageProp = true, section }: {
  files: ViewerFile[];
  startIndex: number;
  onClose: () => void;
  onMutated?: () => void;
  /** فتح شاشة تعديل بيانات الملف (الملاحظة وغيرها) لدى المستدعي */
  onEditMeta?: (attId: string) => void;
  /** false تُخفي إعادة التسمية والنقل ونزع الربط والحذف وتعديل البيانات · ويبقى العرض والمشاركة */
  canManage?: boolean;
  /** قسم الملف · الإدارة تُحسب منه (كامل) */
  section?: SectionKey;
}) {
  // النافذة المنبثقة فوق غطاء القفل · تختفي ما دام مقفلاً (#51 · ui/lockState.ts)
  const appLocked = useAppLocked();
  const { db } = useApp();
  const secPerm = usePerm(section ?? 'library');
  const canManage = canManageProp && (!section || secPerm.manage);
  const toast = useToast();
  const dialog = useDialog();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const [index, setIndex] = useState(Math.min(startIndex, files.length - 1));
  const [infoOpen, setInfoOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [newName, setNewName] = useState('');
  const renameTry = useSaveAttempt();
  const [moveOpen, setMoveOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  // ملفٌ نُزّل للتو من الخادم · يُعاد الرسم فيُعرض
  const [, setFetched] = useState(0);
  const listRef = useRef<FlatList<ViewerFile>>(null);
  const cur = files[index];
  /*
   * الشريط الأفقي باتجاه التطبيق العربي كما هو: الأول على اليمين والتالي يأتي من اليسار · فلا «inverted» ولا
   * اتجاه مفروض: كلاهما قلب الحساب فكان الشريط العلوي يسمّي ملفاً والشاشة تعرض جاره (وجده الفحص على المحاكي).
   * وأندرويد بالعربية يضع موضع البدء من اليمين لكنه يبلّغ إزاحة التمرير من اليسار · فتُقرأ معكوسة.
   */
  const pageAt = (x: number) => {
    const pos = Math.round(x / width);
    return Platform.OS === 'android' && I18nManager.isRTL ? files.length - 1 - pos : pos;
  };
  /** الانتقال بالزر · موضعه بالرقم نفسه الذي بدأ به الشريط */
  const goTo = (i: number) => {
    if (i < 0 || i >= files.length) return;
    listRef.current?.scrollToIndex({ index: i, animated: true });
    setIndex(i);
  };

  // سحب لأعلى على الشريط السفلي يفتح بطاقة المعلومات
  const pan = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponder: (_e, g) => g.dy < -14 && Math.abs(g.dy) > Math.abs(g.dx),
    onPanResponderRelease: (_e, g) => { if (g.dy < -14) setInfoOpen(true); },
  }), []);

  if (!cur) return null;
  const kind = kindOf(cur);
  const uri = fileUriOf(cur);
  const exists = new File(uri).exists;

  const doShare = () => {
    Sharing.isAvailableAsync().then((ok) => {
      if (ok) Sharing.shareAsync(uri, { mimeType: cur.mime || undefined, dialogTitle: cur.name });
    }).catch(() => toast('تعذّرت المشاركة'));
  };

  const doPrint = async () => {
    try {
      setBusy(true);
      if (kind === 'pdf') await Print.printAsync({ uri });
      else if (kind === 'image') {
        await Print.printAsync({ html: `<body style="margin:0"><img src="${uri}" style="width:100%"></body>` });
      } else { toast('الطباعة متاحة للصور وملفات PDF'); }
    } catch { /* أغلق المستخدم حوار الطباعة */ } finally { setBusy(false); }
  };

  const doSaveToGallery = async () => {
    try {
      setBusy(true);
      // إذن الكتابة في التخزين الخارجي محذوف من التطبيق، ومكتبة المعرض تشترطه حتى أندرويد ١٢ ·
      // فعلى ما دون ١٣ يمرّ الحفظ بنافذة المشاركة ويختار المستخدم منها «الصور» أو مجلداً
      if (Platform.OS === 'android' && Number(Platform.Version) < 33) {
        if (!(await Sharing.isAvailableAsync())) { toast('المشاركة غير متاحة على هذا الجهاز'); return; }
        await Sharing.shareAsync(uri, { mimeType: cur.mime || undefined, dialogTitle: 'حفظ في معرض الجهاز' });
        return;
      }
      // من أندرويد ١٣ يحفظ في المعرض بلا إذن قراءة · الطلب للكتابة وحدها
      const perm = await MediaLibrary.requestPermissionsAsync(true);
      if (!perm.granted) { toast('لم يؤذن بالوصول إلى المعرض'); return; }
      // باسم الملف المعروض لا ببصمته · نسخة مؤقتة تُحذف بعد الحفظ
      const base = cur.name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim() || 'ملف';
      const named = new File(Paths.cache, base.toLowerCase().endsWith('.' + cur.ext) ? base : base + '.' + cur.ext);
      try {
        if (named.exists) named.delete();
        new File(uri).copy(named);
        await MediaLibrary.saveToLibraryAsync(named.uri);
      } finally {
        try { if (named.exists) named.delete(); } catch { /* يكنسه الإقلاع */ }
      }
      toast('حُفظ في معرض الجهاز');
    } catch (e) {
      reportFailure({ title: 'تعذّر الحفظ في المعرض', e });
    } finally { setBusy(false); }
  };

  const doDelete = () => {
    dialog({
      title: 'حذف الملف',
      body: `حذف "${cur.name}"؟ يُنقل إلى سلة المحذوفات.`,
      tone: 'danger',
      actions: [
        { label: 'تراجع', variant: 'ghost' },
        {
          label: 'حذف', variant: 'danger',
          onPress: () => {
            softDeleteAttachment(db, cur.attId);
            logAudit(db, 'المكتبة', 'delete', 'ملف', cur.name);
            toast('نُقل إلى سلة المحذوفات');
            onMutated?.();
            onClose();
          },
        },
      ],
    });
  };

  // نزع الربط غير الحذف: يفكّ الملف عن سجله ويبقى في المكتبة غير مرتبط
  const linkedEntity = db.get<{ entity_type: string }>(
    `SELECT entity_type FROM attachments WHERE id = ?`, [cur.attId])?.entity_type ?? 'library';
  const doUnlink = () => {
    dialog({
      title: 'نزع الربط',
      body: `يُفكّ "${cur.name}" عن سجله ويبقى في المكتبة غير مرتبط. الملف لا يُحذف.`,
      tone: 'normal',
      actions: [
        { label: 'تراجع', variant: 'ghost' },
        {
          label: 'نزع الربط', variant: 'primary',
          onPress: () => {
            unlinkAttachment(db, cur.attId);
            logAudit(db, 'المكتبة', 'update', 'نزع ربط ملف', cur.name);
            toast('نُزع الربط · الملف في المكتبة غير مرتبط');
            onMutated?.();
            onClose();
          },
        },
      ],
    });
  };

  const applyRename = () => {
    const v = newName.trim();
    if (!v) { toast('اكتب اسماً'); return; }
    updateLibraryFile(db, cur.attId, { name: v });
    cur.name = v;
    setRenaming(false);
    onMutated?.();
    toast('تمت إعادة التسمية');
  };

  const barBtn = (icon: IconName, label: string, onPress: () => void, disabled?: boolean) => (
    <Pressable key={label} onPress={onPress} disabled={disabled || busy}
      style={{ alignItems: 'center', opacity: disabled || busy ? 0.4 : 1, minWidth: 56 }}>
      <Icon name={icon} size={19} color="#fff" />
      <Text style={{ color: '#C9CFDA', fontSize: 10, marginTop: 3, fontFamily: FONT_BOLD }}>{label}</Text>
    </Pressable>
  );

  return (
    <Modal visible={!appLocked} animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <DirView>
      <View style={{ flex: 1, backgroundColor: '#14171D' }}>
        {/* الشريط العلوي */}
        <View style={{
          paddingTop: insets.top + 6, paddingBottom: 8, paddingHorizontal: 12,
          flexDirection: 'row-reverse', alignItems: 'center', gap: 10, backgroundColor: 'rgba(20,23,29,.96)',
        }}>
          <Pressable onPress={onClose} style={{ padding: 6 }}><Icon name="x" size={20} color="#fff" /></Pressable>
          <Text style={{ flex: 1, color: '#fff', fontSize: 13.5, fontFamily: FONT_BOLD, textAlign: 'right' }} numberOfLines={1}>{cur.name}</Text>
          {canManage ? (
            <>
              <Pressable onPress={() => { setNewName(cur.name); renameTry.reset(); setRenaming(true); }} style={{ padding: 6 }}>
                <Icon name="edit" size={17} color="#fff" />
              </Pressable>
              <Pressable onPress={() => setMoveOpen(true)} style={{ padding: 6 }}>
                <Icon name="swap" size={17} color="#fff" />
              </Pressable>
              {linkedEntity !== 'library' ? (
                <Pressable onPress={doUnlink} style={{ padding: 6 }}>
                  <Icon name="cancel" size={17} color="#F5C86E" />
                </Pressable>
              ) : null}
              <Pressable onPress={doDelete} style={{ padding: 6 }}>
                <Icon name="trash" size={17} color="#FA7D68" />
              </Pressable>
            </>
          ) : null}
        </View>

        {!exists && filesCloudOn() ? (
          <RemoteFilePage key={cur.sha256} file={cur} onReady={() => setFetched((n) => n + 1)} />
        ) : !exists ? (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
            <T size={14} color="#fff" style={{ textAlign: 'center' }}>سجل الملف موجود لكن ملفه غير موجود في المخزن · استعده من نسخة احتياطية أو أعد رفعه</T>
          </View>
        ) : (
          <FlatList
            ref={listRef}
            data={files}
            extraData={index}
            horizontal
            pagingEnabled
            initialScrollIndex={index}
            getItemLayout={(_d, i) => ({ length: width, offset: width * i, index: i })}
            keyExtractor={(f) => f.attId}
            showsHorizontalScrollIndicator={false}
            onMomentumScrollEnd={(e) => {
              const i = pageAt(e.nativeEvent.contentOffset.x);
              if (i >= 0 && i < files.length) setIndex(i);
            }}
            windowSize={3}
            initialNumToRender={1}
            maxToRenderPerBatch={2}
            renderItem={({ item, index: i }) => {
              const k = kindOf(item);
              const active = i === index;
              if (k === 'image') return <ImagePage file={item} width={width} />;
              if (k === 'pdf') return <PdfPage file={item} width={width} active={active} />;
              if (k === 'video' || k === 'audio') return <MediaPage file={item} width={width} active={active} audio={k === 'audio'} />;
              return <OtherPage file={item} width={width} />;
            }}
          />
        )}

        {/* التالي والسابق · عارض PDF الأصلي يأخذ السحب الأفقي لنفسه فلا يُغادَر بالسحب وحده ·
            التالي على اليسار والسابق على اليمين كاتجاه القراءة، ولا يظهر سهمٌ لا ملف وراءه */}
        {exists && index < files.length - 1 ? (
          <Pressable accessibilityLabel="الملف التالي" onPress={() => goTo(index + 1)}
            style={{ position: 'absolute', top: '46%', end: 8, backgroundColor: 'rgba(0,0,0,.5)', borderRadius: 999, padding: 10 }}>
            <View style={{ transform: [{ scaleX: -1 }] }}><Icon name="back" size={20} color="#fff" /></View>
          </Pressable>
        ) : null}
        {exists && index > 0 ? (
          <Pressable accessibilityLabel="الملف السابق" onPress={() => goTo(index - 1)}
            style={{ position: 'absolute', top: '46%', start: 8, backgroundColor: 'rgba(0,0,0,.5)', borderRadius: 999, padding: 10 }}>
            <Icon name="back" size={20} color="#fff" />
          </Pressable>
        ) : null}

        {/* الشريط السفلي · سحبه لأعلى يفتح بطاقة المعلومات */}
        <View {...pan.panHandlers} style={{
          paddingBottom: insets.bottom + 8, paddingTop: 8, paddingHorizontal: 10,
          backgroundColor: 'rgba(20,23,29,.96)', borderTopWidth: 1, borderTopColor: '#2A2F3A',
        }}>
          <View style={{ alignItems: 'center', marginBottom: 6 }}>
            <View style={{ width: 38, height: 4, borderRadius: 2, backgroundColor: '#3A4150' }} />
            <Num size={11.5} color="#C9CFDA" style={{ marginTop: 4 }}>{index + 1} من {files.length}</Num>
          </View>
          <Row style={{ justifyContent: 'space-around' }}>
            {barBtn('export', 'مشاركة', doShare)}
            {barBtn('print', 'طباعة', doPrint, kind !== 'image' && kind !== 'pdf')}
            {barBtn('library', 'للمعرض', doSaveToGallery, kind !== 'image' && kind !== 'video')}
            {barBtn('eye', 'معلومات', () => setInfoOpen(true))}
            {barBtn('attach', 'تطبيق آخر', doShare)}
          </Row>
        </View>

        {/* بطاقة المعلومات */}
        {infoOpen ? (
          <Pressable onPress={() => setInfoOpen(false)}
            style={{ position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, backgroundColor: 'rgba(0,0,0,.45)', justifyContent: 'flex-end' }}>
            <View style={{ backgroundColor: C.paper, borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: 18, paddingBottom: insets.bottom + 16 }}>
              <T size={14.5} bold>{cur.name}</T>
              {([
                ['النوع', cur.ext.toUpperCase() + (cur.mime ? ' · ' + cur.mime : '')],
                ['الحجم', libSizeLabel(cur.sizeBytes)],
                ['التصنيف', libCat(cur.cat).label],
                ['مرتبط بـ', cur.linked],
                ['أُضيف', dfmt(cur.createdAt)],
              ] as Array<[string, string]>).filter(([, v]) => v != null && v !== '').map(([k, v]) => (
                <Row key={k} style={{ justifyContent: 'space-between', paddingVertical: 7, borderBottomWidth: 1, borderBottomColor: C.line }}>
                  <T size={12.5} color={C.muted}>{k}</T>
                  <T size={12.5} bold style={{ flexShrink: 1, textAlign: 'left' }}>{v}</T>
                </Row>
              ))}
              {onEditMeta && canManage ? (
                <View style={{ marginTop: 10 }}>
                  <BtnGhost small icon="edit" title="تعديل بيانات الملف"
                    onPress={() => { setInfoOpen(false); onClose(); onEditMeta(cur.attId); }} />
                </View>
              ) : null}
            </View>
          </Pressable>
        ) : null}

        {/* إعادة التسمية في ورقتها الخاصة (قرار المالك 2026-10-07) · الحفظ ظاهر والأحمر بعد المحاولة */}
        {renaming ? (
          <Sheet visible onClose={() => setRenaming(false)} title="إعادة تسمية الملف"
            footer={<View style={{ flex: 1 }}><BtnPrimary title="حفظ" onPress={() => renameTry.attempt(!!newName.trim(), applyRename)} /></View>}>
            <Field label="الاسم" value={newName} onChange={setNewName} error={renameTry.missing(newName)} />
          </Sheet>
        ) : null}

        {/* النقل إلى تصنيف */}
        <PickerSheet
          visible={moveOpen}
          onClose={() => setMoveOpen(false)}
          title="نقل إلى تصنيف"
          value={cur.cat}
          options={Object.entries(LIB_CATS).map(([value, v]) => ({ value, label: v.label, icon: v.icon as IconName }))}
          onPick={(v) => {
            updateLibraryFile(db, cur.attId, { cat: v });
            cur.cat = v;
            setMoveOpen(false);
            onMutated?.();
            toast('نُقل إلى ' + libCat(v).label);
          }}
        />
      </View>
      </DirView>
    </Modal>
  );
}
