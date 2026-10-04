/**
 * المكتبة · فهرس مركزي: عشرة تصنيفات، تنقّل هرمي
 * المكتبة إلى التصنيف إلى العقار إلى الوحدة إلى الملفات، بحث يتجاوز الشجرة،
 * تحديد متعدد، معاينة بتنقّل، وكشف الملفات غير المرتبطة والمفقودة.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Image, Pressable, FlatList } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as Sharing from 'expo-sharing';
import { File } from 'expo-file-system';
import { Screen, BackButton } from '../src/ui/Screen';
import { Card, T, Num, EmptyState, Row, BtnPrimary, BtnGhost, Field, SearchBox, KpiCard, Chip } from '../src/ui/components';
import { Sheet, SelectField } from '../src/ui/Sheet';
import { useApp } from '../src/ui/store';
import { useToast } from '../src/ui/Toast';
import { C } from '../src/ui/theme';
import { Icon, type IconName } from '../src/ui/icons';
import {
  LIB_CATS, LIB_CAT_SQL, libCat, libraryFiles, libSizeLabel,
  updateLibraryFile, type LibraryFile, type LibSort,
} from '../src/domain/library';
import { useDialog } from '../src/ui/AppDialog';
import { appFilesEnv } from '../src/services/filesEnv';
import { putAttachment, softDeleteAttachment } from '../src/files/store';
import { FileViewer, type ViewerFile } from '../src/ui/FileViewer';
import { thumbUri, existingThumbUri } from '../src/services/thumbs';
import { pickFromGallery, captureWithCamera } from '../src/ui/attach';
import { logAudit } from '../src/domain/audit';
import { usePager, Pager } from '../src/ui/Pager';
import { useDeferredReady } from '../src/ui/useDeferredReady';
import { Skeleton } from '../src/ui/Skeleton';
import { reportFailure } from '../src/ui/failureDialog';
import { usePerm } from '../src/ui/access';

const EMPTY_FILES: LibraryFile[] = [];

// اشتقاق الوحدة والعقار والتصنيف داخل SQL بنفس دلالة libraryFiles ·
// يسمح بترشيح المجلد الحالي وتقسيم الصفحات في الاستعلام بدل جلب الكل
const UNIT_EXPR = `CASE a.entity_type
  WHEN 'unit' THEN a.entity_id
  WHEN 'contract' THEN c.unit_id
  WHEN 'claim' THEN c2.unit_id
  WHEN 'purchase' THEN p.unit_id
  WHEN 'handover' THEN h.unit_id
  WHEN 'occupant' THEN o.unit_id
  WHEN 'payment' THEN c3.unit_id
  ELSE NULL END`;
const PROP_EXPR = `CASE a.entity_type
  WHEN 'property' THEN a.entity_id
  WHEN 'purchase' THEN COALESCE(p.property_id, u.property_id)
  ELSE u.property_id END`;
const CAT_EXPR = LIB_CAT_SQL;
// blobs انضمام يسار لا داخلي: كل مرفق حي يظهر ولو غاب صف blob (استيراد نسخة قديمة)
const LIB_JOINS = `FROM attachments a
  LEFT JOIN blobs b ON b.sha256 = a.sha256
  LEFT JOIN contracts c ON a.entity_type = 'contract' AND c.id = a.entity_id
  LEFT JOIN claims cl ON a.entity_type = 'claim' AND cl.id = a.entity_id
  LEFT JOIN contracts c2 ON c2.id = cl.contract_id
  LEFT JOIN purchases p ON a.entity_type = 'purchase' AND p.id = a.entity_id
  LEFT JOIN handovers h ON a.entity_type = 'handover' AND h.id = a.entity_id
  LEFT JOIN occupants o ON a.entity_type = 'occupant' AND o.id = a.entity_id
  LEFT JOIN contract_payments cp ON a.entity_type = 'payment' AND cp.id = a.entity_id
  LEFT JOIN contracts c3 ON c3.id = cp.contract_id
  LEFT JOIN units u ON u.id = ${UNIT_EXPR}`;

function ThumbImage({ sha256, ext, mime, cat }: { sha256: string; ext: string; mime: string; cat: string }) {
  const [uri, setUri] = React.useState<string | null>(existingThumbUri(sha256));
  React.useEffect(() => {
    let on = true;
    if (!uri) thumbUri(sha256, ext, mime).then((u) => { if (on) setUri(u); }).catch(() => {});
    return () => { on = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sha256]);
  return uri
    ? <Image source={{ uri }} style={{ width: '100%', height: 84 }} resizeMode="cover" />
    : <Icon name={libCat(cat).icon as IconName} size={26} color={C.muted} />;
}

const FileCard = React.memo(function FileCard({
  id, name, sizeBytes, createdAt, sha256, ext, mime, cat, missing, showImage, selected, onPress, onLongPress,
}: {
  id: string; name: string; sizeBytes: number; createdAt: string; sha256: string; ext: string;
  mime: string; cat: string; missing: boolean; showImage: boolean; selected: boolean;
  onPress: (id: string) => void; onLongPress: (id: string) => void;
}) {
  return (
    <Pressable
      onPress={() => onPress(id)}
      onLongPress={() => onLongPress(id)}
      style={{
        flex: 1, maxWidth: '32%', borderWidth: selected ? 2 : 1, borderColor: selected ? C.emerald : C.line,
        borderRadius: 10, overflow: 'hidden', backgroundColor: '#fff', marginBottom: 8,
      }}
    >
      <View style={{ height: 84, backgroundColor: C.paper, alignItems: 'center', justifyContent: 'center' }}>
        {missing ? (
          <T size={11} color={C.rose} center>مفقود من{'\n'}التخزين</T>
        ) : showImage ? (
          <ThumbImage sha256={sha256} ext={ext} mime={mime} cat={cat} />
        ) : (
          <Icon name={libCat(cat).icon as IconName} size={26} color={C.muted} />
        )}
      </View>
      <View style={{ padding: 7 }}>
        {/* بطاقة ضيقة · اسم الملف سطران بأكثر تقدير ثم قصّ · لا حرف تحت حرف */}
        <T size={11.5} bold numberOfLines={2}>{name}</T>
        <Num size={10} color={C.muted}>{libSizeLabel(sizeBytes)} · {createdAt.slice(0, 10)}</Num>
      </View>
    </Pressable>
  );
});

