package com.obaflix.ads

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * Regras de anuncio antes da reproducao, em JVM pura.
 *
 * Nada aqui toca o SDK da Unity nem Activity: e exatamente para isso que existem
 * [InterstitialAdProvider] e [AdHost]. O que se verifica e o comportamento
 * observavel pelo usuario — quando aparece anuncio, quando nao aparece, e que a
 * reproducao e liberada uma vez em todos os casos.
 */
class PlaybackAdGateTest {

    // ---- dubles -----------------------------------------------------------

    private class StoreEmMemoria(override var episodiosNoCiclo: Int = 0) : AdCounterStore

    private class HostFalso(override val disponivel: Boolean = true) : AdHost

    /**
     * Provedor controlado pelo teste.
     *
     * [abrirAutomaticamente] modela `onUnityAdsShowStart` (dica do SDK) disparando
     * [aoAbrir] assim que `show` e chamado. [terminarAutomaticamente] falso deixa
     * o terminal pendurado, para dirigir a ordem overlay/terminal/foco a mao — que
     * e o que importa na barreira de fechamento real.
     */
    private class ProviderFalso(
        var pronto_: Boolean = true,
        val terminarAutomaticamente: Boolean = false,
        val abrirAutomaticamente: Boolean = true,
        val resultado: AdShowOutcome = AdShowOutcome.EXIBIDO,
    ) : InterstitialAdProvider {

        var inicializacoes = 0
        var preloads = 0
        var exibicoes = 0
        var ultimaAbrir: (() -> Unit)? = null
        var ultimaCallback: ((AdShowOutcome) -> Unit)? = null

        override fun initialize() { inicializacoes++ }
        override val pronto: Boolean get() = pronto_
        override fun preload() { preloads++ }

        override fun show(host: AdHost, aoAbrir: () -> Unit, aoTerminar: (AdShowOutcome) -> Unit) {
            exibicoes++
            ultimaAbrir = aoAbrir
            ultimaCallback = aoTerminar
            if (abrirAutomaticamente) aoAbrir()
            if (terminarAutomaticamente) aoTerminar(resultado)
        }
    }

    private lateinit var store: StoreEmMemoria
    private val host = HostFalso()
    private var ultimoProvider: ProviderFalso? = null

    @Before
    fun setUp() {
        store = StoreEmMemoria()
    }

    private fun gate(
        provider: ProviderFalso,
        adsEnabled: () -> Boolean = { true },
    ) = PlaybackAdGate(provider, SeriesAdFrequencyPolicy(store), adsEnabled)
        .also { ultimoProvider = provider }

    /**
     * Nome fixo do overlay simulado — modela a Activity do interstitial do Unity.
     */
    private val OVERLAY = "AdUnitActivity"

    /**
     * Simula o ciclo de vida REAL do overlay do anuncio ate o fechamento visual:
     * a MainActivity perde foco, a Activity do anuncio nasce, o SDK completa
     * (end-card ainda na tela), a Activity do anuncio e destruida e so entao a
     * MainActivity volta ao foco. E o unico caminho que deve liberar.
     */
    private fun PlaybackAdGate.simularFechamentoRealDoAnuncio(resultado: AdShowOutcome) {
        aoMainFoco(false)
        aoOverlayCriado(OVERLAY)
        ultimoProvider?.ultimaCallback?.invoke(resultado) // terminal (complete/failure)
        aoOverlayDestruido(OVERLAY)
        aoMainFoco(true)
    }

    /**
     * Caminho feliz de uma intencao: pede a reproducao e, quando houve exibicao,
     * simula o fechamento real do overlay. Para caminhos sem anuncio, nada disso
     * ocorre. Retorna quantas vezes a reproducao foi liberada.
     */
    private fun PlaybackAdGate.pedir(intent: PlaybackIntent): Int {
        var liberacoes = 0
        requestPlayback(host, intent) { liberacoes++ }
        if (anuncioEmExibicao) {
            simularFechamentoRealDoAnuncio(ultimoProvider?.resultado ?: AdShowOutcome.EXIBIDO)
        }
        return liberacoes
    }

    // ---- filmes -----------------------------------------------------------

