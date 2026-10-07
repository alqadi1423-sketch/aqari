/**
 * أصول الوحدة في بطاقتها (موجز الأصول §٨): يراها من يرى الوحدة (الفني ومندوب الاستلام) بالاسم والغرفة
 * والحالة والضمان، والتكلفة والقيمة الدفترية لقسم الأصول وحده · كل نصٍّ بمفتاحه.
 */
import React, { useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';
import { CollapsibleSection } from './Collapsible';
import { BtnGhost, Money, Row, T } from './components';
import { C, TYPE } from './theme';
import { useApp } from './store';
import { usePerm } from './access';
import { useLang } from '../i18n';
import { dfmt } from '../domain/dates';
import { bookValue } from '../domain/assets/depreciation';
import { AssetBadge, AssetSheet, NewAssetSheet } from './AssetSheets';

export function UnitAssetsSection({ unitId }: { unitId: string }) {
  const { db, version } = useApp();
  const { t } = useLang();
  const perm = usePerm('assets');
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const count = useMemo(() => Number(db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM assets WHERE unit_id = ? AND deleted_at IS NULL AND status NOT IN ('disposed', 'sold')`, [unitId])?.n ?? 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [db, unitId, version]);
  return (
    <>
      {count ? (
        <CollapsibleSection title={t('assets.ui.unitAssets')} count={count} icon="building" pageKey="unitAssets">
          {(page) => db.all<{ id: string; name: string; room: string; category: string; status: 'in_service' | 'maintenance' | 'disposed' | 'sold'; cost_halalas: number | null; warranty_end: string | null }>(
            `SELECT id, name, room, category, status, cost_halalas, warranty_end FROM assets
             WHERE unit_id = ? AND deleted_at IS NULL AND status NOT IN ('disposed', 'sold') ORDER BY room, name LIMIT ? OFFSET ?`,
            [unitId, page.limit, page.offset]).map((a) => (
            <Pressable key={a.id} onPress={() => setOpen(a.id)}>
              <Row style={{ justifyContent: 'space-between', paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: C.line }}>
                <View style={{ flex: 1 }}>
                  <T size={TYPE.body}>{a.name}</T>
                  <T size={TYPE.caption} color={C.muted}>
                    {[a.room, t('assets.cat.' + a.category), a.warranty_end ? t('assets.ui.warrantyEnd') + ' ' + dfmt(a.warranty_end) : ''].filter(Boolean).join(' · ')}
                  </T>
                </View>
                <View style={{ alignItems: 'flex-end', gap: 3 }}>
                  <AssetBadge a={a} />
                  {perm.view && a.cost_halalas != null ? <Money halalas={bookValue(db, { id: a.id, category: a.category }).nbv} size={TYPE.caption} /> : null}
                </View>
              </Row>
            </Pressable>
          ))}
        </CollapsibleSection>
      ) : null}
      {perm.add ? <BtnGhost small icon="plus" title={t('assets.ui.newTitle')} onPress={() => setAdding(true)} /> : null}
      {open ? <AssetSheet id={open} onClose={() => setOpen(null)} /> : null}
      {adding ? <NewAssetSheet unitId={unitId} onClose={() => setAdding(false)} /> : null}
    </>
  );
}
