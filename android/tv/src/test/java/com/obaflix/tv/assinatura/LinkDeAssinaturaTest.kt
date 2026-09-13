package com.obaflix.tv.assinatura

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * O link da continuacao fora da TV: o que pode ir para o QR.
 *
 * O QR fica exposto na sala. Qualquer camera o le — credencial ou dado pessoal
 * ali seria entregue a quem estiver olhando a televisao.
 */
class LinkDeAssinaturaTest {

    @Test
    fun `link fixo aponta para a pagina de planos existente`() {
        val link = linkDaPaginaDePlanos("https://obaflix.online")!!
        assertEquals("https://obaflix.online/planos", link.urlDoQr)
        assertEquals("obaflix.online/planos", link.enderecoLegivel)
        assertNull("link fixo nao expira", link.expiraEmMs)
    }

    @Test
    fun `barra final e www nao atrapalham o endereco legivel`() {
        val link = linkDaPaginaDePlanos("https://www.obaflix.online/")!!
        assertEquals("https://www.obaflix.online/planos", link.urlDoQr)
        assertEquals("obaflix.online/planos", link.enderecoLegivel)
    }

    @Test
    fun `base insegura ou malformada nao gera link`() {
        for (base in listOf("http://obaflix.online", "", "nao e url", "https://usuario:senha@obaflix.online", "ftp://x.y")) {
            assertNull(base, linkDaPaginaDePlanos(base))
        }
    }

    @Test
    fun `QR recusa credencial e dado pessoal`() {
        val proibidas = listOf(
            "https://obaflix.online/planos?token=abc",
            "https://obaflix.online/planos?access_token=abc",
            "https://obaflix.online/planos?refresh_token=abc",
            "https://obaflix.online/planos?x=1&Authorization=Bearer",
            "https://obaflix.online/planos?email=pessoa",
            "https://obaflix.online/planos?cpf=1",
            "https://obaflix.online/planos?telefone=1",
            "https://obaflix.online/planos#token",
            "https://usuario:senha@obaflix.online/planos",
            "http://obaflix.online/planos",
        )
        proibidas.forEach { assertFalse(it, podeIrParaQr(it)) }
    }

    @Test
    fun `QR aceita a pagina de planos e o futuro token opaco de handoff`() {
        assertTrue(podeIrParaQr("https://obaflix.online/planos"))
        assertTrue(podeIrParaQr("https://obaflix.online/assinar?h=Zx9-opaco_123"))
    }

    @Test
    fun `o link de hoje nao carrega nada da conta nem do plano`() {
        val link = linkDaPaginaDePlanos("https://obaflix.online")!!
        assertFalse(link.urlDoQr.contains("?"))
        CatalogoDePlanosTv.TODOS.forEach { assertFalse(link.urlDoQr.contains(it.id)) }
    }
}
