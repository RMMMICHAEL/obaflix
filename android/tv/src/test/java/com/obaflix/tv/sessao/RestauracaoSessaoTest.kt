package com.obaflix.tv.sessao

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Restauracao da sessao na abertura: fechar e reabrir, processo encerrado,
 * aparelho religado. Em todos esses casos o que chega aqui e o mesmo — credencial
 * so em disco, access token perdido — e o que muda e a resposta da rede.
 */
class RestauracaoSessaoTest {

    private class Cenario(
        leituras: List<LeituraCredencial>,
        renovacoes: List<ResultadoRenovacao>,
    ) {
        private val leituras = ArrayDeque(leituras)
        private val renovacoes = ArrayDeque(renovacoes)
        val esperas = mutableListOf<Long>()
        val avisos = mutableListOf<String>()
        var chamadasDeRenovacao = 0

        fun rodar(): DecisaoDeAbertura = runBlocking {
            restaurarSessao(
                ler = { leituras.removeFirstOrNull() ?: LeituraCredencial.Presente },
                renovar = {
                    chamadasDeRenovacao++
                    renovacoes.removeFirst()
                },
                esperar = { esperas += it },
                aoAguardar = { _, motivo -> avisos += motivo },
            )
        }
    }

    @Test
    fun `reabrir com refresh valido entra sem parear`() {
        val c = Cenario(listOf(LeituraCredencial.Presente), listOf(ResultadoRenovacao.Renovado("dev-1")))
        assertEquals(DecisaoDeAbertura.Entrar("dev-1"), c.rodar())
        assertTrue("sem espera quando renova de primeira", c.esperas.isEmpty())
    }

    @Test
    fun `primeira abertura ou depois do logout vai ao pareamento sem chamar a rede`() {
        val c = Cenario(listOf(LeituraCredencial.Ausente), emptyList())
        assertEquals(DecisaoDeAbertura.Parear, c.rodar())
        assertEquals(0, c.chamadasDeRenovacao)
    }

    @Test
    fun `TV religada sem rede espera a conexao e entra sem parear`() {
        val c = Cenario(
            listOf(LeituraCredencial.Presente),
            listOf(
                ResultadoRenovacao.Temporario("UnknownHostException"),
                ResultadoRenovacao.Temporario("SocketTimeoutException"),
                ResultadoRenovacao.Temporario("http_503"),
                ResultadoRenovacao.Renovado("dev-1"),
            ),
        )
        assertEquals(DecisaoDeAbertura.Entrar("dev-1"), c.rodar())
        assertEquals(listOf(2_000L, 4_000L, 8_000L), c.esperas)
        assertEquals(listOf("UnknownHostException", "SocketTimeoutException", "http_503"), c.avisos)
    }

    @Test
    fun `rede fora por muito tempo nunca vira pareamento e a espera tem teto`() {
        val falhas = List(20) { ResultadoRenovacao.Temporario("UnknownHostException") }
        val c = Cenario(listOf(LeituraCredencial.Presente), falhas + ResultadoRenovacao.Renovado("dev-1"))
        assertEquals(DecisaoDeAbertura.Entrar("dev-1"), c.rodar())
        assertEquals(30_000L, c.esperas.max())
        assertEquals(20, c.esperas.size)
    }

    @Test
    fun `aparelho revogado ou refresh recusado exige novo pareamento`() {
        val c = Cenario(listOf(LeituraCredencial.Presente), listOf(ResultadoRenovacao.Recusado))
        assertEquals(DecisaoDeAbertura.Parear, c.rodar())
        assertEquals(1, c.chamadasDeRenovacao)
    }

    @Test
    fun `recusa depois de falhas temporarias tambem exige pareamento`() {
        val c = Cenario(
            listOf(LeituraCredencial.Presente),
            listOf(ResultadoRenovacao.Temporario("http_502"), ResultadoRenovacao.Recusado),
        )
        assertEquals(DecisaoDeAbertura.Parear, c.rodar())
    }

    @Test
    fun `Keystore lento logo apos o boot nao apaga o login`() {
        val c = Cenario(
            listOf(LeituraCredencial.Indisponivel, LeituraCredencial.Indisponivel, LeituraCredencial.Presente),
            listOf(ResultadoRenovacao.Renovado("dev-1")),
        )
        assertEquals(DecisaoDeAbertura.Entrar("dev-1"), c.rodar())
        assertEquals(listOf("armazenamento_indisponivel", "armazenamento_indisponivel"), c.avisos)
    }

    @Test
    fun `Keystore quebrado de vez cai no pareamento em vez de travar no carregamento`() {
        val c = Cenario(List(LEITURAS_INDISPONIVEIS_MAX) { LeituraCredencial.Indisponivel }, emptyList())
        assertEquals(DecisaoDeAbertura.Parear, c.rodar())
        assertEquals(0, c.chamadasDeRenovacao)
    }

    @Test
    fun `credencial apagada durante a espera leva ao pareamento`() {
        // Logout ou recusa confirmada por outro caminho enquanto a TV aguardava rede.
        val c = Cenario(
            listOf(LeituraCredencial.Presente, LeituraCredencial.Ausente),
            listOf(ResultadoRenovacao.Temporario("UnknownHostException")),
        )
        assertEquals(DecisaoDeAbertura.Parear, c.rodar())
    }

    @Test
    fun `so 401 e definitivo`() {
        assertEquals(null, classificarStatusDeRenovacao(200))
        assertEquals(ResultadoRenovacao.Recusado, classificarStatusDeRenovacao(401))
        for (status in listOf(400, 403, 404, 408, 429, 500, 502, 503, 504)) {
            assertEquals(
                "status $status nao pode apagar o login",
                ResultadoRenovacao.Temporario("http_$status"),
                classificarStatusDeRenovacao(status),
            )
        }
    }
}