    @Test
    fun `filme exibe anuncio em toda intencao de ASSISTIR`() {
        val provider = ProviderFalso()
        val gate = gate(provider)

        repeat(3) { assertEquals(1, gate.pedir(PlaybackIntent.FILME)) }

        assertEquals("todo toque em ASSISTIR passa pelo interstitial", 3, provider.exibicoes)
    }

    @Test
    fun `filme nao consome o ciclo das series`() {
        val provider = ProviderFalso()
        val gate = gate(provider)

        repeat(5) { gate.pedir(PlaybackIntent.FILME) }

        assertEquals(0, store.episodiosNoCiclo)
    }

    // ---- series: um anuncio a cada 2 episodios -----------------------------

    @Test
    fun `dois episodios livres e anuncio na proxima intencao`() {
        val provider = ProviderFalso()
        val gate = gate(provider)

        gate.pedir(PlaybackIntent.EPISODIO) // ep 1 — livre
        assertEquals(0, provider.exibicoes)

        gate.pedir(PlaybackIntent.EPISODIO) // ep 2 — livre
        assertEquals(0, provider.exibicoes)

        gate.pedir(PlaybackIntent.EPISODIO) // ep 3 — cota gasta, exibe e reinicia
        assertEquals(1, provider.exibicoes)

        gate.pedir(PlaybackIntent.EPISODIO) // ep 4 — livre
        gate.pedir(PlaybackIntent.EPISODIO) // ep 5 — livre
        assertEquals(1, provider.exibicoes)

        gate.pedir(PlaybackIntent.EPISODIO) // ep 6 — exibe de novo
        assertEquals(2, provider.exibicoes)
    }

    @Test
    fun `serie sempre libera a reproducao, com anuncio ou sem`() {
        val provider = ProviderFalso()
        val gate = gate(provider)

        repeat(6) { assertEquals(1, gate.pedir(PlaybackIntent.EPISODIO)) }
    }

    @Test
    fun `ciclo continua devendo quando nao havia anuncio carregado`() {
        val provider = ProviderFalso(pronto_ = false)
        val gate = gate(provider)

        gate.pedir(PlaybackIntent.EPISODIO) // ep 1 — livre
        gate.pedir(PlaybackIntent.EPISODIO) // ep 2 — livre
        gate.pedir(PlaybackIntent.EPISODIO) // ep 3 — devia exibir, sem inventario
        assertEquals(0, provider.exibicoes)

        // Sem inventario o contador nao avanca: a proxima intencao tenta de novo,
        // em vez de empurrar o anuncio para dois episodios adiante.
        provider.pronto_ = true
        gate.pedir(PlaybackIntent.EPISODIO) // ep 4
        assertEquals(1, provider.exibicoes)
    }

    @Test
    fun `ciclo so reinicia quando o anuncio realmente apareceu`() {
        val provider = ProviderFalso(resultado = AdShowOutcome.NAO_EXIBIDO)
        val gate = gate(provider)

        gate.pedir(PlaybackIntent.EPISODIO) // ep 1 — livre
        gate.pedir(PlaybackIntent.EPISODIO) // ep 2 — livre
        gate.pedir(PlaybackIntent.EPISODIO) // ep 3 — tenta exibir, o show falha

        assertEquals(1, provider.exibicoes)
        assertEquals(
            "falha de exibicao nao pode consumir o ciclo",
            SeriesAdFrequencyPolicy.EPISODIOS_POR_ANUNCIO,
            store.episodiosNoCiclo,
        )
    }

    // ---- anuncioEmExibicao (manter WebView viva no onPause) ----------------

