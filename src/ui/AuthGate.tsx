/**
 * بوابة الدخول الإلزامي (الدراسة أ، معتمدة ٢٠٢٦-١٠-٠٤) · لا متابعة بلا حساب:
 *  - أول فتح أو بعد الخروج: شاشة الدخول بقوقل (وأبل على الآيفون حين يُبنى) وسطر الشروط والخصوصية.
 *    بعد الدخول الأول يعمل التطبيق بلا اتصال كالمعتاد، فالجلسة المحفوظة تكفي.
 *  - الأجهزة القائمة عند التحديث: بياناتها باقية، وبعد الدخول تنضمّ إلى الحساب بلا فقد.
 *  - البيانات ملك الحساب لا الجهاز (توجيه المالك): الخروج يركن نسخة الحساب مقفلةً، والدخول بأي حساب
 *    يفتح نسخته هو أو يسحبها من سحابته · ولا يرث حسابٌ شيئاً من غيره، ولا زرّ يمسح ما لم يُرفع.
 *  - الداخل بنسخة جديدة يُتحقق من دعواته أولاً: المدعوّ يرى دعوته وحدها، ولا منشأة له قبل قراره.
 *  - العضو الذي ينقصه الاسم أو الجوال تظهر له شاشة الإكمال بعد قبوله الدعوة (توجيه المالك ٢٠٢٦-١٠-٠٥).
 * والبناء بلا إعداد Firebase (بيئة التطوير) يمرّ كما هو.
 */
