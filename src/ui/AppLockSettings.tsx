/**
 * إعداد قفل التطبيق (#51) في الإعدادات · التفعيل بقفل الجهاز يتطلب فتحه أولاً، وإلا فرمزٌ للتطبيق يُكتب مرتين ·
 * والإيقاف وتغيير المهلة بعد فتح القفل نفسه
 */
import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { useLang } from '../i18n';
import { BtnPrimary, BtnGhost, Field, Note } from './components';
import { Sheet } from './Sheet';
import { LOCK_DELAYS, pinShapeOk, type LockConfig, type LockDelay } from '../domain/appLock';
import { loadLock, deviceLockAvailable, askDevice, enableDeviceLock, enablePinLock, disableLock, setLockDelay, tryPin } from '../services/appLockService';
import { reportFailure } from './failureDialog';

export function useAppLockSetting(): { value: string; open: () => void; sheet: React.ReactNode } {
  const { t } = useLang();
  const [cfg, setCfg] = useState<LockConfig | null>(null);
  const [device, setDevice] = useState<boolean | null>(null);
  const [visible, setVisible] = useState(false);
  const [pin1, setPin1] = useState('');
  const [pin2, setPin2] = useState('');
  const [current, setCurrent] = useState('');
  const [msg, setMsg] = useState<string | null>(null);

  const refresh = () => { loadLock().then(setCfg).catch(() => {}); deviceLockAvailable().then(setDevice).catch(() => setDevice(false)); };
  useEffect(refresh, []);

  const delayLabel = (d: number) => (d === 0 ? t('lock.delayNow') : d === 60 ? t('lock.delayMinute') : t('lock.delayFive'));
  const value = !cfg?.on ? t('lock.off') : (cfg.method === 'pin' ? t('lock.byPin') : t('lock.byDevice')) + ' · ' + delayLabel(cfg.delay);

  /** يثبت صاحب الجهاز قبل إيقاف القفل أو تغييره */
  const proveOwner = async (): Promise<boolean> => {
    if (!cfg?.on) return true;
    if (cfg.method === 'device') return askDevice();
    const r = await tryPin(current);
    setCurrent('');
    if (r === 'ok') return true;
    setMsg(r === 'wrong' ? t('lock.wrongPin') : t('lock.wait', { n: Math.ceil(r / 1000) }));
    return false;
  };
  const run = async (fn: () => Promise<void>) => {
    setMsg(null);
    try { await fn(); refresh(); } catch (e) { await reportFailure({ title: t('lock.saveFailed'), e }); }
  };
  const delay: LockDelay = cfg?.on ? cfg.delay : 60;

  const sheet = (
    <Sheet visible={visible} onClose={() => setVisible(false)} title={t('lock.settingTitle')}>
      <Note>{t('lock.about')}</Note>
      {cfg?.on && cfg.method === 'pin' ? (
        <Field label={t('lock.currentPin')} value={current} onChange={(v) => setCurrent(v.replace(/[^0-9]/g, '').slice(0, 8))} keyboard="numeric" secure ltr />
      ) : null}
      {!cfg?.on && device ? (
        <BtnPrimary title={t('lock.enableDevice')} onPress={() => run(async () => {
          if (await askDevice()) { await enableDeviceLock(delay); setVisible(false); }
        })} />
      ) : null}
      {!cfg?.on && device === false ? (
        <>
          <Note>{t('lock.noDeviceLockSet')}</Note>
          <Field label={t('lock.newPin')} value={pin1} onChange={(v) => setPin1(v.replace(/[^0-9]/g, '').slice(0, 8))} keyboard="numeric" secure ltr />
          <Field label={t('lock.repeatPin')} value={pin2} onChange={(v) => setPin2(v.replace(/[^0-9]/g, '').slice(0, 8))} keyboard="numeric" secure ltr
            error={!!pin2 && pin2 !== pin1} />
          {pinShapeOk(pin1) && pin1 === pin2 ? (
            <BtnPrimary title={t('lock.enablePin')} onPress={() => run(async () => {
              await enablePinLock(pin1, delay); setPin1(''); setPin2(''); setVisible(false);
            })} />
          ) : null}
        </>
      ) : null}
      {cfg?.on ? (
        <>
          {LOCK_DELAYS.filter((d) => d !== cfg.delay).map((d) => (
            <View key={d} style={{ marginTop: 8 }}>
              <BtnGhost title={t('lock.setDelay', { delay: delayLabel(d) })} onPress={() => run(async () => {
                if (await proveOwner()) await setLockDelay(d);
              })} />
            </View>
          ))}
          <View style={{ marginTop: 8 }}>
            <BtnGhost danger title={t('lock.disable')} onPress={() => run(async () => {
              if (await proveOwner()) { await disableLock(); setVisible(false); }
            })} />
          </View>
        </>
      ) : null}
      {msg ? <Note tone="danger">{msg}</Note> : null}
    </Sheet>
  );
  return { value, open: () => { setMsg(null); setCurrent(''); refresh(); setVisible(true); }, sheet };
}
