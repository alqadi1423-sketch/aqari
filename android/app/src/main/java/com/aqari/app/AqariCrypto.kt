package com.aqari.app

import android.util.Base64
import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.uimanager.ViewManager
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * PBKDF2-HMAC-SHA256 لمفتاح تشفير النسخة الاحتياطية (src/domain/backup/encryption.ts) ·
 * بـ Mac النظام لا بشيفرة JS: ٦٠٠ ألف دورة على Hermes تستغرق عشرات الثواني، وهنا أقل من ثانيتين.
 *
 * ولمَ لا SecretKeyFactory("PBKDF2WithHmacSHA256"): تحويل كلمة المرور من محارف إلى بايتات فيه
 * يختلف بين المزوّدين، وكلمة المرور العربية تحتاج UTF-8 صريحاً · فالخوارزمية هنا كما في RFC 8018
 * حرفاً (كتلة واحدة لمفتاح ٣٢ بايت)، ونتيجتها تطابق node:crypto و@noble/hashes.
 */
class AqariCryptoModule(ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx) {
  override fun getName() = "AqariCrypto"

  @ReactMethod
  fun pbkdf2Sha256(password: String, saltB64: String, iterations: Int, promise: Promise) {
    Thread {
      try {
        val salt = Base64.decode(saltB64, Base64.NO_WRAP)
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(password.toByteArray(Charsets.UTF_8), "HmacSHA256"))
        mac.update(salt)
        mac.update(byteArrayOf(0, 0, 0, 1))
        var u = mac.doFinal()
        val t = u.copyOf()
        for (i in 1 until iterations) {
          u = mac.doFinal(u)
          for (j in t.indices) t[j] = (t[j].toInt() xor u[j].toInt()).toByte()
        }
        promise.resolve(Base64.encodeToString(t, Base64.NO_WRAP))
      } catch (e: Exception) {
        promise.reject("aqari_crypto", e)
      }
    }.start()
  }
}

class AqariCryptoPackage : ReactPackage {
  override fun createNativeModules(ctx: ReactApplicationContext): List<NativeModule> = listOf(AqariCryptoModule(ctx))
  override fun createViewManagers(ctx: ReactApplicationContext): List<ViewManager<*, *>> = emptyList()
}
