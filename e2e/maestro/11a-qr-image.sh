#!/bin/bash
# الجوال الافتراضي · ١١ أ · صورة QR فاتورةٍ مصطنعة في معرض المحاكي ليقرأها ١١ ب (التوجيه الرابع ٦ · ١)
set -u
png="$1/qr-invoice.png"
node e2e/qrInvoice.js "$png" || exit 1
adb shell mkdir -p /sdcard/Pictures
adb push "$png" /sdcard/Pictures/aqari-e2e-qr.png || exit 1
# فهرسة الصورة في مكتبة الوسائط ليراها منتقي الصور
adb shell am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d file:///sdcard/Pictures/aqari-e2e-qr.png || true
adb shell content call --uri content://media --method scan_volume --arg external_primary >/dev/null 2>&1 || true
sleep 3
adb shell content query --uri content://media/external/images/media --projection _display_name | grep -q "aqari-e2e-qr.png"
