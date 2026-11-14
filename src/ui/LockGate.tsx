/**
 * قفل التطبيق (#51 · قرار المالك 2026-10-07 «أ»): غطاءٌ فوق التطبيق عند التشغيل وعند العودة من الخلفية بعد مهلته ·
 * التطبيق تحته حيٌّ كما هو (لا يُعاد تركيبه فلا يبطؤ الرجوع) ومخفيٌّ عن قارئ الشاشة ما دام مقفلاً.
 * بقفل الجهاز (البصمة أو الوجه أو رمز الجهاز) أو برمز التطبيق · وإعدادٌ تعذّرت قراءته والقفل مُعلَّم: قفل الجهاز، فإن لم يكن
 * للجهاز قفل فتأكيد الحساب بقوقل.
 * المتحقق المستقل (الجولة الخامسة): الغطاء يظهر فور الخروج إلى الخلفية فلا يُرى المحتوى عند العودة ولا في صورة التطبيقات
 * الأخيرة ما أمكن · والقرار عند العودة فوري بآخر إعداد (لا بعد قراءةٍ غير متزامنة) وبساعتين · والنوافذ المنبثقة تختفي
 * ما دام مقفلاً (ui/lockState.ts) · والخروج أثناء نافذة البصمة أو قوقل لا يُلغي القفل · ومنتقي الملفات والكاميرا
 * والمشاركة والطباعة نوافذ يفتحها التطبيق وينتظرها فتُعامل معاملتها (whilePrompting)
 * المراجعة الشاملة · البند ٥: «نسيت الرمز» خروجٌ من قوقل ثم دخولٌ جديد يُفحص رمز هويته، بحدٍّ لإعادات الضبط وسطرٍ في سجل
 * العمليات وتنبيهٍ عند الفتح التالي (services/appLockService.ts: recoverByAccount · domain/lockReset.ts) · و«تأكيد حسابي» حين لا
 * قفل للجهاز المسارُ نفسه ثم رمزٌ للتطبيق (المتحقق المستقل: كان يفتح بلا حدٍّ ولا سجل، وهو شرط العيب نفسه) · والزر لا يظهر
 * ما لم يجز: بلغ الحدّ، أو لا حساب على الجهاز، أو تعذّرت قراءة السجل
 * ق٠-٦ · F-3: التأكيد من مزوّد الهوية أياً كان (قوقل اليوم، وشهادة الخادم أنه الجوال المربوط بعد التحويل) بالحدّ والسجل نفسيهما ·
 * وللمالك طريقٌ ثانٍ يعمل الآن على الجهاز وحده: مفتاح الاسترداد (services/lockRecovery.ts)، فلا يُحبس إن أُزيل قوقل
 */
import React, { useEffect, useRef, useState } from 'react';
import { AppState, View } from 'react-native';
import { useLang } from '../i18n';
import { T, BtnPrimary, BtnGhost, Field, Note } from './components';
import { isValidRecoveryKey } from '../domain/backup/recoveryKey';
import { C, TYPE } from './theme';
import { decideReturn, pinShapeOk, type Away, type LockConfig } from '../domain/appLock';
import {
  lockMaybeOn, loadLock, askDevice, deviceLockAvailable, tryPin, promptActive, whilePrompting, onLockChange, monoNow, clockTrusted, enablePinLock,
  recoverByAccount, recoverByKey, resetStatus, resetNotices, type ResetStatus, type Recovery } from '../services/appLockService';
import { confirmSameAccount, accountConfirmable, accountProvider, subscribeCloud } from '../services/cloud';
import { keyResetOffered, checkRecoveryKey } from '../services/lockRecovery';
import { logLockReset, resetWhen, type ResetVia } from '../domain/lockReset';
import { appDb } from '../db/expoAdapter';
import { showDialog } from './AppDialog';
import { setAppLocked } from './lockState';

type Gate = 'open' | 'checking' | 'locked';

/** سطر إعادة الضبط في سجل العمليات · تعذّر القاعدة يُعاد عند الفتح التالي */
const auditReset = (at: number, via: ResetVia) => logLockReset(appDb(), at, via);
/** نصّ التنبيه لكل طريق */
const NOTICE: Record<ResetVia, string> = { google: 'lock.resetNotice', device: 'lock.resetNoticeDevice', key: 'lock.resetNoticeKey' };

