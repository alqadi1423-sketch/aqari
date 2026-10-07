/**
 * ما قُرئ من عقد إيجار مقارناً بالقائم قبل الحفظ (قرارات تفصيل العقد ٢٠٢٦-١٠-٠٧):
 * الفارغ يُملأ افتراضاً، والمختلف لا يُكتب إلا بموافقة صريحة هنا · والمؤجّر للتنبيه وحده.
 */
import React, { useEffect, useMemo } from 'react';
import { Pressable, View } from 'react-native';
import { Note, Row, T } from './components';
import { Icon } from './icons';
import { C, TYPE } from './theme';
import { useApp } from './store';
import { useLang } from '../i18n';
import { compareExtras, type EjarExtras, type ExtraDiff, type ExtraKey } from '../domain/pdf/ejarExtras';

/** الفروق نفسها التي تُعرض هنا وتُطبَّق بعد الحفظ */
export function useLeaseDiffs(extras: EjarExtras | null | undefined, unitId: string, tenantName: string): ExtraDiff[] {
  const { db, version } = useApp();
  return useMemo(() => (extras && unitId ? compareExtras(db, extras, { unitId, tenantName }) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [db, version, extras, unitId, tenantName]);
}

export function LeaseCompare({ extras, diffs, approved, onChange }: {
  extras: EjarExtras | null | undefined;
  diffs: ExtraDiff[];
  approved: Set<ExtraKey>;
  onChange: (s: Set<ExtraKey>) => void;
}) {
  const { db } = useApp();
  const { t } = useLang();
  // الافتراض: الفارغ يُملأ، والمختلف لا
  useEffect(() => {
    onChange(new Set(diffs.filter((d) => d.fillsEmpty && !d.noSlot).map((d) => d.key)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [diffs]);
  const company = useMemo(() => db.get<{ name: string; cr: string }>(`SELECT name, cr FROM company WHERE id = 1`), [db]);
  const lessorWarn: string[] = [];
  if (extras?.lessor.cr && company?.cr && extras.lessor.cr !== company.cr.trim()) lessorWarn.push(t('lease.lessorCrDiffers'));
  else if (extras?.lessor.name && company?.name && extras.lessor.name.replace(/\s+/g, '') !== company.name.replace(/\s+/g, '')) {
    lessorWarn.push(t('lease.lessorDiffers', { name: extras.lessor.name }));
  }
  if (!diffs.length && !lessorWarn.length) return null;
  const toggle = (k: ExtraKey) => {
    const s = new Set(approved);
    if (s.has(k)) s.delete(k); else s.add(k);
    onChange(s);
  };
  return (
    <View style={{ marginTop: 12 }}>
      {lessorWarn.map((w, i) => <Note key={i} tone="danger">{w}</Note>)}
      {diffs.length ? (
        <>
          <T size={TYPE.body} bold>{t('lease.compareTitle')}</T>
          <T size={TYPE.caption} color={C.muted} style={{ marginBottom: 4 }}>{t('lease.compareNote')}</T>
          {diffs.map((d) => {
            const on = approved.has(d.key);
            return (
              <Pressable key={d.key} disabled={d.noSlot} onPress={() => toggle(d.key)}>
                <Row style={{ paddingVertical: 7, borderBottomWidth: 1, borderBottomColor: C.paperLine, alignItems: 'flex-start', gap: 8 }}>
                  {!d.noSlot ? <Icon name={on ? 'check' : 'x'} size={16} color={on ? C.emerald : C.muted} /> : null}
                  <View style={{ flex: 1 }}>
                    <T size={TYPE.body}>{t('lease.field.' + d.key.replace('.', '_'))}</T>
                    <T size={TYPE.caption} color={C.muted}>{t('lease.current') + ': ' + (d.current || t('lease.empty'))}</T>
                    <T size={TYPE.caption} color={on ? C.emerald : C.charcoal}>
                      {t('lease.read') + ': ' + d.read + (d.reading != null ? ' · ' + t('lease.reading', { n: d.reading }) : '')}
                    </T>
                    {d.noSlot ? <T size={TYPE.caption} color={C.muted}>{t('lease.noSlot')}</T> : null}
                  </View>
                </Row>
              </Pressable>
            );
          })}
        </>
      ) : null}
    </View>
  );
}
