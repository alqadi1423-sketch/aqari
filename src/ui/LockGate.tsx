/**
 * قفل التطبيق (#51 · قرار المالك 2026-10-07 «أ»): غطاءٌ فوق التطبيق عند التشغيل وعند العودة من الخلفية بعد مهلته ·
 * التطبيق تحته حيٌّ كما هو (لا يُعاد تركيبه فلا يبطؤ الرجوع) ومخفيٌّ عن قارئ الشاشة ما دام مقفلاً.
 * بقفل الجهاز (البصمة أو الوجه أو رمز الجهاز) أو برمز التطبيق · وإعدادٌ تعذّرت قراءته والقفل مُعلَّم: قفل الجهاز، فإن لم يكن
 * للجهاز قفل فتأكيد الحساب بقوقل.
 * المتحقق المستقل (الجولة الخامسة): الغطاء يظهر فور الخروج إلى الخلفية فلا يُرى المحتوى عند العودة ولا في صورة التطبيقات
 * الأخيرة ما أمكن · والقرار عند العودة فوري بآخر إعداد (لا بعد قراءةٍ غير متزامنة) وبساعتين · والنوافذ المنبثقة تختفي
 * ما دام مقفلاً (ui/lockState.ts) · والخروج أثناء نافذة البصمة أو قوقل لا يُلغي القفل · ومنتقي الملفات والكاميرا
 * والمشاركة والطباعة نوافذ يفتحها التطبيق وينتظرها فتُعامل معاملتها (whilePrompting)
 */
import React, { useEffect, useRef, useState } from 'react';
import { AppState, View } from 'react-native';
import { useLang } from '../i18n';
import { T, BtnPrimary, BtnGhost, Field, Note } from './components';
import { C, TYPE } from './theme';
import { decideReturn, pinShapeOk, type Away, type LockConfig } from '../domain/appLock';
import {
  lockMaybeOn, loadLock, askDevice, deviceLockAvailable, tryPin, promptActive, whilePrompting, onLockChange, monoNow, clockTrusted, enablePinLock } from '../services/appLockService';
import { confirmSameAccount } from '../services/cloud';
import { setAppLocked } from './lockState';

type Gate = 'open' | 'checking' | 'locked';

export function LockGate({ children }: { children: React.ReactNode }) {
  const [gate, setGate] = useState<Gate>(() => (lockMaybeOn() ? 'checking' : 'open'));
  const [cover, setCover] = useState(false);
  const [cfg, setCfg] = useState<LockConfig | null>(null);
  // آخر إعداد معروف · يُقرأ عند العودة بلا انتظار
  const cfgRef = useRef<LockConfig | null>(null);
  const away = useRef<Away | null>(null);

  useEffect(() => {
    const apply = (c: LockConfig) => { cfgRef.current = c; setCfg(c); };
    const off = onLockChange(apply);
    if (lockMaybeOn()) {
      loadLock()
        .then((c) => { apply(c); setGate((g) => (g === 'checking' ? (c.on ? 'locked' : 'open') : g)); })
        .catch(() => setGate('locked'));
    }
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') {
        const a = away.current;
        away.current = null;
        const flagged = lockMaybeOn();
        const back = a ? { ...a, trusted: a.trusted && clockTrusted() } : null;
        // النوافذ المنبثقة تُطوى الآن لا بعد الرسم (المتحقق، الجولة السابعة: كانت تظهر فوق القفل لحظة)
        if (decideReturn(cfgRef.current, flagged, back, Date.now(), monoNow())) { setAppLocked(true); setGate('locked'); }
        setCover(false);
        if (a && flagged) loadLock().then((c) => { apply(c); if (!c.on) setGate('open'); }).catch(() => undefined);
        return;
      }
      // خارجٌ (inactive في iOS قبل صورة التطبيقات الأخيرة، أو background): الغطاء الآن
      if (!lockMaybeOn()) return;
      setCover(true);
      if (s === 'background' && !away.current) away.current = { wall: Date.now(), mono: monoNow(), prompting: promptActive(), trusted: clockTrusted() };
    });
    return () => { off(); sub.remove(); };
  }, []);

  const locked = gate !== 'open';
  const hidden = locked || cover;
  // النوافذ المنبثقة تُطوى حين يُقفل فعلاً وحده: طيّها يمحو ما فيها، فلا تُطوى بكل خروجٍ قبل المهلة (المتحقق، الجولة السادسة)
  useEffect(() => { setAppLocked(locked); }, [locked]);
  return (
    <View style={{ flex: 1 }}>
      <View style={{ flex: 1 }} importantForAccessibility={hidden ? 'no-hide-descendants' : 'auto'} accessibilityElementsHidden={hidden}>
        {children}
      </View>
      {hidden ? (
        <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: C.paper, zIndex: 1000, elevation: 1000 }}>
          {gate === 'locked' && cfg ? <LockScreen cfg={cfg} onOpen={() => setGate('open')} /> : null}
        </View>
      ) : null}
    </View>
  );
}

