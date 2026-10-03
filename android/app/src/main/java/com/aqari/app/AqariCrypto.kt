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
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.PBEKeySpec
import javax.crypto.spec.SecretKeySpec

/**
 * PBKDF2-HMAC-SHA256 لمفتاح تشفير النسخة الاحتياطية (src/domain/backup/encryption.ts) ·
 * من مزوّد النظام لا من شيفرة JS: ٦٠٠ ألف دورة على Hermes تستغرق دقائق.
 *
 * مساران بنتيجة واحدة كما في RFC 8018:
 *  - SecretKeyFactory("PBKDF2WithHmacSHA256") · الأسرع، بلا تخصيص في كل دورة.
 *  - حلقة HMAC بمخزن واحد يُعاد استعماله · احتياطاً.
 * وتحويل كلمة المرور إلى بايتات يختلف بين المزوّدين، وكلمة المرور العربية تحتاج UTF-8 · فقبل الاعتماد على
 * المسار الأول يُقارَن بالثاني على كلمة عربية ثابتة بألف دورة، ولا يُستعمل إلا إن طابقه حرفاً.
 * والنتيجتان تطابقان node:crypto و@noble/hashes (tests/encryption.test.ts).
 */
class AqariCryptoModule(ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx) {
  override fun getName() = "AqariCrypto"

  @ReactMethod
  fun pbkdf2Sha256(password: String, saltB64: String, iterations: Int, promise: Promise) {
    Thread {
      try {
        val salt = Base64.decode(saltB64, Base64.NO_WRAP)
        val key = if (factoryMatches()) viaFactory(password, salt, iterations) else viaMac(password, salt, iterations)
        promise.resolve(Base64.encodeToString(key, Base64.NO_WRAP))
      } catch (e: Exception) {
        promise.reject("aqari_crypto", e)
      }
    }.start()
  }

  companion object {
    @Volatile private var factoryOk: Boolean? = null

    private fun factoryMatches(): Boolean {
      factoryOk?.let { return it }
      val ok = try {
        val pw = "عقاري · تحقق ١٢٣"
        val salt = ByteArray(16) { (it * 7 + 3).toByte() }
        viaFactory(pw, salt, 1000).contentEquals(viaMac(pw, salt, 1000))
      } catch (e: Exception) {
        false
      }
      factoryOk = ok
      return ok
    }

    private fun viaFactory(password: String, salt: ByteArray, iterations: Int): ByteArray {
      val spec = PBEKeySpec(password.toCharArray(), salt, iterations, 256)
      try {
        return SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).encoded
      } finally {
        spec.clearPassword()
      }
    }

    /** RFC 8018 حرفاً (كتلة واحدة لمفتاح ٣٢ بايت) · مخزن واحد للدورات فلا يُخصَّص شيء في الحلقة */
    private fun viaMac(password: String, salt: ByteArray, iterations: Int): ByteArray {
      val mac = Mac.getInstance("HmacSHA256")
      mac.init(SecretKeySpec(password.toByteArray(Charsets.UTF_8), "HmacSHA256"))
      mac.update(salt)
      mac.update(byteArrayOf(0, 0, 0, 1))
      val u = mac.doFinal()
      val t = u.copyOf()
      for (i in 1 until iterations) {
        mac.update(u)
        mac.doFinal(u, 0)
        for (j in t.indices) t[j] = (t[j].toInt() xor u[j].toInt()).toByte()
      }
      return t
    }
  }
}

class AqariCryptoPackage : ReactPackage {
  override fun createNativeModules(ctx: ReactApplicationContext): List<NativeModule> = listOf(AqariCryptoModule(ctx))
  override fun createViewManagers(ctx: ReactApplicationContext): List<ViewManager<*, *>> = emptyList()
}
