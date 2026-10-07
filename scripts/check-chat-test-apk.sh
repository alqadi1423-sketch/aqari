#!/bin/bash
# فحص الحزمة التجريبية · يسقط (رمز خروج غير الصفر) في أي من هذه:
#  - شيء من مشروع المالك فيها: معرّفه أو مفتاحه أو عميل دخوله أو مخزنه أو رقمه
#  - لم يُقارَن شيء (ملف بيئة المالك غائب أو فارغ) · فلا ينجح الفحص صامتاً
#  - اسم الحزمة غير com.aqari.app.chat · فلا تُثبَّت فوق تطبيق المالك
#  - المشروع التجريبي غائب عنها · فلا تُرسل حزمة بلا ربط
# قيم مشروع المالك تُقرأ من ملف بيئته للمقارنة وحدها ولا تُطبع
# الاستعمال: bash scripts/check-chat-test-apk.sh [مسار الحزمة]
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APK=${1:-D:/android-tools/tmp/chat-test/AqariChatTest.apk}
TEST_ENV=${CHAT_TEST_ENV:-/d/keys/aqari-chat/test.env}
OWNER_ENV=${OWNER_ENV:-$ROOT/.env.local}
ANDROID_HOME=${ANDROID_HOME:-D:/android-tools/sdk}
FAIL=0
[ -f "$APK" ] || { echo "لا حزمة: $APK"; exit 1; }
[ -f "$OWNER_ENV" ] || { echo "سقط: ملف بيئة المالك غائب فلا مقارنة"; exit 1; }
COMPARED=0
for k in EXPO_PUBLIC_FIREBASE_PROJECT_ID EXPO_PUBLIC_FIREBASE_API_KEY EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET; do
  v=$(grep -E "^$k=" "$OWNER_ENV" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '\r')
  [ -z "$v" ] && continue
  COMPARED=$((COMPARED + 1))
  n=$(unzip -p "$APK" | grep -a -c -F "$v")
  if [ "$n" != "0" ]; then echo "تسرّب: $k من مشروع المالك موجود في الحزمة"; FAIL=1; else echo "نظيف: $k من مشروع المالك غائب عن الحزمة"; fi
done
OWNER_NUM=$(grep -E "^OWNER_PROJECT_NUMBER=" "$TEST_ENV" | cut -d= -f2- | tr -d '\r')
if [ -n "$OWNER_NUM" ]; then
  COMPARED=$((COMPARED + 1))
  n=$(unzip -p "$APK" | grep -a -c -F "$OWNER_NUM")
  if [ "$n" != "0" ]; then echo "تسرّب: رقم مشروع المالك"; FAIL=1; else echo "نظيف: رقم مشروع المالك غائب"; fi
fi
[ $COMPARED -ge 3 ] || { echo "سقط: قورن $COMPARED فقط من قيم مشروع المالك"; FAIL=1; }
TEST_PID=$(grep -E "^EXPO_PUBLIC_FIREBASE_PROJECT_ID=" "$TEST_ENV" | cut -d= -f2- | tr -d '\r')
[ -n "$TEST_PID" ] || { echo "سقط: ملف البيئة التجريبي بلا معرّف مشروع"; exit 1; }
n=$(unzip -p "$APK" | grep -a -c -F "$TEST_PID")
if [ "$n" = "0" ]; then echo "سقط: المشروع التجريبي غائب عن الحزمة (هل فُعّل الدخول بقوقل فيه؟)"; FAIL=1; else echo "المشروع التجريبي في الحزمة: $TEST_PID"; fi
aapt=$(ls -d "$ANDROID_HOME"/build-tools/*/aapt.exe 2>/dev/null | tail -1)
PKG=$("$aapt" dump badging "$APK" 2>/dev/null | grep -o "^package: name='[^']*'" | cut -d"'" -f2)
LABEL=$("$aapt" dump badging "$APK" 2>/dev/null | grep -o "^application-label:'[^']*'" | cut -d"'" -f2)
echo "الحزمة: $PKG · الاسم: $LABEL"
[ "$PKG" = "com.aqari.app.chat" ] || { echo "سقط: اسم الحزمة ليس com.aqari.app.chat"; FAIL=1; }
exit $FAIL
