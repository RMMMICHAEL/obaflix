package com.obaflix.tv.sessao

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * O cliente de sessao contra um servidor simulado com as mesmas regras do
 * backend: access curto, refresh rotativo, reuso revoga a familia, aparelho
 * revogavel.
 *
 * O que se prova aqui e a fronteira entre "access vencido" (renovavel, sem
 * perder nada) e "renovacao recusada" (definitiva), e o que acontece quando a
 * resposta da rotacao se perde.
 */
class SessaoComServidorSimuladoTest {

    /** Regras de `src/lib/tvPairing.ts`, em memoria. */
    private class Servidor {
        private data class Refresh(val familia: Int, var usado: Boolean = false, var revogado: Boolean = false)

        private val refreshes = mutableMapOf<String, Refresh>()
        private val accessValidos = mutableSetOf<String>()
        private var seq = 0
        var foraDoAr = false

        /** So a renovacao falha (ex.: 5xx/timeout em /api/tv/session); a API responde. */
        var renovacaoIndisponivel = false
        var aparelhoRevogado = false

        fun parear(): Pair<String, String> = emitir(familia = 1)

        private fun emitir(familia: Int): Pair<String, String> {
            val access = "access-${++seq}"
            val refresh = "refresh-$seq"
            accessValidos += access
            refreshes[refresh] = Refresh(familia)
            return access to refresh
        }

        fun vencerAccess() = accessValidos.clear()

        /** `POST /api/tv/session`. `null` = sem resposta (servidor fora). */
        fun renovar(refresh: String): Pair<Int, Pair<String, String>?>? {
            if (foraDoAr || renovacaoIndisponivel) return null
            val r = refreshes[refresh] ?: return 401 to null
            if (r.usado) {
                refreshes.values.filter { it.familia == r.familia }.forEach { it.revogado = true }
                return 401 to null
            }
            if (r.revogado || aparelhoRevogado) return 401 to null
            r.usado = true
            return 200 to emitir(r.familia)
        }

        fun api(access: String?): Int = when {
            foraDoAr -> 0
            aparelhoRevogado -> 401
            access != null && access in accessValidos -> 200
            else -> 401
        }

        fun familiaInteiraRevogada(): Boolean = refreshes.values.all { it.revogado }
    }

    /** O que `PareamentoTv.renovarDetalhado` faz, sobre o servidor simulado. */
    private class Cliente(private val servidor: Servidor) {
        var disco: String? = null
        var access: String? = null
        var perderProximaResposta = false

        fun parear() {
            val (a, r) = servidor.parear()
            access = a
            disco = r
        }

        suspend fun renovar(): ResultadoRenovacao {
            val refresh = disco ?: return ResultadoRenovacao.Temporario("refresh_ilegivel")
            val resposta = servidor.renovar(refresh)
            if (perderProximaResposta) {
                perderProximaResposta = false
                return ResultadoRenovacao.Temporario("SocketTimeoutException")
            }
            resposta ?: return ResultadoRenovacao.Temporario("UnknownHostException")
            return when (val classe = classificarStatusDeRenovacao(resposta.first)) {
                null -> {
                    val (a, r) = resposta.second!!
                    disco = r
                    access = a
                    ResultadoRenovacao.Renovado("dev-1")
                }
                ResultadoRenovacao.Recusado -> {
                    disco = null
                    access = null
                    classe
                }
                else -> classe
            }
        }

        suspend fun chamarApi(): DesfechoDaChamada<Int> = executarComRenovacao(
            chamar = { servidor.api(access) },
            accessRecusado = { it == 401 },
            renovar = { renovar() },
        )

        /** Abertura do app: processo novo, access perdido. */
        suspend fun abrir(esperas: MutableList<Long> = mutableListOf()): DecisaoDeAbertura {
            access = null
            return restaurarSessao(
                ler = { if (disco != null) LeituraCredencial.Presente else LeituraCredencial.Ausente },
                renovar = { renovar() },
                esperar = { esperas += it },
            )
        }
    }