    /**
     * A Activity le [PlaybackAdGate.anuncioEmExibicao] no `onPause` para decidir
     * se mantem a WebView viva (preparando o player por tras do anuncio). Precisa
     * ser true exatamente enquanto o interstitial esta na tela, e voltar a false
     * assim que ele fecha.
     */
    @Test
    fun `anuncioEmExibicao continua verdadeiro ate o overlay sumir com foco`() {
        val provider = ProviderFalso()
        val gate = gate(provider)

        assertFalse("antes de qualquer intencao", gate.anuncioEmExibicao)

        gate.requestPlayback(host, PlaybackIntent.FILME) {}
        gate.aoOverlayCriado(OVERLAY)
        gate.aoMainFoco(false)
        assertTrue("com o overlay do anuncio na tela", gate.anuncioEmExibicao)

        // Terminal do SDK sozinho NAO fecha: o end-card pode continuar na tela.
        provider.ultimaCallback!!(AdShowOutcome.EXIBIDO)
        assertTrue("terminal recebido, overlay ainda vivo", gate.anuncioEmExibicao)

        // Overlay destruido, mas foco ainda nao voltou.
        gate.aoOverlayDestruido(OVERLAY)
        assertTrue("overlay sumiu, mas sem foco ainda", gate.anuncioEmExibicao)

        // So overlay ausente + MainActivity focada confirma o fechamento real.
        gate.aoMainFoco(true)
        assertFalse("overlay sumiu e foco voltou", gate.anuncioEmExibicao)
    }

    @Test
    fun `anuncioEmExibicao permanece falso quando nao ha exibicao`() {
        val provider = ProviderFalso(pronto_ = false) // fail-open, nunca exibe
        val gate = gate(provider)

        gate.pedir(PlaybackIntent.FILME)

        assertFalse(gate.anuncioEmExibicao)
    }

    // ---- Premium (futuro) --------------------------------------------------

    @Test
    fun `adsEnabled falso pula toda a publicidade`() {
        val provider = ProviderFalso()
        val gate = gate(provider, adsEnabled = { false })

        assertEquals(1, gate.pedir(PlaybackIntent.FILME))
        repeat(4) { assertEquals(1, gate.pedir(PlaybackIntent.EPISODIO)) }

        assertEquals("Premium nao ve anuncio", 0, provider.exibicoes)
        assertEquals("nem consome ciclo de serie", 0, store.episodiosNoCiclo)
    }

    // ---- fail-open ---------------------------------------------------------

    @Test
    fun `sem anuncio carregado a reproducao segue e o proximo e pedido`() {
        val provider = ProviderFalso(pronto_ = false)
        val gate = gate(provider)

        assertEquals(1, gate.pedir(PlaybackIntent.FILME))
        assertEquals(0, provider.exibicoes)
        assertTrue("deve pedir o proximo interstitial", provider.preloads >= 1)
    }

    @Test
    fun `tela indisponivel nao segura a reproducao`() {
        val provider = ProviderFalso()
        val gate = gate(provider)

        var liberacoes = 0
        gate.requestPlayback(HostFalso(disponivel = false), PlaybackIntent.FILME) { liberacoes++ }

        assertEquals(1, liberacoes)
        assertEquals(0, provider.exibicoes)
    }

    @Test
    fun `falha de exibicao libera a reproducao mesmo assim`() {
        val provider = ProviderFalso(resultado = AdShowOutcome.NAO_EXIBIDO)
        val gate = gate(provider)

        assertEquals(1, gate.pedir(PlaybackIntent.FILME))
    }

    // ---- concorrencia e idempotencia --------------------------------------

    @Test
    fun `callback duplicada do SDK libera a reproducao uma vez so`() {
        val provider = ProviderFalso()
        val gate = gate(provider)

        var liberacoes = 0
        gate.requestPlayback(host, PlaybackIntent.FILME) { liberacoes++ }
        gate.aoOverlayCriado(OVERLAY)
        gate.aoMainFoco(false)

        val callback = provider.ultimaCallback!!
        callback(AdShowOutcome.EXIBIDO)
        callback(AdShowOutcome.NAO_EXIBIDO) // SDK duplicou, ou watchdog correu junto
        assertEquals("terminal duplicado nao libera com overlay vivo", 0, liberacoes)

        gate.aoOverlayDestruido(OVERLAY)
        gate.aoOverlayDestruido(OVERLAY) // destroy duplicado tambem
        gate.aoMainFoco(true)
        gate.aoMainFoco(true)            // foco duplicado tambem
        assertEquals("uma intencao, uma reproducao", 1, liberacoes)
    }

