package com.obaflix.ads

import android.webkit.CookieManager
import com.obaflix.BuildConfig
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit

/** Recheck the authenticated server challenge before any CMP/SDK ad request. */
object AdmobChallengeEligibility {
    private val client = OkHttpClient.Builder().callTimeout(10, TimeUnit.SECONDS).followRedirects(false).build()
    fun check(nonce: String, done: (Boolean) -> Unit) {
        if (!BuildConfig.ADMOB_REWARDED_APPROVED || !BuildConfig.ADS_AUDIENCE_VALIDATED) { done(false); return }
        val origin = BuildConfig.OBAFLIX_URL.trimEnd('/')
        val unit = if (BuildConfig.PLAY_STORE_BUILD) BuildConfig.ADMOB_REWARDED_PLAY_STANDARD_ID else BuildConfig.ADMOB_REWARDED_DIRECT_STANDARD_ID
        if (!origin.startsWith("https://") || unit.isBlank()) { done(false); return }
        val cookie = CookieManager.getInstance().getCookie(origin) ?: ""
        val request = Request.Builder().url("$origin/api/ads/admob/status")
            .header("Cookie", cookie).header("Origin", origin)
            .header("X-Obaflix-Distribution", if (BuildConfig.PLAY_STORE_BUILD) "play" else "direct")
            .post(JSONObject().put("nonce", nonce).toString().toRequestBody("application/json".toMediaType())).build()
        client.newCall(request).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) { done(false) }
            override fun onResponse(call: Call, response: Response) {
                response.use {
                    val allowed = try {
                        val raw = it.body?.string() ?: ""
                        val value = if (raw.length <= 4096) JSONObject(raw) else JSONObject()
                        it.isSuccessful && value.optBoolean("eligibleForAd", false) && value.optString("unitId") == unit
                    } catch (_: Exception) { false }
                    done(allowed)
                }
            }
        })
    }
}
