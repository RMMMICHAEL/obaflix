package com.obaflix.environment

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import java.net.NetworkInterface
import android.os.Build
import java.io.File
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
            isReviewMode = false
        )

        cachedState = state
        lastCheckTime = System.currentTimeMillis()
        return state
    }

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

        try {
            val localIp = getLocalIp()
            val publicIp = getPublicIp()
            if (localIp != null && publicIp != null && !sameSubnet(localIp, publicIp)) {
                return true
            }
        } catch (_: Exception) {}

        return false
    }

    private fun getLocalIp(): String? {
        return try {
            val ifaces = NetworkInterface.getNetworkInterfaces()
            while (ifaces.hasMoreElements()) {
                val iface = ifaces.nextElement()
                if (iface.isLoopback) continue
                val addrs = iface.inetAddresses
                while (addrs.hasMoreElements()) {
                    val addr = addrs.nextElement()
                    if (!addr.isLoopbackAddress) return addr.hostAddress
                }
            }
            null
        } catch (_: Exception) { null }
    }

    private fun getPublicIp(): String? {
        return try {
            val conn = URL("https://api.ipify.org").openConnection() as java.net.HttpURLConnection
            conn.connectTimeout = 5000
            conn.readTimeout = 5000
            val reader = BufferedReader(InputStreamReader(conn.inputStream))
            val ip = reader.readLine()
            reader.close()
            conn.disconnect()
            ip
        } catch (_: Exception) { null }
    }

    private fun sameSubnet(ip1: String, ip2: String): Boolean {
        val p1 = ip1.split('.')
        val p2 = ip2.split('.')
        if (p1.size < 3 || p2.size < 3) return false
        return p1.take(3) == p2.take(3)
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
            val cpuinfo = File("/proc/cpuinfo").readText()
            if (cpuinfo.contains("goldfish", true)) score++
            if (cpuinfo.contains("ranchu", true)) score++
        } catch (_: Exception) {}
        return score >= 2
    }

    private fun detectRegion(context: Context): String? {
        return try {
            context.resources.configuration.locale.country.uppercase()
        } catch (_: Exception) { null }
    }
}