/**
 * «المزيد» · فهرس الشاشات كلها مرتّبة أقساماً · وكل قسم يضم ما يخصه فقط.
 * روابط الشاشات تسكن هنا وحدها · صفحة الإعدادات للإعدادات وحدها.
 */
import React from 'react';
import { useRouter } from 'expo-router';
import { Screen } from '../../src/ui/Screen';
import { Card, CardTitle, SetRow } from '../../src/ui/components';
import { MORE_SCREENS as SECTIONS } from '../../src/ui/moreScreens';
import { useAccess } from '../../src/ui/access';
import { routeAllowed } from '../../src/domain/access/routes';

export default function More() {
  const router = useRouter();
  // يُبنى من صلاحيات العضو وحدها · الشاشة غير المسموحة لا تظهر، والمجموعة الفارغة لا تظهر
  const access = useAccess();
  const visible = SECTIONS
    .map((s) => ({ ...s, items: s.items.filter(([path]) => routeAllowed(access, path)) }))
    .filter((s) => s.items.length);
  return (
    <Screen title="المزيد" noBack icon="menu">
      {visible.map((s) => (
        <Card key={s.title}>
          <CardTitle>{s.title}</CardTitle>
          {s.items.map(([path, title, sub, icon]) => (
            <SetRow key={path} icon={icon} title={title} sub={sub} onPress={() => router.push(path as never)} />
          ))}
        </Card>
      ))}
    </Screen>
  );
}