    @Test
    fun `toque duplo rapido nao abre um segundo anuncio`() {
        val provider = ProviderFalso()
        val gate = gate(provider)

        var primeira = 0
        var segunda = 0
        gate.requestPlayback(host, PlaybackIntent.FILME) { primeira++ }
        gate.aoOverlayCriado(OVERLAY)
        gate.aoMainFoco(false)
        gate.requestPlayback(host, PlaybackIntent.FILME) { segunda++ } // com anuncio na tela

        assertEquals("um anuncio para os dois toques", 1, provider.exibicoes)
        assertEquals("o segundo toque nao fica preso", 1, segunda)

        provider.ultimaCallback!!(AdShowOutcome.EXIBIDO)
        gate.aoOverlayDestruido(OVERLAY)
        gate.aoMainFoco(true)
        assertEquals(1, primeira)
    }

    @Test
    fun `gate volta a funcionar depois que o anuncio fecha`() {
        val provider = ProviderFalso()
        val gate = gate(provider)

        gate.requestPlayback(host, PlaybackIntent.FILME) {}
        gate.simularFechamentoRealDoAnuncio(AdShowOutcome.EXIBIDO)

        gate.pedir(PlaybackIntent.FILME)
        assertEquals(2, provider.exibicoes)
    }

    // ---- barreira: fechamento visual REAL (overlay Activity + foco) --------

    @Test
    fun `overlay ainda vivo com foco nao libera`() {
        val provider = ProviderFalso()
        val gate = gate(provider)

        var liberacoes = 0
        gate.requestPlayback(host, PlaybackIntent.FILME) { liberacoes++ }
        gate.aoOverlayCriado(OVERLAY)
        provider.ultimaCallback!!(AdShowOutcome.EXIBIDO) // complete cedo

        // Um foco intermediario (entre telas/end-cards) com a Activity do anuncio
        // ainda viva NAO pode liberar.
        gate.aoMainFoco(true)
        assertEquals("overlay vivo: foco intermediario nao libera", 0, liberacoes)
    }

    @Test
    fun `complete sem destroy do overlay nao libera`() {
        val provider = ProviderFalso()
        val gate = gate(provider)

        var liberacoes = 0
        gate.requestPlayback(host, PlaybackIntent.FILME) { liberacoes++ }
        gate.aoOverlayCriado(OVERLAY)
        gate.aoMainFoco(false)
        provider.ultimaCallback!!(AdShowOutcome.EXIBIDO)

        assertEquals("conteudo terminou mas a UI do anuncio segue: nao libera", 0, liberacoes)
    }

    @Test
    fun `destroy do overlay sem foco da MainActivity nao libera`() {
        val provider = ProviderFalso()
        val gate = gate(provider)

        var liberacoes = 0
        gate.requestPlayback(host, PlaybackIntent.FILME) { liberacoes++ }
        gate.aoOverlayCriado(OVERLAY)
        gate.aoMainFoco(false)
        gate.aoOverlayDestruido(OVERLAY)

        assertEquals("overlay sumiu mas a MainActivity ainda nao voltou: nao libera", 0, liberacoes)

        gate.aoMainFoco(true)
        assertEquals("com o foco de volta, libera", 1, liberacoes)
    }

    @Test
    fun `destroy do overlay mais foco libera exatamente uma vez`() {
        val provider = ProviderFalso()
        val gate = gate(provider)

        var liberacoes = 0
        gate.requestPlayback(host, PlaybackIntent.FILME) { liberacoes++ }
        gate.aoOverlayCriado(OVERLAY)
        gate.aoMainFoco(false)
        provider.ultimaCallback!!(AdShowOutcome.EXIBIDO)
        gate.aoOverlayDestruido(OVERLAY)
        gate.aoMainFoco(true)
        assertEquals("overlay ausente + foco -> uma liberacao", 1, liberacoes)

        // Nada depois pode liberar de novo.
        gate.aoOverlayDestruido(OVERLAY)
        gate.aoMainFoco(true)
        assertEquals("sem segunda reproducao", 1, liberacoes)
    }

