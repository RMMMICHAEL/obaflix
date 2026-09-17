package com.obaflix.tv.ui.componentes

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Navegacao vertical entre fileiras.
 *
 * ## O que este arquivo consegue provar, e o que nao consegue
 *
 * O comportamento de foco do Compose so se observa com a composicao viva —
 * exige teste instrumentado (`compose-ui-test`) num aparelho ou emulador de TV,
 * que este projeto ainda nao tem configurado. Nao ha como, em JVM pura, apertar
 * a seta para baixo e conferir onde o cursor parou.
 *
 * ## Por que nao ha mais teste de `focusProperties.enter`
 *
 * Este arquivo chegou a travar so a **fiacao** de um `enter = { primeiro }`
 * que forcava o foco de entrada para o card de indice 0 (0.7.27). Essa
 * verificacao de texto passou perfeitamente enquanto o mecanismo travava o
 * D-pad de verdade em TV fisica: ela provava que o codigo existia, nao que o
 * foco funcionava. O mecanismo foi revertido (ver comentario em
 * FileiraCatalogo), e o teste abaixo faz o oposto — impede que ele volte sem
 * uma validacao real de foco.
 */
class FileirasTest {

    private val fonte: String by lazy {
        File("src/main/java/com/obaflix/tv/ui/componentes/Fileiras.kt").readText()
    }

    private val semComentarios: String by lazy {
        fonte
            .replace(Regex("""/\*[\s\S]*?\*/"""), " ")
            .lines()
            .joinToString("\n") { linha ->
                val corte = linha.indexOf("//")
                if (corte >= 0) linha.substring(0, corte) else linha
            }
    }

    @Test
    fun `o arquivo que este teste protege existe`() {
        // Sem isto, mover o componente transformaria os testes abaixo em no-op
        // silencioso — passariam lendo uma string vazia.
        assertTrue("Fileiras.kt nao encontrado", fonte.contains("fun FileiraCatalogo"))
    }

    @Test
    fun `enter nao volta sem prova de foco vivo`() {
        // Trava o oposto do que este arquivo travava antes: `focusProperties`
        // com `enter =` travou o D-pad em TV fisica na 0.7.27 (ver historico do
        // commit desta linha) e o unico teste da epoca so conferia o texto no
        // arquivo — nunca o foco em execucao. Reintroduzir isto exige antes um
        // teste instrumentado de Compose provando a navegacao em foco vivo;
        // ate la, este teste falha de proposito para impedir a volta silenciosa.
        assertFalse(
            "focusProperties.enter voltou sem teste instrumentado de foco vivo",
            semComentarios.contains("focusProperties") && semComentarios.contains("enter ="),
        )
    }

    @Test
    fun `a navegacao horizontal nao foi tocada`() {
        // Esquerda e direita andam DENTRO do grupo e nao passam por `enter`.
        // Um `left`/`right` explicito aqui significaria que alguem mexeu no que
        // devia ficar como estava.
        assertFalse("apareceu override de navegacao horizontal", semComentarios.contains("left ="))
        assertFalse("apareceu override de navegacao horizontal", semComentarios.contains("right ="))
    }

    @Test
    fun `o grupo de foco continua existindo`() {
        // focusGroup + chave estavel foram o que corrigiu o crash de
        // "LayoutCoordinate operations are only valid when isAttached is true".
        assertTrue(semComentarios.contains("focusGroup()"))
        assertTrue(semComentarios.contains("key = { _, item ->"))
    }

    // -- Aritmetica de colunas (pura) -----------------------------------------

    @Test
    fun `colunas cabem na largura sem vazar`() {
        // 720p, 1080p e 4K em dp de TV.
        assertTrue(colunas(960) in 4..9)
        assertTrue(colunas(1280) in 4..9)
        assertTrue(colunas(1920) in 4..9)
    }

    @Test
    fun `mais largura nunca devolve menos colunas`() {
        var anterior = colunas(600)
        for (largura in 600..2400 step 60) {
            val atual = colunas(largura)
            assertTrue("colunas diminuiu de $anterior para $atual em $largura", atual >= anterior)
            anterior = atual
        }
    }

    @Test
    fun `largura absurda fica dentro dos limites`() {
        assertEquals(4, colunas(0))
        assertEquals(4, colunas(-100))
        assertEquals(9, colunas(100_000))
    }
}
