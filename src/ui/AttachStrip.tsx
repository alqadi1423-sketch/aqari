/**
 * شريط مرفقات أفقي · المرفق يُفتح من الشيء المرتبط به لا من المكتبة وحدها:
 * مصغّرات تُضغط فيفتح العارض ويُسحب للتالي، وزر «إضافة مرفق» في الموضع نفسه.
 */
import type { SectionKey } from '../domain/access/sections';
import { usePerm } from './access';
import React, { useMemo, useState } from 'react';
import { View, ScrollView, Pressable, Image } from 'react-native';
import { T, Num, Row, BtnGhost } from './components';
import { Icon, type IconName } from './icons';
import { useApp } from './store';
import { useToast } from './Toast';
import { C } from './theme';
import { attachmentsFor, type AttachmentRow } from '../files/store';
import { libCat, libSizeLabel } from '../domain/library';
import { existingThumbUri, isImageFile } from '../services/thumbs';
import { attachPicked, pickFile } from './attach';
import { FileViewer, type ViewerFile } from './FileViewer';
import { reportFailure } from './failureDialog';

function toViewer(a: AttachmentRow, linked: string): ViewerFile {
  return {
    attId: a.id, sha256: a.sha256, ext: a.ext,
    name: a.display_name || a.original_name || 'مستند',
    mime: a.mime, sizeBytes: Number(a.size_bytes), createdAt: a.created_at,
    cat: a.cat_override || a.kind, linked,
  };
}

export function AttachStrip({ entityType, entityId, kind, linked, title, hideAdd: hideAddProp, canManage: canManageProp = true, section }: {
  entityType: string;
  entityId: string;
  /** تصنيف المرفق الجديد عند الإضافة من هنا */
  kind: string;
  /** وصف الجهة المرتبط بها (يظهر في بطاقة معلومات العارض) */
  linked: string;
  title?: string;
  /** true تُخفي زر «إضافة مرفق» ويبقى العرض والفتح · الافتراضي إظهاره */
  hideAdd?: boolean;
  /** false تُخفي في العارض إعادة التسمية والنقل ونزع الربط والحذف · الافتراضي إظهارها */
  canManage?: boolean;
  /** قسم الجهة المرتبط بها · يُحسب منه الإضافة (إدخال) والإدارة (كامل) فلا يمرّرهما كل مستدعٍ */
  section?: SectionKey;
}) {
  const { db, version, bump } = useApp();
  const sec = usePerm(section ?? 'library');
  const hideAdd = hideAddProp || (!!section && !sec.add);
  const canManage = canManageProp && (!section || sec.manage);
  const toast = useToast();
  const [viewer, setViewer] = useState<number | null>(null);
  const atts = useMemo(() => attachmentsFor(db, entityType, entityId),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [db, version, entityType, entityId]);
  const files = atts.map((a) => toViewer(a, linked));

  const add = async () => {
    const f = await pickFile();
    if (!f) return;
    attachPicked(db, f, entityType, entityId, kind)
      .then(() => { bump(); toast('أُرفق وظهر في المكتبة تحت تصنيفه'); })
      .catch((e) => reportFailure({ title: 'تعذّر الإرفاق', e }));
  };

  return (
    <View style={{ marginTop: 12 }}>
      <Row style={{ justifyContent: 'space-between', marginBottom: 6 }}>
        <T size={13.5} bold color={C.ink}>{title ?? 'المرفقات'} ({atts.length})</T>
        {hideAdd ? null : <BtnGhost small icon="attach" title="إضافة مرفق" onPress={add} />}
      </Row>
      {atts.length ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <Row gap={8}>
            {atts.map((a, i) => {
              const thumb = isImageFile(a.ext, a.mime) ? existingThumbUri(a.sha256) : null;
              return (
                <Pressable key={a.id} onPress={() => setViewer(i)}
                  style={{ width: 86, borderWidth: 1, borderColor: C.line, borderRadius: 9, overflow: 'hidden', backgroundColor: '#fff' }}>
                  <View style={{ height: 62, backgroundColor: C.paper, alignItems: 'center', justifyContent: 'center' }}>
                    {thumb ? (
                      <Image source={{ uri: thumb }} style={{ width: '100%', height: 62 }} resizeMode="cover" />
                    ) : (
                      <Icon name={(libCat(a.cat_override || a.kind).icon as IconName) || 'attach'} size={22} color={C.muted} />
                    )}
                  </View>
                  <View style={{ padding: 5 }}>
                    <T size={9.5}>{(a.display_name || a.original_name || 'مستند').slice(0, 14)}</T>
                    <Num size={8.5} color={C.muted}>{libSizeLabel(Number(a.size_bytes))}</Num>
                  </View>
                </Pressable>
              );
            })}
          </Row>
        </ScrollView>
      ) : (
        <T size={12} color={C.muted}>لا مرفقات بعد</T>
      )}
      {viewer != null && (
        <FileViewer files={files} startIndex={viewer}
          onClose={() => setViewer(null)} onMutated={() => bump()} canManage={canManage} />
      )}
    </View>
  );
}
