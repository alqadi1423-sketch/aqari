#!/bin/bash
# يُشغَّل داخل المحاكي (android-e2e.yml): تثبيت الحزمة، ثم كل تدفق وخطوة جهازٍ في e2e/maestro بترتيب اسمه، وسجل الجهاز ولقطاته في e2e-out ·
# فشل تدفقٍ لا يوقف ما بعده، والخلاصة تحسب كل تدفق (e2e/summary.js)
set -u
OUT="$PWD/e2e-out"
mkdir -p "$OUT/flows" "$OUT/shots"
adb wait-for-device
# ونوافذ «… isn't responding» من النظام (لا من التطبيق) لا تُعرض: كانت تغطي الشاشة فيسقط كل تدفق (الجوال الافتراضي على 7e3b492:
# «Pixel Launcher isn't responding» فوق الرئيسية في أحد عشر تدفقاً)
adb shell settings put global hide_error_dialogs 1 || true
adb install -r "$E2E_APK" > "$OUT/install.txt" 2>&1 || { echo "install-failed" > "$OUT/status.txt"; cat "$OUT/install.txt"; exit 1; }
adb logcat -c || true
(adb logcat -v time '*:W' ReactNativeJS:V > "$OUT/logcat.txt" 2>&1 &) 
rc=0
# الجهاز حاضر قبل كل تدفق: على 52f19cb سقط Maestro بعد التدفق الثاني فانقطع المحاكي عن adb، وسقطت التدفقات الباقية كلها في ثوانٍ
# بـ«0 devices connected» بلا تشغيل · يُعاد وصله، ويُعاد التدفق مرةً إن سقط لغياب الجهاز وحده (لا لعطلٍ فيه)، ويُكتب ذلك في الخلاصة
ensure_device() {
  for _ in 1 2 3; do
    [ "$(adb get-state 2>/dev/null)" = "device" ] && return 0
    adb reconnect >/dev/null 2>&1 || true
    adb kill-server >/dev/null 2>&1 || true
    adb start-server >/dev/null 2>&1 || true
    timeout 90 adb wait-for-device >/dev/null 2>&1 || true
  done
  [ "$(adb get-state 2>/dev/null)" = "device" ]
}
no_device() { grep -qE "0 devices connected|device offline|no devices/emulators found|device '.*' not found" "$1"; }
# التدفقات (yaml) وخطوات الجهاز (sh: أوامر adb كقتل العملية وضغط الذاكرة وفحص النافذة) بترتيب أسمائها معاً
for f in $(ls e2e/maestro/[0-9]*.yaml e2e/maestro/[0-9]*.sh 2>/dev/null | LC_ALL=C sort); do
  name="$(basename "$f")"; name="${name%.*}"
  start=$(date +%s)
  adb shell am broadcast -a android.intent.action.CLOSE_SYSTEM_DIALOGS >/dev/null 2>&1 || true
  if [[ "$f" == *.sh ]]; then run=(bash "$f" "$OUT"); else
    run=(maestro test "$f" --format junit --output "$OUT/flows/$name.xml" --test-output-dir "$OUT/shots/$name"); fi
  ensure_device || echo "$name: no device before run" >> "$OUT/flows/$name.log"
  note=""
  ok=0; "${run[@]}" > "$OUT/flows/$name.log" 2>&1 && ok=1
  if [ $ok = 0 ] && no_device "$OUT/flows/$name.log"; then
    note=" (retried: device lost)"
    pgrep -f "adb logcat" >/dev/null || (adb logcat -v time '*:W' ReactNativeJS:V >> "$OUT/logcat.txt" 2>&1 &)
    ensure_device && "${run[@]}" > "$OUT/flows/$name.log" 2>&1 && ok=1
  fi
  if [ $ok = 1 ]; then
    echo "$name pass $(( $(date +%s) - start ))s$note" >> "$OUT/status.txt"
  else
    echo "$name fail $(( $(date +%s) - start ))s$note" >> "$OUT/status.txt"
    rc=1
    adb exec-out screencap -p > "$OUT/shots/$name-failure.png" 2>/dev/null || true
  fi
done
adb shell dumpsys meminfo com.aqari.app > "$OUT/meminfo.txt" 2>&1 || true
pkill -f "adb logcat" || true
exit $rc