function LockScreen({ cfg, onOpen }: { cfg: LockConfig; onOpen: () => void }) {
  const { t } = useLang();
  const [pin, setPin] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [device, setDevice] = useState<boolean | null>(null);
  // «نسيت الرمز»: بعد تأكيد الحساب بقوقل رمزٌ جديد قبل الفتح (قرار المالك 2026-10-15 «٢»: «التحقق بقوقل ثم رمز جديد»)
  const [resetting, setResetting] = useState(false);
  const [pin1, setPin1] = useState('');
  const [pin2, setPin2] = useState('');

  const unlockDevice = async () => {
    setMsg(null);
    if (await askDevice()) onOpen();
  };
  const unlockAccount = async () => {
    setMsg(null);
    try { if (await whilePrompting(confirmSameAccount)) onOpen(); else setMsg(t('lock.accountMismatch')); } catch { setMsg(t('lock.accountMismatch')); }
  };
  const forgotPin = async () => {
    setMsg(null);
    try { if (await whilePrompting(confirmSameAccount)) setResetting(true); else setMsg(t('lock.accountMismatch')); } catch { setMsg(t('lock.accountMismatch')); }
  };
  const saveNewPin = async () => {
    setBusy(true);
    try { await enablePinLock(pin1, cfg.delay); setPin1(''); setPin2(''); onOpen(); }
    catch { setMsg(t('lock.newPinFailed')); }
    finally { setBusy(false); }
  };

  useEffect(() => {
    if (cfg.method !== 'device') return;
    deviceLockAvailable().then((ok) => { setDevice(ok); if (ok) unlockDevice(); });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const submitPin = async () => {
    setBusy(true);
    try {
      const r = await tryPin(pin);
      setPin('');
      if (r === 'ok') onOpen();
      else if (r === 'wrong') setMsg(t('lock.wrongPin'));
      else setMsg(t('lock.wait', { n: Math.ceil(r / 1000) }));
    } finally { setBusy(false); }
  };

  return (
    <View style={{ flex: 1, justifyContent: 'center', padding: 24, gap: 14 }}>
      <T size={TYPE.screenTitle} bold center>{t('lock.title')}</T>
      {resetting ? (
        <>
          <Note>{t('lock.setNewPin')}</Note>
          <Field label={t('lock.newPin')} value={pin1} onChange={(v) => setPin1(v.replace(/[^0-9]/g, '').slice(0, 8))} keyboard="numeric" secure ltr />
          <Field label={t('lock.repeatPin')} value={pin2} onChange={(v) => setPin2(v.replace(/[^0-9]/g, '').slice(0, 8))} keyboard="numeric" secure ltr />
          <BtnPrimary title={t('lock.saveNewPin')} loading={busy} disabled={!pinShapeOk(pin1) || pin1 !== pin2} onPress={saveNewPin} />
        </>
      ) : cfg.method === 'pin' ? (
        <>
          <Field label={t('lock.pinLabel')} value={pin} onChange={(v) => setPin(v.replace(/[^0-9]/g, '').slice(0, 8))} keyboard="numeric" secure ltr />
          <BtnPrimary title={t('lock.open')} loading={busy} disabled={!pinShapeOk(pin)} onPress={submitPin} />
        </>
      ) : device === false ? (
        <>
          <Note>{t('lock.noDeviceLock')}</Note>
          <BtnPrimary title={t('lock.confirmAccount')} onPress={unlockAccount} />
        </>
      ) : (
        <BtnPrimary title={t('lock.open')} onPress={unlockDevice} />
      )}
      {msg ? <Note tone="danger">{msg}</Note> : null}
      {cfg.method === 'pin' && !resetting ? (
        <BtnGhost title={t('lock.forgotPin')} onPress={forgotPin} />
      ) : null}
    </View>
  );
}
