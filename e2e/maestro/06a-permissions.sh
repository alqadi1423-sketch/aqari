#!/bin/bash
# الجوال الافتراضي · ٠٦ أ · سحب أذونات التنبيهات والكاميرا قبل الإقلاع (التوجيه الرابع ٤ · ١): التطبيق يعمل بدونها
set -u
PKG=com.aqari.app
adb shell am force-stop "$PKG"
for p in android.permission.POST_NOTIFICATIONS android.permission.CAMERA; do adb shell pm revoke "$PKG" "$p" 2>&1 || true; done
adb shell dumpsys package "$PKG" | grep -E "POST_NOTIFICATIONS|CAMERA" | head -4
true
