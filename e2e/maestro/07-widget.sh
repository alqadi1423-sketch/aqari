#!/bin/bash
# الجوال الافتراضي · ٠٧ · نوافذ الشاشة الرئيسية الثلاث مسجّلةٌ لدى النظام (التوجيه الرابع ٤ · ١) · وضعها على الشاشة لا يُؤتمت
set -u
adb shell dumpsys appwidget > "$1/appwidget.txt" 2>&1 || true
n=$(grep -c "ComponentInfo{com.aqari.app/" "$1/appwidget.txt" || true)
echo "aqari widget providers: $n"
[ "${n:-0}" -ge 3 ]
