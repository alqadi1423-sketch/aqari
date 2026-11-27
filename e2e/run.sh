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
# ق٠-٨ · لا اتصال بقوقل (الشرط ١٣): المحاكي يسجّل حركته (-tcpdump في android-e2e.yml) ويفحصها scripts/ci/noGoogle.js ·
# فحص الاتصال في أندرويد نفسه يذهب إلى قوقل فيُطفأ، وDNS مكشوفٌ ليُقرأ، ثم سؤالٌ عن اسم العلامة يفتح نافذة الحكم: ما قبله إقلاع
# النظام، وما بعده التطبيق · والاسم نفسه MARKER في noGoogle.js
adb shell settings put global captive_portal_mode 0 || true
adb shell settings put global captive_portal_detection_enabled 0 || true
adb shell settings put global private_dns_mode off || true
# وWi-Fi يُطفأ فتخرج الحركة كلها من بيانات الجوال: -tcpdump يسجّل واجهة المحاكي في QEMU (eth0 · 10.0.2.15) وحدها، وWi-Fi في
# المحاكي ٣٧ يمرّ بـnetsim خارجها · فكان التسجيل ٤٧ و٩٨ حزمة بثٍّ متعدد بلا سؤال DNS واحد، وغابت العلامة في كل تشغيل منذ ق٠-٨
# (45732971915 و45815501062) · وعلامة الختام بعد التدفقات تثبت أن الحركة بقيت في التسجيل إلى آخرها (noGoogle.js END_MARKER)
adb shell svc wifi disable || true
adb shell cmd wifi set-wifi-enabled disabled >/dev/null 2>&1 || true
adb shell svc data enable || true
for _ in $(seq 30); do adb shell cmd wifi status 2>/dev/null | grep -qi "wifi is disabled" && break; sleep 2; done
sleep 3
# العلامة تحتاج شبكةً قائمة (بلا شبكة لا يخرج سؤال DNS فتغيب العلامة ويفشل الفحص): انتظارٌ حتى دقيقة لشبكةٍ افتراضية ·
# وحال الشبكة عند كل علامة في net.txt لقراءة الفشل
has_network() { adb shell dumpsys connectivity 2>/dev/null | grep -q "Active default network: [0-9]"; }
# بيانات الجوال لا تقوم أحياناً بعد إطفاء Wi-Fi («Active default network: none» على main في التشغيل 45865769363، والتسجيل حزمتان)،
# فلا علامة ولا حكم · بعد دقيقةٍ بلا شبكة تُعاد البيانات، ثم وضع الطيران إن لزم، ويُكتب ذلك في net.txt
ensure_network() {
  local i
  for i in $(seq "${NET_WAIT:-30}"); do has_network && return 0; sleep "${NET_SLEEP:-2}"; done
  echo "-- no default network: restarting mobile data" >> "$OUT/net.txt"
  adb shell svc data disable >/dev/null 2>&1 || true; sleep "${NET_SLEEP:-2}"; adb shell svc data enable >/dev/null 2>&1 || true
  for i in $(seq "${NET_WAIT:-30}"); do has_network && return 0; sleep "${NET_SLEEP:-2}"; done
  echo "-- still none: toggling airplane mode" >> "$OUT/net.txt"
  adb shell cmd connectivity airplane-mode enable >/dev/null 2>&1 || true; sleep "${NET_SLEEP:-2}"
  adb shell cmd connectivity airplane-mode disable >/dev/null 2>&1 || true
  adb shell svc wifi disable >/dev/null 2>&1 || true
  adb shell svc data enable >/dev/null 2>&1 || true
  for i in $(seq "${NET_WAIT:-30}"); do has_network && return 0; sleep "${NET_SLEEP:-2}"; done
  return 1
}
mark() {
  ensure_network || true
  { echo "== $1"; adb shell cmd wifi status 2>&1 | head -3
    adb shell dumpsys connectivity 2>&1 | grep -E "Active default network|^  NetworkAgentInfo" | cut -c1-300 | head -8; } >> "$OUT/net.txt"
  for _ in 1 2 3; do adb shell ping -c 1 -W 2 "$1" >/dev/null 2>&1 || true; sleep 1; done
}
mark aqari-e2e-window.example.com
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
# أندرويد لم يُقلع التطبيق في التدفق (من سطر السجل $1): على af84ee5 بقي ١٠ أ على شاشة البداية حتى المهلة بهذا السطر وحده،
# وهو عطل المحاكي تحت الحمل لا التطبيق (نجح التدفق نفسه قبله) · يُعاد التدفق مرةً كغياب الجهاز
attach_failed() {
  tail -n +"$1" "$OUT/logcat.txt" 2>/dev/null | grep -qE 'ProcessRecord\{[^}]* [0-9]+:com\.aqari\.app/[^}]*\} failed to attach'
}
# التدفقات (yaml) وخطوات الجهاز (sh: أوامر adb كقتل العملية وضغط الذاكرة وفحص النافذة) بترتيب أسمائها معاً
for f in $(ls e2e/maestro/[0-9]*.yaml e2e/maestro/[0-9]*.sh 2>/dev/null | LC_ALL=C sort); do
  name="$(basename "$f")"; name="${name%.*}"
  start=$(date +%s)
  adb shell am broadcast -a android.intent.action.CLOSE_SYSTEM_DIALOGS >/dev/null 2>&1 || true
  if [[ "$f" == *.sh ]]; then run=(bash "$f" "$OUT"); else
    run=(maestro test "$f" --format junit --output "$OUT/flows/$name.xml" --test-output-dir "$OUT/shots/$name"); fi
  ensure_device || echo "$name: no device before run" >> "$OUT/flows/$name.log"
  note=""
  from=$(( $(wc -l < "$OUT/logcat.txt" 2>/dev/null || echo 0) + 1 ))
  ok=0; "${run[@]}" > "$OUT/flows/$name.log" 2>&1 && ok=1
  if [ $ok = 0 ] && no_device "$OUT/flows/$name.log"; then
    note=" (retried: device lost)"
    pgrep -f "adb logcat" >/dev/null || (adb logcat -v time '*:W' ReactNativeJS:V >> "$OUT/logcat.txt" 2>&1 &)
    ensure_device && "${run[@]}" > "$OUT/flows/$name.log" 2>&1 && ok=1
  elif [ $ok = 0 ] && attach_failed "$from"; then
    note=" (retried: app failed to attach)"
    cp "$OUT/flows/$name.log" "$OUT/flows/$name.attach-failed.log" 2>/dev/null || true
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
# علامة الختام: غيابها في التسجيل يعني أن حركة الجوال خرجت منه أثناء التدفقات (Wi-Fi عاد، أو انقطع)، فلا يُعدّ نظيفاً
ensure_device >/dev/null 2>&1 || true
mark aqari-e2e-window-end.example.com
adb shell dumpsys meminfo com.aqari.app > "$OUT/meminfo.txt" 2>&1 || true
pkill -f "adb logcat" || true
exit $rc
