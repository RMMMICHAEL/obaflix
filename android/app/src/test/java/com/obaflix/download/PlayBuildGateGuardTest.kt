package com.obaflix.download

import org.junit.Assert.assertTrue
import org.junit.Assert.assertFalse
import org.junit.Test
import java.io.File

/**
 * Guardas de fonte do fail-close de download da distribuicao Google Play
 * (buildType playRelease, BuildConfig.PLAY_STORE_BUILD == true).
 *
 * Por que ler fonte e nao chamar funcao: o ramo do Play depende de
 * `BuildConfig.PLAY_STORE_BUILD`, uma constante de build-time. Um unit test roda
 * numa unica variante (debug, PLAY_STORE_BUILD=false), entao nao da para
 * exercitar os dois ramos chamando o metodo. A propriedade que importa e
 * *estrutural*: cada entrada de download do bridge precisa ter o gate, e
 * cancelarDownload precisa recusar ANTES de tocar o DownloadService (que nem
 * existe no manifest Play). O comportamento efetivo e verificado tambem pela
 * inspecao do AAB no CI (gate de manifest) e pelo teste JVM de ObaflixBridge.
 */
class PlayBuildGateGuardTest {

    private val bridge: String by lazy {
        semComentarios(File("src/main/java/com/obaflix/MediaActionsBridge.kt").readText())
    }

    private val overlayPlay: String by lazy {
        File("src/playRelease/AndroidManifest.xml").readText()
    }

    private fun semComentarios(texto: String): String {
        var t = texto.replace(Regex("/\\*[\\s\\S]*?\\*/"), " ")
        t = t.lines().joinToString("\n") { linha ->
            val corte = linha.indexOf("//")
            if (corte >= 0) linha.substring(0, corte) else linha
        }
        return t
    }

    private fun corpo(nome: String): String {
        val inicio = bridge.indexOf("fun $nome(")
        assertTrue("metodo $nome nao encontrado em MediaActionsBridge", inicio >= 0)
        // Ate o proximo @JavascriptInterface ou fim do arquivo — suficiente para
        // conter o corpo do metodo sem depender de contagem de chaves.
        val resto = bridge.substring(inicio + 4)
        val fim = resto.indexOf("@JavascriptInterface")
        return if (fim >= 0) resto.substring(0, fim) else resto
    }

    @Test
    fun `entradas de download tem gate do Play`() {
        listOf(
            "inspecionarFonte", "solicitarDownload", "temPasta",
            "escolherPasta", "descartarSondagem", "cancelarDownload", "listarDownloads",
        ).forEach { metodo ->
            assertTrue(
                "$metodo nao tem o gate BuildConfig.PLAY_STORE_BUILD",
                corpo(metodo).contains("BuildConfig.PLAY_STORE_BUILD"),
            )
        }
    }

    @Test
    fun `inspecionar e solicitar recusam com codigo estavel no Play`() {
        assertTrue(corpo("inspecionarFonte").contains("download_indisponivel_play"))
        assertTrue(corpo("solicitarDownload").contains("download_indisponivel_play"))
    }

    @Test
    fun `cancelarDownload recusa antes de tocar o DownloadService`() {
        val c = corpo("cancelarDownload")
        val gate = c.indexOf("BuildConfig.PLAY_STORE_BUILD")
        val service = c.indexOf("DownloadService.cancelar")
        assertTrue("gate ausente em cancelarDownload", gate >= 0)
        assertTrue("DownloadService.cancelar ausente", service >= 0)
        assertTrue(
            "no Play, cancelarDownload nao pode chamar DownloadService.cancelar (startService sem servico no manifest)",
            gate < service,
        )
    }

    @Test
    fun `listarDownloads devolve lista vazia no Play`() {
        assertTrue(corpo("listarDownloads").contains("{\\\"downloads\\\":[]}"))
    }

    @Test
    fun `Cast nao e afetado pelo gate do Play`() {
        // Os metodos de Cast nunca checam PLAY_STORE_BUILD: Cast segue igual no
        // Play. Ancora nos corpos (o marcador "-- Cast" e comentario e some no
        // strip).
        listOf("castAppInstalado", "solicitarCast", "instalarAppDeCast").forEach { metodo ->
            assertFalse(
                "$metodo de Cast nao deve depender de PLAY_STORE_BUILD",
                corpo(metodo).contains("BuildConfig.PLAY_STORE_BUILD"),
            )
        }
    }

    @Test
    fun `overlay playRelease remove permissoes e servico de download`() {
        listOf(
            "REQUEST_INSTALL_PACKAGES",
            "FOREGROUND_SERVICE_DATA_SYNC",
            "POST_NOTIFICATIONS",
            ".download.DownloadService",
        ).forEach {
            assertTrue("overlay playRelease nao remove $it", overlayPlay.contains(it))
        }
        // FOREGROUND_SERVICE generico tambem e removido (linha propria).
        assertTrue(
            "overlay playRelease deve remover a permissao generica FOREGROUND_SERVICE",
            overlayPlay.contains("android.permission.FOREGROUND_SERVICE\""),
        )
        assertTrue("overlay deve usar tools:node=remove", overlayPlay.contains("tools:node=\"remove\""))
    }
}
