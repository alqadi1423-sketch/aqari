#!/bin/bash
# الجوال الافتراضي · ٠٧ · الودجت مخفية بقرار المالك 2026-11-26 («اخفها حاليا واجل العمل عليها»): لا ودجت من التطبيق لدى النظام ·
# وحين تُظهر (features.ts والبيان) يعود الشرط إلى ثلاثٍ مسجّلة (التوجيه الرابع ٤ · ١)
set -u
adb shell dumpsys appwidget > "$1/appwidget.txt" 2>&1 || true
n=$(grep -c "ComponentInfo{com.aqari.app/" "$1/appwidget.txt" || true)
echo "aqari widget providers: $n"
[ "${n:-0}" -eq 0 ]