export function LockGate({ children }: { children: React.ReactNode }) {
  const { t } = useLang();
  const [gate, setGate] = useState<Gate>(() => (lockMaybeOn() ? 'checking' : 'open'));
  const [cover, setCover] = useState(false);
  const [cfg, setCfg] = useState<LockConfig | null>(null);
  // آخر إعداد معروف · يُقرأ عند العودة بلا انتظار
  const cfgRef = useRef<LockConfig | null>(null);
  const away = useRef<Away | null>(null);
  // الفتح الذي يلي إعادة الضبط نفسها لا يُنبَّه فيه · والتنبيه عند الفتح التالي حتى يُقرّ به · وسطر السجل المتعذّر يُكتب
  const [notices] = useState(() => resetNotices(auditReset));

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

  useEffect(() => {
    if (gate !== 'open') return;
    notices.opened((at, ack, via) => showDialog({
      title: t('lock.resetNoticeTitle'), body: t(NOTICE[via], { when: resetWhen(at) }), tone: 'danger', locked: true,
      actions: [{ label: t('common.ok'), variant: 'primary', onPress: ack }],
    })).catch(() => undefined);
  }, [gate]); // eslint-disable-line react-hooks/exhaustive-deps

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
          {gate === 'locked' && cfg ? <LockScreen cfg={cfg} onOpen={() => setGate('open')} onRecovered={notices.recovered} /> : null}
        </View>
      ) : null}
    </View>
  );
}

