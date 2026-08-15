package com.obaflix.bridge

import java.util.Collections
import java.net.InetAddress

data class ObservedSuperflixMedia(
    val url: String,
    val referer: String?,
    val kind: String,
)

class PlayerState {
    @Volatile
    var cdnHostname: String? = null

    @Volatile
    var embedReferer: String? = null

    @Volatile
    var observedSuperflixUrl: String? = null

    @Volatile
    var observedSuperflixMedia: ObservedSuperflixMedia? = null

    @Volatile
    var superflixObservationActive: Boolean = false

    private val cdnHostnames = Collections.synchronizedSet(mutableSetOf<String>())

    fun resetCdnHosts(primaryHost: String) {
        synchronized(cdnHostnames) {
            cdnHostnames.clear()
            cdnHostnames.add(primaryHost.lowercase())
        }
        cdnHostname = primaryHost.lowercase()
    }

    fun allowCdnHost(host: String) {
        val normalized = host.lowercase().trim()
        if (normalized.isEmpty() || cdnHostnames.contains(normalized)) return
        val isPublic = runCatching {
            val addresses = InetAddress.getAllByName(normalized)
            addresses.isNotEmpty() && addresses.none {
                it.isAnyLocalAddress || it.isLoopbackAddress || it.isLinkLocalAddress ||
                    it.isSiteLocalAddress || it.isMulticastAddress
            }
        }.getOrDefault(false)
        if (isPublic) cdnHostnames.add(normalized)
    }

    fun isAllowedCdnHost(host: String): Boolean {
        val normalized = host.lowercase()
        synchronized(cdnHostnames) {
            return cdnHostnames.any { normalized == it || normalized.endsWith(".$it") }
        }
    }

    fun resetSuperflixObservation() {
        observedSuperflixUrl = null
        observedSuperflixMedia = null
        superflixObservationActive = true
    }

    fun finishSuperflixObservation() {
        superflixObservationActive = false
    }

    fun observeSuperflixUrl(url: String) {
        if (!superflixObservationActive) return
        observedSuperflixUrl = url
    }

    fun observeSuperflixMedia(url: String, referer: String?, kind: String) {
        if (!superflixObservationActive) return
        observedSuperflixMedia = ObservedSuperflixMedia(url, referer, kind)
    }
}
