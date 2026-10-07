#!/bin/bash
# فحص الحزمة التجريبية: لا شيء من مشروع المالك فيها (معرّفه ومفتاحه وعميل دخوله ورقمه) · واسمها وحزمتها
# الاستعمال: bash scripts/check-chat-test-apk.sh [مسار الحزمة]
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APK=${1:-$ROOT/android/app/build/outputs/apk/release/app-release.apk}
TEST_ENV=${CHAT_TEST_ENV:-/d/keys/aqari-chat/test.env}
OWNER_ENV=${OWNER_ENV:-$ROOT/.env.local}
ANDROID_HOME=${ANDROID_HOME:-D:/android-tools/sdk}
LEAK=0
for k in EXPO_PUBLIC_FIREBASE_PROJECT_ID EXPO_PUBLIC_FIREBASE_API_KEY EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET; do
  v=$(grep -E "^$k=" "$OWNER_ENV" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '\r')
  [ -z "$v" ] && continue
  n=$(unzip -p "$APK" | grep -a -c -F "$v")
  if [ "$n" != "0" ]; then echo "تسرّب: $k من مشروع المالك موجود في الحزمة"; LEAK=1; else echo "نظيف: $k من مشروع المالك غائب عن الحزمة"; fi
done
OWNER_NUM=$(grep -E "^OWNER_PROJECT_NUMBER=" "$TEST_ENV" | cut -d= -f2- | tr -d '\r')
if [ -n "$OWNER_NUM" ]; then
  n=$(unzip -p "$APK" | grep -a -c -F "$OWNER_NUM")
  if [ "$n" != "0" ]; then echo "تسرّب: رقم مشروع المالك"; LEAK=1; else echo "نظيف: رقم مشروع المالك غائب"; fi
fi
echo "المشروع التجريبي في الحزمة: $(unzip -p "$APK" | grep -a -c -F 'aqari-chat-test') موضع"
aapt=$(ls -d "$ANDROID_HOME"/build-tools/*/aapt.exe 2>/dev/null | tail -1)
[ -n "$aapt" ] && "$aapt" dump badging "$APK" 2>/dev/null | grep -E "^package:|^application-label:" | cut -c1-120
exit $LEAK
