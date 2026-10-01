package com.obaflix.environment

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import java.net.NetworkInterface
import android.os.Build
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.URL

data class EnvironmentState(
    val isVpn: Boolean,
    val isEmulator: Boolean,
    val region: String?,
    val isReviewMode: Boolean
)

object EnvironmentDetector {

    private var cachedState: EnvironmentState? = null
    private var lastCheckTime: Long = 0L
    private const val CACHE_DURATION_MS = 30_000L

    fun getEnvironment(context: Context): EnvironmentState {
        if (cachedState != null && System.currentTimeMillis() - lastCheckTime < CACHE_DURATION_MS) {
            return cachedState!!
        }

        val state = EnvironmentState(
            isVpn = detectVpn(context),
            isEmulator = detectEmulator(),
            region = detectRegion(context),
            // CORRECAO 1: isReviewMode e campo explicito, sem derivacao automatica.
            // Sinais de antiabuso/compatibilidade, nao de cloaking.
            isReviewMode = false
        )

        cachedState = state
        lastCheckTime = System.currentTimeMillis()
        return state
    }

    // CORRECAO 3: deteccao de VPN por TRANSPORT_VPN + interfaces tun/ipsec.
    // Sem comparacao de sub-rede local vs publico (falso positivo).
    private fun detectVpn(context: Context): Boolean {
        val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager

        try {
            for (network in cm.allNetworks) {
                val caps = cm.getNetworkCapabilities(network) ?: continue
                if (caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) return true
            }
        } catch (_: Exception) {}

        try {
            val ifaces = NetworkInterface.getNetworkInterfaces()
            while (ifaces.hasMoreElements()) {
                val name = ifaces.nextElement().name
                if (name.startsWith("tun") || name.startsWith("ipsec")) return true
            }
        } catch (_: Exception) {}

        return false
    }

    private fun detectEmulator(): Boolean {
        var score = 0
        if (Build.HARDWARE.contains("goldfish", true)) score++
        if (Build.HARDWARE.contains("ranchu", true)) score++
        if (Build.HARDWARE.contains("generic", true)) score++
        if (Build.MANUFACTURER.contains("genymotion", true)) score++
        if (Build.MODEL.contains("emulator", true)) score++
        if (Build.MODEL.contains("simulator", true)) score++
        if (Build.MODEL.contains("google sdk phone", true)) score++
        if (Build.FINGERPRINT.contains("generic", true)) score++
        try {
            val cpuinfo = java.io.File("/proc/cpuinfo").readText()
            if (cpuinfo.contains("goldfish", true)) score++
            if (cpuinfo.contains("ranchu", true)) score++
        } catch (_: Exception) {}
        return score >= 2
    }

    // CORRECAO 2: HTTPS em ip-api.com
    private fun detectRegion(context: Context): String? {
        val ipRegion = try {
            val conn = URL("https://ip-api.com/json/?fields=status,countryCode").openConnection() as java.net.HttpURLConnection
            conn.connectTimeout = 5000
            conn.readTimeout = 5000
            val reader = BufferedReader(InputStreamReader(conn.inputStream))
            val json = reader.readText()
            reader.close()
            conn.disconnect()

            val obj = org.json.JSONObject(json)
            if (obj.optString("status") == "success") {
                obj.optString("countryCode", "").uppercase()
            } else {
                null
            }
        } catch (_: Exception) { null }

        if (!ipRegion.isNullOrEmpty()) return ipRegion

        return try {
            context.resources.configuration.locale.country.uppercase()
        } catch (_: Exception) { null }
    }
}
