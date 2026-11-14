#!/bin/bash
# الجوال الافتراضي · ٠٤ ب · ذاكرةٌ حرجة والتطبيق في المقدمة: يبقى حياً (التوجيه الرابع ٤ · ١)
set -u
PKG=com.aqari.app
adb shell am send-trim-memory "$PKG" RUNNING_CRITICAL
sleep 3
pid=$(adb shell pidof "$PKG" | tr -d '\r')
echo "pid after RUNNING_CRITICAL: ${pid:-none}"
[ -n "$pid" ]
