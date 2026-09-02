package com.obaflix.update

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Cobre so [UpdateChecker.decidir] — a parte pura, sem rede, da checagem. O
 * caminho com OkHttp (`verificar`) precisa de um Context/manifest real e
 * continua validado por build + instalacao manual, nao aqui.
 */
class UpdateCheckerDecisionTest {

    private fun entrada(versionCode: Int) =
        PlatformUpdate("v$versionCode", versionCode, "https://x.example/a.apk", null, null)

    @Test
    fun `versionCode maior que o atual conta como nova versao`() {
        val manifesto = UpdateManifest(1, entrada(10), null)
        val resultado = UpdateChecker.decidir(manifesto, Plataforma.ANDROID, 9)
        assertTrue(resultado is ResultadoVerificacao.NovaVersao)
        assertEquals(10, (resultado as ResultadoVerificacao.NovaVersao).info.versionCode)
    }

    @Test
    fun `versionCode igual ao atual conta como ja atualizado`() {
        val manifesto = UpdateManifest(1, entrada(9), null)
        assertEquals(
            ResultadoVerificacao.JaAtualizado,
            UpdateChecker.decidir(manifesto, Plataforma.ANDROID, 9),
        )
    }

    @Test
    fun `versionCode menor que o atual nunca sugere downgrade`() {
        val manifesto = UpdateManifest(1, entrada(5), null)
        assertEquals(
            ResultadoVerificacao.JaAtualizado,
            UpdateChecker.decidir(manifesto, Plataforma.ANDROID, 9),
        )
    }

    @Test
    fun `plataforma sem entrada no manifesto`() {
        val manifesto = UpdateManifest(1, null, null)
        val resultado = UpdateChecker.decidir(manifesto, Plataforma.ANDROID, 9)
        assertTrue(resultado is ResultadoVerificacao.PlataformaAusente)
        assertEquals("android", (resultado as ResultadoVerificacao.PlataformaAusente).plataforma)
    }

    @Test
    fun `android e androidTv sao consultados de forma independente`() {
        val manifesto = UpdateManifest(1, entrada(10), null)
        // So o Android tem entrada; a TV, mesmo com versionCode baixo, fica "ausente".
        val resultadoTv = UpdateChecker.decidir(manifesto, Plataforma.ANDROID_TV, 5)
        assertTrue(resultadoTv is ResultadoVerificacao.PlataformaAusente)
    }
}
