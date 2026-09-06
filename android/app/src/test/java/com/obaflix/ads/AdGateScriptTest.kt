package com.obaflix.ads

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.mozilla.javascript.Context
import org.mozilla.javascript.Scriptable

/**
 * A barreira de reproducao do anuncio, exercitada de verdade.
 *
 * O teste fisico falhou porque o player ESCAPOU do AD_HOLD: `js_reproduzindo`
 * apareceu dez segundos antes do fim do anuncio. A barreira que impede isso e
 * JavaScript — bloqueio de `play()`, listeners de captura, freio dos vigias de
 * primeiro-frame — e nenhum teste do lado Kotlin a enxerga. Por isso aqui o
 * script roda num motor JS real (Rhino), sobre o ambiente minimo de
 * `adgate-harness.js`, com relogio controlado.
 *
 * O que se afirma e comportamento observavel, nunca o texto do script: midia
 * parada, `currentTime` em zero, vigia que nao troca de servidor por tras do
 * anuncio, entrega adiada que roda uma vez so na liberacao.
 *
 * A maquina de estados do fechamento (overlay + foco) e do lado nativo e esta
 * em [PlaybackAdGateTest].
 */
class AdGateScriptTest {

    private lateinit var cx: Context
    private lateinit var scope: Scriptable

    @Before
    fun setUp() {
        cx = Context.enter()
        // Interpretado: o script e grande e nao ha ganho em compilar para
        // bytecode num teste.
        cx.optimizationLevel = -1
        cx.languageVersion = Context.VERSION_ES6
        scope = ambienteNovo()
    }

    @After
    fun tearDown() {
        Context.exit()
    }

    // ---- infraestrutura ----------------------------------------------------

    private val harness: String by lazy {
        checkNotNull(javaClass.getResourceAsStream("/adgate-harness.js")) {
            "adgate-harness.js ausente em src/test/resources"
        }.bufferedReader().use { it.readText() }
    }

    /** Um "documento" novo: ambiente limpo com o script ja injetado. */
    private fun ambienteNovo(sessaoSalva: String? = null, rotaInicial: String? = null): Scriptable {
        val s = cx.initStandardObjects()
        cx.evaluateString(s, harness, "adgate-harness.js", 1, null)
        if (sessaoSalva != null) {
            cx.evaluateString(
                s, "sessionStorage.setItem('__obaflixAdHold', '$sessaoSalva');", "sessao", 1, null,
            )
        }
        // A pagina ja aberta num episodio: e assim que o player existe quando o
        // usuario toca em "proximo".
        if (rotaInicial != null) {
            cx.evaluateString(s, "irPara('$rotaInicial');", "rota", 1, null)
        }
        cx.evaluateString(s, AdGateScript.paraCapability(CAPABILITY), "adgate.js", 1, null)
        return s
    }

    /** Ambiente ja dentro do player, no episodio T1 E`numero`. */
    private fun noPlayer(numero: Int = 1): Scriptable =
        ambienteNovo(rotaInicial = "/assistir/serie/77/1/$numero")

    private fun js(codigo: String, alvo: Scriptable = scope): Any? =
        cx.evaluateString(alvo, codigo, "teste", 1, null)

    private fun texto(codigo: String, alvo: Scriptable = scope) =
        Context.toString(js(codigo, alvo))

    private fun bool(codigo: String, alvo: Scriptable = scope) =
        Context.toBoolean(js(codigo, alvo))

    private fun num(codigo: String, alvo: Scriptable = scope) =
        Context.toNumber(js(codigo, alvo))

    private fun quantos(evento: String, alvo: Scriptable = scope) =
        num("contarLog('$evento')", alvo).toInt()

    // ---- barreira: nada toca durante o hold --------------------------------