    @Test
    fun `varios X e transicoes de foco nao liberam enquanto o overlay existir`() {
        // Anuncio com varios end-cards: a Activity do anuncio permanece viva; o
        // foco pode oscilar entre telas internas, mas so o desaparecimento real
        // da Activity + foco da MainActivity libera.
        val provider = ProviderFalso()
        val gate = gate(provider)

        var liberacoes = 0
        gate.requestPlayback(host, PlaybackIntent.FILME) { liberacoes++ }
        gate.aoOverlayCriado(OVERLAY)
        gate.aoMainFoco(false)
        provider.ultimaCallback!!(AdShowOutcome.EXIBIDO) // primeiro X / conteudo terminou

        // Varios Xs / oscilacoes de foco, Activity do anuncio ainda viva.
        repeat(3) {
            gate.aoMainFoco(true)
            gate.aoMainFoco(false)
        }
        assertEquals("nenhum X intermediario libera", 0, liberacoes)

        // Ultimo X: a Activity do anuncio some de verdade e a MainActivity volta.
        gate.aoOverlayDestruido(OVERLAY)
        gate.aoMainFoco(true)
        assertEquals("so o fechamento real libera, uma vez", 1, liberacoes)
    }

    @Test
    fun `serie so consome o ciclo no fechamento real, nao no complete`() {
        // O bloqueio de play/pause + ads_hold_violation e do AdGateScript (JS) e
        // nao roda em JVM — a prova fisica e ads_hold_violation=0 e currentTime=0.
        // Aqui fixamos o lado Kotlin: o ciclo da serie so avanca no fechamento
        // real (overlay destruido + foco), nunca no complete cedo.
        val provider = ProviderFalso()
        val gate = gate(provider)

        gate.pedir(PlaybackIntent.EPISODIO) // ep1 livre
        gate.pedir(PlaybackIntent.EPISODIO) // ep2 livre
        assertEquals(2, store.episodiosNoCiclo)

        // ep3: anuncio devido.
        var liberacoes = 0
        gate.requestPlayback(host, PlaybackIntent.EPISODIO) { liberacoes++ }
        gate.aoOverlayCriado(OVERLAY)
        gate.aoMainFoco(false)
        provider.ultimaCallback!!(AdShowOutcome.EXIBIDO) // complete cedo (end-card na tela)
        assertEquals("complete nao libera nem zera o ciclo", 0, liberacoes)
        assertEquals("ciclo ainda devendo enquanto o overlay existe", 2, store.episodiosNoCiclo)

        // Fechamento real.
        gate.aoOverlayDestruido(OVERLAY)
        gate.aoMainFoco(true)
        assertEquals(1, liberacoes)
        assertEquals("ciclo reiniciado so apos o fechamento real", 0, store.episodiosNoCiclo)
    }

    @Test
    fun `callback stale de um anuncio anterior nao libera o gate atual`() {
        val provider = ProviderFalso()
        val gate = gate(provider)

        // Primeiro anuncio: abre, fecha de verdade e libera.
        var primeira = 0
        gate.requestPlayback(host, PlaybackIntent.FILME) { primeira++ }
        gate.aoOverlayCriado(OVERLAY)
        val terminalAntigo = provider.ultimaCallback!!
        gate.aoMainFoco(false)
        terminalAntigo(AdShowOutcome.EXIBIDO)
        gate.aoOverlayDestruido(OVERLAY)
        gate.aoMainFoco(true)
        assertEquals(1, primeira)

        // Segundo anuncio (nova geracao) em andamento.
        var segunda = 0
        gate.requestPlayback(host, PlaybackIntent.FILME) { segunda++ }
        gate.aoOverlayCriado(OVERLAY)
        gate.aoMainFoco(false)

        // Terminal tardio do PRIMEIRO anuncio nao pode liberar o segundo.
        terminalAntigo(AdShowOutcome.EXIBIDO)
        assertEquals("terminal stale nao libera o gate atual", 0, segunda)

        // O segundo so libera com o proprio fechamento real.
        provider.ultimaCallback!!(AdShowOutcome.EXIBIDO)
        gate.aoOverlayDestruido(OVERLAY)
        gate.aoMainFoco(true)
        assertEquals(1, segunda)
    }

