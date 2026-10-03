package com.aqari.app

import android.content.Intent
import android.net.Uri
import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.uimanager.ViewManager

/**
 * فتح الشاشتين الداخليتين (تثبيت الودجت · حفظ ملف الخطأ) بقصدٍ صريح يسمّي الصنف.
 *
 * ولمَ لا رابط: الشاشتان غير مكشوفتين (exported=false) فلا يناديهما تطبيق آخر ولا صفحة ويب ·
 * وأندرويد ١٤ لا يوصل القصد الضمني (وهو ما يرسله Linking.openURL) إلى مكوّن غير مكشوف ولو من
 * التطبيق نفسه، فكان زرّ «أضف ودجت» لا يفعل شيئاً (النتيجة ‎-91 على المحاكي). والقصد الصريح يصل.
 */
class AqariIntentsModule(private val ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx) {
  override fun getName() = "AqariIntents"

  @ReactMethod
  fun pinWidget(kind: String, promise: Promise) =
    start(PinWidgetActivity::class.java, "aqariwidget://pin/" + Uri.encode(kind), promise)

  @ReactMethod
  fun saveErrorLog(name: String, promise: Promise) =
    start(SaveErrorLogActivity::class.java, "aqarilog://save/" + Uri.encode(name), promise)

  private fun start(cls: Class<*>, uri: String, promise: Promise) {
    try {
      val intent = Intent(Intent.ACTION_VIEW, Uri.parse(uri))
        .setClass(ctx, cls)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      ctx.startActivity(intent)
      promise.resolve(true)
    } catch (e: Exception) {
      promise.reject("aqari_intent", e)
    }
  }
}

class AqariIntentsPackage : ReactPackage {
  override fun createNativeModules(ctx: ReactApplicationContext): List<NativeModule> = listOf(AqariIntentsModule(ctx))
  override fun createViewManagers(ctx: ReactApplicationContext): List<ViewManager<*, *>> = emptyList()
}