export default function Library() {
  const { db, version, bump } = useApp();
  const toast = useToast();
  const dialog = useDialog();
  const perm = usePerm('library');
  const env = appFilesEnv(db);
  const ready = useDeferredReady();
  const pager = usePager('library');
  const [path, setPath] = useState<string[]>([]); // [cat, propertyId, unitId]
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<LibSort>('new');
  const [kind, setKind] = useState<'' | 'img' | 'doc'>('');
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [uploadOpen, setUploadOpen] = useState(false);
  const [upCat, setUpCat] = useState('other');
  const [upNote, setUpNote] = useState('');
  const [preview, setPreview] = useState<{ list: LibraryFile[]; idx: number } | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [edName, setEdName] = useState('');
  const [edNote, setEdNote] = useState('');
  const [edCat, setEdCat] = useState('other');

  const all = useMemo(() => (ready ? libraryFiles(env) : EMPTY_FILES),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [db, version, ready]);
  const byId = useMemo(() => new Map(all.map((r) => [r.id, r])), [all]);

  // أسماء العقارات وأرقام الوحدات تُجلب دفعة واحدة · لا db.get لكل مجلد أثناء الرسم
  const propNames = useMemo(() => {
    if (!ready) return new Map<string, string>();
    return new Map(db.all<{ id: string; name: string }>(`SELECT id, name FROM properties`).map((r) => [r.id, r.name]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, version, ready]);
  const unitNos = useMemo(() => {
    if (!ready) return new Map<string, string>();
    return new Map(db.all<{ id: string; unit_no: string }>(`SELECT id, unit_no FROM units`).map((r) => [r.id, r.unit_no]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, version, ready]);

  // فحص ذاتي لخط حفظ الملفات كاملاً عند فتح المكتبة (بصمة ← كتابة ← قراءة ← حذف) ·
  // إن فشل أي جزء ظهر السبب الحقيقي هنا على الشاشة بدل «لا تعمل» صامتة
  const [storageProbe, setStorageProbe] = useState<string | null>(null);
  React.useEffect(() => {
    (async () => {
      try {
        const payload = new Uint8Array([65, 81, 65, 82, 73]);
        await env.hasher(payload);
        env.fs.mkdirp(env.attachmentsDir);
        const probePath = env.attachmentsDir + '/probe.tmp';
        env.fs.write(probePath, payload);
        const back = env.fs.read(probePath);
        env.fs.remove(probePath);
        setStorageProbe(back.byteLength !== payload.byteLength ? 'القراءة بعد الكتابة أعادت حجماً مختلفاً' : null);
      } catch (e) {
        setStorageProbe('فشل فحص خط حفظ الملفات');
        reportFailure({ title: 'مخزن الملفات معطّل على هذا الجهاز', where: 'فحص مخزن الملفات', e });
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const searching = !!q.trim();
  const fileMode = searching || path.length >= 2;

  const scope = useMemo(() => {
    let rows = all;
    if (path[0]) rows = rows.filter((r) => r.cat === path[0]);
    if (path[1] !== undefined) rows = rows.filter((r) => (r.propertyId ?? '__none') === path[1]);
    if (path[2] !== undefined) rows = rows.filter((r) => (r.unitId ?? '__none') === path[2]);
    return rows;
  }, [all, path]);

  const unitFolderIds = useMemo(
    () => (path.length === 2 ? [...new Set(scope.filter((r) => r.unitId).map((r) => r.unitId!))] : []),
    [scope, path]
  );

  const propName = (id: string) =>
    id === '__none' ? 'غير مرتبط بعقار' : propNames.get(id) ?? 'عقار محذوف';
  const unitName = (id: string) =>
    id === '__none' ? 'مستندات العقار العامة' : unitNos.get(id) ? 'وحدة ' + unitNos.get(id) : 'وحدة محذوفة';

  const stats = useMemo(() => {
    if (!ready) return { size: 0, images: 0, missing: 0, orphan: 0 };
    let size = 0; let images = 0; let missing = 0; let orphan = 0;
    for (const r of all) {
      size += r.sizeBytes;
      if (r.isImage) images++;
      if (r.missing) missing++;
      if (!r.link) orphan++;
    }
    return { size, images, missing, orphan };
  }, [all, ready]);

  /**
   * شرط WHERE للعرض الحالي (بحث أو مجلد) · نفس دلالة الترشيح القديمة لكن في SQL.
   * wholeScope: للمعاينة في مستوى العقار تشمل ملفات الوحدات أيضاً كما في السلوك الأصلي.
   */
  const buildFileQuery = useCallback((wholeScope = false) => {
    const where: string[] = ['a.deleted_at IS NULL'];
    const params: (string | number)[] = [];
    const needle = q.trim();
    if (needle) {
      where.push(`(a.display_name LIKE '%'||?||'%' OR a.original_name LIKE '%'||?||'%' OR a.note LIKE '%'||?||'%')`);
      params.push(needle, needle, needle);
    } else {
      if (path[0]) { where.push(`${CAT_EXPR} = ?`); params.push(path[0]); }
      if (path[1] !== undefined) {
        if (path[1] === '__none') where.push(`${PROP_EXPR} IS NULL`);
        else { where.push(`${PROP_EXPR} = ?`); params.push(path[1]); }
      }
      if (path[2] !== undefined) { where.push(`${UNIT_EXPR} = ?`); params.push(path[2]); }
      else if (path.length === 2 && !wholeScope) where.push(`${UNIT_EXPR} IS NULL`);
    }
    if (kind === 'img') where.push(`a.mime LIKE 'image%'`);
    if (kind === 'doc') where.push(`(a.mime IS NULL OR a.mime NOT LIKE 'image%')`);
    const order =
      sort === 'new' ? 'a.created_at DESC'
      : sort === 'old' ? 'a.created_at ASC'
      : sort === 'size' ? 'COALESCE(b.size_bytes, 0) DESC'
      : `COALESCE(NULLIF(a.display_name, ''), NULLIF(a.original_name, ''), 'ملف')`;
    return { where: where.join(' AND '), params, order };
  }, [q, path, kind, sort]);

  // صفحة واحدة فقط تُجلب بالمعرفات ثم تُروى من خريطة الملفات · مع عدّ إجمالي بنفس الشرط
  const { pageRows, total } = useMemo(() => {
    if (!ready || !fileMode) return { pageRows: EMPTY_FILES, total: 0 };
    const { where, params, order } = buildFileQuery();
    const n = db.get<{ n: number }>(`SELECT COUNT(*) AS n ${LIB_JOINS} WHERE ${where}`, params)?.n ?? 0;
    const ids = db.all<{ id: string }>(
      `SELECT a.id ${LIB_JOINS} WHERE ${where} ORDER BY ${order}, a.id LIMIT ? OFFSET ?`,
      [...params, pager.limit, pager.offset]
    );
    const rows = ids.map((r) => byId.get(r.id)).filter((x): x is LibraryFile => !!x);
    return { pageRows: rows, total: n };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, version, ready, fileMode, buildFileQuery, byId, pager.limit, pager.offset]);

  useEffect(() => {
    pager.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, kind, sort, path]);

  const upload = async () => {
    const res = await DocumentPicker.getDocumentAsync({ multiple: true });
    if (res.canceled || !res.assets?.length) return;
    let n = 0;
    for (const a of res.assets) {
      try {
        const bytes = new File(a.uri).bytesSync();
        await putAttachment(env, bytes, {
          entityType: 'library', kind: upCat, originalName: a.name ?? 'ملف',
          mime: a.mimeType ?? '', note: upNote.trim(),
        });
        n++;
      } catch (e) {
        reportFailure({ title: 'تعذّر حفظ ' + (a.name ?? 'ملف'), e });
      }
    }
    logAudit(db, 'المكتبة', 'create', 'رفع ملفات', n + ' ملف');
    setUploadOpen(false); setUpNote('');
    bump();
    toast('أُضيف ' + n + ' ملف إلى المكتبة');
  };

  const deleteFiles = (ids: string[]) => {
    dialog({
      title: 'حذف ملفات',
      body: `حذف ${ids.length} ملف من المكتبة؟`,
      tone: 'danger',
      actions: [
        { label: 'تراجع', variant: 'ghost' },
        {
          label: 'حذف', variant: 'danger',
          onPress: () => {
            db.transaction(() => { for (const id of ids) softDeleteAttachment(db, id); });
            logAudit(db, 'المكتبة', 'delete', 'حذف ملفات', ids.length + ' ملف');
            setSel(new Set());
            bump(); toast('حُذفت الملفات · تبقى في السلة طوال مدة الاحتفاظ');
          },
        },
      ],
    });
  };

  const toggleSel = useCallback((id: string) => {
    setSel((s) => { const n = new Set(s); if (n.has(id)) { n.delete(id); } else { n.add(id); } return n; });
  }, []);

  const openPreview = useCallback((id: string) => {
    const { where, params, order } = buildFileQuery(true);
    const ids = db.all<{ id: string }>(`SELECT a.id ${LIB_JOINS} WHERE ${where} ORDER BY ${order}, a.id`, params);
    // المفقود يبقى في القائمة: العارض يعرضه بوسم فقدانه بدل أن يختفي أو يفتح غيره
    const list = ids.map((r) => byId.get(r.id)).filter((x): x is LibraryFile => !!x);
    const idx = Math.max(0, list.findIndex((x) => x.id === id));
    setPreview({ list, idx });
  }, [db, buildFileQuery, byId]);

  const selActive = sel.size > 0;
  const onPressCard = useCallback((id: string) => {
    if (selActive) toggleSel(id); else openPreview(id);
  }, [selActive, toggleSel, openPreview]);
  // التحديد المتعدد لا يحمل إلا النقل والحذف · فلا يبدأ لمن لا يملكهما
  const onLongPressCard = useCallback((id: string) => {
    if (!perm.manage) return;
    setSel((s) => new Set(s).add(id));
  }, [perm.manage]);

  const renderItem = useCallback(({ item }: { item: LibraryFile }) => (
    <FileCard
      id={item.id} name={item.name} sizeBytes={item.sizeBytes} createdAt={item.createdAt}
      sha256={item.sha256} ext={item.ext} mime={item.mime} cat={item.cat}
      missing={item.missing} showImage={item.isImage && !item.missing}
      selected={sel.has(item.id)} onPress={onPressCard} onLongPress={onLongPressCard}
    />
  ), [sel, onPressCard, onLongPressCard]);
  const keyExtractor = useCallback((r: LibraryFile) => r.id, []);

  const folderBody = () => {
    if (!ready) return <Skeleton />;
    if (searching) {
      return <T size={11} bold color={C.muted} style={{ marginBottom: 7 }}>نتائج البحث ({total}) · من كل المكتبة</T>;
    }
    if (path.length === 0) {
      const cats = Object.keys(LIB_CATS).map((k) => {
        const f = all.filter((r) => r.cat === k);
        return f.length ? (
          <FolderCard key={k} icon={LIB_CATS[k].icon as IconName} label={LIB_CATS[k].label}
            count={f.length} size={f.reduce((s, r) => s + r.sizeBytes, 0)}
            onPress={() => setPath([k])} />
        ) : null;
      }).filter(Boolean);
      return cats.length ? <>{cats}</> : (
        <EmptyState>المكتبة فارغة. أي ملف تُرفقه في أي شاشة يظهر هنا تلقائياً.</EmptyState>
      );
    }
    if (path.length === 1) {
      const ids = [...new Set(scope.map((r) => r.propertyId ?? '__none'))];
      return ids.length ? (
        <>{ids.map((pid) => {
          const f = scope.filter((r) => (r.propertyId ?? '__none') === pid);
          return <FolderCard key={pid} icon={pid === '__none' ? 'archive' : 'building'} label={propName(pid)}
            count={f.length} size={f.reduce((s, r) => s + r.sizeBytes, 0)}
            onPress={() => setPath([path[0], pid])} />;
        })}</>
      ) : <EmptyState>لا ملفات في هذا المجلد.</EmptyState>;
    }
    if (path.length === 2) {
      return (
        <>
          {unitFolderIds.map((uid_) => {
            const f = scope.filter((r) => r.unitId === uid_);
            return <FolderCard key={uid_} icon="home" label={unitName(uid_)} count={f.length}
              size={f.reduce((s, r) => s + r.sizeBytes, 0)}
              onPress={() => setPath([path[0], path[1], uid_])} />;
          })}
          {total ? (
            <T size={11} bold color={C.muted} style={{ marginVertical: 7 }}>مستندات على مستوى العقار</T>
          ) : null}
        </>
      );
    }
    return null;
  };

  const listEmpty = !ready ? null
    : searching && total === 0 ? <EmptyState>لا نتائج.</EmptyState>
    : !searching && path.length === 3 && total === 0 ? <EmptyState>لا ملفات في هذه الوحدة.</EmptyState>
    : !searching && path.length === 2 && total === 0 && !unitFolderIds.length ? <EmptyState>لا ملفات هنا.</EmptyState>
    : null;

  const listHeader = (
    <View>
      {storageProbe ? (
        <Pressable
          onPress={() => Sharing.isAvailableAsync().then((ok) => { if (ok) return; }).catch(() => {})}
          style={{ backgroundColor: '#FBEBE9', borderRadius: 9, padding: 11, marginBottom: 8 }}>
          <T size={12.5} bold color={C.rose}>مخزن الملفات معطّل على هذا الجهاز</T>
          <T size={11.5} color={C.rose} style={{ marginTop: 3 }}>السبب: {storageProbe}</T>
          <T size={11} color={C.muted} style={{ marginTop: 3 }}>تفاصيل الخطأ في ملف التقرير المحفوظ في التنزيلات</T>
        </Pressable>
      ) : null}
      <Row style={{ flexWrap: 'wrap', marginBottom: 8 }}>
        <KpiCard label="إجمالي الملفات" value={String(all.length)} />
        <KpiCard label="الصور" value={String(stats.images)} />
      </Row>
      <Row style={{ flexWrap: 'wrap', marginBottom: 8 }}>
        <KpiCard label="المساحة" value={libSizeLabel(stats.size)} tone={stats.missing ? 'neg' : undefined} />
        <KpiCard label="غير مرتبطة / مفقودة" tone={stats.missing ? 'neg' : 'neu'} value={`${stats.orphan} / ${stats.missing}`} />
      </Row>

      {/* المسار */}
      <Row style={{ flexWrap: 'wrap', marginBottom: 8 }}>
        {path.length ? <BackButton onPress={() => setPath((p) => p.slice(0, -1))} /> : null}
        <Pressable onPress={() => setPath([])}><T size={12.5} bold={!path.length}>المكتبة</T></Pressable>
        {path[0] !== undefined && (
          <Pressable onPress={() => setPath([path[0]])}>
            <T size={12.5} bold={path.length === 1}> / {libCat(path[0]).label}</T>
          </Pressable>
        )}
        {path[1] !== undefined && (
          <Pressable onPress={() => setPath([path[0], path[1]])}>
            <T size={12.5} bold={path.length === 2}> / {propName(path[1])}</T>
          </Pressable>
        )}
        {path[2] !== undefined && <T size={12.5} bold> / {unitName(path[2])}</T>}
        <T size={11.5} color={C.muted}>· {scope.length} ملف هنا</T>
      </Row>

      <View style={{ marginBottom: 8 }}><SearchBox value={q} onChange={setQ} /></View>
      <Row style={{ flexWrap: 'wrap', marginBottom: 8 }}>
        <Chip label="الأحدث" active={sort === 'new'} onPress={() => setSort('new')} />
        <Chip label="الأقدم" active={sort === 'old'} onPress={() => setSort('old')} />
        <Chip label="الاسم" active={sort === 'name'} onPress={() => setSort('name')} />
        <Chip label="الحجم" active={sort === 'size'} onPress={() => setSort('size')} />
        <Chip label="صور" active={kind === 'img'} onPress={() => setKind(kind === 'img' ? '' : 'img')} />
        <Chip label="مستندات" active={kind === 'doc'} onPress={() => setKind(kind === 'doc' ? '' : 'doc')} />
      </Row>

      {sel.size && perm.manage ? (
        <Card style={{ backgroundColor: C.emeraldSoft }}>
          <Row style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
            <T size={12.5} bold>{sel.size} محدَّد</T>
            <Row>
              <BtnGhost small title="نقل إلى مجلد" onPress={() => { setEditId('__bulk'); setEdCat('other'); }} />
              <BtnGhost small danger title="حذف" onPress={() => deleteFiles([...sel])} />
              <BtnGhost small title="إلغاء" onPress={() => setSel(new Set())} />
            </Row>
          </Row>
        </Card>
      ) : null}

      {folderBody()}
    </View>
  );

  return (
    <Screen title="المكتبة" scroll={false}
      actions={perm.add ? <BtnPrimary small title="+ رفع ملفات" onPress={() => setUploadOpen(true)} /> : null}>
      <FlatList
        data={ready ? pageRows : EMPTY_FILES}
        keyExtractor={keyExtractor}
        renderItem={renderItem}
        numColumns={3}
        columnWrapperStyle={{ gap: 8 }}
        ListHeaderComponent={listHeader}
        ListFooterComponent={fileMode ? <Pager pager={pager} total={total} /> : null}
        ListEmptyComponent={listEmpty}
        initialNumToRender={12}
        maxToRenderPerBatch={12}
        windowSize={5}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: 12 }}
      />

      {/* رفع ملفات */}
      <Sheet visible={uploadOpen} onClose={() => setUploadOpen(false)} title="رفع ملفات إلى المكتبة"
        footer={
          <>
            <View style={{ flex: 1 }}><BtnPrimary title="اختيار الملفات ورفعها" onPress={upload} /></View>
          </>
        }>
        <SelectField label="التصنيف" value={upCat}
          options={Object.entries(LIB_CATS).map(([k, v]) => ({ value: k, icon: v.icon as IconName, label: v.label }))}
          onPick={setUpCat} />
        <Field label="ملاحظة" value={upNote} onChange={setUpNote} />
        <Row>
          <View style={{ flex: 1 }}>
            <BtnGhost small icon="library" title="من المعرض" onPress={async () => {
              const f = await pickFromGallery();
              if (!f) return;
              try {
                const bytes = new File(f.uri).bytesSync();
                await putAttachment(env, bytes, { entityType: 'library', kind: upCat, originalName: f.name, mime: f.mime, note: upNote.trim() });
                setUploadOpen(false); bump(); toast('أُضيف إلى المكتبة');
              } catch (e) { reportFailure({ title: 'تعذّر الحفظ', e }); }
            }} />
          </View>
          <View style={{ flex: 1 }}>
            <BtnGhost small icon="eye" title="تصوير بالكاميرا" onPress={async () => {
              const f = await captureWithCamera();
              if (!f) return;
              try {
                const bytes = new File(f.uri).bytesSync();
                await putAttachment(env, bytes, { entityType: 'library', kind: upCat, originalName: f.name, mime: f.mime, note: upNote.trim() });
                setUploadOpen(false); bump(); toast('أُضيف إلى المكتبة');
              } catch (e) { reportFailure({ title: 'تعذّر الحفظ', e }); }
            }} />
          </View>
        </Row>
      </Sheet>

      {/* العارض الداخلي · صورة/PDF/فيديو/صوت بسحب أفقي بين ملفات المجموعة */}
      {preview && (
        <FileViewer
          files={preview.list.map((r): ViewerFile => ({
            attId: r.id, sha256: r.sha256, ext: r.ext, name: r.name, mime: r.mime,
            sizeBytes: r.sizeBytes, createdAt: r.createdAt, cat: r.cat, linked: r.link,
          }))}
          startIndex={preview.idx}
          onClose={() => setPreview(null)}
          onMutated={() => bump()}
          canManage={perm.manage}
          onEditMeta={(attId) => {
            const r = preview.list.find((x) => x.id === attId);
            if (!r) return;
            setEditId(r.id); setEdName(r.name); setEdNote(r.note); setEdCat(r.cat);
          }}
        />
      )}

      {/* تعديل بيانات ملف / نقل جماعي */}
      {editId && (
        <Sheet visible onClose={() => setEditId(null)}
          title={editId === '__bulk' ? 'نقل إلى مجلد' : 'تعديل بيانات الملف'}
          footer={
            <>
              <View style={{ flex: 1 }}>
                <BtnPrimary title="حفظ" onPress={() => {
                  if (editId === '__bulk') {
                    db.transaction(() => { for (const id of sel) updateLibraryFile(db, id, { cat: edCat }); });
                    logAudit(db, 'المكتبة', 'update', 'تغيير تصنيف', sel.size + ' ملف');
                    setSel(new Set());
                    toast('حُدِّث التصنيف');
                  } else {
                    updateLibraryFile(db, editId, { name: edName.trim(), note: edNote.trim(), cat: edCat });
                    logAudit(db, 'المكتبة', 'update', 'تعديل بيانات ملف', edName.trim());
                    toast('حُفظت البيانات');
                  }
                  setEditId(null); bump();
                }} />
              </View>
            </>
          }>
          {editId !== '__bulk' && <Field label="اسم الملف" value={edName} onChange={setEdName} />}
          <SelectField label="التصنيف" value={edCat}
            options={Object.entries(LIB_CATS).map(([k, v]) => ({ value: k, icon: v.icon as IconName, label: v.label }))}
            onPick={setEdCat} />
          {editId !== '__bulk' && <Field label="ملاحظة" value={edNote} onChange={setEdNote} />}
        </Sheet>
      )}
    </Screen>
  );
}

function FolderCard({ icon, label, count, size, onPress }: {
  icon: IconName; label: string; count: number; size: number; onPress: () => void;
}) {
  return (
    <Pressable onPress={onPress} style={{
      flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: '#fff',
      borderWidth: 1, borderColor: C.line, borderRadius: 10, padding: 11, marginBottom: 8,
    }}>
      <Icon name={icon} size={20} color={C.emerald} />
      <View style={{ flex: 1, minWidth: 90 }}>
        <T size={12.5} bold numberOfLines={2}>{label}</T>
      </View>
      <View style={{ alignItems: 'flex-end' }}>
        <Num size={12.5} bold>{count}</Num>
        <T size={10} color={C.muted}>{libSizeLabel(size)}</T>
      </View>
    </Pressable>
  );
}
