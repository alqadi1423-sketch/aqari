#!/bin/bash
# الحزمة التجريبية للمحادثة (قرار المالك 2026-10-07) · مشروع Firebase تجريبي منفصل وحده:
#  - اسم حزمة مختلف com.aqari.app.chat واسم ظاهر «عقاري · تجريبي» فتُثبَّت بجانب حزمة المالك ولا تمسّها
#  - ملف البيئة المحلي (.env.local بمشروع المالك) لا يُقرأ أبداً (EXPO_NO_DOTENV)
#  - gradle لا يمرّر متغيرات البيئة إلى خطوة حزمة JavaScript، فتُبنى الحزمة هنا بقيم المشروع التجريبي وتُترجم
#    بـ Hermes وتُستبدل في الحزمة وتُوقَّع بالمفتاح نفسه (كلمتا السر من متغيرات البيئة ولا تُطبعان)
#  - بعد البناء فحصٌ يسقط إن وُجد في الحزمة شيء من مشروع المالك (scripts/check-chat-test-apk.sh)
# الاستعمال: bash scripts/build-chat-test.sh <arm64-v8a|x86_64> <اسم السجل>
ARCH=${1:-arm64-v8a}
LOG=${BUILD_LOG_DIR:-D:/android-tools/tmp/audit}/${2:-chat-test}.log
TEST_ENV=${CHAT_TEST_ENV:-/d/keys/aqari-chat/test.env}
SIGNING_ENV=${SIGNING_ENV:-/d/keys/aqari/signing.env}
OUT=${CHAT_TEST_OUT:-D:/android-tools/tmp/chat-test/AqariChatTest.apk}
[ -f "$TEST_ENV" ] || { echo "لا ملف بيئة تجريبي: $TEST_ENV"; exit 1; }
set -a; . "$SIGNING_ENV"; . "$TEST_ENV"; set +a
export EXPO_NO_DOTENV=1
export JAVA_HOME=${JAVA_HOME:-D:/android-tools/jdk-21.0.12+8}
export ANDROID_HOME=${ANDROID_HOME:-D:/android-tools/sdk}
export ANDROID_SDK_ROOT=$ANDROID_HOME
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BT=$(ls -d "$ANDROID_HOME"/build-tools/*/ | tail -1)
W=$(dirname "$OUT")/work
# الشيفرة الأصلية التجريبية في مسار خاص بها · لا يُعاد استعمال مخرَج بناء المالك (مراجعة المحادثة #4)
NATIVE=$(dirname "$OUT")/native-$ARCH.apk
rm -rf "$W"; mkdir -p "$W/assets"

# ١) الشيفرة الأصلية باسم الحزمة التجريبي · SKIP_GRADLE=1 يعيد استعمال آخر بناء لها
cd "$ROOT/android" || exit 1
if [ "$SKIP_GRADLE" != "1" ]; then
./gradlew assembleRelease -PreactNativeArchitectures=$ARCH \
  -PaqariAppId=com.aqari.app.chat "-PaqariAppLabel=عقاري · تجريبي" --max-workers=1 \
  "-Dorg.gradle.jvmargs=-Xmx2g -XX:MaxMetaspaceSize=768m -XX:+UseSerialGC" -Dorg.gradle.parallel=false \
  -Pkotlin.compiler.execution.strategy=in-process > "$LOG" 2>&1
rc=$?
grep -E "BUILD SUCCESSFUL|BUILD FAILED" "$LOG"
[ $rc -eq 0 ] || exit $rc
./gradlew --stop >/dev/null 2>&1
cp app/build/outputs/apk/release/app-release.apk "$NATIVE" || exit 1
# مسار مخرَج بناء المالك لا تبقى فيه حزمة تجريبية تُلتقط خطأً
rm -f app/build/outputs/apk/release/app-release.apk
fi
# لا تُستعمل شيفرة أصلية إلا باسم الحزمة التجريبي
AAPT=$(ls -d "$ANDROID_HOME"/build-tools/*/aapt.exe 2>/dev/null | tail -1)
[ -f "$NATIVE" ] || { echo "لا شيفرة أصلية تجريبية: ابنِ بلا SKIP_GRADLE"; exit 1; }
"$AAPT" dump badging "$NATIVE" 2>/dev/null | grep -q "^package: name='com.aqari.app.chat'" || { echo "سقط: الشيفرة الأصلية ليست باسم الحزمة التجريبي"; exit 1; }

# ٢) حزمة JavaScript بقيم المشروع التجريبي وحدها
cd "$ROOT" || exit 1
# --reset-cache: ذاكرة metro لا تحفظ قيم البيئة في مفتاحها، فبدونه تعود قيم بناء سابق
npx expo export:embed --platform android --dev false --minify true --reset-cache \
  --entry-file node_modules/expo-router/entry.js \
  --bundle-output "$W/assets/index.android.bundle" --assets-dest "$W/res" >> "$LOG" 2>&1 || { echo "تعذّرت حزمة JavaScript"; exit 1; }
HERMESC=$(ls -d node_modules/hermes-compiler/hermesc/win64-bin/hermesc.exe node_modules/react-native/sdks/hermesc/win64-bin/hermesc.exe 2>/dev/null | head -1)
"$HERMESC" -emit-binary -O -out "$W/assets/b.hbc" "$W/assets/index.android.bundle" >> "$LOG" 2>&1 || { echo "تعذّرت ترجمة Hermes"; exit 1; }
mv "$W/assets/b.hbc" "$W/assets/index.android.bundle"

# ٣) الاستبدال والمحاذاة والتوقيع
cp "$NATIVE" "$W/u.apk"
(cd "$W" && "$JAVA_HOME/bin/jar.exe" -u -0 -M -f u.apk assets/index.android.bundle) || exit 1
"$BT/zipalign.exe" -f -p 4 "$W/u.apk" "$W/a.apk" || exit 1
"$JAVA_HOME/bin/java.exe" -jar "$BT/lib/apksigner.jar" sign --ks "$AQARI_UPLOAD_STORE_FILE" --ks-key-alias "$AQARI_UPLOAD_KEY_ALIAS" \
  --ks-pass env:AQARI_UPLOAD_STORE_PASSWORD --key-pass env:AQARI_UPLOAD_KEY_PASSWORD --out "$OUT" "$W/a.apk" || exit 1
echo "الحزمة: $OUT ($(stat -c %s "$OUT"))"

# ٤) الفحص
bash "$ROOT/scripts/check-chat-test-apk.sh" "$OUT"
