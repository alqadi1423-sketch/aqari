#!/bin/bash
# الجوال الافتراضي · ٠٤ د · قتل العملية في الخلفية كما يفعل النظام عند نقص الذاكرة (التوجيه الرابع ٤ · ١)
set -u
PKG=com.aqari.app
adb shell am send-trim-memory "$PKG" COMPLETE || true
adb shell am kill "$PKG"
sleep 2
if [ -n "$(adb shell pidof "$PKG" | tr -d '\r')" ]; then adb shell am force-stop "$PKG"; sleep 1; fi
pid=$(adb shell pidof "$PKG" | tr -d '\r')
echo "pid after kill: ${pid:-none}"
[ -z "$pid" ]
