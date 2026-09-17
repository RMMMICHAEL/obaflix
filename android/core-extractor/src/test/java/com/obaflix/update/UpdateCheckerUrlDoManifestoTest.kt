package com.obaflix.update

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Crash do smoke do APK de homologacao (2026-09-14):
 *
 *   FATAL EXCEPTION: DefaultDispatcher-worker-2
 *   java.lang.IllegalArgumentException: Expected URL scheme 'http' or 'https'
 *   but no scheme was found for
 *
 * Retrace com o mapping.txt da variante: UpdateChecker$verificar$2 <-
 * Atualizador$iniciar$1 <- AppTvKt$AppTv$1. A variante `homologacao` desliga a
 * auto-atualizacao com `UPDATE_MANIFEST_URL = ""`; `verificar` montava a
 * requisicao do OkHttp antes do `try`, e a URL vazia derrubava o processo logo
 * depois de a Home abrir. Antes da correcao, o primeiro teste falhava com essa
 * mesma mensagem.
 */
class UpdateCheckerUrlDoManifestoTest {

    private fun verificar(url: String) = runBlocking { UpdateChecker.verificar(url, Plataforma.ANDROID_TV, 41) }

    @Test
    fun `url de manifesto vazia nao derruba o processo`() {
        val erro = runCatching { verificar("") }.exceptionOrNull()
        assertNull("verificar(\"\") lancou: $erro", erro)
    }

    @Test
    fun `url ausente ou invalida volta como manifesto invalido sem montar requisicao`() {
        for (url in listOf("", "   ", "sem-esquema", "obaflix.online/update-manifest.json", "ftp://exemplo.invalid/m.json", "http://exemplo.invalid/m.json")) {
            val r = runCatching { verificar(url) }
            assertNull("\"$url\" lancou: ${r.exceptionOrNull()}", r.exceptionOrNull())
            assertEquals("\"$url\"", ResultadoVerificacao.ManifestoInvalido("url_de_manifesto_ausente_ou_invalida"), r.getOrNull())
        }
    }

    @Test
    fun `so https com host e aceito como manifesto configurado`() {
        assertNull(UpdateChecker.manifestoConfigurado(""))
        assertNull(UpdateChecker.manifestoConfigurado(null))
        assertNull(UpdateChecker.manifestoConfigurado("  "))
        assertNull(UpdateChecker.manifestoConfigurado("http://app.obaflix.online/update-manifest.json"))
        assertNotNull(UpdateChecker.manifestoConfigurado("https://app.obaflix.online/update-manifest.json"))
        assertNotNull(UpdateChecker.manifestoConfigurado(" https://app.obaflix.online/update-manifest.json "))
    }

    @Test
    fun `atualizador nao abre laco para url desligada`() {
        assertFalse(Atualizador.atualizacaoAtiva(""))
        assertFalse(Atualizador.atualizacaoAtiva("sem-esquema"))
        assertTrue(Atualizador.atualizacaoAtiva("https://app.obaflix.online/update-manifest.json"))
    }
}
