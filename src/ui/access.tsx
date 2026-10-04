/**
 * الصلاحية في الواجهة · useAccess يقرأ عضوية الجهاز مع كل كتابة (version)،
 * والحارس يرجع من أي مسار قسمه «لا» فلا رابط مباشر يفتحه (docs/PERMISSIONS.md §٢).
 */
import React, { useEffect, useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { usePathname, useRouter } from 'expo-router';
import { C } from './theme';
import { useApp } from './store';
import { readAccess } from '../services/access';
import { canAdd, canEdit, canManage, canView, type Access } from '../domain/access/access';
import type { SectionKey } from '../domain/access/sections';
import { routeAllowed } from '../domain/access/routes';

export function useAccess(): Access {
  const { db, version } = useApp();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => readAccess(db), [db, version]);
}

export interface SectionPerm {
  view: boolean;
  /** إضافة جديد · إدخال فأعلى */
  add: boolean;
  /** تعديل وإلغاء وحذف · كامل */
  manage: boolean;
  /** تعديل صفّ بعينه · كامل، أو مسودة كاتبها بإدخال */
  edit(row?: { by?: string | null; draft?: boolean }): boolean;
}

/** صلاحية قسم واحد للأزرار · الزر غير المسموح لا يظهر */
export function usePerm(k: SectionKey): SectionPerm {
  const a = useAccess();
  return useMemo(() => ({
    view: canView(a, k),
    add: canAdd(a, k),
    manage: canManage(a, k),
    edit: (row) => canEdit(a, k, row),
  }), [a, k]);
}

/** يلفّ شجرة الشاشات · المسار غير المسموح لا يُرسم ويُستبدل بالرئيسية */
export function RouteGuard({ children }: { children: React.ReactNode }) {
  const access = useAccess();
  const pathname = usePathname();
  const router = useRouter();
  const allowed = routeAllowed(access, pathname);
  useEffect(() => {
    if (!allowed) router.replace('/');
  }, [allowed, router]);
  // الشجرة تبقى مركّبة لتعمل الملاحة · وغطاءٌ فارغ يحجب الشاشة الممنوعة حتى يتم الاستبدال
  return (
    <View style={{ flex: 1 }}>
      {children}
      {allowed ? null : <View style={[StyleSheet.absoluteFill, { backgroundColor: C.paper }]} />}
    </View>
  );
}
