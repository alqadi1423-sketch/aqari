package com.rekaz.aqari

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.widget.RemoteViews
import org.json.JSONObject
import java.io.File

/**
 * ودجتات «عقاري».
 *
 * الودجت عملية منفصلة لا تفتح قاعدة البيانات ولا تشغّل جافاسكربت، فمصدرها
 * الوحيد ملف `widget.json` يكتبه التطبيق في مجلده الداخلي. والنصوص فيه
 * مكتوبة منسَّقة جاهزة، فلا يُعاد بناء التنسيق هنا ولا تختلف الودجت عن الشاشة.
 *
 * والتحديث على وجهين: دوري كل نصف ساعة (أدنى ما يسمح به أندرويد)، وفوري
 * كلما غادر المستخدم التطبيق — فالتطبيق يكتب اللقطة عند كل تغيير، وMainActivity
 * تُنبّه الودجتات عند التوقف.
 */

private const val SNAPSHOT_FILE = "widget.json"

/** بيانات اللقطة · قيمها الافتراضية حال غياب الملف أو تلفه */
internal data class Snapshot(
    val lateCount: Int = 0,
    val lateSum: String = "0.00",
    val dueThisMonth: String = "0.00",
    val paidThisMonth: String = "0.00",
    val monthPct: Int = 0,
    val empty: Boolean = true
)

internal fun readSnapshot(context: Context): Snapshot {
    return try {
        val f = File(context.filesDir, SNAPSHOT_FILE)
        if (!f.exists()) return Snapshot()
        val o = JSONObject(f.readText())
        Snapshot(
            lateCount = o.optInt("lateCount", 0),
            lateSum = o.optString("lateSum", "0.00"),
            dueThisMonth = o.optString("dueThisMonth", "0.00"),
            paidThisMonth = o.optString("paidThisMonth", "0.00"),
            monthPct = o.optInt("monthPct", 0),
            empty = o.optBoolean("empty", true)
        )
    } catch (e: Exception) {
        Snapshot()
    }
}

/** فتح مسار في التطبيق · الرابط العميق نفسه الذي تستعمله الشاشات */
internal fun deepLink(context: Context, path: String, requestCode: Int): PendingIntent {
    val intent = Intent(Intent.ACTION_VIEW, Uri.parse("aqari://$path")).apply {
        setPackage(context.packageName)
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
    }
    return PendingIntent.getActivity(
        context, requestCode, intent,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )
}

/** تنبيه كل ودجتات التطبيق بأن اللقطة تغيّرت */
internal fun refreshAllWidgets(context: Context) {
    val mgr = AppWidgetManager.getInstance(context)
    val classes = listOf(
        TodayStripWidget::class.java,
        QuickActionsWidget::class.java,
        CollectionPanelWidget::class.java
    )
    for (cls in classes) {
        val ids = mgr.getAppWidgetIds(ComponentName(context, cls))
        if (ids.isNotEmpty()) {
            val intent = Intent(context, cls).apply {
                action = AppWidgetManager.ACTION_APPWIDGET_UPDATE
                putExtra(AppWidgetManager.EXTRA_APPWIDGET_IDS, ids)
            }
            context.sendBroadcast(intent)
        }
    }
}

/** ١ · شريط اليوم · 4×1 · كم متأخرة وبكم */
class TodayStripWidget : AppWidgetProvider() {
    override fun onUpdate(context: Context, mgr: AppWidgetManager, ids: IntArray) {
        val s = readSnapshot(context)
        for (id in ids) {
            val v = RemoteViews(context.packageName, R.layout.widget_today_strip)
            if (s.empty) {
                v.setTextViewText(R.id.strip_title, context.getString(R.string.widget_empty_title))
                v.setTextViewText(R.id.strip_amount, context.getString(R.string.widget_empty_hint))
            } else if (s.lateCount == 0) {
                v.setTextViewText(R.id.strip_title, context.getString(R.string.widget_no_late))
                v.setTextViewText(R.id.strip_amount, s.paidThisMonth)
            } else {
                v.setTextViewText(
                    R.id.strip_title,
                    context.getString(R.string.widget_late_count, s.lateCount)
                )
                v.setTextViewText(R.id.strip_amount, s.lateSum)
            }
            v.setOnClickPendingIntent(
                R.id.strip_root,
                deepLink(context, "/collect?filter=late", 101)
            )
            v.setOnClickPendingIntent(
                R.id.strip_button,
                deepLink(context, "/collect?filter=late", 102)
            )
            mgr.updateAppWidget(id, v)
        }
    }
}

/** ٨ · أزرار سريعة · 4×1 · بلا بيانات إطلاقاً */
class QuickActionsWidget : AppWidgetProvider() {
    override fun onUpdate(context: Context, mgr: AppWidgetManager, ids: IntArray) {
        for (id in ids) {
            val v = RemoteViews(context.packageName, R.layout.widget_quick_actions)
            v.setOnClickPendingIntent(R.id.qa_collect, deepLink(context, "/collect", 201))
            v.setOnClickPendingIntent(R.id.qa_invoice, deepLink(context, "/invoices", 202))
            v.setOnClickPendingIntent(R.id.qa_claim, deepLink(context, "/claims", 203))
            v.setOnClickPendingIntent(R.id.qa_more, deepLink(context, "/more", 204))
            mgr.updateAppWidget(id, v)
        }
    }
}

/** ٢ · لوحة التحصيل · 4×2 · المحصَّل مقابل المستحق */
class CollectionPanelWidget : AppWidgetProvider() {
    override fun onUpdate(context: Context, mgr: AppWidgetManager, ids: IntArray) {
        val s = readSnapshot(context)
        for (id in ids) {
            val v = RemoteViews(context.packageName, R.layout.widget_collection_panel)
            if (s.empty) {
                v.setTextViewText(R.id.panel_amount, context.getString(R.string.widget_empty_title))
                v.setTextViewText(R.id.panel_sub, context.getString(R.string.widget_empty_hint))
                v.setTextViewText(R.id.panel_pct, "")
                v.setTextViewText(R.id.panel_late, "")
                v.setProgressBar(R.id.panel_bar, 100, 0, false)
            } else {
                v.setTextViewText(R.id.panel_amount, s.paidThisMonth)
                v.setTextViewText(
                    R.id.panel_sub,
                    context.getString(R.string.widget_collected_of, s.dueThisMonth)
                )
                v.setTextViewText(
                    R.id.panel_pct,
                    context.getString(R.string.widget_month_pct, s.monthPct)
                )
                v.setTextViewText(
                    R.id.panel_late,
                    if (s.lateCount == 0) context.getString(R.string.widget_no_late)
                    else context.getString(R.string.widget_late_count, s.lateCount)
                )
                v.setProgressBar(R.id.panel_bar, 100, s.monthPct.coerceIn(0, 100), false)
            }
            v.setOnClickPendingIntent(
                R.id.panel_root,
                deepLink(context, "/collect?filter=month", 301)
            )
            mgr.updateAppWidget(id, v)
        }
    }
}
