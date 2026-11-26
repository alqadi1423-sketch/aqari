#!/bin/bash
# بناء Gradle بإعادةٍ لعطل الشبكة وحده (الجوال الافتراضي على d9609a0: «Plugin [id: 'org.gradle.toolchains.foojay-resolver-convention',
# version: '1.0.0'] was not found» من settings.gradle.kts في @react-native/gradle-plugin، والذاكرة فارغة، فسقط البناء في ٢١ ثانية وما
# بعده كله بلا تدفق · والالتزامات قبله وبعده بنت الحزمة نفسها).
# يُشغَّل من مجلد android بمعاملات gradlew نفسها · يُعاد البناء حتى ثلاث مرات إن كان الفشل في جلب إضافةٍ أو اعتمادٍ من الشبكة،
# بمهلةٍ بين المحاولات وبـ--refresh-dependencies فلا يبقى «غير موجود» محفوظاً من المحاولة الأولى ·
# وأي فشلٍ آخر (خطأ ترجمة، أو إعدادٌ خاطئ) يُسقط الخطوة من أول مرة برمز Gradle نفسه، ونفاد المحاولات يُسقطها كذلك.
# GRADLEW وRETRY_WAIT للاختبار وحده (tests/e2e.gradleRetry.test.ts).
set -u -o pipefail
GRADLEW="${GRADLEW:-./gradlew}"
ATTEMPTS="${GRADLE_ATTEMPTS:-3}"
WAIT="${RETRY_WAIT:-30}"
# رسائل Gradle لفشل الجلب من المستودعات (لا رسائل المترجم: «Unresolved reference» لا تطابق)
NETWORK='Could not resolve|could not resolve plugin artifact|was not found in any of the following sources|Could not GET|Could not HEAD|Could not download|Connection reset|Connection refused|Read timed out|Connect timed out|connect timed out|Remote host terminated the handshake|Received status code 5[0-9][0-9]|Could not install Gradle distribution|Unable to tunnel through proxy'
log="$(mktemp)"
trap 'rm -f "$log"' EXIT
rc=1
for i in $(seq "$ATTEMPTS"); do
  extra=()
  [ "$i" -gt 1 ] && extra=(--refresh-dependencies)
  bash "$GRADLEW" "$@" "${extra[@]}" 2>&1 | tee "$log"
  rc=${PIPESTATUS[0]}
  [ "$rc" -eq 0 ] && exit 0
  if ! grep -qE "$NETWORK" "$log"; then
    echo "gradle-retry: فشلٌ ليس من الشبكة (رمز $rc) · لا إعادة"
    exit "$rc"
  fi
  if [ "$i" -lt "$ATTEMPTS" ]; then
    echo "::warning::gradle-retry: فشل الجلب من الشبكة في المحاولة $i من $ATTEMPTS · إعادةٌ بعد $((WAIT * i)) ثانية"
    sleep $((WAIT * i))
  fi
done
echo "gradle-retry: فشل الجلب من الشبكة في المحاولات كلها ($ATTEMPTS) · رمز $rc"
exit "$rc"