    @Test
    fun `play durante o hold e barrado sem tocar e sem virar violacao`() {
        js("window.__gate = armarHold('/assistir/filme/123')")
        assertTrue("o hold precisa ficar armado", texto("logs()").contains("ads_hold_armed"))

        js("window.__v = novoVideo(); window.__v.play();")

        assertTrue("a midia nao pode sair do pausado", bool("window.__v.paused"))
        assertEquals(0.0, num("window.__v.currentTime"), 0.0)
        assertEquals("tentativa barrada e o mecanismo funcionando", 1, quantos("ads_play_bloqueado"))
        assertEquals("barrar nao e escapar", 0, quantos("ads_hold_violation"))
    }

    @Test
    fun `evento playing durante o hold e violacao e para a midia na hora`() {
        js("window.__gate = armarHold()")
        js("window.__v = novoVideo(); window.__v.paused = false; window.__v.currentTime = 5;")

        js("disparar('playing', window.__v)")

        assertTrue("o player escapou: tem de ser pausado imediatamente", bool("window.__v.paused"))
        assertEquals("e o tempo volta para zero", 0.0, num("window.__v.currentTime"), 0.0)
        assertEquals(1, quantos("ads_hold_violation"))
    }

    @Test
    fun `timeupdate so vira violacao quando o tempo realmente andou`() {
        js("window.__gate = armarHold()")
        js("window.__v = novoVideo()")

        js("disparar('timeupdate', window.__v)")
        assertEquals("tempo em zero e ruido de carga, nao escape", 0, quantos("ads_hold_violation"))

        js("window.__v.currentTime = 2; disparar('timeupdate', window.__v);")
        assertEquals("tempo andando com o anuncio na tela e escape", 1, quantos("ads_hold_violation"))
        assertEquals(0.0, num("window.__v.currentTime"), 0.0)
    }

    @Test
    fun `callback de outro gate nao solta a barreira`() {
        js("window.__gate = armarHold()")

        js("window.__obaflixAdGateResume('gfalso')")

        js("window.__v = novoVideo(); window.__v.play();")
        assertTrue("resume de gate estranho nao pode liberar", bool("window.__v.paused"))
    }

    // ---- vigias do player: espera intencional nao e falha -------------------

    @Test
    fun `vigia de primeiro frame nao dispara no hold e ganha prazo cheio depois`() {
        js("window.__gate = armarHold()")
        // Mesmo formato do vigia real do player: setTimeout longo que, sem
        // primeiro frame, troca de servidor.
        js("window.__trocasDeServidor = 0; setTimeout(function () { window.__trocasDeServidor++; }, 7000);")

        js("avancarRelogio(7000)")
        assertEquals(
            "failover por tras do anuncio e exatamente o que nao pode acontecer",
            0.0, num("window.__trocasDeServidor"), 0.0,
        )
        assertEquals(1, quantos("ads_hold_timer_adiado"))

        js("window.__obaflixAdGateResume(window.__gate)")
        assertEquals("rearmar nao e disparar", 0.0, num("window.__trocasDeServidor"), 0.0)
        assertEquals(1, quantos("ads_hold_timer_rearmado"))

        js("avancarRelogio(6999)")
        assertEquals("o prazo recomeca inteiro", 0.0, num("window.__trocasDeServidor"), 0.0)
        js("avancarRelogio(1)")
        assertEquals(
            "fora do anuncio o vigia volta a valer",
            1.0, num("window.__trocasDeServidor"), 0.0,
        )
    }

    @Test
    fun `timer curto continua correndo durante o hold`() {
        js("window.__gate = armarHold()")
        js("window.__ui = 0; setTimeout(function () { window.__ui++; }, 500);")

        js("avancarRelogio(500)")

        assertEquals("o freio e so para os vigias, nao para a UI", 1.0, num("window.__ui"), 0.0)
    }

