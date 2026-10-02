/**
 * تقسيم الصفحات: زر واحد أسفل القائمة يفتح خيارات العدد، والخيارات تتبع بياناتك
 * فلا يُعرض خيار يتجاوز سجلاتك (إلا الأول الذي يسعها كلها) · والاختيار محفوظ لكل شاشة.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { View } from 'react-native';
import { Row, Num, BtnGhost } from './components';
import { PickerSheet } from './Sheet';
import { C, TYPE } from './theme';
import { useApp } from './store';
import { getSetting, setSetting } from '../repos/settings';

const ALL_SIZES = [5, 10, 20, 50, 100, 500] as const;

/** الخيارات المتاحة لعددٍ ما: ما دون العدد كله + أول خيار يسعه كاملاً */
export function sizesForTotal(total: number): number[] {
  const under = ALL_SIZES.filter((s) => s <= total);
  const firstAbove = ALL_SIZES.find((s) => s > total);
  const out = [...under, ...(firstAbove ? [firstAbove] : [])];
  return out.length ? out : [ALL_SIZES[0]];
}

export interface PagerState {
  page: number;
  size: number;
  limit: number;
  offset: number;
  setSize: (n: number) => void;
  setPage: (n: number) => void;
  /** يعيد الصفحة للأولى · يُستدعى عند تغيّر البحث أو المرشِّحات */
  reset: () => void;
}

export function usePager(screenKey: string): PagerState {
  const { db } = useApp();
  const [size, setSizeState] = useState<number>(() => {
    const saved = Number(getSetting(db, ('pageSize:' + screenKey) as never) ?? 20);
    return (ALL_SIZES as readonly number[]).includes(saved) ? saved : 20;
  });
  const [page, setPage] = useState(0);
  const setSize = useCallback((n: number) => {
    setSizeState(n);
    setPage(0);
    try { setSetting(db, ('pageSize:' + screenKey) as never, n as never); } catch { /* الحفظ ثانوي */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screenKey]);
  const reset = useCallback(() => setPage(0), []);
  return { page, size, limit: size, offset: page * size, setSize, setPage, reset };
}

/** أسفل القائمة: التنقل + زر عدد العناصر يفتح خياراته المتكيفة */
export function Pager({ pager, total }: { pager: PagerState; total: number }) {
  const [pickOpen, setPickOpen] = useState(false);
  const pages = Math.max(1, Math.ceil(total / pager.size));
  useEffect(() => {
    if (pager.page >= pages) pager.setPage(Math.max(0, pages - 1));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pages]);
  if (total <= 5) return null;
  const from = total === 0 ? 0 : pager.offset + 1;
  const to = Math.min(total, pager.offset + pager.size);
  const sizes = sizesForTotal(total);
  return (
    <View style={{ marginTop: 8, marginBottom: 4 }}>
      {total > pager.size ? (
        <Row style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <BtnGhost small title="التالي" disabled={pager.page >= pages - 1}
            onPress={() => pager.setPage(pager.page + 1)} />
          <Num size={TYPE.caption} color={C.muted}>{`${from} إلى ${to} من ${total}`}</Num>
          <BtnGhost small title="السابق" disabled={pager.page === 0}
            onPress={() => pager.setPage(pager.page - 1)} />
        </Row>
      ) : null}
      <BtnGhost small title={`عدد العناصر في الصفحة: ${pager.size}`} onPress={() => setPickOpen(true)} />
      <PickerSheet
        visible={pickOpen}
        onClose={() => setPickOpen(false)}
        title="عدد العناصر في الصفحة"
        options={sizes.map((n) => ({ value: String(n), label: String(n) }))}
        value={String(pager.size)}
        onPick={(v) => pager.setSize(Number(v))}
      />
    </View>
  );
}
