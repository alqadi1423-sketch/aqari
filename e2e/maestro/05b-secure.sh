#!/bin/bash
# الجوال الافتراضي · ٠٥ ب · نافذة التطبيق تحمل FLAG_SECURE بعد التفعيل (التوجيه الرابع ٤ · ١)
set -u
adb shell dumpsys window windows > "$1/window.txt" 2>&1 || true
grep -n "com.aqari.app" "$1/window.txt" | head -5
awk '/Window #/{w=$0} /com.aqari.app/{f=1} f && /fl=/{print; f=0}' "$1/window.txt" | head -5
awk '/com.aqari.app/{f=1} f && /fl=/{print; f=0}' "$1/window.txt" | grep -q "SECURE"