function LockScreen({ cfg, onOpen, onRecovered }: { cfg: LockConfig; onOpen: () => void; onRecovered: () => void }) {
  const { t } = useLang();
  const [pin, setPin] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [device, setDevice] = useState<boolean | null>(null);
  // «نسيت الرمز»: بعد تأكيد الحساب بقوقل رمزٌ جديد قبل الفتح (قرار المالك 2026-10-15 «٢»: «التحقق بقوقل ثم رمز جديد»)
  const [resetting, setResetting] = useState(false);
  const [pin1, setPin1] = useState('');
  const [pin2, setPin2] = useState('');
  // حدّ إعادة الضبط وتنبيه ما سبق منها · والحساب الذي تُؤكَّد به · الزر لا يظهر حتى يُعرف أنه جائز ويُعاد حسابه بعد كل محاولة
  const [status, setStatus] = useState<ResetStatus | null>(null);
  const [account, setAccount] = useState(accountConfirmable);
  const [provider, setProvider] = useState(accountProvider);
  // مفتاح الاسترداد للمالك (ق٠-٦ · F-3): يُعرض حين يُعرف أن للحساب مفتاحاً وأنه ليس عضواً
  const [keyOffer, setKeyOffer] = useState(false);
  const [keyMode, setKeyMode] = useState(false);
  const [typedKey, setTypedKey] = useState('');
  const refreshStatus = () => { resetStatus().then(setStatus).catch(() => setStatus({ waitMs: null, notice: null })); };
  useEffect(() => {
    refreshStatus();
    keyResetOffered().then(setKeyOffer).catch(() => setKeyOffer(false));
    return subscribeCloud(() => { setAccount(accountConfirmable()); setProvider(accountProvider()); });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const viaAccount: Exclude<ResetVia, 'key'> = provider === 'device' ? 'device' : 'google';
  const failMsg = (why: Exclude<Recovery, { ok: true }>['why']): string | null =>
    why === 'cancel' || why === 'device' || why === 'limit' ? null : why === 'mismatch' ? t('lock.accountMismatch')
      : why === 'store' ? t('lock.resetStoreFailed') : why === 'revoked' ? t('lock.deviceRevoked')
        : why === 'wrongKey' ? t('lock.recoveryKeyWrong') : t('lock.accountFailed');

  const unlockDevice = async () => {
    setMsg(null);
    if (await askDevice()) onOpen();
  };
  // «نسيت الرمز» و«تأكيد حسابي» (لا قفل للجهاز): تأكيد الحساب بالحدّ والسجل ثم رمزٌ جديد قبل الفتح
  // (قرار المالك 2026-10-15 «٢»: «التحقق بقوقل ثم رمز جديد»)
  const forgotPin = async () => {
    setMsg(null);
    let r: Recovery;
    try { r = await recoverByAccount(() => whilePrompting(confirmSameAccount), auditReset, viaAccount); } catch { r = { ok: false, why: 'error' }; }
    afterRecovery(r);
  };
  const afterRecovery = (r: Recovery) => {
    if (r.ok) { onRecovered(); setKeyMode(false); setTypedKey(''); setResetting(true); return; }
    if (r.why === 'limit' && r.waitMs) { const waitMs = r.waitMs; setStatus((st) => ({ waitMs, notice: st?.notice ?? null })); }
    else refreshStatus();
    setMsg(failMsg(r.why));
  };
  // «نسيت الرمز» بمفتاح الاسترداد: بالحدّ والسجل والتنبيه نفسها ثم رمزٌ جديد
  const submitKey = async () => {
    setMsg(null);
    setBusy(true);
    let r: Recovery;
    try { r = await recoverByKey(() => checkRecoveryKey(typedKey), auditReset); } catch { r = { ok: false, why: 'error' }; }
    finally { setBusy(false); }
    afterRecovery(r);
  };
  const saveNewPin = async () => {
    setBusy(true);
    try { await enablePinLock(pin1, cfg.delay); setPin1(''); setPin2(''); onOpen(); }
    // بلا قفل للجهاز وإعدادٌ تعذّر حفظه (المخزن الآمن معطوب): الحساب أُكِّد وحُسب وسُجِّل فيُفتح ولا يُحبس صاحبه
    catch { if (cfg.method === 'device') onOpen(); else setMsg(t('lock.newPinFailed')); }
    finally { setBusy(false); }
  };

  // قفل الجهاز · ويُعاد فحصه عند العودة إلى التطبيق: من أضاف قفلاً للجهاز يفتح به
  const deviceRef = useRef<boolean | null>(null);
  useEffect(() => {
    if (cfg.method !== 'device') return;
    const check = () => deviceLockAvailable().then((ok) => {
      const was = deviceRef.current;
      deviceRef.current = ok;
      setDevice(ok);
      if (ok && was !== true) unlockDevice();
    });
    check();
    const sub = AppState.addEventListener('change', (s) => { if (s === 'active' && deviceRef.current === false) check(); });
    return () => sub.remove();
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

  // ما يُعرض مكان زرّ إعادة الضبط: الزر إن جاز · وكم بقي إن بلغ الحدّ · وسبب تعذّر السجل · ولا شيء بلا حساب ولا مفتاح
  const offer = !status || resetting ? null : status.waitMs === null ? 'store' : status.waitMs > 0 ? 'wait' : account || keyOffer ? 'offer' : null;
  const offerNote = offer === 'store' ? <Note tone="danger">{t('lock.resetStoreFailed')}</Note>
    : offer === 'wait' ? <Note>{t('lock.resetLimit', { n: Math.ceil((status?.waitMs ?? 0) / 3_600_000) })}</Note> : null;
  const keyButton = offer === 'offer' && keyOffer ? <BtnGhost title={t('lock.forgotPinKey')} onPress={() => { setMsg(null); setKeyMode(true); }} /> : null;
  const accountTitle = (forgot: boolean) => t(forgot ? (viaAccount === 'device' ? 'lock.forgotPinDevice' : 'lock.forgotPin') : (viaAccount === 'device' ? 'lock.confirmDevice' : 'lock.confirmAccount'));
  const noLockNote = viaAccount === 'device' || (!account && keyOffer) ? t('lock.noDeviceLockAny') : t('lock.noDeviceLock');

  return (
    <View style={{ flex: 1, justifyContent: 'center', padding: 24, gap: 14 }}>
      <T size={TYPE.screenTitle} bold center>{t('lock.title')}</T>
      {keyMode && !resetting && offer === 'offer' ? (
        <>
          <Note>{t('lock.recoveryKeyHint')}</Note>
          <Field label={t('lock.recoveryKeyLabel')} value={typedKey} onChange={(v) => setTypedKey(v.slice(0, 40))} ltr />
          <BtnPrimary title={t('lock.useRecoveryKey')} loading={busy} disabled={!isValidRecoveryKey(typedKey)} onPress={submitKey} />
          <BtnGhost title={t('common.cancel')} onPress={() => { setKeyMode(false); setTypedKey(''); setMsg(null); }} />
        </>
      ) : resetting ? (
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
          <Note>{noLockNote}</Note>
          {offer === 'offer' ? (account ? <BtnPrimary title={accountTitle(false)} onPress={forgotPin} /> : null) : offerNote}
          {keyButton}
        </>
      ) : (
        <BtnPrimary title={t('lock.open')} onPress={unlockDevice} />
      )}
      {msg && !(offer === 'store' && msg === t('lock.resetStoreFailed')) ? <Note tone="danger">{msg}</Note> : null}
      {status?.notice && !resetting ? <Note tone="danger">{t(NOTICE[status.notice.via], { when: resetWhen(status.notice.at) })}</Note> : null}
      {cfg.method === 'pin' && !resetting && !keyMode ? (offer === 'offer' ? (account ? <BtnGhost title={accountTitle(true)} onPress={forgotPin} /> : null) : offerNote) : null}
      {cfg.method === 'pin' && !resetting && !keyMode ? keyButton : null}
    </View>
  );
}
