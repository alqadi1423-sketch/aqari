/**
 * بوابة الدخول الإلزامي (الدراسة أ، معتمدة ٢٠٢٦-١٠-٠٤) · لا متابعة بلا حساب:
 *  - أول فتح أو بعد الخروج: شاشة الدخول بقوقل (وأبل على الآيفون حين يُبنى) وسطر الشروط والخصوصية.
 *    بعد الدخول الأول يعمل التطبيق بلا اتصال كالمعتاد، فالجلسة المحفوظة تكفي.
 *  - الأجهزة القائمة عند التحديث: بياناتها باقية، وبعد الدخول تنضمّ إلى الحساب بلا فقد.
 *  - الخروج يرجع هنا، وبيانات الجهاز تبقى مقفلة حتى يدخل حسابها نفسه.
 *  - دخل حسابٌ غير حساب بيانات الجهاز: لا تُرفع إليه ولا تُعرض، ويُختار حذفها من الجهاز أو الخروج.
 * والبناء بلا إعداد Firebase (بيئة التطوير) يمرّ كما هو.
 */
import React, { useEffect, useState } from 'react';
import { View, Pressable, ActivityIndicator, Linking, ScrollView } from 'react-native';
import { T, BtnPrimary, BtnGhost, Note } from './components';
import { C, TYPE } from './theme';
import { useApp } from './store';
import { useDialog } from './AppDialog';
import { reportFailure } from './failureDialog';
import { cloudConfig } from '../cloud/config';
import {
  cloudState, subscribeCloud, primeSession, cloudSignIn, cloudSignOut, deviceAccount, restoreAwaitingAdoption, bindDeviceToCurrentAccount,
  acceptInviteNow, declineInvites,
} from '../services/cloud';

/** صفحتا الشروط والخصوصية على استضافة المشروع · تُنشران بعد مراجعة المالك لمسودتيهما */
export function legalUrls(): { terms: string; privacy: string } | null {
  const cfg = cloudConfig();
  if (!cfg) return null;
  return { terms: `https://${cfg.projectId}.web.app/terms`, privacy: `https://${cfg.projectId}.web.app/privacy` };
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <ScrollView contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', padding: 24, backgroundColor: C.paper }}>
      <View style={{ alignItems: 'center', marginBottom: 26 }}>
        <T size={30} bold color={C.emerald}>عقاري</T>
        <T size={TYPE.caption} color={C.muted} style={{ marginTop: 4 }}>أحد حلول منصة رِكز</T>
      </View>
      {children}
    </ScrollView>
  );
}