    @Test
    fun `falha antes de abrir o overlay e fail-open imediato`() {
        // abrirAutomaticamente=false + terminal imediato: o show falha antes de
        // qualquer overlay, entao NAO ha UI do anuncio sobreposta e libera na hora.
        val provider = ProviderFalso(
            terminarAutomaticamente = true,
            abrirAutomaticamente = false,
            resultado = AdShowOutcome.NAO_EXIBIDO,
        )
        val gate = gate(provider)

        var liberacoes = 0
        gate.requestPlayback(host, PlaybackIntent.FILME) { liberacoes++ }
        assertEquals("sem overlay, fail-open na hora", 1, liberacoes)
    }

    @Test
    fun `activity destruida cancela o hold sem reproduzir`() {
        val provider = ProviderFalso()
        val gate = gate(provider)

        var liberacoes = 0
        gate.requestPlayback(host, PlaybackIntent.FILME) { liberacoes++ }
        gate.aoOverlayCriado(OVERLAY)
        gate.aoMainFoco(false)
        assertTrue("anuncio em andamento", gate.anuncioEmExibicao)

        gate.aoDestruirHost()
        assertFalse("hold cancelado com a tela", gate.anuncioEmExibicao)

        // Callbacks tardios da geracao cancelada nao reproduzem numa tela morta.
        provider.ultimaCallback!!(AdShowOutcome.EXIBIDO)
        gate.aoOverlayDestruido(OVERLAY)
        gate.aoMainFoco(true)
        assertEquals("nada reproduz apos destruir a Activity", 0, liberacoes)
    }

    @Test
    fun `foco sem anuncio em andamento e no-op`() {
        val provider = ProviderFalso()
        val gate = gate(provider)

        // Foco inicial do lancamento do app, sem nenhum anuncio: nao pode liberar
        // nada nem quebrar.
        gate.aoMainFoco(true)
        gate.aoOverlayDestruido(OVERLAY) // evento espurio tambem
        assertEquals(0, provider.exibicoes)
        assertFalse(gate.anuncioEmExibicao)
    }

    @Test
    fun `aviso de inicio de anuncio so sai quando ha anuncio`() {
        val comAnuncio = ProviderFalso(terminarAutomaticamente = false)
        var avisou = false
        gate(comAnuncio).requestPlayback(
            host, PlaybackIntent.FILME,
            aoIniciarAnuncio = { avisou = true },
        ) {}
        assertTrue(avisou)

        val semAnuncio = ProviderFalso(pronto_ = false)
        var avisouSemAnuncio = false
        gate(semAnuncio).requestPlayback(
            host, PlaybackIntent.FILME,
            aoIniciarAnuncio = { avisouSemAnuncio = true },
        ) {}
        assertFalse(avisouSemAnuncio)
    }

    // ---- o que NAO conta como intencao ------------------------------------

    /**
     * Retentativa, buffering, reconexao, troca de servidor, failover automatico
     * e re-resolucao de fonte acontecem dentro da pagina ja aberta: nao ha
     * navegacao, entao [AdGateScript] nao intercepta nada e o gate nunca e
     * chamado. O que este teste fixa e a outra metade da garantia — que **nada**
     * no gate alem de `requestPlayback` mexe no ciclo. Se alguem um dia
     * incrementar o contador em `aquecer`, `preload` ou numa callback do
     * provedor, isto quebra.
     */
    @Test
    fun `so requestPlayback move o ciclo das series`() {
        val provider = ProviderFalso()
        val gate = gate(provider)

        gate.pedir(PlaybackIntent.EPISODIO) // unica intencao real
        assertEquals(1, store.episodiosNoCiclo)

        // Tudo o que uma sessao com falhas dispara no gate e no provedor sem
        // haver um novo toque do usuario.
        repeat(20) {
            gate.aquecer()
            provider.preload()
            provider.ultimaCallback?.invoke(AdShowOutcome.NAO_EXIBIDO)
        }

        assertEquals("ciclo intacto sem nova intencao", 1, store.episodiosNoCiclo)
        assertEquals("e nenhum anuncio a mais", 0, provider.exibicoes)
    }
}