    @Test
    fun `espera durante o hold nao chega a sonda de travamento`() {
        js("window.__gate = armarHold()")
        js(
            """
            window.__v = novoVideo();
            window.__travamentos = 0;
            window.__v.addEventListener('waiting', function () { window.__travamentos++; });
            """.trimIndent(),
        )

        js("disparar('waiting', window.__v)")
        assertEquals(
            "esperar com anuncio na tela e intencional: nao pode virar js_travado",
            0.0, num("window.__travamentos"), 0.0,
        )
        assertEquals(1, quantos("ads_hold_waiting_suprimido"))

        js("window.__obaflixAdGateResume(window.__gate)")
        js("disparar('waiting', window.__v)")
        assertEquals(
            "fora do hold, travamento real continua sendo visto",
            1.0, num("window.__travamentos"), 0.0,
        )
    }

    // ---- entrega adiada e liberacao ----------------------------------------

    @Test
    fun `entrega da extracao e adiada e roda uma vez na liberacao`() {
        js("window.__gate = armarHold()")
        js("window.__entregas = 0")

        assertTrue(
            "com o anuncio na tela a entrega precisa ser adiada",
            bool("window.__obaflixAdGateDefer(function () { window.__entregas++; })"),
        )
        assertEquals(0.0, num("window.__entregas"), 0.0)
        assertEquals("a preparacao por tras do anuncio continua valendo", 1, quantos("ads_preload_ready"))

        js("window.__obaflixAdGateResume(window.__gate)")

        assertEquals(1.0, num("window.__entregas"), 0.0)
        assertEquals(1, quantos("ads_hold_cleared"))
    }

    @Test
    fun `apos a liberacao a midia recebe um autoplay e o play volta ao normal`() {
        js("window.__gate = armarHold()")
        js("window.__v = novoVideo(); window.__v.play();")
        assertTrue(bool("window.__v.paused"))

        js("window.__obaflixAdGateResume(window.__gate)")
        assertFalse("quem tentou tocar durante o anuncio recebe UM autoplay", bool("window.__v.paused"))

        js("window.__v.pause(); window.__v.play();")
        assertFalse("o play do documento volta a ser o original", bool("window.__v.paused"))
    }

    @Test
    fun `sem hold nada e interceptado`() {
        assertFalse("sem anuncio, nada a adiar", bool("window.__obaflixAdGateDefer(function () {})"))

        js("window.__v = novoVideo(); window.__v.play(); disparar('playing', window.__v);")

        assertFalse("fora do anuncio o player toca normalmente", bool("window.__v.paused"))
        assertEquals(0, quantos("ads_hold_violation"))
        assertEquals(0, quantos("ads_play_bloqueado"))
    }

    // ---- persistencia entre navegacoes -------------------------------------

    @Test
    fun `hold restaurado num documento novo ja bloqueia antes do autoplay`() {
        js("window.__gate = armarHold()")
        val salvo = texto("sessionStorage.getItem('__obaflixAdHold')")
        assertNotNull("o hold precisa ser espelhado para sobreviver a um load novo", salvo)

        // Load novo: window recriado, mesmo sessionStorage, script reinjetado.
        val documentoNovo = ambienteNovo(sessaoSalva = salvo)

        assertEquals(1, quantos("ads_hold_restaurado", documentoNovo))
        js("window.__v = novoVideo(); window.__v.play();", documentoNovo)
        assertTrue(
            "o bloqueio precisa estar de pe antes de o player poder dar autoplay",
            bool("window.__v.paused", documentoNovo),
        )
    }

    // ---- interceptacao do clique -------------------------------------------

    @Test
    fun `clique em filme e episodio vira intencao e outros destinos passam direto`() {
        js("clicar('/assistir/filme/123')")
        js("clicar('/assistir/serie/9/1/2')")
        js("clicar('/filme/123')")
        js("clicar('/perfil')")

        assertEquals(2.0, num("pedidos.length"), 0.0)
        assertEquals("movie", texto("pedidos[0].tipo"))
        assertEquals("episode", texto("pedidos[1].tipo"))
    }

