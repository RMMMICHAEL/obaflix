package com.obaflix.bridge

import java.util.Collections
import java.net.InetAddress

data class ObservedSuperflixMedia(
    val url: String,
    val referer: String?,
    val kind: String,
)

data class ObservedSubtitle(
    val url: String,
    val referer: String?,
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

    /** Momento em que o WebView viu a primeira mídia; base da janela de espera por legendas. */
    @Volatile
    var observedSuperflixMediaAt: Long = 0L
        private set

    // Identifica qual extração é dona da observação atual. Sem isso, uma extração
    // cancelada (troca rápida de episódio) desligava a observação da extração nova
    // ao rodar seu próprio finally.
    @Volatile
    private var observationToken: Long = 0L

    /**
     * Midias que ja foram testadas e recusadas pelo CDN.
     *
     * A pagina do provedor tem mais de um player, e o que arranca sozinho pede
     * um manifesto que responde 403 — midia do player alternativo, nao do
     * servidor que a pessoa escolhe. Guardar a primeira que aparece entregava
     * justamente essa. Com a lista, uma candidata recusada nao volta a ser
     * guardada e a observacao continua ate vir a que presta.
     */
    private val superflixRejeitadas = Collections.synchronizedSet(mutableSetOf<String>())

    /** Descarta a midia guardada e impede que ela seja aceita de novo. */
    fun rejeitarSuperflixMedia(url: String) {
        superflixRejeitadas.add(url)
        if (observedSuperflixMedia?.url == url) observedSuperflixMedia = null
    }

    private val superflixSubtitles = Collections.synchronizedList(mutableListOf<ObservedSubtitle>())

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

    /** Abre uma janela de observação e devolve o token que a identifica. */
    fun beginSuperflixObservation(): Long {
        val token = System.nanoTime()
        observationToken = token
        observedSuperflixUrl = null
        observedSuperflixMedia = null
        superflixRejeitadas.clear()
        observedSuperflixMediaAt = 0L
        superflixSubtitles.clear()
        superflixObservationActive = true
        return token
    }

    /** Só encerra a observação se ela ainda pertencer a esta extração. */
    fun finishSuperflixObservation(token: Long) {
        if (observationToken != token) return
        superflixObservationActive = false
    }

    fun observeSuperflixUrl(url: String) {
        if (!superflixObservationActive) return
        observedSuperflixUrl = url
    }

    fun observeSuperflixMedia(url: String, referer: String?, kind: String) {
        if (!superflixObservationActive) return
        if (url in superflixRejeitadas) return
        // O primeiro manifesto HLS é o mais completo (master). Requisições
        // seguintes — sub-playlists ou um MP4 de pré-roll — não o substituem.
        if (observedSuperflixMedia?.kind == "hls") {
            // Candidata ignorada por já haver um HLS guardado.
            //
            // Isto é diagnóstico, não decisão: se a página tiver mais de um
            // player e o primeiro a pedir mídia não for o servidor que a pessoa
            // escolheu, quem fica guardado é o errado — e o log passa a mostrar
            // exatamente quantas candidatas vieram depois e como eram. Sem esta
            // linha, tudo que viesse a seguir sumia sem deixar rastro.
            ObaLog.evento(
                ObaLog.Fase.PROVEDOR, "midia_candidata_ignorada",
                "tipo" to kind,
                "url" to ObaLog.url(url),
                "jaGuardada" to ObaLog.url(observedSuperflixMedia?.url),
            )
            return
        }
        observedSuperflixMedia = ObservedSuperflixMedia(url, referer, kind)
        observedSuperflixMediaAt = System.currentTimeMillis()
        ObaLog.evento(
            ObaLog.Fase.PROVEDOR, "midia_guardada",
            "tipo" to kind,
            "url" to ObaLog.url(url),
            "referer" to ObaLog.url(referer),
        )
    }

    fun observeSuperflixSubtitle(url: String, referer: String?) {
        if (!superflixObservationActive) return
        synchronized(superflixSubtitles) {
            if (superflixSubtitles.none { it.url == url }) {
                superflixSubtitles.add(ObservedSubtitle(url, referer))
            }
        }
    }

    val observedSuperflixSubtitles: List<ObservedSubtitle>
        get() = synchronized(superflixSubtitles) { superflixSubtitles.toList() }
}
