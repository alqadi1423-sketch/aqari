package com.aqari.app

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.view.View
import android.widget.RemoteViews
import org.json.JSONObject
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

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
 *
 * وقفل التطبيق المفعّل (المراجعة الشاملة · البند ٢٣) يكتب لقطةً بلا مبالغ ولا نسبة ولا نقد ومعها `locked`،
 * فتعرض الودجت الأعداد وحدها و«المبالغ مخفية» · وفرع القفل يسبق كل فرعٍ يعرض مبلغاً فلا يُعرض ولو وُجد.
 * ولا تثق الودجت بـ`locked` وحده: علامة القفل نفسها في المجلد نفسه تُعدّ قفلاً، فلقطةٌ لم تمرّ بالكتابة الأخيرة
 * (نسخة حسابٍ عادت، أو لقطة إصدارٍ سابق قبل أول فتح، أو تعذّر حذفها) لا تُعرض مبالغها والقفل مفعّل.
 *
 * واللقطة تحمل جدول الأيام القادمة (المراجعة الشاملة 2026-11-13 · E-3): `ahead` كل يومٍ تتغيّر فيه الأرقام خلال ستين يوماً بأرقامه
 * منسَّقة، و`validUntil` آخر يومٍ تصحّ له · فتعرض الودجت أرقام يومها (بتاريخ الجهاز المحلي) لا يوم آخر فتح، وبعد `validUntil` تُخفي
 * الأعداد والمبالغ وتكتب «آخر تحديث … · افتح التطبيق».
 */

private const val SNAPSHOT_FILE = "widget.json"

/** علامة قفل التطبيق · يكتبها appLockService.ts في Paths.document، وهو context.filesDir نفسه */
private const val LOCK_FLAG_FILE = "app-lock.flag"

/** قفل التطبيق مفعّل بعلامته · تعذّر فحصها يُعدّ مفعّلاً كما في التطبيق (lockMaybeOn) */
internal fun lockFlagged(context: Context): Boolean {
    return try {
        File(context.filesDir, LOCK_FLAG_FILE).exists()
    } catch (e: Exception) {
        true
    }
}

/** بيانات اللقطة · قيمها الافتراضية حال غياب الملف أو تلفه */
internal data class Snapshot(
    val lateCount: Int = 0,
    val lateSum: String = "0.00",
    val dueThisMonth: String = "0.00",
    val paidThisMonth: String = "0.00",
    val monthPct: Int = 0,
    val empty: Boolean = true,
    /** صلاحية العضو لا تشمل التحصيل · لا مبالغ في الملف أصلاً */
    val noCollect: Boolean = false,
    /** قفل التطبيق مفعّل · لا مبالغ في الملف ولا تُعرض */
    val locked: Boolean = false,
    val canCollect: Boolean = true,
    val canInvoices: Boolean = true,
    val canClaims: Boolean = true,
    /** تجاوز اليومُ جدول اللقطة (E-3) · لا عدد ولا مبلغ، و«آخر تحديث» بيوم اللقطة */
    val stale: Boolean = false,
    /** يوم كتابة اللقطة YYYY-MM-DD */
    val day: String = ""
)

/**
 * موضع يوم الجدول الصالح لـ`today` (E-3) · دالّةٌ خالصة، ومثيلتها pickWidgetDay في src/domain/widgetAhead.ts تُختبر هناك ·
 * null: تجاوز اليومُ validUntil (أو يوم اللقطة إن خلت منه، كلقطة إصدارٍ سابق) · ‎-1: أرقام اللقطة نفسها ·
 * وإلا موضع آخر يومٍ في ahead لم يتجاوز اليوم (والمتساويان يُختار آخرهما) · التواريخ YYYY-MM-DD تُقارن نصاً
 */
internal fun pickAheadIndex(today: String, day: String, validUntil: String, aheadDays: List<String>): Int? {
    val until = if (validUntil.isNotBlank()) validUntil else day
    if (until.isNotBlank() && today > until) return null
    var best = -1
    for (i in aheadDays.indices) {
        val d = aheadDays[i]
        if (d.isNotBlank() && d <= today && (best < 0 || d >= aheadDays[best])) best = i
    }
    return best
}

/** «28/11» من «2026-11-28» · كـ dfmt بلا سنة، ومثيلتها widgetShortDay */
internal fun shortDay(iso: String): String =
    if (iso.length >= 10) iso.substring(8, 10) + "/" + iso.substring(5, 7) else iso

/** اليوم بتاريخ الجهاز المحلي YYYY-MM-DD · كـ today() في التطبيق، وبأرقام لاتينية أياً كانت لغة الجهاز */
internal fun localToday(): String = SimpleDateFormat("yyyy-MM-dd", Locale.US).format(Date())

