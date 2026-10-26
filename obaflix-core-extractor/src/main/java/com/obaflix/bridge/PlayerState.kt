package com.obaflix.bridge

import java.util.Collections
import java.net.InetAddress

data class ObservedSuperflixMedia(
    val url: String,
    val referer: String?,
    val kind: String,
    /**
     * Status com que o CDN respondeu a requisicao que a propria pagina fez.
     *
     * Zero significa "nao medido": a requisicao passou pela WebView sem que a
     * interceptacao conseguisse assumi-la, e nesse caso quem confere e a sonda
     * fora de banda do extrator.
     */
    val status: Int = 0,
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

    /** UA do contexto que autorizou a fonte atual; null usa o UA normal do app. */
    @Volatile
    var mediaUserAgent: String? = null

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

    /**
     * Momento em que um servidor foi realmente escolhido nesta observacao.
     *
     * O provedor so pede `/player/source` quando alguem escolhe um servidor —
     * e o Electron usa exatamente essa requisicao como marco da selecao. Antes
     * dela, qualquer midia que aparece pertence ao player que a pagina arranca
     * sozinha, nao ao servidor escolhido; guardar essa era o que entregava ao
     * Media3 um manifesto que o CDN recusa.
     *
     * Zero enquanto ninguem escolheu nada.
     */
    @Volatile
    var superflixSelecaoEm: Long = 0L
        private set

    val superflixSelecionado: Boolean get() = superflixSelecaoEm > 0L

    /**
     * Marca a escolha de servidor e descarta a midia da escolha anterior.
     *
     * Trocar de servidor tem de invalidar o que o anterior deixou guardado,
     * senao a segunda tentativa entrega a fonte da primeira.
     */
    fun confirmarSelecaoSuperflix(origem: String) {
        if (!superflixObservationActive) return
        val primeira = superflixSelecaoEm == 0L
        superflixSelecaoEm = System.currentTimeMillis()
        if (!primeira) observedSuperflixMedia = null
        ObaLog.evento(
            ObaLog.Fase.PROVEDOR, "servidor_confirmado",
            "origem" to origem,
            "primeira" to primeira,
        )
    }

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
        superflixSelecaoEm = 0L
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

    /**
     * Candidata a midia vista pela pagina do provedor.
     *
     * Duas condicoes, as mesmas que o Electron aplica:
     *
     *  1. **Depois da escolha do servidor.** No Electron isso e implicito —
     *     `/player/source` e o que produz a URL. Aqui e explicito, porque a
     *     pagina tem um segundo player que arranca sozinho e pede midia antes
     *     de qualquer escolha.
     *  2. **Status de resposta em 2xx/3xx.** E o filtro do `capture()` do
     *     Electron, que recebe `statusCode` de graca no `onCompleted`. Status
     *     zero significa que nao houve como medir; a duvida segue para a sonda
     *     do extrator, como antes.
     */
    fun observeSuperflixMedia(url: String, referer: String?, kind: String, status: Int = 0) {
        if (!superflixObservationActive) return
        if (url in superflixRejeitadas) return

        ObaLog.evento(
            ObaLog.Fase.PROVEDOR, "midia_candidata",
            "tipo" to kind,
            "status" to status,
            "posSelecao" to superflixSelecionado,
            "url" to ObaLog.url(url),
        )

        if (!superflixSelecionado) {
            ObaLog.evento(
                ObaLog.Fase.PROVEDOR, "midia_candidata_ignorada",
                "motivo" to "antes_da_selecao",
                "url" to ObaLog.url(url),
            )
            return
        }

        if (status != 0 && status !in 200..399) {
            superflixRejeitadas.add(url)
            ObaLog.evento(
                ObaLog.Fase.PROVEDOR, "midia_candidata_ignorada",
                "motivo" to "status_$status",
                "url" to ObaLog.url(url),
            )
            return
        }

        // O primeiro manifesto HLS e o mais completo (master). Requisicoes
        // seguintes - sub-playlists ou um MP4 de pre-roll - nao o substituem.
        if (observedSuperflixMedia?.kind == "hls") {
            ObaLog.evento(
                ObaLog.Fase.PROVEDOR, "midia_candidata_ignorada",
                "motivo" to "hls_ja_guardado",
                "tipo" to kind,
                "url" to ObaLog.url(url),
                "jaGuardada" to ObaLog.url(observedSuperflixMedia?.url),
            )
            return
        }

        observedSuperflixMedia = ObservedSuperflixMedia(url, referer, kind, status)
        observedSuperflixMediaAt = System.currentTimeMillis()
        ObaLog.evento(
            ObaLog.Fase.PROVEDOR, "midia_validada",
            "tipo" to kind,
            "status" to status,
            "msAposSelecao" to (System.currentTimeMillis() - superflixSelecaoEm),
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
