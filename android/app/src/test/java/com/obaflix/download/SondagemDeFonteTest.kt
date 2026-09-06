package com.obaflix.download

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * O que acontece entre abrir e fechar o modal de qualidade.
 *
 * Duas garantias moram aqui. A primeira: fechar o modal nao inicia download
 * nenhum e solta a URL assinada da memoria. A segunda: um pedido de download
 * so e aceito com a sondagem certa, dentro do prazo e com uma qualidade que
 * pertence a ela — sem isso, um pedido antigo do JavaScript poderia baixar
 * usando uma fonte que ja nao e a da tela.
 */
class SondagemDeFonteTest {

    private val FONTE = DownloadSource(
        url = "https://cdn.exemplo.com/master.m3u8?token=abc123",
        referer = "https://provedor.exemplo/embed",
        userAgent = "Mozilla/5.0",
        kind = MediaKind.HLS,
        expiresAt = null,
    )

    private val QUALIDADES = listOf(
        QualidadeDownload("v0", "1080p", 1080, "https://cdn.exemplo.com/1080/i.m3u8"),
        QualidadeDownload("v2", "480p", 480, "https://cdn.exemplo.com/480/i.m3u8"),
    )

    /** Relogio controlado: o prazo e regra, nao sorte de temporizacao. */
    private class Relogio(var agora: Long = 0L)

    private fun sondagem(relogio: Relogio, validadeMs: Long = 1000L): SondagemDeFonte {
        var n = 0
        return SondagemDeFonte(
            validadeMs = validadeMs,
            relogio = { relogio.agora },
            gerarId = { "s${++n}" },
        )
    }

    @Test
    fun `resgatar com o id e a qualidade certos devolve a fonte`() {
        val s = sondagem(Relogio())
        val id = s.guardar(FONTE, QUALIDADES, "serie:1:t1:e1", "Ep 1")

        val r = s.resgatar(id, "v2") as SondagemDeFonte.Resgate.Ok
        assertEquals("480p", r.qualidade.label)
        assertEquals("https://cdn.exemplo.com/480/i.m3u8", r.qualidade.uri)
        assertEquals("serie:1:t1:e1", r.pid)
        assertEquals(FONTE.referer, r.source.referer)
    }

    @Test
    fun `fechar o modal descarta e nenhum download pode comecar depois`() {
        // A garantia central: cancelar nao inicia nada, e a URL assinada sai da
        // memoria na hora em vez de esperar o prazo.
        val s = sondagem(Relogio())
        val id = s.guardar(FONTE, QUALIDADES, "p", "Ep 1")
        assertTrue(s.temSondagemAberta)

        s.descartar()

        assertFalse(s.temSondagemAberta)
        assertEquals(SondagemDeFonte.Resgate.NaoEncontrada, s.resgatar(id, "v2"))
    }

    @Test
    fun `sem nenhuma sondagem aberta nada e resgatavel`() {
        val s = sondagem(Relogio())
        assertEquals(SondagemDeFonte.Resgate.NaoEncontrada, s.resgatar("qualquer", "v0"))
    }

    @Test
    fun `id de outra sondagem nao serve`() {
        // Modal fechado num episodio e aberto em outro: o pedido atrasado do
        // primeiro nao pode baixar usando a fonte do segundo.
        val s = sondagem(Relogio())
        val primeiro = s.guardar(FONTE, QUALIDADES, "p1", "Ep 1")
        s.guardar(FONTE, QUALIDADES, "p2", "Ep 2")

        assertEquals(SondagemDeFonte.Resgate.NaoEncontrada, s.resgatar(primeiro, "v0"))
    }

    @Test
    fun `sondagem vencida e recusada`() {
        val relogio = Relogio()
        val s = sondagem(relogio, validadeMs = 1000L)
        val id = s.guardar(FONTE, QUALIDADES, "p", "Ep 1")

        relogio.agora = 1001L
        assertEquals(SondagemDeFonte.Resgate.Expirada, s.resgatar(id, "v0"))
    }

    @Test
    fun `dentro do prazo ainda vale`() {
        val relogio = Relogio()
        val s = sondagem(relogio, validadeMs = 1000L)
        val id = s.guardar(FONTE, QUALIDADES, "p", "Ep 1")

        relogio.agora = 1000L
        assertTrue(s.resgatar(id, "v0") is SondagemDeFonte.Resgate.Ok)
    }

    @Test
    fun `vencer tambem solta a fonte da memoria`() {
        val relogio = Relogio()
        val s = sondagem(relogio, validadeMs = 1000L)
        val id = s.guardar(FONTE, QUALIDADES, "p", "Ep 1")

        relogio.agora = 5000L
        s.resgatar(id, "v0")
        assertFalse(s.temSondagemAberta)
    }

    @Test
    fun `qualidade que nao pertence a esta sondagem e recusada`() {
        val s = sondagem(Relogio())
        val id = s.guardar(FONTE, QUALIDADES, "p", "Ep 1")

        assertEquals(SondagemDeFonte.Resgate.QualidadeInvalida, s.resgatar(id, "v99"))
        // E a sondagem continua aberta: foi um pedido invalido, nao um cancelamento.
        assertTrue(s.temSondagemAberta)
    }

    @Test
    fun `resgatar duas vezes nao gera dois downloads`() {
        // Um toque duplo no botao de qualidade nao pode virar dois itens na fila.
        val s = sondagem(Relogio())
        val id = s.guardar(FONTE, QUALIDADES, "p", "Ep 1")

        assertTrue(s.resgatar(id, "v0") is SondagemDeFonte.Resgate.Ok)
        assertEquals(SondagemDeFonte.Resgate.NaoEncontrada, s.resgatar(id, "v0"))
    }

    @Test
    fun `qualidade Padrao nao fixa variante e cai na fonte original`() {
        val s = sondagem(Relogio())
        val id = s.guardar(FONTE, listOf(QualidadeDownload.padrao()), "p", "Ep 1")

        val r = s.resgatar(id, QualidadeDownload.ID_PADRAO) as SondagemDeFonte.Resgate.Ok
        assertEquals(null, r.qualidade.uri)
        // Quem monta o registro usa `qualidade.uri ?: source.url`.
        assertEquals(FONTE.url, r.qualidade.uri ?: r.source.url)
    }
}