    @Test
    fun `sem resposta do lado nativo a navegacao segue sozinha`() {
        js("window.__gate = clicar('/assistir/filme/123')")
        assertEquals("a navegacao fica retida ate o gate decidir", 0.0, num("ultimaAncora.cliques"), 0.0)

        js("avancarRelogio(10000)")

        assertEquals("fail-open: o usuario assiste", 1.0, num("ultimaAncora.cliques"), 0.0)
    }

    // ---- troca de episodio dentro do player --------------------------------

    @Test
    fun `proximo episodio no player vira intencao com origem player`() {
        val p = noPlayer(1)

        js("window.__g = trocarEpisodio(1, 2).id", p)

        assertEquals("a troca interna precisa chegar ao gate", 1.0, num("pedidos.length", p), 0.0)
        assertEquals("episode", texto("pedidos[0].tipo", p))
        assertEquals("player", texto("pedidos[0].origem", p))
        assertTrue(texto("logs()", p).contains("ads_episode_intent:player_next"))
    }

    @Test
    fun `anterior e selecao explicita tambem passam pelo gate`() {
        val p = noPlayer(3)

        js("window.__g = trocarEpisodio(1, 2).id", p)
        js("responderLivre(window.__g)", p)
        js("window.__g = trocarEpisodio(1, 7).id", p)

        assertEquals(2.0, num("pedidos.length", p), 0.0)
        val log = texto("logs()", p)
        assertTrue("voltar um episodio e intencao", log.contains("ads_episode_intent:player_previous"))
        assertTrue("pular para outro episodio e intencao", log.contains("ads_episode_intent:player_select"))
    }

    @Test
    fun `troca automatica no fim do episodio e rotulada como auto`() {
        val p = noPlayer(1)

        js("window.__g = trocarEpisodioSemGesto(1, 2).id", p)

        assertTrue(
            "sem toque recente o log precisa dizer que a troca foi automatica",
            texto("logs()", p).contains("ads_episode_intent:player_next_auto"),
        )
        assertEquals("e ela continua sendo uma intencao de iniciar outro episodio", 1.0, num("pedidos.length", p), 0.0)
    }

    @Test
    fun `entrada pelo catalogo nao conta de novo na rota que ela mesma provoca`() {
        js("window.__g = clicar('/assistir/serie/77/1/1')")
        js("responderLivre(window.__g)")

        // O Next grava a rota do episodio que o gate acabou de decidir.
        js("rotaDoPlayer('/assistir/serie/77/1/1')")

        assertEquals("uma intencao, uma decisao", 1.0, num("pedidos.length"), 0.0)
        assertEquals("catalogo", texto("pedidos[0].origem"))
    }

    @Test
    fun `clique duplicado no proximo conta uma vez so`() {
        val p = noPlayer(1)

        js("window.__g = trocarEpisodio(1, 2).id", p)
        js("rotaDoPlayer(caminhoDoEpisodio(1, 2))", p) // segundo evento do mesmo toque
        js("window.history.replaceState({}, '', caminhoDoEpisodio(1, 2))", p)

        assertEquals("a mesma rota nao pode virar duas intencoes", 1.0, num("pedidos.length", p), 0.0)
    }

    @Test
    fun `voltar ao episodio cuja decisao ainda esta em voo nao conta de novo`() {
        val p = noPlayer(1)

        js("trocarEpisodio(1, 2)", p) // decisao em voo
        js("trocarEpisodio(1, 3)", p)
        js("trocarEpisodio(1, 2)", p) // volta antes de a primeira responder

        assertEquals(2.0, num("pedidos.length", p), 0.0)
        assertTrue(texto("logs()", p).contains("ads_episode_intent_dedup:em_voo"))
    }

