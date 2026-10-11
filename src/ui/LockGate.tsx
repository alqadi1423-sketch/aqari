/**
 * قفل التطبيق (#51 · قرار المالك 2026-10-07 «أ»): غطاءٌ فوق التطبيق عند التشغيل وعند العودة من الخلفية بعد مهلته ·
 * التطبيق تحته حيٌّ كما هو (لا يُعاد تركيبه فلا يبطؤ الرجوع) ومخفيٌّ عن قارئ الشاشة ما دام مقفلاً.
 * بقفل الجهاز (البصمة أو الوجه أو رمز الجهاز) أو برمز التطبيق · وإعدادٌ تعذّرت قراءته والقفل مُعلَّم: قفل الجهاز، فإن لم يكن
 * للجهاز قفل فتأكيد الحساب بقوقل.
 */
import React, { useEffect, useRef, useState } from 'react';
import { AppState, View } from 'react-native';
import { useLang } from '../i18n';
import { T, BtnPrimary, BtnGhost, Field, Note } from './components';
import { C, TYPE } from './theme';
import { lockOnReturn, pinShapeOk, type LockConfig } from '../domain/appLock';
import { lockMaybeOn, loadLock, askDevice, deviceLockAvailable, tryPin, promptActive, whilePrompting } from '../services/appLockService';
import { confirmSameAccount } from '../services/cloud';

type Gate = 'open' | 'checking' | 'locked';

export function LockGate({ children }: { children: React.ReactNode }) {
  const [gate, setGate] = useState<Gate>(() => (lockMaybeOn() ? 'checking' : 'open'));
  const [cfg, setCfg] = useState<LockConfig | null>(null);
  const bgAt = useRef<number | null>(null);

  useEffect(() => {
    if (gate !== 'checking') return;
    loadLock().then((c) => { setCfg(c); setGate(c.on ? 'locked' : 'open'); }).catch(() => setGate('locked'));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (promptActive()) { bgAt.current = null; return; }
      if (s === 'background') {
        if (bgAt.current === null) bgAt.current = Date.now();
      } else if (s === 'active') {
        const at = bgAt.current;
        bgAt.current = null;
        if (!lockMaybeOn()) return;
        loadLock().then((c) => { setCfg(c); if (lockOnReturn(c, at, Date.now())) setGate('locked'); }).catch(() => setGate('locked'));
      }
    });
    return () => sub.remove();
  }, []);

  const locked = gate !== 'open';
  return (
    <View style={{ flex: 1 }}>
      <View style={{ flex: 1 }} importantForAccessibility={locked ? 'no-hide-descendants' : 'auto'} accessibilityElementsHidden={locked}>
        {children}
      </View>
      {locked ? (
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

  const unlockDevice = async () => {
    setMsg(null);
    if (await askDevice()) onOpen();
  };
  const unlockAccount = async () => {
    setMsg(null);
    try { if (await whilePrompting(confirmSameAccount)) onOpen(); else setMsg(t('lock.accountMismatch')); } catch { setMsg(t('lock.accountMismatch')); }
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
      {cfg.method === 'pin' ? (
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
      {cfg.method === 'pin' ? (
        <BtnGhost title={t('lock.forgotPin')} onPress={unlockAccount} />
      ) : null}
    </View>
  );
}