import React, { useEffect, useState } from 'react';
import { View, Pressable, ActivityIndicator, Linking, ScrollView } from 'react-native';
import { T, BtnPrimary, BtnGhost, Note } from './components';
import { C, TYPE } from './theme';
import { useApp } from './store';
import { reportFailure } from './failureDialog';
import { cloudConfig } from '../cloud/config';
import {
  cloudState, subscribeCloud, primeSession, cloudSignIn, cloudSignOut, activateAccount,
  acceptInviteNow, declineInvites, bindUnboundToAccount, keepUnboundAside,
} from '../services/cloud';
import { activeAccount } from '../services/accountSlots';
import { readMembership } from '../services/access';
import { profileIncomplete } from '../domain/access/profile';
import { MyProfileForm } from './ProfileForm';
import { getSyncState } from '../sync/engine';

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
  const [cloud, setCloud] = useState(cloudState());
  useEffect(() => { primeSession(); return subscribeCloud(() => setCloud(cloudState())); }, []);
  const [busy, setBusy] = useState(false);
  void version; // تُعاد القراءة بعد فتح نسخة حساب

  const active = cloud.configured && cloud.restored ? activeAccount(db) : null;
  const needsActivation = !!cloud.user && !cloud.gate && !cloud.invites?.length && active !== cloud.user.uid;
  // جلسة محفوظة لحسابٍ ليست نسخته النشطة · تُفتح نسخته (أو تُسحب) ولا يُعرض شيء قبلها
  useEffect(() => {
    if (needsActivation && cloud.user) activateAccount(cloud.user).then(bump).catch(() => {});
  }, [needsActivation, cloud.user, bump]);

  if (!cloud.configured) return <>{children}</>;
  const spinner = (msg?: string) => (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: C.paper }}>
      <ActivityIndicator color={C.emerald} size="large" />
      {msg ? <T size={TYPE.body} color={C.muted} style={{ marginTop: 12 }}>{msg}</T> : null}
    </View>
  );
  if (!cloud.restored) return spinner();
  const run = async (fn: () => Promise<unknown> | unknown, title: string, where: string) => {
    setBusy(true);
    try { await fn(); bump(); }
    catch (e) { await reportFailure({ title, where, db, e }); }
    setBusy(false);
  };

  if (cloud.user) {
    const email = cloud.user.email;
    if (cloud.gate === 'switching' || needsActivation) return spinner('جاري فتح بيانات حساب ' + email);
    // التحقق من الدعوات لم يتمّ · لا يُفترض الداخل مالكاً ولا تُنشأ له منشأة
    if (cloud.gate === 'retry') {
      return (
        <Shell>
          <Note>{'لم يكتمل التحقق من حساب ' + email + ' · أول دخول بالحساب على هذا الجهاز يحتاج اتصالاً بالإنترنت.'}</Note>
          <BtnPrimary title="أعد المحاولة" loading={busy} onPress={() => run(() => activateAccount(cloud.user!), 'تعذّر التحقق', 'الدخول')} />
          <View style={{ marginTop: 10 }}>
            <BtnGhost title="خروج" onPress={() => run(() => cloudSignOut(), 'تعذّر الخروج', 'الخروج')} />
          </View>
        </Shell>
      );
    }
    // دعوة منشأة · وحدها قبل أي منشأة له
    if (cloud.invites?.length) {
      return (
        <Shell>
          <T size={TYPE.cardTitle} bold style={{ textAlign: 'center', marginBottom: 6 }}>دعوة للانضمام</T>
          <T size={TYPE.body} color={C.muted} style={{ textAlign: 'center', marginBottom: 12 }}>{'لحساب ' + email}</T>
          {cloud.invites.map((inv) => (
            <View key={inv.org} style={{ marginBottom: 10 }}>
              <BtnPrimary title={'انضم إلى «' + (inv.doc.orgName || 'منشأة عقاري') + '»'} loading={busy}
                onPress={() => run(() => acceptInviteNow(db, inv.org, inv.doc), 'تعذّر الانضمام', 'قبول الدعوة')} />
            </View>
          ))}
          <Note>ترى في المنشأة ما تجيزه لك صلاحيتك وحدها.</Note>
          <View style={{ marginTop: 12 }}>
            <BtnGhost title="لا · أستعمل التطبيق لأملاكي" onPress={() => { declineInvites(db); bump(); }} />
          </View>
        </Shell>
      );
    }
    // بيانات على الجهاز لم تُربط بأي حساب (إصدار قديم) · لا تُعطى لحساب إلا بقراره، ولا تُمسح
    if (cloud.gate === 'unbound') {
      return (
        <Shell>
          <Note>على هذا الجهاز بيانات من إصدار سابق لم تُربط بأي حساب.</Note>
          <BtnPrimary title={'اربطها بحساب ' + email} loading={busy} onPress={() => run(() => bindUnboundToAccount(db), 'تعذّر الربط', 'الدخول')} />
          <View style={{ marginTop: 10 }}>
            <BtnGhost title="ليست لي · أبقِها على الجهاز وافتح بيانات حسابي" onPress={() => run(() => keepUnboundAside(db), 'تعذّر فتح الحساب', 'الدخول')} />
          </View>
        </Shell>
      );
    }
    if (active === cloud.user.uid) {
      const m = readMembership(db);
      if (m && profileIncomplete(m.profile)) {
        return (
          <Shell>
            <T size={TYPE.cardTitle} bold style={{ textAlign: 'center', marginBottom: 6 }}>أكمل بياناتك</T>
            <T size={TYPE.body} color={C.muted} style={{ textAlign: 'center', marginBottom: 12 }}>
              {'يطلبها صاحب «' + (getSyncState(db, 'org_name') || 'المنشأة') + '» · الاسم والجوال إلزاميان'}
            </T>
            {!cloud.online ? <Note>حفظ بياناتك يحتاج اتصالاً بالإنترنت.</Note> : null}
            <MyProfileForm submitTitle="حفظ والمتابعة" />
          </Shell>
        );
      }
      return <>{children}</>;
    }
    return spinner();
  }

  const legal = legalUrls();
  return (
    <Shell>
      {cloud.online ? (
        <BtnPrimary icon="lock" title="الدخول بحساب قوقل" loading={busy}
          onPress={() => run(() => cloudSignIn(), 'تعذّر الدخول', 'الدخول')} />
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
