package com.aqari.app

import android.view.WindowManager
import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.uimanager.ViewManager

/**
 * منع لقطة الشاشة وتسجيلها ومعاينة التطبيقات الأخيرة (قرار المالك 2026-10-15 «٣»: «خيار في الإعدادات، مطفأ افتراضاً») ·
 * FLAG_SECURE على نافذة النشاط · يُطبَّق عند الإقلاع وعند تغيير الإعداد
 */
class AqariSecureModule(private val ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx) {
  override fun getName() = "AqariSecure"

  @ReactMethod
  fun setSecure(on: Boolean) {
    val activity = ctx.currentActivity ?: return
    activity.runOnUiThread {
      if (on) activity.window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
      else activity.window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
    }
  }
}

class AqariSecurePackage : ReactPackage {
  override fun createNativeModules(ctx: ReactApplicationContext): List<NativeModule> = listOf(AqariSecureModule(ctx))
  override fun createViewManagers(ctx: ReactApplicationContext): List<ViewManager<*, *>> = emptyList()
}
