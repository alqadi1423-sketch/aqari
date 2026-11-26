#!/bin/bash
# الجوال الافتراضي · ٠٨ · زمن الإقلاع البارد يُسجَّل للمتابعة (التوجيه الرابع ٤ · ١) · لا يُحكم عليه هنا: «السرعة تُقاس على جوال
# حقيقي وحده، والمحاكي لاختبار الوظائف» (قرار المالك 2026-10-07)
set -u
PKG=com.aqari.app
for i in 1 2 3; do
  adb shell am force-stop "$PKG"; sleep 2
  adb shell am start -W -n "$PKG/.MainActivity" | tr -d '\r' | grep -E "TotalTime|WaitTime|Status" | sed "s/^/run $i: /" | tee -a "$1/coldstart.txt"
done
grep -q "TotalTime" "$1/coldstart.txt"