    @Test
    fun `access vencido com refresh valido renova e refaz a chamada sem pedir login`() = runBlocking {
        val s = Servidor()
        val c = Cliente(s).apply { parear() }
        s.vencerAccess()

        val d = c.chamarApi()
        assertEquals(DesfechoDaChamada.Respondeu(200, renovou = true), d)
        assertTrue(c.disco != null)
    }

    @Test
    fun `chamada com access valido nao renova`() = runBlocking {
        val c = Cliente(Servidor()).apply { parear() }
        val refreshAntes = c.disco
        assertEquals(DesfechoDaChamada.Respondeu(200, renovou = false), c.chamarApi())
        assertEquals(refreshAntes, c.disco)
    }

    @Test
    fun `fechar reabrir forcar parada e religar entram sem parear`() = runBlocking {
        val s = Servidor()
        val c = Cliente(s).apply { parear() }
        repeat(3) { assertEquals(DecisaoDeAbertura.Entrar("dev-1"), c.abrir()) }
        assertEquals(DesfechoDaChamada.Respondeu(200, renovou = false), c.chamarApi())
    }

    @Test
    fun `renovacao indisponivel ao vencer o access adia sem apagar e renova quando volta`() = runBlocking {
        val s = Servidor()
        val c = Cliente(s).apply { parear() }
        s.vencerAccess()
        s.renovacaoIndisponivel = true

        assertTrue(c.chamarApi() is DesfechoDaChamada.RenovacaoAdiada)
        assertTrue("falha temporaria nao apaga", c.disco != null)

        s.renovacaoIndisponivel = false
        assertEquals(DesfechoDaChamada.Respondeu(200, renovou = true), c.chamarApi())
    }

    @Test
    fun `abrir sem internet espera e entra quando a conexao volta`() = runBlocking {
        val s = Servidor()
        val c = Cliente(s).apply { parear() }
        s.foraDoAr = true
        var tentativas = 0
        val decisao = restaurarSessao(
            ler = { LeituraCredencial.Presente },
            renovar = { if (++tentativas == 3) s.foraDoAr = false; c.renovar() },
            esperar = {},
        )
        assertEquals(DecisaoDeAbertura.Entrar("dev-1"), decisao)
    }

    @Test
    fun `aparelho revogado e recusa definitiva e exige pareamento`() = runBlocking {
        val s = Servidor()
        val c = Cliente(s).apply { parear() }
        s.aparelhoRevogado = true

        assertEquals(DesfechoDaChamada.SessaoRecusada, c.chamarApi())
        assertNull(c.disco)
        assertEquals(DecisaoDeAbertura.Parear, c.abrir())
    }

    @Test
    fun `logout apaga a credencial e a abertura seguinte vai ao pareamento`() = runBlocking {
        val c = Cliente(Servidor()).apply { parear() }
        c.disco = null
        c.access = null
        assertEquals(DecisaoDeAbertura.Parear, c.abrir())
    }

    @Test
    fun `resposta perdida apos a rotacao cai no reuso e exige novo pareamento sem vazar sessao`() = runBlocking {
        val s = Servidor()
        val c = Cliente(s).apply { parear() }
        s.vencerAccess()

        // O servidor gira e grava; a resposta nao chega.
        c.perderProximaResposta = true
        assertTrue(c.chamarApi() is DesfechoDaChamada.RenovacaoAdiada)
        assertTrue("o cliente continua com o token antigo", c.disco != null)

        // Proxima tentativa apresenta o token ja usado: reuso.
        assertEquals(DesfechoDaChamada.SessaoRecusada, c.chamarApi())
        assertNull(c.disco)
        assertTrue("a familia inteira, inclusive o sucessor perdido, foi revogada", s.familiaInteiraRevogada())
        assertEquals(DecisaoDeAbertura.Parear, c.abrir())
    }
}
