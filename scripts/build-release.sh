#!/bin/bash
# بناء حزمة الإصدار الموقّعة من D:/Aqari · لا يطبع كلمات السر ولا يحملها: تُقرأ من ملف البيئة خارج المستودع
# الاستعمال: bash scripts/build-release.sh <arm64-v8a|x86_64> <اسم السجل>
#   arm64-v8a للمالك · x86_64 للتحقق على المحاكي وحده ولا تُرسل للمالك
# بعده: (cd android && ./gradlew --stop) · ولا يعمل المحاكي والبناء معاً (ذاكرة الجهاز ٨ غ.ب)
ARCH=${1:-arm64-v8a}
LOG=${BUILD_LOG_DIR:-D:/android-tools/tmp/audit}/${2:-build}.log
SIGNING_ENV=${SIGNING_ENV:-/d/keys/aqari/signing.env}
set -a; . "$SIGNING_ENV"; set +a
export JAVA_HOME=${JAVA_HOME:-D:/android-tools/jdk-21.0.12+8}
export ANDROID_HOME=${ANDROID_HOME:-D:/android-tools/sdk}
export ANDROID_SDK_ROOT=$ANDROID_HOME
cd "$(dirname "$0")/../android" || exit 1
./gradlew :app:createBundleReleaseJsAndAssets --rerun assembleRelease -PreactNativeArchitectures=$ARCH --max-workers=1 \
  "-Dorg.gradle.jvmargs=-Xmx2g -XX:MaxMetaspaceSize=768m -XX:+UseSerialGC" -Dorg.gradle.parallel=false \
  -Pkotlin.compiler.execution.strategy=in-process > "$LOG" 2>&1
rc=$?
echo "rc=$rc"
grep -E "BUILD SUCCESSFUL|BUILD FAILED" "$LOG"
ls -l app/build/outputs/apk/release/app-release.apk | awk '{print $5}'
exit $rc
