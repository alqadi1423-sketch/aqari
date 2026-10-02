/**
 * عارض الملفات داخل التطبيق · الملف الذي لا أستطيع رؤيته كأنه غير محفوظ:
 * صورة بتكبير الإصبعين وتدوير، PDF بتصفح صفحات ورقمها من الإجمالي، فيديو وصوت
 * بمشغّل أصلي، وسائر الأنواع ببطاقة وفتح بتطبيق آخر · سحب أفقي بين ملفات المجموعة،
 * وبطاقة معلومات، ومشاركة وطباعة وحفظ في المعرض وإعادة تسمية ونقل وحذف.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Modal, View, FlatList, Pressable, useWindowDimensions,
  TextInput, ActivityIndicator, Image, PanResponder, Text, Platform,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import { useVideoPlayer, VideoView } from 'expo-video';
import * as MediaLibrary from 'expo-media-library';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import { File } from 'expo-file-system';
import { T, Num, BtnGhost, BtnPrimary, Row } from './components';
import { PickerSheet } from './Sheet';
import { Icon, type IconName } from './icons';
import { useApp } from './store';
import { useToast } from './Toast';
import { useDialog } from './AppDialog';
import { C, FONT_BOLD } from './theme';
import { LIB_CATS, libCat, libSizeLabel, updateLibraryFile } from '../domain/library';
import { softDeleteAttachment, unlinkAttachment } from '../files/store';
import { dfmt } from '../domain/dates';
import { joinPath } from '../files/fsAdapter';
import { appDataRoot } from '../files/expoFs';
import { thumbUri, existingThumbUri, isImageFile } from '../services/thumbs';
import Pdf from 'react-native-pdf';
import { logAudit } from '../domain/audit';
import { reportFailure } from './failureDialog';

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

/* ═══════════ صفحة صورة · تكبير بالإصبعين وتدوير عبر WebView ═══════════ */
function ImagePage({ file, width }: { file: ViewerFile; width: number }) {
  const [loaded, setLoaded] = useState(false);
  const [thumb, setThumb] = useState<string | null>(existingThumbUri(file.sha256));
  const webRef = useRef<WebView>(null);
  useEffect(() => {
    if (!thumb) thumbUri(file.sha256, file.ext, file.mime).then(setThumb).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.sha256]);
  const html = `<!DOCTYPE html><html><head>
    <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=8">
    <style>body{margin:0;background:#14171D;min-height:100vh;display:flex;align-items:center;justify-content:center}
    img{max-width:100vw;max-height:100vh;transition:transform .2s}</style></head>
    <body><img id="im" src="${fileUriOf(file)}"><script>
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
        originWhitelist={['*']}
        allowFileAccess
        allowFileAccessFromFileURLs
        allowUniversalAccessFromFileURLs
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

/* ═══════════ صفحة PDF · محرك النظام (PdfRenderer) فالتشكيل العربي عليه لا علينا ═══════════ */
function PdfPage({ file, width }: { file: ViewerFile; width: number }) {
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [err, setErr] = useState('');
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
        <View style={{ marginTop: 14, minWidth: 200 }}>
          <BtnPrimary title="فتح بتطبيق آخر" onPress={openExternal} />
        </View>
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
        onError={(e) => { setErr('تعذّر عرض الملف داخلياً'); reportFailure({ title: 'تعذّر عرض الملف داخلياً', where: 'عرض الملف', e }); }}
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
export function FileViewer({ files, startIndex, onClose, onMutated, onEditMeta }: {
  files: ViewerFile[];
  startIndex: number;
  onClose: () => void;
  onMutated?: () => void;
  /** فتح شاشة تعديل بيانات الملف (الملاحظة وغيرها) لدى المستدعي */
  onEditMeta?: (attId: string) => void;
}) {
  const { db } = useApp();
  const toast = useToast();
  const dialog = useDialog();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const [index, setIndex] = useState(Math.min(startIndex, files.length - 1));
  const [infoOpen, setInfoOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [newName, setNewName] = useState('');
  const [moveOpen, setMoveOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const listRef = useRef<FlatList<ViewerFile>>(null);
  const cur = files[index];

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
      await MediaLibrary.saveToLibraryAsync(uri);
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
    <Modal visible animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <View style={{ flex: 1, backgroundColor: '#14171D' }}>
        {/* الشريط العلوي */}
        <View style={{
          paddingTop: insets.top + 6, paddingBottom: 8, paddingHorizontal: 12,
          flexDirection: 'row-reverse', alignItems: 'center', gap: 10, backgroundColor: 'rgba(20,23,29,.96)',
        }}>
          <Pressable onPress={onClose} style={{ padding: 6 }}><Icon name="x" size={20} color="#fff" /></Pressable>
          <Text style={{ flex: 1, color: '#fff', fontSize: 13.5, fontFamily: FONT_BOLD, textAlign: 'right' }} numberOfLines={1}>{cur.name}</Text>
          <Pressable onPress={() => { setNewName(cur.name); setRenaming(true); }} style={{ padding: 6 }}>
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
        </View>

        {!exists ? (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
            <T size={14} color="#fff" style={{ textAlign: 'center' }}>سجل الملف موجود لكن ملفه غير موجود في المخزن · استعده من نسخة احتياطية أو أعد رفعه</T>
          </View>
        ) : (
          <FlatList
            ref={listRef}
            data={files}
            horizontal
            inverted
            pagingEnabled
            initialScrollIndex={index}
            getItemLayout={(_d, i) => ({ length: width, offset: width * i, index: i })}
            keyExtractor={(f) => f.attId}
            showsHorizontalScrollIndicator={false}
            onMomentumScrollEnd={(e) => {
              const i = Math.round(e.nativeEvent.contentOffset.x / width);
              if (i >= 0 && i < files.length) setIndex(i);
            }}
            windowSize={3}
            initialNumToRender={1}
            maxToRenderPerBatch={2}
            renderItem={({ item, index: i }) => {
              const k = kindOf(item);
              const active = i === index;
              if (k === 'image') return <ImagePage file={item} width={width} />;
              if (k === 'pdf') return <PdfPage file={item} width={width} />;
              if (k === 'video' || k === 'audio') return <MediaPage file={item} width={width} active={active} audio={k === 'audio'} />;
              return <OtherPage file={item} width={width} />;
            }}
          />
        )}

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
                ['أُضيف', dfmt(cur.createdAt.slice(0, 10))],
              ] as Array<[string, string]>).filter(([, v]) => v != null && v !== '').map(([k, v]) => (
                <Row key={k} style={{ justifyContent: 'space-between', paddingVertical: 7, borderBottomWidth: 1, borderBottomColor: C.line }}>
                  <T size={12.5} color={C.muted}>{k}</T>
                  <T size={12.5} bold style={{ flexShrink: 1, textAlign: 'left' }}>{v}</T>
                </Row>
              ))}
              {onEditMeta ? (
                <View style={{ marginTop: 10 }}>
                  <BtnGhost small icon="edit" title="تعديل بيانات الملف"
                    onPress={() => { setInfoOpen(false); onClose(); onEditMeta(cur.attId); }} />
                </View>
              ) : null}
            </View>
          </Pressable>
        ) : null}

        {/* إعادة التسمية */}
        {renaming ? (
          <Pressable onPress={() => setRenaming(false)}
            style={{ position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, backgroundColor: 'rgba(0,0,0,.5)', justifyContent: 'center', padding: 24 }}>
            <Pressable onPress={() => {}} style={{ backgroundColor: C.paper, borderRadius: 14, padding: 16 }}>
              <T size={13.5} bold style={{ marginBottom: 10 }}>إعادة تسمية الملف</T>
              <TextInput value={newName} onChangeText={setNewName} autoFocus
                style={{ borderWidth: 1, borderColor: C.line, borderRadius: 9, padding: 10, textAlign: 'right', fontSize: 13, backgroundColor: '#FAFAF7' }} />
              <Row style={{ marginTop: 12 }}>
                <View style={{ flex: 1 }}><BtnGhost title="تراجع" onPress={() => setRenaming(false)} /></View>
                <View style={{ flex: 1 }}><BtnPrimary title="حفظ" onPress={applyRename} /></View>
              </Row>
            </Pressable>
          </Pressable>
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
    </Modal>
  );
}
