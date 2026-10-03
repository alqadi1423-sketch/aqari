package com.aqari.app

import android.app.Activity
import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.os.Build
import android.os.Bundle

/**
 * «أضف ودجت إلى الشاشة» · شاشة بلا واجهة تطلب من أندرويد تثبيت الودجت ثم تنصرف.
 *
 * بلا هذا الزر لا سبيل للمستخدم إلا أن يطول ضغطه على الشاشة ويبحث في قائمة
 * الودجتات · وهذا يضعه أمامه بضغطة من الإعدادات. ويفتحها التطبيق بقصد صريح (AqariIntents.kt)
 * يحمل `aqariwidget://pin/<النوع>` · وهي غير مكشوفة فلا يناديها تطبيق آخر.
 */
class PinWidgetActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val kind = intent?.data?.lastPathSegment ?: "strip"
        val cls = when (kind) {
            "actions" -> QuickActionsWidget::class.java
            "panel" -> CollectionPanelWidget::class.java
            else -> TodayStripWidget::class.java
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            try {
                val mgr = AppWidgetManager.getInstance(this)
                if (mgr.isRequestPinAppWidgetSupported) {
                    mgr.requestPinAppWidget(ComponentName(this, cls), null, null)
                }
            } catch (e: Exception) {
                // المشغّل قد يرفض · لا شيء يُعطَّل
            }
        }
        finish()
    }
}