    @Test
    fun `retry failover resume e remontagem do player nao contam como intencao`() {
        val p = noPlayer(4)

        // Nada disso muda a rota — e por isso que nada disso conta.
        js("rotaDoPlayer(caminhoDoEpisodio(1, 4))", p)                          // reload interno
        js("window.history.replaceState({}, '', caminhoDoEpisodio(1, 4))", p)   // resume
        js("window.__v = novoVideo(); disparar('error', window.__v);", p)       // erro de midia
        js("avancarRelogio(60000)", p)                                          // vigias e retries

        assertEquals("nenhuma dessas coisas e um episodio novo", 0.0, num("pedidos.length", p), 0.0)
    }

    // ---- barreira provisoria da troca interna ------------------------------

    @Test
    fun `o episodio novo nao toca entre a intencao e a decisao`() {
        val p = noPlayer(1)

        js("window.__g = trocarEpisodio(1, 2).id", p)
        js("window.__v = novoVideo(); window.__v.play();", p)

        assertTrue("a rota ja trocou: a barreira tem de estar de pe antes da decisao", bool("window.__v.paused", p))
        assertEquals(1, quantos("ads_play_bloqueado", p))
        assertEquals(0, quantos("ads_hold_violation", p))
    }

    @Test
    fun `midia do episodio anterior e silenciada sem virar violacao nem perder progresso`() {
        val p = noPlayer(1)
        js("window.__ant = novoVideo(); window.__ant.paused = false; window.__ant.currentTime = 1200;", p)

        js("trocarEpisodio(1, 2)", p)
        js("disparar('timeupdate', window.__ant)", p)

        assertTrue("o episodio que estava tocando precisa parar", bool("window.__ant.paused", p))
        assertEquals(
            "zerar aqui atropelaria o progresso que o player acabou de salvar",
            1200.0, num("window.__ant.currentTime", p), 0.0,
        )
        assertEquals(0, quantos("ads_hold_violation", p))
        assertEquals(1, quantos("ads_hold_midia_anterior_pausada", p))

        // A cortesia vale uma vez: se ela voltar a tocar, conta como qualquer outra.
        js("disparar('playing', window.__ant)", p)
        assertEquals(1, quantos("ads_hold_violation", p))
    }

    @Test
    fun `decisao livre solta a barreira provisoria na hora`() {
        val p = noPlayer(1)
        js("window.__g = trocarEpisodio(1, 2).id", p)

        js("responderLivre(window.__g)", p)

        js("window.__v = novoVideo(); window.__v.play();", p)
        assertFalse("episodio livre toca normalmente", bool("window.__v.paused", p))
        assertTrue(texto("logs()", p).contains("ads_release:livre"))
    }

    @Test
    fun `decisao de anuncio confirma a mesma barreira e preserva o que ja foi preparado`() {
        val p = noPlayer(1)
        js("window.__g = trocarEpisodio(1, 2).id", p)
        js("window.__entregas = 0", p)

        // Extracao do episodio novo resolve enquanto a barreira provisoria esta de pe.
        assertTrue(bool("window.__obaflixAdGateDefer(function () { window.__entregas++; })", p))

        js("responderAnuncio(window.__g)", p)
        assertTrue(
            "confirmar nao pode rearmar: rearmar descartaria a fila como stale",
            texto("logs()", p).contains("ads_hold_confirmado"),
        )
        assertEquals("com o anuncio na tela nada e entregue", 0.0, num("window.__entregas", p), 0.0)

        js("responderLivre(window.__g)", p) // fechamento real do overlay
        assertEquals(
            "a preparacao feita por tras do anuncio precisa sobreviver",
            1.0, num("window.__entregas", p), 0.0,
        )
    }

