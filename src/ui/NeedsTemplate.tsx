/**
 * ما يحتاج قالباً ولا قالب له (قرار المالك ٢٠٢٦-١٠-٠٥: لا محتوى مزروعاً) · يظهر السبب مكانه ورابطٌ لإنشائه،
 * والرابط لمن يملك إنشاء القوالب وحده · ومن لا يملكه يُقال له من ينشئه.
 */
import React from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { BtnGhost, Note } from './components';
import { usePerm } from './access';

export function NeedsTemplate({ reason, linkLabel, route, onNavigate }: {
  reason: string;
  linkLabel: string;
  route: '/form-templates' | '/scripts';
  /** يُغلق ما فوق الرابط (ورقة أو حوار) قبل الانتقال */
  onNavigate?: () => void;
}) {
  const router = useRouter();
  // القوالب في قسم المنشأة · وإنشاؤها إضافةٌ فيه
  const canCreate = usePerm('company').add;
  return (
    <View style={{ marginBottom: 8 }}>
      <Note tone="gold">{canCreate ? reason : reason + ' · ويُنشئ القوالب من له صلاحية المنشأة'}</Note>
      {canCreate ? (
        <BtnGhost small icon="plus" title={linkLabel} onPress={() => { onNavigate?.(); router.push(route); }} />
      ) : null}
    </View>
  );
}
