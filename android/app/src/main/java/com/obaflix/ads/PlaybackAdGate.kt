package com.obaflix.ads

import com.obaflix.bridge.ObaLog
import java.util.concurrent.atomic.AtomicBoolean

/** O que o usuario pediu para comecar. */
enum class PlaybackIntent {
    /** Toque em ASSISTIR de um filme. Toda intencao passa pelo interstitial. */
    FILME,

    /** Toque para iniciar um episodio. Vale a regra de frequencia da serie. */
    EPISODIO,
}

/**
 * Unico lugar do aplicativo que decide se um anuncio aparece antes da
 * reproducao — e o unico que fala com o [InterstitialAdProvider].
 *
 * Ordem: intencao do usuario -> politica -> interstitial quando aplicavel ->
 * a reproducao que ja existia. O gate entra **antes** da resolucao pesada do
 * video (nada do pipeline de fontes, failover ou extracao foi movido ou
 * reescrito), e nao conhece nada dele: recebe uma continuacao opaca e a executa.
 *
 * Principio inegociavel: **fail-open**. Erro de inicializacao, falha de
 * carregamento, falta de inventario, timeout, tela invalida ou SDK em silencio
 * — em todos os casos a continuacao roda e o usuario assiste. Publicidade nunca
 * bloqueia reproducao.
 */
