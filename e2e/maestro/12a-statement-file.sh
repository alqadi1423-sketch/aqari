#!/bin/bash
# الجوال الافتراضي · ١٢ أ · كشف حسابٍ مصطنع (CSV) في «التنزيلات» ليقرأه ١٢ ب (التوجيه الرابع ٦ · ٢)
set -u
csv="$1/aqari-e2e-statement.csv"
node e2e/bankStatement.js "$csv" || exit 1
adb shell mkdir -p /sdcard/Download
adb push "$csv" /sdcard/Download/aqari-e2e-statement.csv || exit 1
adb shell am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d file:///sdcard/Download/aqari-e2e-statement.csv || true
adb shell content call --uri content://media --method scan_volume --arg external_primary >/dev/null 2>&1 || true
sleep 3
adb shell ls /sdcard/Download | grep -q "aqari-e2e-statement.csv"