export function AuthGate({ children }: { children: React.ReactNode }) {
  const { db, bump, version } = useApp();
  const dialog = useDialog();
  const [cloud, setCloud] = useState(cloudState());
  useEffect(() => { primeSession(); return subscribeCloud(() => setCloud(cloudState())); }, []);
  const [busy, setBusy] = useState(false);
  void version; // تُعاد القراءة بعد تفريغ الجهاز

  if (!cloud.configured) return <>{children}</>;
  if (!cloud.restored) {
    return <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: C.paper }}><ActivityIndicator color={C.emerald} size="large" /></View>;
  }
  const owner = deviceAccount(db);
  // دعوة منشأة لإيميل الداخل على جهاز جديد · يختار قبل أي مزامنة (صلاحيات الأقسام)
  if (cloud.user && cloud.invites?.length) {
    return (
      <Shell>
        <T size={TYPE.cardTitle} bold style={{ textAlign: 'center', marginBottom: 10 }}>دعوة للانضمام</T>
        {cloud.invites.map((inv) => (
          <View key={inv.org} style={{ marginBottom: 10 }}>
            <BtnPrimary title={'انضم إلى «' + (inv.doc.orgName || 'منشأة عقاري') + '»'} loading={busy} onPress={async () => {
              setBusy(true);
              try { await acceptInviteNow(db, inv.org, inv.doc); bump(); }
              catch (e) { await reportFailure({ title: 'تعذّر الانضمام', where: 'قبول الدعوة', db, e }); }
              setBusy(false);
            }} />
          </View>
        ))}
        <Note>ترى في المنشأة ما تجيزه لك صلاحيتك وحدها، وتُمسح أي بيانات على هذا الجهاز قبل الانضمام.</Note>
        <View style={{ marginTop: 12 }}>
          <BtnGhost title="لا · أستعمل التطبيق لأملاكي" onPress={() => { declineInvites(db); bump(); }} />
        </View>
      </Shell>
    );
  }
  if (cloud.user && (!owner || owner.uid === cloud.user.uid || restoreAwaitingAdoption(db))) return <>{children}</>;

  const legal = legalUrls();
  const signIn = async () => {
    setBusy(true);
    try { await cloudSignIn(); bump(); }
    catch (e) { await reportFailure({ title: 'تعذّر الدخول', where: 'الدخول', db, e }); }
    setBusy(false);
  };

  // دخل حسابٌ غير حساب بيانات الجهاز
  if (cloud.user && owner) {
    return (
      <Shell>
        <Note tone="danger">
          {'على هذا الجهاز بيانات حساب ' + (owner.email || 'آخر') + '، ودخلت بحساب ' + cloud.user.email
            + '. لا تُعرض هذه البيانات لحسابك ولا تُرفع إليه.'}
        </Note>
        <View style={{ marginTop: 12 }}>
          <BtnGhost title="اخرج وادخل بالحساب الآخر" onPress={async () => { await cloudSignOut(); bump(); }} />
        </View>
        <View style={{ marginTop: 10 }}>
          <BtnPrimary danger title="احذف بيانات الجهاز وابدأ بهذا الحساب" loading={busy} onPress={() => dialog({
            title: 'حذف بيانات الجهاز',
            body: 'تُحذف من هذا الجهاز كل بيانات الحساب ' + (owner.email || 'الآخر')
              + ' ومرفقاته ونسخ الأمان عليه، ولا تُمسّ نسخته في السحابة إن كانت. لا رجعة في هذا على الجهاز.',
            tone: 'danger',
            actions: [
              { label: 'تراجع', variant: 'ghost' },
              { label: 'احذف وابدأ', variant: 'primary', onPress: async () => {
                setBusy(true);
                try { await bindDeviceToCurrentAccount(db); bump(); }
                catch (e) { await reportFailure({ title: 'تعذّر حذف بيانات الجهاز', where: 'تفريغ الجهاز', db, e }); }
                setBusy(false);
              } },
            ],
          })} />
        </View>
      </Shell>
    );
  }

  return (
    <Shell>
      {owner?.email ? (
        <T size={TYPE.body} style={{ textAlign: 'center', marginBottom: 14 }}>
          {'بيانات هذا الجهاز لحساب ' + owner.email + ' · سجّل الدخول به لتفتحها.'}
        </T>
      ) : null}
      {cloud.online ? (
        <BtnPrimary icon="lock" title="الدخول بحساب قوقل" loading={busy} onPress={signIn} />
      ) : (
        <Note>أول دخول يحتاج اتصالاً بالإنترنت · بعده يعمل التطبيق بلا اتصال.</Note>
      )}
      {legal ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', marginTop: 18, gap: 4 }}>
          <T size={TYPE.caption} color={C.muted}>بالمتابعة توافق على</T>
          <Pressable onPress={() => Linking.openURL(legal.terms).catch(() => {})}>
            <T size={TYPE.caption} bold color={C.emerald}>الشروط</T>
          </Pressable>
          <T size={TYPE.caption} color={C.muted}>و</T>
          <Pressable onPress={() => Linking.openURL(legal.privacy).catch(() => {})}>
            <T size={TYPE.caption} bold color={C.emerald}>سياسة الخصوصية</T>
          </Pressable>
        </View>
      ) : null}
    </Shell>
  );
}
