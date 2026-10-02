package com.rekaz.aqari

import android.app.Activity
import android.content.ContentValues
import android.os.Build
import android.os.Bundle
import android.provider.MediaStore
import java.io.File

/**
 * «احفظ تفاصيل الخطأ» · ينقل ملف الخطأ الذي كتبه التطبيق إلى مجلد التنزيلات.
 *
 * ولمَ خطوة أصلية أصلاً: مجلد التنزيلات عامّ خارج مساحة التطبيق، ولا تكتب فيه
 * واجهة الملفات في expo · فيكتب التطبيق الملف في مجلده المؤقت ثم يناديها برابط
 * `aqarilog://save/<الاسم>` فتنقله وتحذف الأصل. وهي بلا واجهة تنصرف فور فراغها،
 * على شكل `PinWidgetActivity` نفسه.
 *
 * والاسم يُفحص فحصاً صارماً قبل القراءة: بادئة معروفة، وحروف مسموحة وحدها، وبلا
 * فاصل مسار · فلا يستطيع تطبيقٌ آخر أن ينادي هذه الشاشة لينسخ ملفاً غيرَ المقصود.
 */
class SaveErrorLogActivity : Activity() {

  private val allowed = Regex("^عقاري · خطأ · [0-9\\-]{1,32}\\.txt$")

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    try { save(intent?.data?.lastPathSegment) } catch (e: Exception) { /* لا يعطّل */ }
    finish()
  }

  private fun save(rawName: String?) {
    val name = rawName ?: return
    if (!allowed.matches(name)) return

    // التنزيلات عبر MediaStore بلا أي إذن من أندرويد ١٠ · وما دونه يحتاج إذن الكتابة
    // المحذوف من التطبيق، فلا يُكتب هناك ويحفظه المستخدم من نافذة المشاركة في الحوار
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return

    val staged = File(File(filesDir, "tmp"), name)
    if (!staged.exists()) return
    val text = staged.readBytes()

    val values = ContentValues().apply {
      put(MediaStore.Downloads.DISPLAY_NAME, name)
      put(MediaStore.Downloads.MIME_TYPE, "text/plain")
      put(MediaStore.Downloads.IS_PENDING, 1)
    }
    val resolver = contentResolver
    val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: return
    resolver.openOutputStream(uri)?.use { it.write(text) }
    values.clear()
    values.put(MediaStore.Downloads.IS_PENDING, 0)
    resolver.update(uri, values, null, null)

    try { staged.delete() } catch (e: Exception) { /* نُقل · وبقاؤه لا يضرّ */ }
  }
}
