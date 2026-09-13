package com.obaflix.tv.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Fiacao das telas de planos e da promocao.
 *
 * Mesmo criterio de `FileirasTest`: o comportamento de foco e de player so se
 * observa em aparelho, mas as pecas de que ele depende podem ser travadas no
 * codigo-fonte. Se uma refatoracao tirar o BACK de uma tela, trouxer um botao de
 * pular para a promocao ou colocar segredo no APK, isto quebra antes do release.
 */
class ContratoPlanosTvTest {

    private val raiz = File("src/main/java/com/obaflix/tv")

    private fun fonte(caminho: String): String = File(raiz, caminho).readText()

    /** Sem comentarios: a regra vale para codigo, nao para a explicacao dele. */
    private fun codigo(caminho: String): String =
        fonte(caminho)
            .replace(Regex("""/\*[\s\S]*?\*/"""), " ")
            .lines()
            .joinToString("\n") { linha ->
                val corte = linha.indexOf("//")
                if (corte >= 0 && !linha.contains("https://")) linha.substring(0, corte) else linha
            }

    private val telasNovas = listOf("ui/PortaoDeReproducao.kt", "ui/TelaPlanos.kt", "ui/TelaAssinarForaDaTv.kt")

    @Test
    fun `textos da tela anterior ao video`() {
        val portao = fonte("ui/PortaoDeReproducao.kt")
        assertTrue(portao.contains("\"Assista grátis no Obaflix\""))
        assertTrue(
            portao.contains(
                "\"Assista a um vídeo rápido e continue gratuitamente. Com um plano você remove os anúncios e libera mais benefícios.\"",
            ),
        )
        assertTrue(portao.contains("\"Assistir gratuitamente\""))
        assertTrue(portao.contains("\"Ver planos\""))
    }

    @Test
    fun `promocao sem pular, sem avancar e sem controles`() {
        val portao = codigo("ui/PortaoDeReproducao.kt")
        listOf("seekTo", "seekForward", "seekBack", "\"Pular", "useController = true").forEach {
            assertFalse(it, portao.contains(it))
        }
        assertTrue(portao.contains("useController = false"))
        assertTrue("fim real conferido antes de concluir", portao.contains("terminouDeVerdade("))
    }

    @Test
    fun `conclusao pedida num ponto so, depois do fim do video`() {
        val portao = codigo("ui/PortaoDeReproducao.kt")
        assertEquals(1, Regex("""concluirPromocao\(""").findAll(portao).count())
        assertTrue(portao.contains("is EtapaDaReproducao.ConcluindoPromocao ->"))
        assertEquals(1, Regex("""VideoTerminou""").findAll(portao).count())
    }

    @Test
    fun `fontes leva a credencial e autoriza antes do player`() {
        val api = codigo("catalogo/ApiObaflix.kt")
        assertTrue(api.contains("put(\"concessao\", concessao)"))
        assertTrue(api.contains("\"/api/playback/authorize\""))
        assertTrue(api.contains("\"/api/ads/promocao/iniciar\""))
        assertTrue(api.contains("\"/api/ads/complete\""))

        val app = codigo("ui/AppTv.kt")
        assertTrue("o player passa pelo portao", app.contains("PortaoDeReproducao(topo)"))
        assertFalse("nenhum atalho direto ao player", app.contains("TelaPlayer(topo.pedido)"))
    }

    @Test
    fun `planos acessiveis pela barra e pelas recusas`() {
        val app = codigo("ui/AppTv.kt")
        assertTrue(app.contains("BotaoPlanosDaBarra()"))
        assertTrue(app.contains("is Camada.Planos -> TelaPlanos(topo)"))
        assertTrue(app.contains("is Camada.AssinarForaDaTv -> TelaAssinarForaDaTv(topo)"))
        assertTrue(codigo("ui/TelaCanais.kt").contains("Navegacao.abrirPlanos()"))
        assertTrue(codigo("ui/TelaPlayerDeCanal.kt").contains("Camada.Planos()"))
    }

    @Test
    fun `telas novas tratam Voltar e definem foco inicial`() {
        telasNovas.forEach {
            val c = codigo(it)
            assertTrue("$it sem BackHandler", c.contains("BackHandler("))
            assertTrue("$it sem foco inicial", c.contains("requestFocus()"))
        }
        val planos = codigo("ui/TelaPlanos.kt")
        assertTrue("ordem explicita do D-pad", planos.contains("cardVizinho(i, -1") && planos.contains("cardVizinho(i, +1"))
        assertTrue("restauracao do card", planos.contains("focoDosPlanos(camada.memoria.indiceFocado"))
    }

    @Test
    fun `nenhum formulario de pagamento na TV`() {
        telasNovas.forEach {
            val c = codigo(it).lowercase()
            listOf("textfield", "basictextfield", "cpf", "pix", "cupom").forEach { proibido ->
                assertFalse("$it contem $proibido", c.contains(proibido))
            }
        }
    }

    @Test
    fun `APK de TV sem segredo e sem URL definitiva da promocao`() {
        val proibidos = listOf("ADMIN_SECRET_TOKEN", "MONETIZACAO_ATIVA", "PROMOCAO_TV_VIDEO_URL", "app.obaflix.online/ads/")
        raiz.walkTopDown().filter { it.isFile && it.extension == "kt" }.forEach { arquivo ->
            val texto = arquivo.readText()
            proibidos.forEach { assertFalse("${arquivo.name} contem $it", texto.contains(it)) }
        }
        val gradle = File("build.gradle").readText()
        proibidos.forEach { assertFalse("build.gradle contem $it", gradle.contains(it)) }
    }

    @Test
    fun `adicional VIP de 5,90 nao aparece na TV`() {
        raiz.walkTopDown().filter { it.isFile && it.extension == "kt" }.forEach {
            assertFalse(it.name, it.readText().contains("5,90"))
        }
    }
}