    @Test
    fun `sem resposta do lado nativo a barreira da troca interna cai sozinha`() {
        val p = noPlayer(1)
        js("trocarEpisodio(1, 2)", p)

        // O fail-open do gate usa o setTimeout original de proposito: se ele
        // passasse pelo freio dos vigias, a barreira seguraria o proprio prazo
        // que deveria solta-la, e a reproducao ficaria presa para sempre.
        js("avancarRelogio(10000)", p)

        js("window.__v = novoVideo(); window.__v.play();", p)
        assertFalse("fail-open: o usuario assiste", bool("window.__v.paused", p))
    }

    // ---- sequencia completa, script + gate nativo de verdade ---------------

    private class ContadorEmMemoria(override var episodiosNoCiclo: Int = 0) : AdCounterStore

    private class HostDeTeste : AdHost {
        override val disponivel = true
    }

    private class ProviderDeTeste : InterstitialAdProvider {
        var exibicoes = 0
        var terminal: ((AdShowOutcome) -> Unit)? = null
        override fun initialize() = Unit
        override val pronto = true
        override fun preload() = Unit
        override fun show(host: AdHost, aoAbrir: () -> Unit, aoTerminar: (AdShowOutcome) -> Unit) {
            exibicoes++
            aoAbrir()
            terminal = aoTerminar
        }
    }

    /**
     * A sequencia inteira, com as duas metades ligadas: o script produz as
     * intencoes (clique no catalogo e trocas dentro do player), o
     * [PlaybackAdGate] real decide, e a resposta volta para o script. E o unico
     * teste que prova a frase do produto — a ordem nao muda conforme o caminho
     * que o usuario tomou.
     */
    @Test
    fun `ep1 e ep2 livres, ep3 anuncio, ep4 e ep5 livres, ep6 anuncio — venha do catalogo ou do player`() {
        val provider = ProviderDeTeste()
        val store = ContadorEmMemoria()
        val gate = PlaybackAdGate(provider, SeriesAdFrequencyPolicy(store))
        val host = HostDeTeste()
        val p = ambienteNovo()

        fun decidir(gateId: String): Boolean {
            var comAnuncio = false
            gate.requestPlayback(
                host, PlaybackIntent.EPISODIO,
                aoIniciarAnuncio = {
                    comAnuncio = true
                    js("responderAnuncio('$gateId')", p)
                },
                liberarReproducao = { js("responderLivre('$gateId')", p) },
            )
            if (comAnuncio) {
                // Fechamento visual real, como em PlaybackAdGateTest.
                gate.aoOverlayCriado("AdUnitActivity")
                gate.aoMainFoco(false)
                provider.terminal!!(AdShowOutcome.EXIBIDO)
                gate.aoOverlayDestruido("AdUnitActivity")
                gate.aoMainFoco(true)
            }
            return comAnuncio
        }

        fun ultimoId() = texto("ultimoPedido().id", p)

        // ep1: entrada pelo catalogo.
        js("clicar('/assistir/serie/77/1/1')", p)
        assertFalse("ep1 e livre", decidir(ultimoId()))

        // ep2..ep6: tudo dentro do player.
        js("trocarEpisodio(1, 2)", p)
        assertFalse("ep2 e livre", decidir(ultimoId()))

        js("trocarEpisodio(1, 3)", p)
        assertTrue("ep3 paga o anuncio", decidir(ultimoId()))

        js("trocarEpisodio(1, 4)", p)
        assertFalse("ciclo reiniciado: ep4 livre", decidir(ultimoId()))

        js("trocarEpisodio(1, 5)", p)
        assertFalse("ep5 livre", decidir(ultimoId()))

        js("trocarEpisodio(1, 6)", p)
        assertTrue("ep6 paga o anuncio", decidir(ultimoId()))

        assertEquals("seis intencoes, seis decisoes", 6.0, num("pedidos.length", p), 0.0)
        assertEquals("dois anuncios em seis episodios", 2, provider.exibicoes)
        assertEquals(
            "o contador vive so no lado nativo",
            0, store.episodiosNoCiclo,
        )
    }

    private companion object {
        const val CAPABILITY = "cap-de-teste"
    }
}
