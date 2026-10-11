package com.aqari.app

import android.os.SystemClock
import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.uimanager.ViewManager

/**
 * ساعة قفل التطبيق (#51 · المتحقق المستقل، الجولة السادسة): مللي ثانية منذ إقلاع الجهاز، تعدّ نومه ولا يغيّرها المستخدم.
 *
 * ولمَ لا performance.now: هي steady_clock (CLOCK_MONOTONIC) فتقف أثناء نوم الجهاز، فمن غاب ساعتين والجهاز نائم ثم
 * أُرجعت ساعة الجهاز تبدو غيبته ثواني ولا يُقفل التطبيق · وelapsedRealtime تعدّ النوم.
 */
class AqariClockModule(ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx) {
  override fun getName() = "AqariClock"

  @ReactMethod(isBlockingSynchronousMethod = true)
  fun elapsedRealtime(): Double = SystemClock.elapsedRealtime().toDouble()
}

class AqariClockPackage : ReactPackage {
  override fun createNativeModules(ctx: ReactApplicationContext): List<NativeModule> = listOf(AqariClockModule(ctx))
  override fun createViewManagers(ctx: ReactApplicationContext): List<ViewManager<*, *>> = emptyList()
}
