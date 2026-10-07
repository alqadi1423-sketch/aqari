/**
 * الأصول (قرار المالك ٢٠٢٦-١٠-٠٤ على موجز الأصول) · السجل بفئته ووحدته وحالته وقيمته الدفترية،
 * وأدوات التحويل والإهلاك · كل نصٍّ بمفتاحه في ملفي الترجمة.
 */
import React, { useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { Screen } from '../src/ui/Screen';
import { BtnPrimary, Card, ChipGroup, EmptyState, Money, Row, SearchBox, T } from '../src/ui/components';
import { SelectField } from '../src/ui/Sheet';
import { ActionMenuButton } from '../src/ui/ActionMenu';
import { C, TYPE } from '../src/ui/theme';
import { useApp } from '../src/ui/store';
import { usePerm } from '../src/ui/access';
import { useLang } from '../src/i18n';
import { listAssets } from '../src/domain/assets/service';
import { bookValue } from '../src/domain/assets/depreciation';
import {
  AssetBadge, AssetSheet, ContentsSheet, ConvertSheet, NewAssetSheet, useCategoryOptions, useRunDepreciation,
} from '../src/ui/AssetSheets';

type StatusFilter = '' | 'pending' | 'in_service' | 'maintenance' | 'disposed' | 'sold';

export default function Assets() {
  const { db, version } = useApp();
  const { t } = useLang();
  const perm = usePerm('assets');
  const params = useLocalSearchParams<{ unit?: string; status?: string }>();
  const cats = useCategoryOptions();
  const runNow = useRunDepreciation();
  const [q, setQ] = useState('');
  const [category, setCategory] = useState('');
  const [property, setProperty] = useState('');
  const [status, setStatus] = useState<StatusFilter>((params.status as StatusFilter) || '');
  const [open, setOpen] = useState<string | null>(null);
  const [sheet, setSheet] = useState<'new' | 'convert' | 'contents' | null>(null);
  const props = useMemo(() => db.all<{ id: string; name: string }>(`SELECT id, name FROM properties WHERE deleted_at IS NULL ORDER BY name`),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [db, version]);
  const rows = useMemo(() => listAssets(db, { propertyId: property || null, unitId: params.unit || null, category: category || null, status: status || null, q }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [db, version, property, category, status, q, params.unit]);
  const anyAsset = useMemo(() => !!db.get(`SELECT 1 FROM assets WHERE deleted_at IS NULL LIMIT 1`),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [db, version]);
  const total = useMemo(() => (perm.view ? rows.filter((a) => a.cost_halalas != null && a.status !== 'disposed' && a.status !== 'sold')
    .reduce((s, a) => s + bookValue(db, a).nbv, 0) : 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [db, rows, perm.view]);
  return (
    <Screen title={t('assets.title')} icon="building"
      actions={(
        <Row gap={6}>
          {perm.add ? <BtnPrimary small icon="plus" title={t('assets.ui.add')} onPress={() => setSheet('new')} /> : null}
          <ActionMenuButton title={t('assets.ui.tools')} actions={[
            perm.add ? { label: t('assets.ui.contentsTool'), onPress: () => setSheet('contents') } : null,
            perm.manage ? { label: t('assets.ui.convertTool'), onPress: () => setSheet('convert') } : null,
            perm.manage ? { label: t('assets.ui.runNow'), onPress: runNow } : null,
          ]} />
        </Row>
      )}>
      <SearchBox value={q} onChange={setQ} placeholder={t('common.search')} />
      <ChipGroup<StatusFilter> options={[
        ['', t('common.all')], ['pending', t('assets.ui.pendingFilter')], ['in_service', t('assets.status.in_service')],
        ['maintenance', t('assets.status.maintenance')], ['disposed', t('assets.status.disposed')], ['sold', t('assets.status.sold')],
      ]} value={status} onChange={setStatus} />
      <Row>
        <View style={{ flex: 1 }}>
          <SelectField label={t('common.property')} value={property} options={[{ value: '', label: t('common.all') }, ...props.map((p) => ({ value: p.id, label: p.name }))]} onPick={setProperty} />
        </View>
        <View style={{ flex: 1 }}>
          <SelectField label={t('assets.ui.category')} value={category} options={[{ value: '', label: t('common.all') }, ...cats]} onPick={setCategory} />
        </View>
      </Row>
      {perm.view && rows.length ? (
        <Row style={{ justifyContent: 'space-between', marginBottom: 6 }}>
          <T size={TYPE.caption} color={C.muted}>{t('assets.ui.nbv')}</T>
          <Money halalas={total} bold />
        </Row>
      ) : null}
      {!rows.length ? <EmptyState>{anyAsset ? t('assets.ui.noMatch') : t('assets.ui.empty')}</EmptyState> : (
        <Card>
          {rows.map((a) => (
            <Pressable key={a.id} onPress={() => setOpen(a.id)}>
              <Row style={{ justifyContent: 'space-between', paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: C.paperLine }}>
                <View style={{ flex: 1, gap: 2 }}>
                  <T size={TYPE.body} bold numberOfLines={1}>{a.name}</T>
                  <T size={TYPE.caption} color={C.muted} numberOfLines={1}>
                    {[a.property_name, a.unit_no, a.room, t('assets.cat.' + a.category)].filter(Boolean).join(' · ')}
                  </T>
                </View>
                <View style={{ alignItems: 'flex-end', gap: 4 }}>
                  <AssetBadge a={a} />
                  {perm.view && a.cost_halalas != null && a.status !== 'disposed' && a.status !== 'sold'
                    ? <Money halalas={bookValue(db, a).nbv} size={TYPE.caption} /> : null}
                </View>
              </Row>
            </Pressable>
          ))}
        </Card>
      )}
      {open ? <AssetSheet id={open} onClose={() => setOpen(null)} /> : null}
      {sheet === 'new' ? <NewAssetSheet onClose={() => setSheet(null)} unitId={params.unit} /> : null}
      {sheet === 'convert' ? <ConvertSheet onClose={() => setSheet(null)} /> : null}
      {sheet === 'contents' ? <ContentsSheet onClose={() => setSheet(null)} /> : null}
    </Screen>
  );
}
