package com.obaflix.tv

import com.obaflix.update.Atualizador
import com.obaflix.update.Plataforma
import com.obaflix.update.ResultadoVerificacao
import com.obaflix.update.UpdateChecker
import kotlinx.coroutines.runBlocking
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Configuracao efetiva da variante `homologacao`, conferida contra o BuildConfig
 * gerado — nao contra o build.gradle.
 *
 *   gradlew :tv:testHomologacaoUnitTest -Pobaflix.urlTeste=https://<ambiente-de-teste>
 *
 * Reproduz o cenario do crash do smoke: a Home abre, o `AppTv` chama o
 * `Atualizador` com `BuildConfig.UPDATE_MANIFEST_URL` vazio. Isso tem de ser
 * "atualizacao desligada", nunca uma requisicao HTTP com URL vazia.
 */
class ConfiguracaoHomologacaoTest {

    private val desligadosDeProposito = setOf("UPDATE_MANIFEST_URL")

    @Test
    fun `url principal e https e nao e Production`() {
        val url = BuildConfig.OBAFLIX_URL.toHttpUrlOrNull()
        assertNotNull("OBAFLIX_URL invalida: '${BuildConfig.OBAFLIX_URL}'", url)
        assertTrue(url!!.isHttps)
        assertFalse("OBAFLIX_URL aponta para Production", url.host.endsWith("obaflix.online"))
    }

    @Test
    fun `core-extractor usa a mesma url do tv`() {
        assertEquals(BuildConfig.OBAFLIX_URL, com.obaflix.core.BuildConfig.OBAFLIX_URL)
    }

    @Test
    fun `auto-atualizacao desligada de proposito nao vira requisicao`() {
        assertEquals("", BuildConfig.UPDATE_MANIFEST_URL)
        assertFalse(Atualizador.atualizacaoAtiva(BuildConfig.UPDATE_MANIFEST_URL))
        val resultado = runCatching {
            runBlocking { UpdateChecker.verificar(BuildConfig.UPDATE_MANIFEST_URL, Plataforma.ANDROID_TV, BuildConfig.VERSION_CODE) }
        }
        assertEquals(null, resultado.exceptionOrNull())
        assertTrue(resultado.getOrNull() is ResultadoVerificacao.ManifestoInvalido)
    }

    @Test
    fun `nenhum campo de url do BuildConfig fica vazio ou fora de https`() {
        for (config in listOf(BuildConfig::class.java, com.obaflix.core.BuildConfig::class.java)) {
            val campos = config.declaredFields.filter { it.type == String::class.java && it.name.endsWith("URL") }
            assertTrue("${config.name} sem campos de URL", campos.isNotEmpty())
            for (campo in campos) {
                val valor = campo.get(null) as String
                if (valor.isEmpty()) {
                    assertTrue("${config.simpleName}.${campo.name} vazio sem estar desligado de proposito", campo.name in desligadosDeProposito)
                } else {
                    val url = valor.toHttpUrlOrNull()
                    assertNotNull("${config.simpleName}.${campo.name} invalida: '$valor'", url)
                    assertTrue("${config.simpleName}.${campo.name} fora de https", url!!.isHttps)
                    assertNotEquals("${config.simpleName}.${campo.name} em Production", "obaflix.online", url.host)
                }
            }
        }
    }
}