class PlaybackAdGate(
    private val provider: InterstitialAdProvider,
    private val seriesPolicy: SeriesAdFrequencyPolicy,
    private val adsEnabled: () -> Boolean = { AdsConfig.adsEnabled },
) {

    /**
     * Ha um interstitial em exibicao agora.
     *
     * Lido e escrito somente na thread principal (o gate e chamado da bridge,
     * que faz `post` para ela, e as callbacks do provider chegam la tambem).
     */
    private var emExibicao = false

    /** Geracao do anuncio atual; invalida callbacks tardios de um gate anterior. */
    private var geracao = 0

    /** Barreira de fechamento do anuncio em andamento, ou `null`. */
    private var barreira: Barreira? = null

    /**
     * Ha um interstitial cobrindo a tela agora?
     *
     * Verdadeiro do instante em que o anuncio comeca ate o release confirmado —
     * inclusive durante a espera pelo retorno do foco (end-card ainda na tela).
     * Lido pela Activity para manter a WebView viva (preparacao em segundo plano)
     * e para so encaminhar o foco ao gate enquanto ha anuncio. So escrito na
     * thread principal.
     */
    val anuncioEmExibicao: Boolean
        get() = emExibicao

    /** Inicializa o SDK e ja deixa o primeiro interstitial a caminho. */
    fun aquecer() {
        provider.initialize()
        provider.preload()
    }

    /**
     * Processa uma intencao real de reproducao.
     *
     * [liberarReproducao] e a continuacao: o fluxo de reproducao que ja existia,
     * exatamente como era. Roda **uma unica vez**, sempre — em qualquer caminho
     * desta funcao e em qualquer callback tardia.
     *
     * [aoIniciarAnuncio] avisa que um interstitial esta prestes a cobrir a tela.
     * Serve para quem espera do outro lado desligar o proprio watchdog: a partir
     * dali quem decide o tempo e o usuario, e uma espera com prazo curto
     * liberaria a reproducao por tras do anuncio.
     */
    fun requestPlayback(
        host: AdHost,
        intent: PlaybackIntent,
        aoIniciarAnuncio: () -> Unit = {},
        liberarReproducao: () -> Unit,
    ) {
        val liberar = ContinuacaoUnica(liberarReproducao)

        if (!adsEnabled()) {
            // Caminho do futuro Premium: nenhuma tela precisa saber disso.
            registrar("ads_gate_decision", "decisao" to "sem_anuncios", "motivo" to "ads_desabilitados")
            liberar.executar()
            return
        }

        if (emExibicao) {
            // Toque duplo rapido, ou uma segunda intencao enquanto o anuncio da
            // primeira ainda esta na tela. Nunca abre um segundo anuncio.
            registrar("ads_gate_decision", "decisao" to "sem_anuncios", "motivo" to "gate_ocupado")
            liberar.executar()
            return
        }

        val deveExibir = when (intent) {
            PlaybackIntent.FILME -> true
            PlaybackIntent.EPISODIO -> seriesPolicy.registrarIntencaoDeEpisodio()
        }
        registrar(
            "ads_gate_decision",
            "intencao" to intent.name.lowercase(),
            "decisao" to if (deveExibir) "exibir" else "seguir",
        )
        if (!deveExibir) {
            liberar.executar()
            return
        }

        if (!host.disponivel) {
            registrar("show_ignorado", "motivo" to "tela_indisponivel")
            liberar.executar()
            return
        }

        if (!provider.pronto) {
            // Sem inventario carregado: segue direto e ja pede o proximo, para
            // que a proxima intencao encontre um anuncio pronto.
            registrar("show_ignorado", "motivo" to "sem_anuncio_carregado")
            provider.preload()
            liberar.executar()
            return
        }

        emExibicao = true
        val gen = ++geracao
        val b = Barreira(gen, intent, liberar)
        barreira = b
        registrar("show_iniciado", "intencao" to intent.name.lowercase(), "gate" to gen)
        aoIniciarAnuncio()
        provider.show(
            host,
            aoAbrir = { aoAbrirOverlay(gen) },
            aoTerminar = { resultado -> aoTerminalDoAnuncio(gen, resultado) },
        )
    }

    /**
     * Dica do SDK de que o anuncio comecou (`onUnityAdsShowStart`). Serve como
     * fallback caso o SDK nao use uma Activity separada neste aparelho; o sinal
     * definitivo de overlay presente vem do lifecycle da Activity do anuncio.
     */
    private fun aoAbrirOverlay(gen: Int) {
        val b = barreira ?: return
        if (b.gen != gen || b.liberado) return
        b.sdkMostrou = true
        registrar("ads_overlay_aberto", "gate" to gen)
    }

    /**
     * Uma Activity do fluxo do anuncio foi criada por cima da nossa. E o sinal
     * REAL de "overlay presente" — enquanto existir, [tentarRelease] nunca libera.
     * `classe` e so o nome simples, para provar no log qual Activity o SDK usa.
     */
    fun aoOverlayCriado(classe: String) {
        val b = barreira ?: return
        b.overlaysVivos += 1
        b.overlayJaAbriu = true
        registrar("ads_overlay_activity_created", "classe" to classe, "vivos" to b.overlaysVivos, "gate" to b.gen)
    }

    fun aoOverlayResumido(classe: String) {
        val b = barreira ?: return
        registrar("ads_overlay_activity_resumed", "classe" to classe, "gate" to b.gen)
    }

    fun aoOverlayPausado(classe: String) {
        val b = barreira ?: return
        registrar("ads_overlay_activity_paused", "classe" to classe, "gate" to b.gen)
    }

    /**
     * Uma Activity do anuncio foi destruida. Quando a ultima some, o overlay
     * deixou de existir; combinado com a MainActivity focada, e o fechamento
     * visual real — inclusive depois de todos os end-cards e Xs intermediarios.
     */
    fun aoOverlayDestruido(classe: String) {
        val b = barreira ?: return
        if (b.overlaysVivos > 0) b.overlaysVivos -= 1
        registrar("ads_overlay_activity_destroyed", "classe" to classe, "vivos" to b.overlaysVivos, "gate" to b.gen)
        tentarRelease(b)
    }

    /**
     * O SDK enviou o callback terminal. So marca `terminalRecebido` — NUNCA
     * libera sozinho (o end-card pode continuar na tela). Se nenhum overlay
     * chegou a existir (falha antes de abrir), nao ha UI sobreposta: fail-open.
     */
    private fun aoTerminalDoAnuncio(gen: Int, resultado: AdShowOutcome) {
        val b = barreira
        if (b == null || b.gen != gen) {
            registrar("ads_callback_ignorado", "motivo" to "stale", "gate" to gen)
            return
        }
        if (b.terminalRecebido) {
            registrar("ads_callback_ignorado", "motivo" to "duplicate", "gate" to gen)
            return
        }
        b.terminalRecebido = true
        b.resultado = resultado
        registrar("ads_unity_terminal_recebido", "resultado" to resultado.name.lowercase(), "gate" to gen)
        if (!b.overlayJaAbriu && !b.sdkMostrou) {
            // Falha antes de qualquer overlay: nao ha UI do anuncio sobreposta.
            confirmarRelease(b, "sem_overlay")
        } else {
            tentarRelease(b)
        }
    }

    /**
     * A MainActivity ganhou (ou perdeu) foco. Enquanto qualquer Activity do
     * anuncio ainda existir, um `focado=true` e so um foco intermediario entre
     * telas do anuncio e NAO pode liberar ([ads_focus_ignorado_overlay_ativo]).
     */
    fun aoMainFoco(focado: Boolean) {
        val b = barreira ?: return
        b.mainFocada = focado
        if (!focado) return
        if (b.overlaysVivos > 0) {
            registrar("ads_focus_ignorado_overlay_ativo", "vivos" to b.overlaysVivos, "gate" to b.gen)
            return
        }
        tentarRelease(b)
    }

    /**
     * Libera se e so se: algum overlay chegou a existir, nenhum overlay do
     * anuncio continua vivo, e a MainActivity esta focada de novo. Enquanto nao,
     * registra a espera. `mesma geracao` e garantido por operar so na barreira
     * corrente.
     */
    private fun tentarRelease(b: Barreira) {
        if (b.liberado) return
        val abriuAlgum = b.overlayJaAbriu || b.sdkMostrou
        if (!abriuAlgum) return
        if (b.overlaysVivos > 0) {
            registrar("ads_waiting_dismiss", "motivo" to "overlay_vivo", "vivos" to b.overlaysVivos, "gate" to b.gen)
            return
        }
        if (!b.mainFocada) {
            registrar("ads_waiting_dismiss", "motivo" to "sem_foco", "gate" to b.gen)
            return
        }
        registrar("ads_dismiss_confirmed", "gate" to b.gen)
        confirmarRelease(b, "dismiss+focus")
    }

    /**
     * A Activity host foi destruida com um anuncio em andamento: cancela a
     * barreira SEM liberar. O toque foi abandonado junto com a tela; um callback
     * tardio (foco, terminal, overlay) da geracao cancelada nao encontra mais a
     * barreira e para.
     */
    fun aoDestruirHost() {
        val b = barreira ?: return
        if (b.liberado) return
        b.liberado = true
        emExibicao = false
        barreira = null
        registrar("ads_hold_cancelado", "motivo" to "host_destruido", "gate" to b.gen)
    }

    /** Fechamento real confirmado (ou sem overlay): libera exatamente uma vez. */
    private fun confirmarRelease(b: Barreira, motivo: String) {
        if (b.liberado) return
        b.liberado = true
        emExibicao = false
        barreira = null
        registrar("show_terminado", "resultado" to b.resultado.name.lowercase(), "gate" to b.gen)
        registrar("ads_release_confirmed", "motivo" to motivo, "gate" to b.gen)
        if (b.resultado == AdShowOutcome.EXIBIDO && b.intent == PlaybackIntent.EPISODIO) {
            seriesPolicy.aoConsumirAnuncio()
        }
        // Proximo interstitial a caminho assim que este e consumido — nunca no
        // instante exato em que o usuario toca em ASSISTIR.
        provider.preload()
        b.liberar.executar()
    }

    /**
     * Estado de uma exibicao, amarrado a uma geracao. Maquina de estados:
     * SHOW_REQUESTED -> OVERLAY_PRESENT (overlaysVivos>0) -> [terminalRecebido] ->
     * WAITING_DISMISS -> DISMISSED (overlaysVivos==0 && mainFocada) -> RELEASED.
     * Um novo anuncio incrementa a geracao; callback tardio do anterior nao acha
     * a barreira dele e para.
     */
    private class Barreira(
        val gen: Int,
        val intent: PlaybackIntent,
        val liberar: ContinuacaoUnica,
    ) {
        /** onUnityAdsShowStart: dica do SDK (fallback sem Activity separada). */
        var sdkMostrou = false

        /** Alguma Activity do anuncio ja existiu (sinal real de overlay). */
        var overlayJaAbriu = false

        /** Quantas Activities do anuncio estao vivas agora. */
        var overlaysVivos = 0

        /** onUnityAdsShowComplete/Failure — nunca libera sozinho. */
        var terminalRecebido = false

        /** A MainActivity esta focada agora. Comeca focada (o show sai dela). */
        var mainFocada = true

        var liberado = false
        var resultado: AdShowOutcome = AdShowOutcome.NAO_EXIBIDO
    }

    private fun registrar(evento: String, vararg campos: Pair<String, Any?>) {
        ObaLog.evento(FASE, evento, *campos)
    }

    /**
     * Continuacao idempotente.
     *
     * Uma intencao de reproducao nunca pode chamar a continuacao duas vezes: um
     * SDK que dispare `onShowComplete` e `onShowFailure`, ou a callback real
     * chegando junto com o watchdog, resultaria em duas reproducoes iniciadas
     * para o mesmo toque.
     */
    private class ContinuacaoUnica(private val acao: () -> Unit) {
        private val gasta = AtomicBoolean(false)

        fun executar() {
            if (gasta.compareAndSet(false, true)) {
                ObaLog.evento(FASE, "ads_continue_playback")
                acao()
            }
        }
    }

    companion object {
        /** Fase propria na trilha do [ObaLog], ao lado de player/cdn/extracao. */
        const val FASE = "anuncio"
    }
}