internal fun readSnapshot(context: Context): Snapshot {
    return try {
        val f = File(context.filesDir, SNAPSHOT_FILE)
        if (!f.exists()) return Snapshot()
        val o = JSONObject(f.readText())
        val day = o.optString("day", "")
        val ahead = o.optJSONArray("ahead")
        val aheadDays = ArrayList<String>()
        if (ahead != null) {
            for (i in 0 until ahead.length()) aheadDays.add(ahead.optJSONObject(i)?.optString("day", "") ?: "")
        }
        val pick = pickAheadIndex(localToday(), day, o.optString("validUntil", ""), aheadDays)
        val stale = pick == null
        // أرقام اليوم: يوم الجدول المختار، أو أرقام اللقطة نفسها · والبائتة بلا أرقام أصلاً
        val src: JSONObject = if (pick != null && pick >= 0) (ahead?.optJSONObject(pick) ?: o) else o
        Snapshot(
            lateCount = if (stale) 0 else src.optInt("lateCount", 0),
            lateSum = if (stale) "" else src.optString("lateSum", "0.00"),
            dueThisMonth = if (stale) "" else src.optString("dueThisMonth", "0.00"),
            paidThisMonth = if (stale) "" else src.optString("paidThisMonth", "0.00"),
            monthPct = if (stale) 0 else src.optInt("monthPct", 0),
            empty = o.optBoolean("empty", true),
            noCollect = o.optBoolean("noCollect", false),
            locked = o.optBoolean("locked", false) || lockFlagged(context),
            canCollect = o.optJSONObject("can")?.optBoolean("collect", true) ?: true,
            canInvoices = o.optJSONObject("can")?.optBoolean("invoices", true) ?: true,
            canClaims = o.optJSONObject("can")?.optBoolean("claims", true) ?: true,
            stale = stale,
            day = day
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
            if (s.noCollect) {
                v.setTextViewText(R.id.strip_title, context.getString(R.string.widget_no_access))
                v.setTextViewText(R.id.strip_amount, "")
            } else if (s.empty) {
                v.setTextViewText(R.id.strip_title, context.getString(R.string.widget_empty_title))
                v.setTextViewText(R.id.strip_amount, context.getString(R.string.widget_empty_hint))
            } else if (s.stale) {
                // تجاوز اليومُ جدول اللقطة (E-3) · لا عدد قد يكون بائتاً ولا مبلغ، وتاريخ آخر تحديث
                v.setTextViewText(R.id.strip_title, context.getString(R.string.widget_stale, shortDay(s.day)))
                v.setTextViewText(R.id.strip_amount, context.getString(R.string.widget_locked_amount))
            } else if (s.locked) {
                v.setTextViewText(
                    R.id.strip_title,
                    if (s.lateCount == 0) context.getString(R.string.widget_no_late)
                    else context.getString(R.string.widget_late_count, s.lateCount)
                )
                v.setTextViewText(R.id.strip_amount, context.getString(R.string.widget_locked_amount))
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
        val s = readSnapshot(context)
        for (id in ids) {
            val v = RemoteViews(context.packageName, R.layout.widget_quick_actions)
            // ما لا تجيزه صلاحية العضو لا يظهر زره
            v.setViewVisibility(R.id.qa_collect, if (s.canCollect) View.VISIBLE else View.GONE)
            v.setViewVisibility(R.id.qa_invoice, if (s.canInvoices) View.VISIBLE else View.GONE)
            v.setViewVisibility(R.id.qa_claim, if (s.canClaims) View.VISIBLE else View.GONE)
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
            if (s.noCollect) {
                v.setTextViewText(R.id.panel_amount, context.getString(R.string.widget_no_access))
                v.setTextViewText(R.id.panel_sub, "")
                v.setTextViewText(R.id.panel_pct, "")
                v.setTextViewText(R.id.panel_late, "")
                v.setProgressBar(R.id.panel_bar, 100, 0, false)
                v.setViewVisibility(R.id.panel_bar, View.VISIBLE)
            } else if (s.empty) {
                v.setTextViewText(R.id.panel_amount, context.getString(R.string.widget_empty_title))
                v.setTextViewText(R.id.panel_sub, context.getString(R.string.widget_empty_hint))
                v.setTextViewText(R.id.panel_pct, "")
                v.setTextViewText(R.id.panel_late, "")
                v.setProgressBar(R.id.panel_bar, 100, 0, false)
                v.setViewVisibility(R.id.panel_bar, View.VISIBLE)
            } else if (s.stale) {
                // تجاوز اليومُ جدول اللقطة (E-3) · لا عدد ولا مبلغ ولا نسبة، والشريط يُخفى كحال القفل
                v.setTextViewText(R.id.panel_amount, context.getString(R.string.widget_locked_amount))
                v.setTextViewText(R.id.panel_sub, context.getString(R.string.widget_stale, shortDay(s.day)))
                v.setTextViewText(R.id.panel_pct, "")
                v.setTextViewText(R.id.panel_late, "")
                v.setProgressBar(R.id.panel_bar, 100, 0, false)
                v.setViewVisibility(R.id.panel_bar, View.INVISIBLE)
            } else if (s.locked) {
                // الشريط يُخفى ويبقى مكانه · فلا يقرأ أحدٌ الصفر نسبةً ولا يتغيّر التخطيط
                // وكل فرعٍ يضبط ظهوره: RemoteViews يُطبَّق على العرض القائم فيبقى المخفيّ مخفياً في الحال التالية
                v.setTextViewText(R.id.panel_amount, context.getString(R.string.widget_locked_amount))
                v.setTextViewText(R.id.panel_sub, context.getString(R.string.widget_locked_hint))
                v.setTextViewText(R.id.panel_pct, "")
                v.setTextViewText(
                    R.id.panel_late,
                    if (s.lateCount == 0) context.getString(R.string.widget_no_late)
                    else context.getString(R.string.widget_late_count, s.lateCount)
                )
                v.setProgressBar(R.id.panel_bar, 100, 0, false)
                v.setViewVisibility(R.id.panel_bar, View.INVISIBLE)
            } else {
                v.setViewVisibility(R.id.panel_bar, View.VISIBLE)
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
